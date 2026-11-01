import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createMcpGrantAuthority,
  type McpGrantRecord,
  type VerifiedMcpToken,
} from "../src/mcp/grant-authority.js";

const resource = "https://platform.example/mcp";
const issuer = "https://platform.example/api/auth";
const token: VerifiedMcpToken = {
  ownerId: "owner",
  clientId: "client",
  issuer,
  audience: [resource],
  scopes: ["metadata:read"],
  expiresAt: 900,
};
const grant: McpGrantRecord = {
  id: "grant",
  ownerId: "owner",
  clientId: "client",
  approvalSessionId: "session",
  resource,
  generation: 2,
  tokenGeneration: 2,
  expiresAt: 800,
  revoked: false,
};

test("MCP token authorization binds actual grant, approval session, final SDK observation and hash", async () => {
  let observedHash = "";
  const authorize = createMcpGrantAuthority(
    {
      observe: async (hash, decide) => {
        observedHash = hash;
        return decide({ grant, sessionExpiresAt: 700 });
      },
    },
    issuer,
    resource,
    () => 100,
  );
  const scopes = ["metadata:read"];
  const result = await authorize("synthetic-token", { ...token, scopes }, async () => ({
    ...token,
    scopes,
  }));
  assert.equal(observedHash, createHash("sha256").update("synthetic-token").digest("hex"));
  assert.deepEqual(result, {
    id: "grant",
    ownerId: "owner",
    clientId: "client",
    approvalSessionId: "session",
    resource,
    generation: 2,
    scopes: ["metadata:read"],
    validUntil: 700,
  });
  scopes.push("query:prepare");
  assert.deepEqual(result?.scopes, ["metadata:read"]);
});

test("MCP authorization rejects mismatches, revocation and changed final claims", async () => {
  for (const changed of [
    { revoked: true },
    { ownerId: "other" },
    { clientId: "other" },
    { generation: 3 },
    { approvalSessionId: "" },
    { resource: "https://other.example/mcp" },
  ]) {
    const authorize = createMcpGrantAuthority(
      {
        observe: async (_hash, decide) =>
          decide({ grant: { ...grant, ...changed }, sessionExpiresAt: 700 }),
      },
      issuer,
      resource,
      () => 100,
    );
    assert.equal(await authorize("token", token, async () => token), null);
  }
  const authorize = createMcpGrantAuthority(
    { observe: async (_hash, decide) => decide({ grant, sessionExpiresAt: 700 }) },
    issuer,
    resource,
    () => 100,
  );
  assert.equal(
    await authorize(
      "token",
      { ...token, audience: [resource, "https://other.example"] },
      async () => token,
    ),
    null,
  );
  assert.equal(
    await authorize("token", token, async () => ({
      ...token,
      scopes: ["metadata:read", "query:prepare"],
    })),
    null,
  );
  assert.equal(await authorize("token", token, async () => null), null);
});

test("MCP authorization cannot outlive grant, session or token while the transaction commits", async () => {
  for (const expiry of ["grant", "session", "token"]) {
    let now = 100;
    const authorize = createMcpGrantAuthority(
      {
        observe: async (_hash, decide) => {
          const result = await decide({
            grant: { ...grant, expiresAt: expiry === "grant" ? 200 : 800 },
            sessionExpiresAt: expiry === "session" ? 200 : 700,
          });
          assert.equal(result, true);
          now = 201;
          return result;
        },
      },
      issuer,
      resource,
      () => now,
    );
    const initial = { ...token, expiresAt: expiry === "token" ? 200 : 900 };
    assert.equal(await authorize("token", initial, async () => initial), null);
  }
});

test("an asynchronous authorization cannot change the initially checked scope", async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const scopes = ["metadata:read"];
  const authorize = createMcpGrantAuthority(
    {
      observe: async (_hash, decide) => {
        entered();
        await paused;
        return decide({ grant, sessionExpiresAt: 700 });
      },
    },
    issuer,
    resource,
    () => 100,
  );
  const pending = authorize("token", { ...token, scopes }, async () => ({ ...token, scopes }));
  await waiting;
  scopes.push("query:prepare");
  unblock();
  assert.equal(await pending, null);
});
