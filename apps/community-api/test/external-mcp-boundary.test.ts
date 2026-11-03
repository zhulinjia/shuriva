import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { generate } from "selfsigned";
import { decodeJson } from "../src/mcp-client/limits.js";
import {
  abortableAddresses,
  clientFetch,
  type NetworkPolicy,
  validateDestination,
} from "../src/mcp-client/network.js";
import {
  digest,
  snapshotTools,
  validateArguments,
  validateSchema,
} from "../src/mcp-client/tool-policy.js";

const policy = (url: string): NetworkPolicy => ({
  destinations: [url],
  credentialDestinations: [url],
  privateApprovals: [{ origin: new URL(url).origin, addresses: ["127.0.0.1"] }],
  blockedOrigins: [],
  controlPorts: [],
});
test("G4 waiting for DNS is bounded even when the underlying lookup remains outstanding", async () => {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 20);
  try {
    await assert.rejects(abortableAddresses(new Promise(() => {}), abort.signal), /CANCELLED/);
  } finally {
    clearTimeout(timer);
  }
});

test("G4 all DNS answers, private consent, exact credential target and control-plane aliases are checked", () => {
  const raw = "https://public.example/mcp",
    p = { ...policy(raw), privateApprovals: [] };
  assert.throws(
    () =>
      validateDestination(raw, p, [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    /ADDRESS_REJECTED/,
  );
  for (const address of ["169.254.169.254", "100.100.100.200", "0.0.0.0", "::ffff:127.0.0.1"])
    assert.throws(
      () =>
        validateDestination(
          raw,
          { ...p, privateApprovals: [{ origin: new URL(raw).origin, addresses: [address] }] },
          [{ address, family: address.includes(":") ? 6 : 4 }],
        ),
      /REJECTED/,
    );
  assert.throws(
    () =>
      validateDestination(
        "http://example.test:3000/mcp",
        {
          ...policy("http://example.test:3000/mcp"),
          privateApprovals: [{ origin: "http://example.test:3000", addresses: ["127.2.3.4"] }],
          controlPorts: [3000],
        },
        [{ address: "127.2.3.4", family: 4 }],
      ),
    /CONTROL_PLANE/,
  );
  assert.throws(
    () => validateDestination(`${raw}/other`, p, [{ address: "8.8.8.8", family: 4 }]),
    /DESTINATION/,
  );
  assert.throws(
    () =>
      validateDestination(
        "http://public.example/mcp",
        { ...p, destinations: ["http://public.example/mcp"] },
        [{ address: "8.8.8.8", family: 4 }],
      ),
    /HTTPS/,
  );
});
test("G4 bounded schemas reject reference, regex, unsupported dialect and malicious structures; hashes include hints", () => {
  for (const s of [
    { $ref: "https://private.invalid/x" },
    { type: "string", pattern: "(a+)+$" },
    { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
    { type: "object", properties: { x: { format: "email" } } },
  ])
    assert.throws(() => validateSchema(s), /SCHEMA_REJECTED/);
  assert.throws(
    () => decodeJson(Buffer.from(`${"[".repeat(10000)}0${"]".repeat(10000)}`)),
    /STRUCTURE_LIMIT/,
  );
  assert.throws(() => decodeJson(Buffer.from('{"n":1e999}')), /INVALID_JSON/);
  const raw = {
    name: "echo",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { n: { type: "integer", minimum: 0 } },
      required: ["n"],
      additionalProperties: false,
    },
  };
  const tool = snapshotTools([raw])[0];
  assert.ok(tool);
  assert.equal(tool.status, "available");
  validateArguments(tool, { n: 1 });
  assert.throws(() => validateArguments(tool, { n: -1 }), /ARGUMENTS/);
  assert.throws(() => validateArguments(tool, { n: 1, x: "extra" }), /ARGUMENTS/);
  assert.notEqual(
    tool.hash,
    snapshotTools([{ ...raw, annotations: { readOnlyHint: true } }])[0]?.hash,
  );
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
});
test("G4 native HTTP pins DNS, suppresses cookies/redirects and validates CRLF SSE before SDK parsing", async (t) => {
  let mode = "json",
    received = 0;
  const server = createServer((_req, res) => {
    received++;
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      return;
    }
    if (mode === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "canary=secret" });
      res.end('data: {"jsonrpc":"2.0","id":1,"result":{}}\r\n\r\n');
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  const url = `http://pinned.test:${a.port}/mcp`,
    p = policy(url),
    signal = AbortSignal.timeout(10000);
  let guarded = 0;
  const fetchFn = clientFetch(
    p,
    async (send) => {
      guarded++;
      await send(() => {}, signal);
    },
    signal,
    async () => [{ address: "127.0.0.1", family: 4 }],
  );
  assert.equal((await (await fetchFn(url)).json()).ok, true);
  assert.equal(guarded, 1);
  await assert.rejects(fetchFn(url, { headers: { cookie: "private" } }), /CREDENTIAL_DESTINATION/);
  assert.equal(received, 1);
  mode = "redirect";
  await assert.rejects(fetchFn(url), /REDIRECT/);
  assert.equal(received, 2);
  mode = "sse";
  const response = await fetchFn(url);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.match(await response.text(), /"result":\{\}/);
  assert.equal(received, 3);
  await assert.rejects(
    fetchFn(`${url}/unapproved`, { headers: { authorization: "Bearer synthetic" } }),
    /DESTINATION/,
  );
  assert.equal(received, 3);
});
test("G4 failed admission never writes bytes to the approved endpoint", async (t) => {
  let received = 0,
    connections = 0;
  const s = createServer((_q, r) => {
    received++;
    r.end("{}");
  });
  s.on("connection", () => {
    connections++;
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  const a = s.address();
  assert.ok(a && typeof a !== "string");
  const url = `http://127.0.0.1:${a.port}/mcp`;
  const f = clientFetch(
    policy(url),
    async () => {
      throw Error("admission revoked");
    },
    AbortSignal.timeout(1000),
  );
  await assert.rejects(f(url, { method: "POST", body: "{}" }), /admission revoked/);
  assert.equal(received, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(connections, 0);
});

test("G4 a lost admission lease cancels a not-yet-flushed HTTP request independently of the caller signal", async (t) => {
  let received = 0;
  const s = createServer((_q, r) => {
    received++;
    r.end("{}");
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  const a = s.address();
  assert.ok(a && typeof a !== "string");
  const url = `http://127.0.0.1:${a.port}/mcp`,
    lease = new AbortController();
  const f = clientFetch(
    policy(url),
    async (send) => {
      const work = send(() => lease.signal.throwIfAborted(), lease.signal);
      queueMicrotask(() => lease.abort());
      await work;
    },
    AbortSignal.timeout(5000),
  );
  await assert.rejects(f(url, { method: "POST", body: "{}" }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(received, 0);
});

test("G4 HTTPS keeps certificate hostname verification while pinning the approved IP", {
  timeout: 20000,
}, async (t) => {
  const cert = await generate([{ name: "commonName", value: "pinned.test" }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "pinned.test" }] }],
  });
  let received = 0;
  const server = httpsServer({ cert: cert.cert, key: cert.private }, (q, r) => {
    received++;
    assert.equal(q.headers.authorization, "Bearer synthetic");
    r.setHeader("content-type", "application/json");
    r.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const root = await mkdtemp(join(tmpdir(), "shuriva-g4-tls-")),
    ca = join(root, "ca.pem");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(ca, cert.cert, { flag: "wx" });
  const script = `import assert from 'node:assert/strict';import {clientFetch} from ${JSON.stringify(new URL("../src/mcp-client/network.js", import.meta.url).href)};const port=process.argv[1];for(const host of ['pinned.test','wrong.test']){const url='https://'+host+':'+port+'/mcp';const p={destinations:[url],credentialDestinations:[url],privateApprovals:[{origin:new URL(url).origin,addresses:['127.0.0.1']}],blockedOrigins:[],controlPorts:[]};const f=clientFetch(p,send=>send(()=>{},AbortSignal.timeout(5000)),AbortSignal.timeout(5000),async()=>[{address:'127.0.0.1',family:4}]);if(host==='pinned.test')assert.equal((await(await f(url,{headers:{authorization:'Bearer synthetic'}})).json()).ok,true);else await assert.rejects(f(url,{headers:{authorization:'Bearer synthetic'}}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});}console.log('TLS pinning and hostname verification passed');`;
  const output = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script, String(addr.port)],
    {
      env: { SYSTEMROOT: process.env.SystemRoot ?? "", NODE_EXTRA_CA_CERTS: ca },
      windowsHide: true,
      timeout: 12000,
      maxBuffer: 2048,
    },
  );
  assert.match(output.stdout, /verification passed/);
  assert.equal(received, 1);
});
