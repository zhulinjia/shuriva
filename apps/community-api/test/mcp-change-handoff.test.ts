import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ScopeCoordinator } from "../src/datasources/public.js";
import type { AuthorizedMcpGrant, HandoffReceipt } from "../src/mcp/grant-authority.js";
import { McpInvocations } from "../src/mcp/invocations.js";
import { delegatedTablesSchema, type GrantView, McpError } from "../src/mcp/model.js";
import type { McpStore } from "../src/mcp/store.js";
import type { DelegatedRead } from "../src/queries/public.js";

function fixture(enabled = true) {
  const ownerId = randomUUID(),
    sessionId = randomUUID(),
    workspaceId = randomUUID(),
    sourceId = randomUUID(),
    connectorId = randomUUID(),
    grantId = randomUUID();
  const grant: GrantView = {
    id: grantId,
    ownerId,
    clientId: "synthetic-client",
    approvalSessionId: sessionId,
    workspaceId,
    sourceId,
    connectorId,
    tables: [["orders", ["id", "label"]]],
    scopes: ["change:propose", "operation:read"],
    generation: 1,
    expiresAt: Date.now() + 60000,
    revoked: false,
  };
  const token: AuthorizedMcpGrant = {
    id: grantId,
    ownerId,
    clientId: grant.clientId,
    approvalSessionId: sessionId,
    resource: "http://127.0.0.1:43131/mcp",
    generation: 1,
    scopes: grant.scopes,
    validUntil: grant.expiresAt,
  };
  const records = new Map<string, Record<string, unknown>>();
  let active = true;
  let bindingGeneration = randomUUID();
  let expireDuringReceipt = false;
  let receiptWait: Promise<void> | undefined;
  let receiptEntered: (() => void) | undefined;
  const store = {
    active: async (owner: string, id: string) => {
      if (!active || owner !== ownerId || id !== grantId)
        throw new McpError("MCP_GRANT_REJECTED", 403);
      return grant;
    },
    client: async (owner: string, id: string) =>
      owner === ownerId && id === grant.clientId ? { mode: "http", clientId: id } : undefined,
    invocation: async (owner: string, id: string) => {
      const row = records.get(id);
      return row?.ownerId === owner ? { ...row } : null;
    },
    reserve: async (
      owner: string,
      id: string,
      generation: number,
      requestId: string,
      commitment: string,
      bootId: string,
      tool: string,
    ) => {
      if (records.has(requestId)) throw Error("duplicate");
      records.set(requestId, {
        id: requestId,
        ownerId: owner,
        grantId: id,
        generation,
        commitment,
        bootId,
        tool,
        state: "pending_approval",
        approvalSessionId: null,
        taskId: null,
        taskNonce: null,
      });
    },
    transition: async (owner: string, id: string, from: string, to: string, session: string) => {
      const row = records.get(id);
      if (!row || row.ownerId !== owner || row.state !== from) return false;
      row.state = to;
      row.approvalSessionId = session;
      return true;
    },
    acknowledgeHandoff: async (input: {
      ownerId: string;
      id: string;
      grantId: string;
      generation: number;
      commitment: string;
      bootId: string;
      sessionId: string;
    }) => {
      const row = records.get(input.id);
      if (
        !row ||
        row.ownerId !== input.ownerId ||
        row.grantId !== input.grantId ||
        row.generation !== input.generation ||
        row.commitment !== input.commitment ||
        row.bootId !== input.bootId ||
        row.approvalSessionId !== input.sessionId ||
        row.state !== "handoff_unknown" ||
        row.tool !== "change_propose"
      )
        return false;
      if (expireDuringReceipt) {
        active = false;
        return true;
      }
      receiptEntered?.();
      if (receiptWait) await receiptWait;
      return true;
    },
    finishInvocation: async () => {},
  } as unknown as McpStore & { acknowledgeHandoff: HandoffReceipt };
  const coordinator = {
    withScope: async (
      _scope: unknown,
      work: (binding: { connectorId: string; bindingGeneration: string }) => Promise<unknown>,
    ) => work({ connectorId, bindingGeneration }),
    withBoundIdentity: async (
      _scope: unknown,
      work: (binding: { connectorId: string; bindingGeneration: string }) => Promise<unknown>,
    ) => work({ connectorId, bindingGeneration }),
  } as unknown as ScopeCoordinator;
  const authorize = async () => {
    if (!active) throw new McpError("MCP_GRANT_REJECTED", 403);
    return token;
  };
  const withAuthorization = async <T>(
    _headers: unknown,
    work: (
      token: AuthorizedMcpGrant,
      check: () => void,
      signal: AbortSignal,
      receipt?: HandoffReceipt,
    ) => Promise<T>,
    adminSession?: string,
  ) => {
    if (adminSession !== sessionId) throw new McpError("MCP_SESSION_EXPIRED", 403);
    const check = () => {
      if (!active) throw new McpError("MCP_GRANT_REJECTED", 403);
    };
    check();
    return work(token, check, new AbortController().signal, store.acknowledgeHandoff);
  };
  const service = new McpInvocations(
    store,
    randomBytes(32),
    {} as DelegatedRead,
    coordinator,
    authorize,
    "http://127.0.0.1:43129",
    withAuthorization,
    async () => {},
    async () => {},
    enabled,
  );
  const input = {
    requestId: randomUUID(),
    workspaceId,
    sourceId,
    plan: {
      operation: "update",
      table: "orders",
      changes: [{ column: "label", value: { kind: "string", value: "synthetic-canary" } }],
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    },
  };
  return {
    service,
    input,
    token,
    grant,
    ownerId,
    sessionId,
    records,
    revoke: () => {
      active = false;
    },
    expireDuringReceipt: () => {
      expireDuringReceipt = true;
    },
    holdReceipt: (wait: Promise<void>, entered: () => void) => {
      receiptWait = wait;
      receiptEntered = entered;
    },
    rebind: () => {
      bindingGeneration = randomUUID();
    },
  };
}

