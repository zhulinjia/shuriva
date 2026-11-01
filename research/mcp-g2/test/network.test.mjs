import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { publicModelAddress } from "../../../apps/community-api/dist/src/ai/model-network.js";
import { listenLoopback } from "../dist/loopback-listener.js";
import { guardedFetch } from "../dist/network.js";

async function target(t) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/metadata" });
      res.end();
    } else if (req.url === "/large") {
      res.end("x".repeat(2048));
    } else if (req.url === "/slow") {
      req.on("close", () => res.destroy());
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }
  });
  const port = await listenLoopback(server);
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://g2.synthetic.invalid:${port}`;
  const policy = {
    destinations: ["/mcp", "/redirect", "/large", "/slow", "/oauth-metadata", "/token"].map(
      (value) => `${origin}${value}`,
    ),
    blockedOrigins: [],
    credentialOrigin: origin,
    credentialDestinations: [`${origin}/mcp`],
    privateApprovals: [{ origin, addresses: ["127.0.0.1"] }],
    timeoutMs: 150,
    responseBytes: 1024,
  };
  return { origin, policy, requests: () => requests };
}

test("real native HTTP pins one checked DNS answer; redirects never fetch a second destination", async (t) => {
  const f = await target(t);
  let resolutions = 0;
  const fetch = guardedFetch(f.policy, publicModelAddress, async () => {
    resolutions++;
    return [{ address: "127.0.0.1", family: 4 }];
  });
  assert.deepEqual(await (await fetch(`${f.origin}/mcp`)).json(), { ok: true });
  assert.equal(resolutions, 1);
  await assert.rejects(() => fetch(`${f.origin}/redirect`), /MCP_REDIRECT_REJECTED/);
  assert.equal(f.requests(), 2);
  assert.equal(resolutions, 2);
});

test("mixed DNS, metadata, IPv6, unapproved paths/origins and credential forwarding fail before send", async (t) => {
  const f = await target(t);
  const mixed = guardedFetch(f.policy, publicModelAddress, async () => [
    { address: "127.0.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ]);
  await assert.rejects(() => mixed(`${f.origin}/mcp`), /MCP_ADDRESS_REJECTED/);
  for (const address of ["169.254.169.254", "100.100.100.200", "::ffff:127.0.0.1", "fe80::1"]) {
    const p = { ...f.policy, privateApprovals: [{ origin: f.origin, addresses: [address] }] };
    const fetch = guardedFetch(p, publicModelAddress, async () => [
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await assert.rejects(() => fetch(`${f.origin}/mcp`), /MCP_ADDRESS_REJECTED/);
  }
  const fetch = guardedFetch(f.policy, publicModelAddress, async () => [
    { address: "127.0.0.1", family: 4 },
  ]);
  for (const url of [
    "http://127.0.0.1:3306/mcp",
    `${f.origin}/not-approved`,
    `http://user:secret@${new URL(f.origin).host}/mcp`,
    `${f.origin}/mcp#fragment`,
  ])
    await assert.rejects(() => fetch(url), /MCP_DESTINATION_REJECTED/);
  await assert.rejects(
    () => fetch(`${f.origin}/mcp`, { headers: { cookie: "synthetic=private" } }),
    /MCP_CREDENTIAL_DESTINATION_REJECTED/,
  );
  const restricted = guardedFetch({ ...f.policy, blockedOrigins: [f.origin] }, publicModelAddress);
  await assert.rejects(() => restricted(`${f.origin}/mcp`), /MCP_DESTINATION_REJECTED/);
  assert.equal(f.requests(), 0);
});

test("DNS/body stalls, oversized response and cancellation have bounded failure without replay", async (t) => {
  const f = await target(t);
  const stalled = guardedFetch(f.policy, publicModelAddress, () => new Promise(() => {}));
  await assert.rejects(() => stalled(`${f.origin}/mcp`), /MCP_NETWORK_TIMEOUT/);
  const fetch = guardedFetch(f.policy, publicModelAddress, async () => [
    { address: "127.0.0.1", family: 4 },
  ]);
  const large = await fetch(`${f.origin}/large`);
  await assert.rejects(() => large.text(), /MCP_RESPONSE_LIMIT/);
  await assert.rejects(() => fetch(`${f.origin}/slow`), /MCP_NETWORK_FAILED/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => fetch(`${f.origin}/mcp`, { signal: controller.signal }),
    /MCP_NETWORK_TIMEOUT/,
  );
  assert.equal(f.requests(), 2);
});

test("private address approval cannot become a public destination after DNS changes", async (t) => {
  const f = await target(t);
  assert.equal(publicModelAddress("8.8.8.8", 4), true);
  const fetch = guardedFetch(f.policy, publicModelAddress, async () => [
    { address: "8.8.8.8", family: 4 },
  ]);
  await assert.rejects(() => fetch(`${f.origin}/mcp`), /MCP_ADDRESS_REJECTED/);
  assert.equal(f.requests(), 0);
});

test("exact query-bearing destinations and arbitrary credential headers stay bound to the approved recipient", async (t) => {
  const resource = await target(t),
    issuer = await target(t);
  const destination = `${resource.origin}/mcp?tenant=A`;
  const fetch = guardedFetch(
    {
      ...resource.policy,
      destinations: [destination, `${issuer.origin}/oauth-metadata`],
      credentialDestinations: [destination],
      privateApprovals: [...resource.policy.privateApprovals, ...issuer.policy.privateApprovals],
    },
    publicModelAddress,
    async () => [{ address: "127.0.0.1", family: 4 }],
  );
  assert.equal(
    (await fetch(destination, { headers: { "X-API-Key": "synthetic-key" } })).status,
    200,
  );
  await assert.rejects(
    () =>
      fetch(`${resource.origin}/mcp?tenant=B`, { headers: { authorization: "Bearer synthetic" } }),
    /MCP_DESTINATION_REJECTED/,
  );
  for (const name of ["authorization", "x-api-key", "x-custom-secret"])
    await assert.rejects(
      () => fetch(`${issuer.origin}/oauth-metadata`, { headers: { [name]: "synthetic-private" } }),
      /MCP_CREDENTIAL_DESTINATION_REJECTED/,
    );
  assert.equal((await fetch(`${issuer.origin}/oauth-metadata`)).status, 200);
  assert.equal(resource.requests(), 1);
  assert.equal(issuer.requests(), 1);
});
