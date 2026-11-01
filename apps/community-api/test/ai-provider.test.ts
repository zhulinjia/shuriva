import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { test } from "node:test";
import { modelFetch } from "../src/ai/model-network.js";
import { askModel, modelEndpoint, publicModelAddress } from "../src/ai/provider.js";
import { decodeModelSchema } from "../src/ai/schema.js";

const schema = {
  database: "demo",
  tables: [{ name: "customers", columns: [{ name: "id", type: "int" }] }],
};

async function server(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  return { server: instance, url: `http://127.0.0.1:${address.port}/v1` };
}

test("model request sends only the user question and validated schema to the configured endpoint", async () => {
  let seen = false;
  const fixture = await server(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer test-only-key");
    const request = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: Array<{ content: string }>;
    };
    assert.deepEqual(JSON.parse(request.messages[1]?.content ?? ""), {
      question: "查询客户",
      schema,
    });
    seen = true;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ kind: "clarification", question: "需要哪些字段？" }),
            },
          },
        ],
      }),
    );
  });
  try {
    assert.deepEqual(
      await askModel(
        { baseUrl: fixture.url, model: "fake", apiKey: "test-only-key" },
        "查询客户",
        schema,
      ),
      { kind: "clarification", question: "需要哪些字段？" },
    );
    assert.ok(seen);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("model endpoints reject credentials, private IPs, unsafe schemes and paths", () => {
  for (const url of [
    "http://example.com/v1",
    "https://127.0.0.2/v1",
    "https://10.0.0.1/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?key=secret",
    "file:///etc/passwd",
    "https://example.com/a%2fb",
  ]) {
    assert.throws(() => modelEndpoint(url));
  }
  assert.equal(modelEndpoint("http://localhost:1234/v1").pathname, "/v1/chat/completions");
  for (const [ip, family] of [
    ["127.0.0.1", 4],
    ["169.254.169.254", 4],
    ["10.0.0.1", 4],
    ["::1", 6],
    ["::ffff:127.0.0.1", 6],
    ["2002:0a00:0001::", 6],
    ["2001:db8::1", 6],
  ] as const) {
    assert.equal(publicModelAddress(ip, family), false);
  }
  assert.equal(publicModelAddress("8.8.8.8", 4), true);
});

test("SDK transport rejects a DNS response containing private addresses and unreviewed requests", async () => {
  let lookups = 0;
  const fetch = modelFetch("https://model.example/v1", "test", async () => {
    lookups++;
    return [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
  });
  const init = { method: "POST", headers: { authorization: "Bearer test" }, body: "{}" };
  await assert.rejects(
    fetch("https://model.example/v1/chat/completions", init),
    /INVALID_ENDPOINT/,
  );
  assert.equal(lookups, 1);
  await assert.rejects(
    fetch("https://other.example/v1/chat/completions", init),
    /INVALID_ENDPOINT/,
  );
  await assert.rejects(
    fetch("https://model.example/v1/chat/completions", {
      ...init,
      headers: { authorization: "Bearer wrong" },
    }),
    /INVALID_MODEL_REQUEST/,
  );
  assert.equal(lookups, 1);
});

test("schema decoding rejects extra fields, invented type content and duplicate columns", () => {
  assert.throws(() => decodeModelSchema({ ...schema, password: "secret" }));
  assert.throws(() =>
    decodeModelSchema({
      database: "demo",
      tables: [{ name: "customers", columns: [{ name: "id", type: "enum('secret')" }] }],
    }),
  );
  assert.throws(() =>
    decodeModelSchema({
      database: "demo",
      tables: [
        {
          name: "customers",
          columns: [
            { name: "id", type: "int" },
            { name: "id", type: "int" },
          ],
        },
      ],
    }),
  );
});

test("model redirects and incomplete output are rejected without contacting the redirect", async () => {
  let redirected = false;
  const destination = await server((_req, res) => {
    redirected = true;
    res.end("unexpected");
  });
  const source = await server((_req, res) => {
    res.writeHead(302, { location: destination.url });
    res.end();
  });
  try {
    await assert.rejects(
      askModel({ baseUrl: source.url, model: "fake", apiKey: "test" }, "查询", schema),
      /MODEL_UNAVAILABLE/,
    );
    assert.equal(redirected, false);
  } finally {
    source.server.closeAllConnections();
    destination.server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => source.server.close(() => resolve())),
      new Promise<void>((resolve) => destination.server.close(() => resolve())),
    ]);
  }
  const incomplete = await server((_req, res) =>
    res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{}" } }] })),
  );
  try {
    await assert.rejects(
      askModel({ baseUrl: incomplete.url, model: "fake", apiKey: "test" }, "查询", schema),
      /MODEL_RESPONSE_INVALID/,
    );
  } finally {
    incomplete.server.closeAllConnections();
    await new Promise<void>((resolve) => incomplete.server.close(() => resolve()));
  }
});