test("change drafts are disabled in the ordinary composition", async (t) => {
  const f = fixture(false);
  t.after(() => f.service.close());
  await assert.rejects(
    f.service.prepareChange(f.token, { authorization: "Bearer synthetic" }, f.input),
    /MCP_WRITES_DISABLED/,
  );
  assert.equal(f.records.size, 0);
});

test("large valid grants do not consume the bounded change draft handoff", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  for (let table = 0; table < 55; table++)
    f.grant.tables.push([
      `table_${table}`,
      Array.from({ length: 5 }, (_, col) => `column_${col}_${"x".repeat(50)}`),
    ]);
  delegatedTablesSchema.parse(f.grant.tables);
  const input = {
    ...f.input,
    plan: {
      ...f.input.plan,
      changes: [{ column: "label", value: { kind: "string", value: "x".repeat(16000) } }],
    },
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(f.grant.tables)) + Buffer.byteLength(JSON.stringify(input)) >
      32768,
  );
  const result = await f.service.prepareChange(
    f.token,
    { authorization: "Bearer synthetic" },
    input,
  );
  assert.equal(result.state, "approval_required");
});

test("authorization expiry during receipt update is checked before returning success", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const prepared = await f.service.prepareChange(
    f.token,
    { authorization: "Bearer synthetic" },
    f.input,
  );
  const row = f.records.get(prepared.id);
  assert.ok(row);
  let receipt = "";
  const who = { ownerId: f.ownerId, sessionId: f.sessionId };
  await f.service.claimChange(who, prepared.id, String(row.commitment), async (value) => {
    assert.ok(
      value && typeof value === "object" && "receipt" in value && typeof value.receipt === "string",
    );
    receipt = value.receipt;
  });
  f.expireDuringReceipt();
  await assert.rejects(
    f.service.acknowledgeChange(who, prepared.id, receipt),
    /MCP_GRANT_REJECTED/,
  );
  assert.equal(row.state, "handoff_unknown");
  assert.throws(
    () =>
      f.service.verifyChangeOrigin({
        id: prepared.id,
        ...who,
        workspaceId: f.input.workspaceId,
        sourceId: f.input.sourceId,
        plan: f.input.plan,
      }),
    /MCP_CHANGE_ORIGIN_UNAVAILABLE/,
  );
});
test("a receipt removed while its database lock waits cannot be acknowledged", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const prepared = await f.service.prepareChange(
    f.token,
    { authorization: "Bearer synthetic" },
    f.input,
  );
  const row = f.records.get(prepared.id);
  assert.ok(row);
  const who = { ownerId: f.ownerId, sessionId: f.sessionId };
  let receipt = "";
  await f.service.claimChange(who, prepared.id, String(row.commitment), async (value) => {
    assert.ok(
      value && typeof value === "object" && "receipt" in value && typeof value.receipt === "string",
    );
    receipt = value.receipt;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.holdReceipt(gate, entered);
  const attempt = f.service.acknowledgeChange(who, prepared.id, receipt);
  await waiting;
  await assert.rejects(
    f.service.acknowledgeChange(who, prepared.id, receipt),
    /MCP_RECEIPT_REJECTED/,
  );
  f.service.close();
  release();
  await assert.rejects(attempt, /MCP_RECEIPT_REJECTED/);
  assert.equal(row.state, "handoff_unknown");
});
test("draft claim is owned, single-use and records unknown instead of guessing browser receipt", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const prepared = await f.service.prepareChange(
      f.token,
      { authorization: "Bearer synthetic" },
      f.input,
    ),
    id = prepared.id;
  const row = f.records.get(id);
  assert.ok(row);
  const commitment = String(row.commitment);
  assert.equal(JSON.stringify([...f.records.values()]).includes("synthetic-canary"), false);
  const who = { ownerId: f.ownerId, sessionId: f.sessionId };
  await assert.rejects(
    f.service.claimChange(
      { ownerId: randomUUID(), sessionId: randomUUID() },
      id,
      commitment,
      async () => assert.fail(),
    ),
    /NOT_FOUND/,
  );
  let entered: () => void = () => {},
    release: () => void = () => {},
    sent = 0,
    receipt = "";
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const first = f.service.claimChange(who, id, commitment, async (value, check) => {
    check();
    assert.ok(
      value && typeof value === "object" && "receipt" in value && typeof value.receipt === "string",
    );
    receipt = value.receipt;
    sent++;
    entered();
    await gate;
    check();
  });
  await reached;
  await assert.rejects(
    f.service.claimChange(who, id, commitment, async () => assert.fail()),
    /MCP_APPROVAL_STALE/,
  );
  release();
  await first;
  assert.equal(sent, 1);
  assert.equal(row.state, "handoff_unknown");
  await assert.rejects(
    f.service.claimChange(who, id, commitment, async () => assert.fail()),
    /MCP_APPROVAL_EXPIRED/,
  );
  await assert.rejects(
    f.service.acknowledgeChange({ ...who, sessionId: randomUUID() }, id, receipt),
    /MCP_RECEIPT_REJECTED/,
  );
  await f.service.acknowledgeChange(who, id, receipt);
  assert.equal(row.state, "handoff_unknown");
  assert.throws(
    () =>
      f.service.verifyChangeOrigin({
        id,
        ...who,
        sessionId: randomUUID(),
        workspaceId: f.input.workspaceId,
        sourceId: f.input.sourceId,
        plan: f.input.plan,
      }),
    /MCP_CHANGE_ORIGIN_UNAVAILABLE/,
  );
  assert.equal(
    f.service.verifyChangeOrigin({
      id,
      ...who,
      workspaceId: f.input.workspaceId,
      sourceId: f.input.sourceId,
      plan: f.input.plan,
    }).invocationId,
    id,
  );
  await assert.rejects(f.service.acknowledgeChange(who, id, receipt), /MCP_RECEIPT_REJECTED/);
});
test("a draft cannot be disclosed after the same source is unbound and rebound", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const prepared = await f.service.prepareChange(
    f.token,
    { authorization: "Bearer synthetic" },
    f.input,
  );
  f.rebind();
  await assert.rejects(
    f.service.reviewChange({ ownerId: f.ownerId, sessionId: f.sessionId }, prepared.id, async () =>
      assert.fail("must not disclose"),
    ),
    /MCP_BINDING_CHANGED/,
  );
});

