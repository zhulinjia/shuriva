import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { ApiError } from "../src/api.ts";
import { modelTransport, prepareModelSchema, withRequestTimeout } from "../src/models/model-session.ts";

const scope = { instanceId: "instance", scopeToken: "token" };
const preview = {
  schema: { database: "demo", tables: [] },
  schemaHash: "hash",
  destination: { baseUrl: "https://example.com", model: "fake", configVersion: "fixture-version" },
};
const instant = { now: () => 1000, delay: async () => {} };

test("a lost creation response retries the same identity and recovers temporary polling failure", async () => {
  const submitted = [];
  let polls = 0;
  const transport = {
    scope: async () => scope,
    create: async (payload) => {
      submitted.push(payload);
      if (submitted.length === 1) throw new Error("lost response");
    },
    status: async () => {
      if (++polls === 1) throw new Error("offline");
      return { state: "completed" };
    },
    preview: async () => preview,
  };
  const result = await prepareModelSchema(
    transport,
    "same-id",
    new AbortController().signal,
    instant,
  );
  assert.deepEqual(result, { scope, preview });
  assert.deepEqual(submitted, [submitted[0], submitted[0]]);
  assert.equal(submitted[0].requestId, "same-id");
  assert.equal(polls, 2);
});

test("definite rejection is not retried, and cancellation before scope response cannot submit", async () => {
  let calls = 0;
  const transport = {
    scope: async () => scope,
    create: async () => {
      calls++;
      throw new ApiError(409, "stale");
    },
    status: async () => ({ state: "completed" }),
    preview: async () => preview,
  };
  await assert.rejects(prepareModelSchema(transport, "id", new AbortController().signal, instant));
  assert.equal(calls, 1);
  const controller = new AbortController();
  const cancelled = {
    ...transport,
    scope: async () => {
      controller.abort();
      return scope;
    },
  };
  await assert.rejects(
    prepareModelSchema(cancelled, "id", controller.signal, instant),
    /cancelled/,
  );
  assert.equal(calls, 1);
});

test("failed or expired schema tasks cannot produce a preview", async () => {
  let previews = 0;
  const transport = {
    scope: async () => scope,
    create: async () => {},
    status: async () => ({ state: "failed" }),
    preview: async () => {
      previews++;
      return preview;
    },
  };
  await assert.rejects(
    prepareModelSchema(transport, "id", new AbortController().signal, instant),
    /schema unavailable/,
  );
  assert.equal(previews, 0);
});

test("schema preparation reports actual queued and running state before producing a preview",async()=>{
  const stages=[];let calls=0;
  const transport={scope:async()=>scope,create:async()=>{},status:async()=>({state:["queued","running","completed"][calls++]}),preview:async()=>preview};
  await prepareModelSchema(transport,"id",new AbortController().signal,{...instant,onProgress:stage=>stages.push(stage)});
  assert.deepEqual(stages,["checking_access","submitting_schema","waiting_connector","reading_schema","building_preview"]);
});

test("a stalled create is aborted and retried with the original task identity", async () => {
  const attempts = [];
  let timedOutSignal;
  const transport = {
    scope: async () => scope,
    create: (input, signal) => {
      attempts.push(input);
      if (attempts.length === 1) {
        timedOutSignal = signal;
        return new Promise(() => {});
      }
      return Promise.resolve();
    },
    status: async () => ({ state: "completed" }),
    preview: async () => preview,
  };
  const result = await prepareModelSchema(transport, "stable-id", new AbortController().signal, {
    delay: async () => {},
    requestTimeoutMs: 20,
    totalTimeoutMs: 300,
  });
  assert.deepEqual(result, { scope, preview });
  assert.equal(timedOutSignal?.aborted, true);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
});

test("a stalled status request times out and polling can recover", async () => {
  let calls = 0;
  const transport = {
    scope: async () => scope,
    create: async () => {},
    status: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve({ state: "completed" })),
    preview: async () => preview,
  };
  const result = await prepareModelSchema(transport, "id", new AbortController().signal, {
    delay: async () => {},
    requestTimeoutMs: 20,
    totalTimeoutMs: 300,
  });
  assert.deepEqual(result, { scope, preview });
  assert.equal(calls, 2);
});

test("a stalled paid model call times out once without automatic retries", async () => {
  let attempts = 0;
  let operationSignal;
  await assert.rejects(
    withRequestTimeout(new AbortController().signal, 20, (signal) => {
      attempts++;
      operationSignal = signal;
      return new Promise(() => {});
    }),
    /timeout/,
  );
  assert.equal(attempts, 1);
  assert.equal(operationSignal?.aborted, true);
});

test("cancellation settles even when the underlying operation ignores its signal", async () => {
  const controller = new AbortController();
  const pending = withRequestTimeout(controller.signal, 1000, () => new Promise(() => {}));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("a real loopback server that never responds cannot leave scope loading stuck", async () => {
  let requests = 0;
  const server = createServer((_req, _res) => {
    requests++;
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(
      prepareModelSchema(
        modelTransport(`http://127.0.0.1:${address.port}/queries`),
        "synthetic-id",
        new AbortController().signal,
        { requestTimeoutMs: 1000, totalTimeoutMs: 2500 },
      ),
    );
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
