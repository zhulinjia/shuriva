import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { DataSourceError } from "../src/datasources/public.js";
import { AuditTrail } from "../src/history/audit.js";
import type { AuditEntry } from "../src/history/model.js";
import type { HistoryStore } from "../src/history/store.js";

function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), "stage7-audit-outbox-"));
  return {
    path: join(directory, "audit-outbox.json"),
    close() {
      for (const file of fs.readdirSync(directory)) fs.unlinkSync(join(directory, file));
      fs.rmdirSync(directory);
    },
  };
}
const event: AuditEntry = { event: "connection.paired", outcome: "success" };

test("paused initialization never touches disk and start loads the latest queue or rejects corruption unchanged", async () => {
  const files = fixture();
  const saved: unknown[] = [];
  const store = {
    appendAudit: async (owner: string, scope: unknown, entry: AuditEntry, id?: string) => {
      saved.push({ id, owner, scope, entry });
    },
  } as unknown as HistoryStore;
  let trail: AuditTrail | undefined;
  try {
    trail = new AuditTrail(store, files.path, true);
    await trail.flush();
    assert.equal(fs.existsSync(files.path), false);
    const latest = { id: randomUUID(), owner: "owner", scope: null, entry: event };
    fs.writeFileSync(files.path, JSON.stringify({ version: 1, items: [latest] }), { mode: 0o600 });
    trail.start();
    await trail.flush();
    assert.deepEqual(saved, [latest]);
    trail.close();
    const corrupt = "{file changed while startup waited for registry lock";
    trail = new AuditTrail(store, files.path, true);
    fs.writeFileSync(files.path, corrupt);
    assert.throws(() => trail?.start(), /AUDIT_OUTBOX_INVALID/);
    assert.equal(trail.health().available, false);
    assert.equal(fs.readFileSync(files.path, "utf8"), corrupt);
  } finally {
    trail?.close();
    files.close();
  }
});

test("durable audit metadata survives restart and drains using its original stable UUID", async () => {
  const files = fixture();
  const scope = { workspaceId: randomUUID(), sourceId: randomUUID() };
  const saved: unknown[] = [];
  let unavailable = true;
  const store = {
    appendAudit: async (owner: string, scope: unknown, entry: AuditEntry, id?: string) => {
      if (unavailable) throw Error("fixture database unavailable");
      saved.push({ id, owner, scope, entry });
    },
  } as unknown as HistoryStore;
  let trail: AuditTrail | undefined;
  try {
    trail = new AuditTrail(store, files.path);
    trail.record("owner", event, scope);
    await trail.flush();
    const pending = JSON.parse(fs.readFileSync(files.path, "utf8"));
    assert.equal(pending.items.length, 1);
    assert.match(pending.items[0].id, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(pending), /SELECT|password|parameters|rows/);
    if (process.platform !== "win32") assert.equal(fs.statSync(files.path).mode & 0o777, 0o600);
    trail.close();
    unavailable = false;
    trail = new AuditTrail(store, files.path, true);
    await trail.flush();
    assert.equal(saved.length, 0);
    assert.equal(trail.health().available, false);
    trail.start();
    await trail.flush();
    assert.deepEqual(saved, pending.items);
    assert.deepEqual(JSON.parse(fs.readFileSync(files.path, "utf8")), { version: 1, items: [] });
  } finally {
    trail?.close();
    files.close();
  }
});

