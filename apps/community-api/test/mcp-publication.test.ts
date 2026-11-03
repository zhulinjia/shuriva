import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { ResponsePublication } from "../src/mcp/response-publication.js";
class ResponseProbe extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes = 0;
  write(_chunk: unknown) {
    this.writes++;
    return true;
  }
  end() {
    this.writes++;
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}
test("final SDK serialization cannot publish after the lease expired", async () => {
  const socket = new ResponseProbe(),
    publication = new ResponsePublication(socket as unknown as ServerResponse),
    lease = new AbortController();
  let expired = false;
  await publication.send(async () => {
    publication.release(
      { content: [{ type: "text", text: "synthetic" }] },
      () => {
        if (expired) throw Error("expired lease");
      },
      lease.signal,
    );
    await publication.finished;
  });
  const serialized = new ReadableStream<Uint8Array>({
    start(controller) {
      expired = true;
      controller.enqueue(Buffer.from('{"result":"synthetic"}'));
      controller.close();
    },
  });
  await assert.rejects(() => publication.prepare(new Response(serialized)), /expired lease/);
  socket.destroy();
  await publication.finished;
});
test("lease is checked again when already encoded bytes reach the Node write boundary", async () => {
  const socket = new ResponseProbe(),
    publication = new ResponsePublication(socket as unknown as ServerResponse),
    lease = new AbortController();
  let expired = false;
  await publication.send(async () => {
    publication.release(
      { content: [{ type: "text", text: "synthetic" }] },
      () => {
        if (expired) throw Error("expired lease");
      },
      lease.signal,
    );
    await publication.finished;
  });
  await publication.prepare(new Response('{"result":"already encoded"}'));
  expired = true;
  assert.equal(socket.write(Buffer.from("must not be sent")), false);
  assert.equal(socket.writes, 0);
  assert.equal(socket.destroyed, true);
  await publication.finished;
});
test("authorization expiry closes a backpressured SDK publication", async () => {
  const socket = new ResponseProbe(),
    publication = new ResponsePublication(socket as unknown as ServerResponse),
    lease = new AbortController();
  await publication.send(async () => {
    publication.release({ content: [{ type: "text", text: "synthetic" }] }, () => {}, lease.signal);
    await publication.finished;
  });
  const neverComplete = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('{"incomplete":'));
    },
  });
  const result = publication.prepare(new Response(neverComplete));
  lease.abort();
  await assert.rejects(() => result);
  assert.equal(socket.destroyed, true);
  await publication.finished;
});