test("truncated, oversized and cancelled model responses cannot be mistaken for success", async () => {
  const broken = await server((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"choices":');
    setTimeout(() => res.destroy(), 10);
  });
  try {
    await assert.rejects(
      askModel({ baseUrl: broken.url, model: "fake", apiKey: "test" }, "查询", schema),
      /MODEL_UNAVAILABLE|MODEL_RESPONSE_INVALID/,
    );
  } finally {
    broken.server.closeAllConnections();
    await new Promise<void>((resolve) => broken.server.close(() => resolve()));
  }
  const oversized = await server((_req, res) => {
    res.end("x".repeat(300_000));
  });
  try {
    await assert.rejects(
      askModel({ baseUrl: oversized.url, model: "fake", apiKey: "test" }, "查询", schema),
      /MODEL_RESPONSE_INVALID/,
    );
  } finally {
    oversized.server.closeAllConnections();
    await new Promise<void>((resolve) => oversized.server.close(() => resolve()));
  }
  let started!: () => void;
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stalled = await server((_req, res) => {
    res.writeHead(200);
    res.write("{");
    started();
  });
  const controller = new AbortController();
  try {
    const pending = askModel(
      { baseUrl: stalled.url, model: "fake", apiKey: "test" },
      "查询",
      schema,
      controller.signal,
    );
    await seen;
    controller.abort();
    await assert.rejects(pending, /MODEL_UNAVAILABLE/);
  } finally {
    stalled.server.closeAllConnections();
    await new Promise<void>((resolve) => stalled.server.close(() => resolve()));
  }
  const timeout = await server((_req, res) => {
    res.writeHead(200);
    res.write("{");
  });
  try {
    await assert.rejects(
      askModel(
        { baseUrl: timeout.url, model: "fake", apiKey: "test" },
        "查询",
        schema,
        AbortSignal.timeout(50),
      ),
      /MODEL_UNAVAILABLE/,
    );
  } finally {
    timeout.server.closeAllConnections();
    await new Promise<void>((resolve) => timeout.server.close(() => resolve()));
  }
});

test("the SDK never retries a failed paid request and rejects malformed structured output", async () => {
  let calls = 0;
  const failed = await server((_req, res) => {
    calls++;
    res.statusCode = 503;
    res.end("temporary failure");
  });
  try {
    await assert.rejects(
      askModel({ baseUrl: failed.url, model: "fake", apiKey: "test" }, "查询", schema),
    );
    assert.equal(calls, 1);
  } finally {
    failed.server.closeAllConnections();
    await new Promise<void>((resolve) => failed.server.close(() => resolve()));
  }
  const malformed = await server((_req, res) => {
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ kind: "query", sql: "DELETE FROM customers" }) },
          },
        ],
      }),
    );
  });
  try {
    await assert.rejects(
      askModel({ baseUrl: malformed.url, model: "fake", apiKey: "test" }, "查询", schema),
      /MODEL_RESPONSE_INVALID/,
    );
  } finally {
    malformed.server.closeAllConnections();
    await new Promise<void>((resolve) => malformed.server.close(() => resolve()));
  }
});

test("the transport reports request handoff once and fails closed when the handoff is rejected", async () => {
  let handoffs = 0;
  let requests = 0;
  const fixture = await server((_req, res) => {
    requests++;
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ kind: "clarification", question: "请补充条件" }) },
          },
        ],
      }),
    );
  });
  try {
    await assert.rejects(
      askModel({ baseUrl: fixture.url, model: "fake", apiKey: "test" }, "查询", schema, undefined, {
        beforeRequest: () => {
          throw new Error("expired lease");
        },
      }),
      /MODEL_UNAVAILABLE/,
    );
    assert.equal(requests, 0);
    await askModel(
      { baseUrl: fixture.url, model: "fake", apiKey: "test" },
      "查询",
      schema,
      undefined,
      {
        onRequestSent: () => {
          handoffs++;
        },
      },
    );
    assert.equal(handoffs, 1);
    await assert.rejects(
      askModel({ baseUrl: fixture.url, model: "fake", apiKey: "test" }, "查询", schema, undefined, {
        onRequestSent: () => {
          throw new Error("expired lease");
        },
      }),
      /MODEL_UNAVAILABLE/,
    );
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});
