import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { test } from "node:test";
import { createPool } from "mysql2/promise";
import { databaseConnectionOptions } from "../src/auth/database.js";

function packet(payload: Buffer, sequence: number) {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}
function greeting() {
  const flags = 0x0008aa0d;
  const low = Buffer.alloc(2),
    high = Buffer.alloc(2),
    id = Buffer.alloc(4);
  low.writeUInt16LE(flags & 0xffff);
  high.writeUInt16LE(flags >>> 16);
  id.writeUInt32LE(1);
  return packet(
    Buffer.concat([
      Buffer.from([10]),
      Buffer.from("8.0.40\0"),
      id,
      Buffer.from("salt1234"),
      Buffer.from([0]),
      low,
      Buffer.from([45, 2, 0]),
      high,
      Buffer.from([21]),
      Buffer.alloc(10),
      Buffer.from("567890abcdef\0mysql_native_password\0"),
    ]),
    0,
  );
}

for (const name of ["ip", "localhost"] as const) {
  test(`real mysql2 TLS verifies the configured IP against ${name} SAN before credentials`, {
    timeout: 8000,
  }, async () => {
    const cert = await readFile(new URL(`../../test/fixtures/tls/${name}.pem`, import.meta.url));
    const key = await readFile(
      new URL("../../test/fixtures/tls/synthetic-key.pem", import.meta.url),
    );
    const secureContext = createSecureContext({ cert, key });
    const sockets = new Set<Socket>();
    let authenticated = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.write(greeting());
      let bytes = Buffer.alloc(0);
      const upgrade = (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 4 || bytes.length < bytes.readUIntLE(0, 3) + 4) return;
        socket.pause();
        socket.removeListener("data", upgrade);
        assert.equal(bytes.readUIntLE(0, 3), 32); // SSLRequest contains no credentials.
        const end = bytes.readUIntLE(0, 3) + 4;
        if (bytes.length > end) socket.unshift(bytes.subarray(end));
        const tls = new TLSSocket(socket, { isServer: true, secureContext });
        sockets.add(tls);
        tls.on("error", () => {});
        tls.on("close", () => sockets.delete(tls));
        let authentication = Buffer.alloc(0);
        tls.on("data", (chunk) => {
          authentication = Buffer.concat([authentication, chunk]);
          if (
            authentication.length < 4 ||
            authentication.length < authentication.readUIntLE(0, 3) + 4
          )
            return;
          if (authenticated) return;
          authenticated = true;
          tls.write(packet(Buffer.from([0, 0, 0, 2, 0, 0, 0]), 3));
        });
        tls.resume();
      };
      socket.on("data", upgrade);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const options = databaseConnectionOptions(
      `mysql://synthetic:unused@127.0.0.1:${address.port}/unused?tls=required`,
    );
    assert.ok(options.ssl && typeof options.ssl === "object");
    const pool = createPool({ ...options, ssl: { ...options.ssl, ca: cert } });
    try {
      if (name === "ip") {
        const connection = await pool.getConnection();
        connection.release();
        assert.equal(authenticated, true);
      } else {
        await assert.rejects(
          () => pool.getConnection(),
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "HANDSHAKE_SSL_ERROR" &&
            error.message.includes("IP: 127.0.0.1 is not in the cert's list"),
        );
        assert.equal(authenticated, false);
      }
    } finally {
      await pool.end();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