test("a committed DB event replays idempotently after removing it from disk fails, and later UI writes are denied", async (context) => {
  const files = fixture();
  const saved = new Map<string, string>();
  let attempts = 0;
  const store = {
    appendAudit: async (_owner: string, _scope: unknown, entry: AuditEntry, id?: string) => {
      assert.ok(id);
      attempts++;
      const body = JSON.stringify(entry);
      assert.equal(saved.get(id) ?? body, body);
      saved.set(id, body);
    },
  } as unknown as HistoryStore;
  let trail: AuditTrail | undefined;
  const original = fs.renameSync;
  try {
    trail = new AuditTrail(store, files.path);
    const rename = context.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
      if (to === files.path && JSON.parse(fs.readFileSync(from, "utf8")).items.length === 0)
        throw Error("fixture removal rename failed");
      original(from, to);
    }) as typeof fs.renameSync);
    trail.record("owner", event);
    await trail.flush();
    assert.equal(saved.size, 1);
    assert.deepEqual(trail.health(), { available: false, durable: true, pending: 1 });
    assert.equal(JSON.parse(fs.readFileSync(files.path, "utf8")).items.length, 1);
    const app = express();
    trail.install(app, async () => "owner");
    let mutations = 0;
    app.post("/api/model/check", (_req, res) => {
      mutations++;
      res.end();
    });
    const server = app.listen(0, "127.0.0.1");
    try {
      if (!server.listening)
        await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(`${base}/api/model/check`, { method: "POST" })).status, 503);
      assert.equal(mutations, 0);
      assert.equal(
        ((await (await fetch(`${base}/api/history/audit-health`)).json()) as { available: boolean })
          .available,
        false,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    trail.close();
    rename.mock.restore();
    trail = new AuditTrail(store, files.path);
    await trail.flush();
    assert.equal(attempts, 2);
    assert.equal(saved.size, 1);
    assert.equal(JSON.parse(fs.readFileSync(files.path, "utf8")).items.length, 0);
  } finally {
    trail?.close();
    context.mock.restoreAll();
    files.close();
  }
});

test("corrupt, duplicate or unexpected outbox data fails closed without deleting or rewriting the file", () => {
  const files = fixture();
  const item = { id: randomUUID(), owner: "owner", scope: null, entry: event };
  const invalid = [
    "{broken",
    JSON.stringify({ version: 1, items: [item, item] }),
    JSON.stringify({ version: 1, items: [{ ...item, sql: "SELECT private" }] }),
  ];
  try {
    for (const content of invalid) {
      fs.writeFileSync(files.path, content, { mode: 0o600 });
      assert.throws(() => new AuditTrail({} as HistoryStore, files.path), /AUDIT_OUTBOX_INVALID/);
      assert.equal(fs.readFileSync(files.path, "utf8"), content);
    }
  } finally {
    files.close();
  }
});

test("failure to persist a new event prevents DB delivery and exposes unavailable health", async (context) => {
  const files = fixture();
  let deliveries = 0;
  const trail = new AuditTrail(
    {
      appendAudit: async () => {
        deliveries++;
      },
    } as unknown as HistoryStore,
    files.path,
  );
  const original = fs.renameSync;
  try {
    context.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
      if (to === files.path) throw Error("fixture outbox unavailable");
      original(from, to);
    }) as typeof fs.renameSync);
    assert.throws(() => trail.record("owner", event), /AUDIT_UNAVAILABLE/);
    await trail.flush();
    assert.equal(deliveries, 0);
    assert.equal(trail.health().available, false);
    assert.equal(JSON.parse(fs.readFileSync(files.path, "utf8")).items.length, 0);
  } finally {
    trail.close();
    context.mock.restoreAll();
    files.close();
  }
});

test("a durable event identity conflicting with storage fails closed without discarding the event", async () => {
  const files = fixture();
  const trail = new AuditTrail(
    {
      appendAudit: async () => {
        throw new DataSourceError("CONFLICT");
      },
    } as unknown as HistoryStore,
    files.path,
  );
  try {
    trail.record("owner", event);
    await trail.flush();
    assert.equal(trail.health().available, false);
    assert.equal(JSON.parse(fs.readFileSync(files.path, "utf8")).items.length, 1);
    assert.throws(() => trail.record("owner", event), /AUDIT_UNAVAILABLE/);
  } finally {
    trail.close();
    files.close();
  }
});