test("rebind between claiming and receiving a draft cannot create origin provenance", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const prepared = await f.service.prepareChange(
    f.token,
    { authorization: "Bearer synthetic" },
    f.input,
  );
  const who = { ownerId: f.ownerId, sessionId: f.sessionId };
  let receipt = "";
  await f.service.claimChange(
    who,
    prepared.id,
    String(f.records.get(prepared.id)?.commitment),
    async (value) => {
      assert.ok(
        value &&
          typeof value === "object" &&
          "receipt" in value &&
          typeof value.receipt === "string",
      );
      receipt = value.receipt;
    },
  );
  f.rebind();
  await assert.rejects(
    f.service.acknowledgeChange(who, prepared.id, receipt),
    /MCP_BINDING_CHANGED/,
  );
  assert.throws(
    () =>
      f.service.verifyChangeOrigin({
        id: prepared.id,
        ...who,
        workspaceId: f.input.workspaceId,
        sourceId: f.input.sourceId,
        plan: f.input.plan,
      }),
    /MCP_CHANGE_ORIGIN_UNAVAILABLE/,
  );
});
test("revocation before actual disclosure preserves an unknown outcome and never publishes the draft", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const prepared = await f.service.prepareChange(
      f.token,
      { authorization: "Bearer synthetic" },
      f.input,
    ),
    row = f.records.get(prepared.id);
  assert.ok(row);
  let published = false;
  await assert.rejects(
    f.service.claimChange(
      { ownerId: f.ownerId, sessionId: f.sessionId },
      prepared.id,
      String(row.commitment),
      async (_value, check) => {
        f.revoke();
        check();
        published = true;
      },
    ),
    /MCP_GRANT_REJECTED/,
  );
  assert.equal(published, false);
  assert.equal(row.state, "handoff_unknown");
});

