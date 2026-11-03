import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Entry } from "@napi-rs/keyring";
import { generate } from "selfsigned";
import { localEntry, loadLocalCredential } from "../src/mcp/local-vault.js";
import { trustedLocalFetch } from "../src/mcp/local-channel.js";
import { mcpFixture } from "./mcp-fixture.js";

test("local OAuth CLI accepts approved subset and terminates a verified denial", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 60000,
}, async (t) => {
  const f = await mcpFixture("local_domain");
  t.after(() => f.close());
  const granted = await f.request("/api/mcp/grants", { ...f.scope, scopes: ["metadata:read"] });
  assert.equal(granted.status, 201);
  for (const accept of [true, false]) {
    const ref = randomUUID(),
      entry = localEntry(ref);
    t.after(() => {
      if (entry.getPassword()) entry.deletePassword();
    });
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../src/mcp-local-login.js", import.meta.url)),
        ref,
        f.resource,
        `${f.origin}/api/auth`,
        f.client.clientId,
        "http://127.0.0.1:19492/callback",
        "metadata:read",
      ],
      { env: { SystemRoot: process.env.SystemRoot ?? "" }, stdio: ["ignore", "ignore", "pipe"] },
    );
    const done = once(child, "exit");
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let stderr = "";
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("local login did not request authorization")),
        15000,
      );
      child.stderr.on("data", (b) => {
        stderr += b.toString();
        const found = stderr.match(/\n(http:\/\/[^\s]+)\n/);
        if (found?.[1]) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("local login exited before authorization"));
      });
    });
    const start = await fetch(url, { headers: f.headers, redirect: "manual" });
    assert.equal(start.status, 302, await start.clone().text());
    const location = start.headers.get("location");
    assert.ok(location);
    const id = new URL(location).searchParams.get("mcpConsent");
    assert.ok(id);
    const review = await f.request(`/api/mcp/consents/${id}`);
    assert.equal(review.status, 200);
    assert.deepEqual((await review.json()).scopes, ["metadata:read"]);
    const decision = await f.request(`/api/mcp/consents/${id}`, { accept });
    assert.equal(decision.status, 200, await decision.clone().text());
    const callback = String((await decision.json()).redirectUrl);
    const invalid = new URL(callback);
    invalid.searchParams.set("state", "incorrect-state");
    assert.equal((await fetch(invalid)).status, 403);
    assert.equal((await fetch(callback)).status, 200);
    assert.equal(
      (await done)[0],
      accept ? 0 : 1,
      stderr.replaceAll(/http:\/\/[^\s]+/g, "[authorization URL]"),
    );
    if (accept) {
      const value = loadLocalCredential(ref);
      assert.equal(value.clientId, f.client.clientId);
      assert.ok(value.expiresAt > Date.now());
    } else assert.equal(entry.getPassword(), null);
  }
});

test("a different TLS server cannot receive the local bearer", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 20000,
}, async (t) => {
  const resource = `http://127.0.0.1:19497/mcp`,
    key = createHash("sha256").update(resource).digest("hex"),
    entry = new Entry("shuriva-mcp-local-channel", key, { linux: { store: "secret-service" } });
  assert.equal(entry.getPassword(), null, "fixture reference must be unused");
  const trusted = await generate([{ name: "commonName", value: "127.0.0.1" }], {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
    }),
    impostor = await generate([{ name: "commonName", value: "127.0.0.1" }], {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
    });
  let received = false;
  const server = createServer({ cert: impostor.cert, key: impostor.private }, (_req, res) => {
    received = true;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  entry.setPassword(
    JSON.stringify({
      resource,
      issuer: "http://127.0.0.1:19498/api/auth",
      port: address.port,
      cert: trusted.cert,
    }),
  );
  t.after(async () => {
    entry.deletePassword();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  await assert.rejects(() =>
    trustedLocalFetch(resource)(resource, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-never-send" },
      body: "{}",
    }),
  );
  assert.equal(received, false);
});
