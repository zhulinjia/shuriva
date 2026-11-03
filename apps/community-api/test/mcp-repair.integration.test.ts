import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mcpFixture } from "./mcp-fixture.js";
import { authMutationIdentity } from "../src/auth.js";
import type { McpAudit } from "../src/mcp/model.js";
import { McpInvocations } from "../src/mcp/invocations.js";
const enabled = process.env.STAGE9_G3_TEST === "1";
test("cleanup racing an acknowledged binding cannot reactivate the job", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  await f.runtime.invocations.prepare(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  });
  const review = await f.runtime.invocations.review(f.identity, id),
    bind = f.runtime.store.bindJob.bind(f.runtime.store),
    verify = f.runtime.oauth.verify.bind(f.runtime.oauth);
  let reached!: () => void, resume!: () => void;
  const atBinding = new Promise<void>((r) => {
      reached = r;
    }),
    gate = new Promise<void>((r) => {
      resume = r;
    });
  f.runtime.store.bindJob = async (...args) => {
    const result = await bind(...args);
    reached();
    await gate;
    return result;
  };
  const approved = f.runtime.invocations
    .approve(f.identity, id, String(review.commitment), true)
    .then(
      () => true,
      () => false,
    );
  try {
    await atBinding;
    const row = await f.runtime.store.invocation(f.identity.ownerId, id);
    assert.ok(row?.taskId);
    f.runtime.oauth.verify = async () => {
      throw Error("synthetic authorization outage");
    };
    let cancelled = false;
    // An already-started observation can be waiting behind the held approval
    // transaction. Include its bounded IO deadline plus the next sweep tick;
    // this test proves late-binding safety, not a three-second latency target.
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if (f.reads.jobs.status(f.binding, String(row.taskId))?.state === "cancelled") {
        cancelled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(cancelled, true);
    f.runtime.oauth.verify = verify;
    resume();
    assert.equal(await approved, false);
    assert.equal(await f.reads.next(f.binding.connectorId), null);
  } finally {
    f.runtime.store.bindJob = bind;
    f.runtime.oauth.verify = verify;
    resume();
    await approved;
  }
});

test("a captured result cannot be published after invocation expiry while the grant remains valid", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  await f.runtime.invocations.prepare(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  });
  const review = await f.runtime.invocations.review(f.identity, id);
  await f.runtime.invocations.approve(f.identity, id, String(review.commitment), true);
  const task = await f.reads.next(f.binding.connectorId);
  assert.ok(task && "id" in task);
  f.reads.jobs.complete(
    f.binding,
    task.id,
    "ok",
    Buffer.from(
      JSON.stringify({
        columns: [{ name: "id", type: "int" }],
        rows: [],
        timezone: "UTC",
        truncated: false,
      }),
    ).toString("base64url"),
  );
  const result = await f.runtime.invocations.status(subject, id);
  assert.equal(result.resultAvailable, true);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    t.mock.timers.tick(121000);
    assert.ok(await f.runtime.oauth.verify(headers));
    let sent = false;
    await assert.rejects(() =>
      f.runtime.invocations.publish(
        subject,
        headers,
        "operation:read",
        id,
        async () => {
          sent = true;
        },
        "operation_status",
        randomUUID(),
        result,
      ),
    );
    assert.equal(sent, false);
  } finally {
    t.mock.timers.reset();
  }
});
test("a slow peer and failed metadata writes cannot delay independent cancellation", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers);
  const signed = await f.auth.api.signInUsername({
      body: { username: f.username, password: f.password },
      returnHeaders: true,
    }),
    cookie = signed.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; "),
    other = await authMutationIdentity(f.auth)({ cookie });
  assert.ok(other);
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    await f.runtime.invocations.prepare(subject, headers, {
      requestId: id,
      workspaceId: f.scope.workspaceId,
      sourceId: f.scope.sourceId,
      sql: "SELECT id FROM customers",
      parameters: [],
      maxRows: 10,
      schemaVersion: null,
    });
    const who = index === 0 ? f.identity : other,
      view = await f.runtime.invocations.review(who, id);
    await f.runtime.invocations.approve(who, id, String(view.commitment), true);
    const task = await f.reads.next(f.binding.connectorId);
    assert.ok(task && "id" in task);
    if (index === 0)
      f.reads.jobs.complete(
        f.binding,
        task.id,
        "ok",
        Buffer.from(
          JSON.stringify({
            columns: [{ name: "id", type: "int" }],
            rows: [],
            timezone: "UTC",
            truncated: false,
          }),
        ).toString("base64url"),
      );
  }
  const row = await f.runtime.store.invocation(f.identity.ownerId, ids[1] ?? "");
  assert.ok(row?.taskId);
  const verify = f.runtime.oauth.verify.bind(f.runtime.oauth),
    finish = f.runtime.store.finishInvocation.bind(f.runtime.store);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.runtime.oauth.verify = async (h) => {
    await gate;
    return verify(h);
  };
  f.runtime.store.finishInvocation = async () => {
    throw Error("synthetic metadata outage");
  };
  try {
    await f.auth.api.signOut({ headers: new Headers({ cookie }) });
    let cancelled = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const work = f.reads.jobs.claim(f.binding.connectorId);
      if (work?.type === "cancel" && work.task.taskId === row.taskId) {
        cancelled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(cancelled, true);
  } finally {
    f.runtime.oauth.verify = verify;
    f.runtime.store.finishInvocation = finish;
    release();
  }
});