test("receipt cannot complete a handoff after the grant is revoked", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const prepared = await f.service.prepareChange(
    f.token,
    { authorization: "Bearer synthetic" },
    f.input,
  );
  const row = f.records.get(prepared.id);
  assert.ok(row);
  let receipt = "";
  const who = { ownerId: f.ownerId, sessionId: f.sessionId };
  await f.service.claimChange(who, prepared.id, String(row.commitment), async (value) => {
    assert.ok(
      value && typeof value === "object" && "receipt" in value && typeof value.receipt === "string",
    );
    receipt = value.receipt;
  });
  f.revoke();
  await assert.rejects(
    f.service.acknowledgeChange(who, prepared.id, receipt),
    /MCP_GRANT_REJECTED/,
  );
  assert.equal(row.state, "handoff_unknown");
});

test("lost handoff response leaves unknown state and never resends the draft", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const prepared = await f.service.prepareChange(
    f.token,
    { authorization: "Bearer synthetic" },
    f.input,
  );
  const row = f.records.get(prepared.id);
  assert.ok(row);
  const who = { ownerId: f.ownerId, sessionId: f.sessionId };
  let attempts = 0;
  await assert.rejects(
    f.service.claimChange(who, prepared.id, String(row.commitment), async () => {
      attempts++;
      throw Error("synthetic connection closed");
    }),
    /connection closed/,
  );
  assert.equal(row.state, "handoff_unknown");
  await assert.rejects(
    f.service.claimChange(who, prepared.id, String(row.commitment), async () => {
      attempts++;
    }),
    /MCP_APPROVAL_EXPIRED/,
  );
  assert.equal(attempts, 1);
});