test("metadata-only schema status, correlated recipient audit, and failed-code isolation", {
  skip: !enabled,
  timeout: 40000,
}, async (t) => {
  const events: Parameters<McpAudit>[] = [];
  let available = true;
  const f = await mcpFixture("http", async (...args) => {
    if (!available) throw Error("synthetic audit unavailable");
    events.push(args);
  });
  t.after(() => f.close());
  f.scope.scopes = ["metadata:read"];
  assert.equal((await f.request("/api/mcp/grants", f.scope)).status, 201);
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await fetch(`${f.origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: "invalid-code",
            code_verifier: "a".repeat(43),
            client_id: f.client.clientId,
            redirect_uri: "http://127.0.0.1:19492/callback",
            resource: f.resource,
          }),
        })
      ).status,
      400,
    );
  const token = await f.token(),
    client = new Client(
      { name: "metadata-only", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.resource), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("operation_status"));
  assert.equal(tools.includes("query_prepare"), false);
  const listed = await client.callTool({ name: "workspaces_list", arguments: {} });
  assert.equal(listed.isError, undefined);
  const listEvents = events.filter((e) => e[2]?.name === "workspaces_list");
  assert.equal(listEvents.length, 2);
  assert.equal(listEvents[0]?.[1], listEvents[1]?.[1]);
  assert.equal(listEvents[0]?.[2]?.clientId, f.client.clientId);
  assert.ok(listEvents[0]?.[2]?.grantId);
  const id = randomUUID();
  assert.equal(
    (await client.callTool({ name: "schema_get", arguments: { requestId: id } })).isError,
    undefined,
  );
  assert.equal(
    (await client.callTool({ name: "operation_status", arguments: { id } })).isError,
    undefined,
  );
  const schemaEvents = events.filter((e) => e[2]?.name === "schema_get");
  assert.equal(schemaEvents.length, 2);
  assert.ok(schemaEvents.every((e) => e[2]?.invocationId === id));
  assert.equal(schemaEvents[0]?.[1], schemaEvents[1]?.[1]);
  await client.callTool({ name: "operation_status", arguments: { id } });
  const polls = events.filter(
    (e) => e[2]?.name === "operation_status" && e[2]?.phase === "requested",
  );
  assert.equal(polls.length, 2);
  assert.notEqual(polls[0]?.[1], polls[1]?.[1]);
  assert.ok(polls.every((e) => e[2]?.invocationId === id));
  available = false;
  assert.equal((await client.callTool({ name: "workspaces_list", arguments: {} })).isError, true);
});

test("actual approving session is held through dispatch and logout cancels without client polling", {
  skip: !enabled,
  timeout: 40000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers);
  const signed = await f.auth.api.signInUsername({
      body: { username: f.username, password: f.password },
      returnHeaders: true,
    }),
    cookie = signed.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; "),
    approver = await authMutationIdentity(f.auth)({ cookie });
  assert.ok(approver);
  const id = randomUUID();
  await f.runtime.invocations.prepare(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  });
  const review = await f.runtime.invocations.review(approver, id);
  await f.runtime.invocations.approve(approver, id, String(review.commitment), true);
  let entered!: () => void, finish!: () => void;
  const reached = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      finish = r;
    });
  f.setSigner(async (task) => {
    entered();
    await gate;
    return { ...task, protocol: 1, signature: "fixture-signature" };
  });
  let published!: () => void, finishPublication!: () => void;
  const atPublication = new Promise<void>((r) => {
      published = r;
    }),
    publicationGate = new Promise<void>((r) => {
      finishPublication = r;
    });
  const dispatch = f.reads.next(f.binding.connectorId, async (_task, assertActive, signal) => {
    assertActive();
    signal?.throwIfAborted();
    published();
    await publicationGate;
  });
  await reached;
  let loggedOut = false;
  const logout = f.auth.api.signOut({ headers: new Headers({ cookie }) }).then(() => {
    loggedOut = true;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(loggedOut, false);
  finish();
  await atPublication;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(loggedOut, false);
  finishPublication();
  assert.ok(await dispatch);
  await logout;
  const deadline = Date.now() + 5000;
  let cancelled = false;
  while (Date.now() < deadline) {
    const next = f.reads.jobs.claim(f.binding.connectorId);
    if (next?.type === "cancel") {
      cancelled = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(cancelled, true);
  assert.ok(await f.runtime.oauth.verify(headers));
});

test("stalled cleanup writes cannot occupy authorization monitoring slots", {
  skip: !enabled,
  timeout: 40000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers);
  const signed = await f.auth.api.signInUsername({
    body: { username: f.username, password: f.password },
    returnHeaders: true,
  });
  const cookie = signed.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; "),
    other = await authMutationIdentity(f.auth)({ cookie });
  assert.ok(other);
  const finish = f.runtime.store.finishInvocation.bind(f.runtime.store);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let writes = 0;
  f.runtime.store.finishInvocation = async (i) => {
    writes++;
    await gate;
    return finish(i);
  };
  const input = {
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  };
  try {
    for (let i = 0; i < 8; i++) {
      const id = randomUUID();
      await f.runtime.invocations.prepare(subject, headers, { ...input, requestId: id });
      await f.runtime.invocations.cancel(subject, id);
      assert.equal((await f.runtime.invocations.status(subject, id)).state, "cancelled");
    }
    assert.equal(writes, 2);
    assert.equal(f.runtime.invocations.cleanupHealth().pending, 8);
    const id = randomUUID();
    await f.runtime.invocations.prepare(subject, headers, { ...input, requestId: id });
    const view = await f.runtime.invocations.review(other, id);
    await f.runtime.invocations.approve(other, id, String(view.commitment), true);
    const task = await f.reads.next(f.binding.connectorId);
    assert.ok(task && "id" in task);
    await f.auth.api.signOut({ headers: new Headers({ cookie }) });
    const until = Date.now() + 3500;
    let cancelled = false;
    while (Date.now() < until) {
      const work = f.reads.jobs.claim(f.binding.connectorId);
      if (work?.type === "cancel" && work.task.taskId === task.id) {
        cancelled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(cancelled, true);
    assert.equal(writes, 2);
    assert.equal(f.reads.jobs.executionState(f.binding, task.id)?.state, "outcome_unknown");
  } finally {
    f.runtime.store.finishInvocation = finish;
    release();
    const until = Date.now() + 2500;
    while (f.runtime.invocations.cleanupHealth().pending && Date.now() < until)
      await new Promise((r) => setTimeout(r, 30));
  }
});

test("shutdown owns pending reservation and prevents late approval registration", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  const reserve = f.runtime.store.reserve.bind(f.runtime.store);
  let reached!: () => void, resume!: () => void;
  const entered = new Promise<void>((r) => {
      reached = r;
    }),
    gate = new Promise<void>((r) => {
      resume = r;
    });
  f.runtime.store.reserve = async (...args) => {
    reached();
    await gate;
    return reserve(...args);
  };
  const prepared = f.runtime.invocations
    .prepare(subject, headers, {
      requestId: id,
      workspaceId: f.scope.workspaceId,
      sourceId: f.scope.sourceId,
      sql: "SELECT id FROM customers",
      parameters: [],
      maxRows: 10,
      schemaVersion: null,
    })
    .then(
      () => true,
      () => false,
    );
  try {
    await entered;
    f.runtime.invocations.close();
    resume();
    assert.equal(await prepared, false);
    await assert.rejects(() => f.runtime.invocations.review(f.identity, id));
    const until = Date.now() + 2500;
    let state: unknown;
    while (Date.now() < until) {
      state = (await f.runtime.store.invocation(f.identity.ownerId, id))?.state;
      if (state === "expired") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(state, "expired");
    assert.equal(await f.reads.next(f.binding.connectorId), null);
  } finally {
    resume();
    await prepared;
    f.runtime.store.reserve = reserve;
  }
});

test("captured schema result is invalidated before publication and final send", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  await f.runtime.invocations.schema(subject, headers, id);
  const task = await f.reads.next(f.binding.connectorId);
  assert.ok(task && "id" in task);
  const schema = {
    database: "isolated",
    tables: [
      {
        name: "customers",
        columns: [{ name: "id", type: "int" }],
        version: "a".repeat(64),
        structureHash: "b".repeat(64),
      },
    ],
  };
  assert.equal(
    f.reads.jobs.complete(
      f.binding,
      task.id,
      "ok",
      Buffer.from(JSON.stringify(schema)).toString("base64url"),
    ),
    true,
  );
  const captured = await f.runtime.invocations.status(subject, id);
  assert.equal(captured.resultAvailable, true);
  await f.runtime.invocations.publish(
    subject,
    headers,
    "operation:read",
    id,
    async (check) => {
      check();
      f.reads.jobs.cancelModelMatching(f.identity.ownerId, f.scope.workspaceId, f.scope.sourceId);
      assert.throws(check, /MCP_RESULT_EXPIRED/);
    },
    "operation_status",
    randomUUID(),
    captured,
  );
  let sent = false;
  await assert.rejects(() =>
    f.runtime.invocations.publish(
      subject,
      headers,
      "operation:read",
      id,
      async () => {
        sent = true;
      },
      "operation_status",
      randomUUID(),
      captured,
    ),
  );
  assert.equal(sent, false);
});

test("rejection erases authority before another metadata lookup and retries project the latched state", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  const input = {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  };
  await f.runtime.invocations.prepare(subject, headers, input);
  const view = await f.runtime.invocations.review(f.identity, id),
    lookup = f.runtime.store.invocation.bind(f.runtime.store),
    finish = f.runtime.store.finishInvocation.bind(f.runtime.store);
  let lookups = 0,
    resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  f.runtime.store.invocation = async (...args) => {
    lookups++;
    if (lookups > 1) throw Error("unexpected second rejection lookup");
    return lookup(...args);
  };
  f.runtime.store.finishInvocation = async (intent) => {
    await gate;
    return finish(intent);
  };
  try {
    await f.runtime.invocations.approve(f.identity, id, String(view.commitment), false);
    assert.equal(lookups, 1);
    f.runtime.store.invocation = lookup;
    assert.equal((await f.runtime.invocations.prepare(subject, headers, input)).state, "cancelled");
    assert.equal((await f.runtime.invocations.status(subject, id)).state, "cancelled");
    assert.equal(
      (await f.runtime.invocations.list(f.identity.ownerId)).find((r) => r.id === id)?.state,
      "cancelled",
    );
    await assert.rejects(() => f.runtime.invocations.review(f.identity, id));
  } finally {
    f.runtime.store.invocation = lookup;
    f.runtime.store.finishInvocation = finish;
    resume();
    await f.runtime.invocations.settleCleanup();
  }
});

test("deadline cleanup runs even when all eight authorization monitor slots are stalled", {
  skip: !enabled,
  timeout: 40000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    ids = Array.from({ length: 9 }, () => randomUUID());
  const input = {
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  };
  for (const id of ids)
    await f.runtime.invocations.prepare(subject, headers, { ...input, requestId: id });
  const last = ids.at(-1);
  assert.ok(last);
  const view = await f.runtime.invocations.review(f.identity, last);
  await f.runtime.invocations.approve(f.identity, last, String(view.commitment), true);
  assert.ok(await f.reads.next(f.binding.connectorId));
  const verify = f.runtime.oauth.verify.bind(f.runtime.oauth);
  let calls = 0,
    resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  f.runtime.oauth.verify = async (h) => {
    calls++;
    await gate;
    return verify(h);
  };
  try {
    const reached = Date.now() + 2500;
    while (calls < 8 && Date.now() < reached) await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 8);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(121000);
    let settled = false;
    for (let i = 0; i < 60; i++) {
      const rows = await f.runtime.invocations.list(f.identity.ownerId);
      settled =
        rows.length === 9 &&
        rows.every((r) => r.state === (r.id === last ? "outcome_unknown" : "expired"));
      if (settled) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(settled, true);
  } finally {
    t.mock.timers.reset();
    f.runtime.oauth.verify = verify;
    resume();
  }
});

test("shutdown drain includes a reservation that settles inside the drain window", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID(),
    reserve = f.runtime.store.reserve.bind(f.runtime.store);
  let reached!: () => void, resume!: () => void;
  const entered = new Promise<void>((r) => {
      reached = r;
    }),
    gate = new Promise<void>((r) => {
      resume = r;
    });
  f.runtime.store.reserve = async (...args) => {
    reached();
    await gate;
    return reserve(...args);
  };
  const prepared = f.runtime.invocations
    .prepare(subject, headers, {
      requestId: id,
      workspaceId: f.scope.workspaceId,
      sourceId: f.scope.sourceId,
      sql: "SELECT id FROM customers",
      parameters: [],
      maxRows: 10,
      schemaVersion: null,
    })
    .then(
      () => true,
      () => false,
    );
  try {
    await entered;
    f.runtime.invocations.close();
    let drained = false;
    const drain = f.runtime.invocations.settleCleanup().then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(drained, false);
    resume();
    assert.equal(await prepared, false);
    await drain;
    assert.equal((await f.runtime.store.invocation(f.identity.ownerId, id))?.state, "expired");
  } finally {
    resume();
    await prepared;
    f.runtime.store.reserve = reserve;
  }
});

test("failed delegated jobs release authority and schema retries project failed cleanup", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  await f.runtime.invocations.schema(subject, headers, id);
  const task = await f.reads.next(f.binding.connectorId);
  assert.ok(task && "id" in task);
  assert.equal(f.reads.jobs.complete(f.binding, task.id, "failed", "denied"), true);
  const finish = f.runtime.store.finishInvocation.bind(f.runtime.store);
  let resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  f.runtime.store.finishInvocation = async (intent) => {
    await gate;
    return finish(intent);
  };
  try {
    assert.equal((await f.runtime.invocations.status(subject, id)).state, "failed");
    assert.equal(f.runtime.invocations.cleanupHealth().pending, 1);
    assert.equal((await f.runtime.invocations.schema(subject, headers, id)).state, "failed");
  } finally {
    f.runtime.store.finishInvocation = finish;
    resume();
    await f.runtime.invocations.settleCleanup();
  }
});

test("failed execution is cleaned independently of all stalled authorization monitors", {
  skip: !enabled,
  timeout: 35000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    ids = Array.from({ length: 9 }, () => randomUUID());
  const input = {
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  };
  for (const id of ids)
    await f.runtime.invocations.prepare(subject, headers, { ...input, requestId: id });
  const last = ids.at(-1);
  assert.ok(last);
  const view = await f.runtime.invocations.review(f.identity, last);
  await f.runtime.invocations.approve(f.identity, last, String(view.commitment), true);
  const task = await f.reads.next(f.binding.connectorId);
  assert.ok(task && "id" in task);
  const verify = f.runtime.oauth.verify.bind(f.runtime.oauth);
  let calls = 0,
    resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  f.runtime.oauth.verify = async (h) => {
    calls++;
    await gate;
    return verify(h);
  };
  try {
    const until = Date.now() + 2500;
    while (calls < 8 && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 8);
    assert.equal(f.reads.jobs.complete(f.binding, task.id, "failed", "denied"), true);
    let failed = false;
    for (let i = 0; i < 60; i++) {
      failed =
        (await f.runtime.invocations.list(f.identity.ownerId)).find((r) => r.id === last)?.state ===
        "failed";
      if (failed) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(failed, true);
  } finally {
    f.runtime.oauth.verify = verify;
    resume();
  }
});

test("concurrent approvals claim one winner without replacing or cancelling its job", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  await f.runtime.invocations.prepare(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  });
  const original = f.runtime.invocations.review.bind(f.runtime.invocations),
    view = await original(f.identity, id);
  let reviews = 0,
    resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  f.runtime.invocations.review = async (...args) => {
    const value = await original(...args);
    reviews++;
    if (reviews === 2) resume();
    await gate;
    return value;
  };
  try {
    const outcomes = await Promise.allSettled([
      f.runtime.invocations.approve(f.identity, id, String(view.commitment), true),
      f.runtime.invocations.approve(f.identity, id, String(view.commitment), true),
    ]);
    assert.equal(reviews, 2);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    const row = await f.runtime.store.invocation(f.identity.ownerId, id),
      task = await f.reads.next(f.binding.connectorId);
    assert.ok(row?.taskId && task && "id" in task);
    assert.equal(task.id, row.taskId);
    assert.equal(
      f.reads.jobs.complete(
        f.binding,
        task.id,
        "ok",
        Buffer.from(
          JSON.stringify({
            columns: [{ name: "id", type: "int" }],
            rows: [],
            timezone: "UTC",
            truncated: false,
          }),
        ).toString("base64url"),
      ),
      true,
    );
    assert.equal((await f.runtime.invocations.status(subject, id)).resultAvailable, true);
  } finally {
    f.runtime.invocations.review = original;
    resume();
  }
});

test("cleanup erases an in-flight poll copy and transfers its cleanup intent once", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  await f.runtime.invocations.prepare(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  });
  const view = await f.runtime.invocations.review(f.identity, id);
  await f.runtime.invocations.approve(f.identity, id, String(view.commitment), true);
  const verify = f.runtime.oauth.verify.bind(f.runtime.oauth),
    session = f.reads.sessionIsActive.bind(f.reads),
    finish = f.runtime.store.finishInvocation.bind(f.runtime.store),
    copies: Parameters<typeof verify>[0][] = [];
  let resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  let writes = 0,
    calls = 0;
  f.runtime.oauth.verify = async (h) => {
    copies.push(h);
    return verify(h);
  };
  f.reads.sessionIsActive = async () => {
    calls++;
    await gate;
    return false;
  };
  f.runtime.store.finishInvocation = async (intent) => {
    writes++;
    return finish(intent);
  };
  const poll = f.runtime.invocations.status(subject, id);
  try {
    const until = Date.now() + 2500;
    while ((!calls || !f.runtime.health().observation?.outstanding) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls && f.runtime.health().observation?.outstanding);
    assert.ok(copies.length);
    f.runtime.invocations.close();
    assert.ok(copies.every((h) => h.authorization === undefined));
    await f.runtime.invocations.settleCleanup();
    assert.equal(writes, 1);
    resume();
    const result = await poll;
    assert.equal(result.resultAvailable, false);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(writes, 1);
    assert.equal(f.runtime.invocations.cleanupHealth().pending, 0);
  } finally {
    resume();
    await poll.catch(() => {});
    f.runtime.oauth.verify = verify;
    f.reads.sessionIsActive = session;
    f.runtime.store.finishInvocation = finish;
  }
});

test("claimed approval metadata failure latches cleanup instead of retaining a pending approval", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  const input = {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  };
  await f.runtime.invocations.prepare(subject, headers, input);
  const view = await f.runtime.invocations.review(f.identity, id),
    lookup = f.runtime.store.invocation.bind(f.runtime.store);
  let lookups = 0;
  f.runtime.store.invocation = async (...args) => {
    lookups++;
    if (lookups === 2) throw Error("synthetic approval metadata failure");
    return lookup(...args);
  };
  try {
    await assert.rejects(() =>
      f.runtime.invocations.approve(f.identity, id, String(view.commitment), true),
    );
    assert.equal(lookups, 2);
  } finally {
    f.runtime.store.invocation = lookup;
  }
  assert.equal((await f.runtime.invocations.status(subject, id)).state, "failed");
  await assert.rejects(() => f.runtime.invocations.review(f.identity, id));
  assert.equal(await f.reads.next(f.binding.connectorId), null);
});

test("cleanup during a completed-state write returns metadata without capturing the old result", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  await f.runtime.invocations.schema(subject, headers, id);
  const task = await f.reads.next(f.binding.connectorId);
  assert.ok(task && "id" in task);
  const schema = {
    database: "isolated",
    tables: [
      {
        name: "customers",
        columns: [{ name: "id", type: "int" }],
        version: "a".repeat(64),
        structureHash: "b".repeat(64),
      },
    ],
  };
  assert.equal(
    f.reads.jobs.complete(
      f.binding,
      task.id,
      "ok",
      Buffer.from(JSON.stringify(schema)).toString("base64url"),
    ),
    true,
  );
  const transition = f.runtime.store.transition.bind(f.runtime.store);
  let reached!: () => void, resume!: () => void;
  const entered = new Promise<void>((r) => {
      reached = r;
    }),
    gate = new Promise<void>((r) => {
      resume = r;
    });
  f.runtime.store.transition = async (...args) => {
    reached();
    await gate;
    return transition(...args);
  };
  const poll = f.runtime.invocations.status(subject, id);
  try {
    await entered;
    f.runtime.invocations.close();
    assert.equal(f.reads.jobs.status(f.binding, task.id)?.payload, undefined);
    resume();
    const result = await poll;
    assert.equal(result.resultAvailable, false);
    assert.equal("result" in result, false);
  } finally {
    resume();
    await poll.catch(() => {});
    f.runtime.store.transition = transition;
  }
});

for (const completed of [false, true]) {
  test(completed
    ? "decoded results do not cross a delayed authorization commit boundary"
    : "queued observations cannot outlive cleanup during authorization commit", {
    skip: !enabled,
    timeout: 30000,
  }, async (t) => {
    const f = await mcpFixture();
    const token = await f.token(),
      headers = { authorization: `Bearer ${token}` },
      subject = await f.runtime.oauth.verify(headers);
    let hold = false,
      reached!: () => void,
      resume!: () => void;
    const entered = new Promise<void>((r) => {
        reached = r;
      }),
      gate = new Promise<void>((r) => {
        resume = r;
      });
    let crossed: unknown;
    // Fault injection at the application's authorization port, after the checked
    // callback but before its enclosing commit returns. Other tests use real locks.
    const service = new McpInvocations(
      f.runtime.store,
      randomBytes(32),
      f.reads,
      f.runtime.coordinator,
      (h) => f.runtime.oauth.verify(h),
      f.origin,
      async (h, action) => {
        const fresh = await f.runtime.oauth.verify(h),
          value = await action(fresh, () => {}, new AbortController().signal);
        if (hold) {
          crossed = value;
          reached();
          await gate;
        }
        return value;
      },
      async () => {},
      async () => {},
    );
    t.after(async () => {
      service.close();
      await service.settleCleanup();
      await f.close();
    });
    const id = randomUUID();
    await service.schema(subject, headers, id);
    if (completed) {
      const task = await f.reads.next(f.binding.connectorId);
      assert.ok(task && "id" in task);
      const schema = {
        database: "isolated",
        tables: [
          {
            name: "customers",
            columns: [{ name: "id", type: "int" }],
            version: "a".repeat(64),
            structureHash: "b".repeat(64),
          },
        ],
      };
      assert.equal(
        f.reads.jobs.complete(
          f.binding,
          task.id,
          "ok",
          Buffer.from(JSON.stringify(schema)).toString("base64url"),
        ),
        true,
      );
    }
    hold = true;
    const poll = service.status(subject, id);
    try {
      await entered;
      assert.ok(crossed && typeof crossed === "object" && !("result" in crossed));
      service.close();
      resume();
      const value = await poll;
      assert.equal(value.resultAvailable, false);
      assert.equal("result" in value, false);
      assert.equal(["queued", "running"].includes(value.state), false);
    } finally {
      resume();
      await poll.catch(() => {});
    }
  });
}
