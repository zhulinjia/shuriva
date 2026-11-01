import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname } from "node:path";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { diagnostics } from "../logging/public.js";
import type { AuthenticateOwner } from "../connectors/public.js";
import { DataSourceError } from "../datasources/public.js";
import { type AuditEntry, auditSchema, type HistoryScope } from "./model.js";
import type { HistoryStore } from "./store.js";
import { declaredRequestAudit, requestAuditContext } from "./request-audit.js";

type AuditScope = Pick<HistoryScope, "workspaceId" | "sourceId"> | null;
const queuedEvent = z.strictObject({
  id: z.string().uuid(),
  owner: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  scope: z.strictObject({ workspaceId: z.string().uuid(), sourceId: z.string().uuid() }).nullable(),
  entry: auditSchema,
});
const outboxSchema = z
  .strictObject({ version: z.literal(1), items: z.array(queuedEvent).max(1024) })
  .superRefine((value, ctx) => {
    if (new Set(value.items.map((item) => item.id)).size !== value.items.length)
      ctx.addIssue({ code: "custom", message: "duplicate event" });
  });
type QueuedEvent = z.infer<typeof queuedEvent>;

/** Bounded metadata-only outbox. Stable IDs make replay after uncertain DB acknowledgement idempotent. */
export class AuditTrail {
  private queue: QueuedEvent[] = [];
  private pending?: Promise<void>;
  private readonly timer: NodeJS.Timeout;
  private failed = false;
  private closed = false;
  constructor(
    private readonly store: HistoryStore,
    private readonly path?: string,
    private paused = false,
  ) {
    if (path && !paused) this.load();
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
  }
  private load(): void {
    if (!this.path) return;
    fs.mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const stat = fs.lstatSync(this.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 1_048_576 ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        throw Error("AUDIT_OUTBOX_INVALID");
      this.queue = outboxSchema.parse(JSON.parse(fs.readFileSync(this.path, "utf8"))).items;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.persist([]);
        return;
      }
      this.failed = true;
      throw Error("AUDIT_OUTBOX_INVALID", { cause: error });
    }
  }
  /** Synchronous local writes serialize queue snapshots; no DB delivery starts before this succeeds. */
  private persist(items: QueuedEvent[]): void {
    if (!this.path) return;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(file, JSON.stringify({ version: 1, items }), "utf8");
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      fs.renameSync(temp, this.path);
      // Windows does not support opening/syncing directories through Node. NTFS rename remains atomic.
      if (process.platform !== "win32") {
        const directory = fs.openSync(dirname(this.path), "r");
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
      }
    } catch (error) {
      this.failed = true;
      diagnostics.error("audit.persistence_unavailable", {}, error);
      throw Error("AUDIT_UNAVAILABLE", { cause: error });
    }
  }
  health() {
    return {
      available: !this.failed && !this.closed && !this.paused && this.queue.length < 1000,
      durable: !!this.path,
      pending: this.queue.length,
    };
  }
  /** Delivery starts after the app acquires its existing single-process registry lock. */
  start(): void {
    if (this.paused && this.path) this.load();
    this.paused = false;
    void this.flush();
  }
  /** A persistence failure is surfaced; callers must distinguish it from the external operation's outcome. */
  record(owner: string, entry: AuditEntry, scope: AuditScope = null): void {
    if (this.failed || this.closed || this.paused) throw Error("AUDIT_UNAVAILABLE");
    const item = queuedEvent.parse({ id: randomUUID(), owner, scope, entry });
    if (this.queue.length >= 1024) {
      diagnostics.error("audit.capacity_exhausted");
      throw Error("AUDIT_CAPACITY");
    }
    const next = [...this.queue, item];
    this.persist(next);
    this.queue = next;
    void this.flush();
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.deliver();
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }
  private async deliver(): Promise<void> {
    while (!this.closed && !this.failed && !this.paused && this.queue[0]) {
      const item = this.queue[0];
      try {
        await this.store.appendAudit(item.owner, item.scope, item.entry, item.id);
      } catch (error) {
        if (
          error instanceof DataSourceError &&
          (error.code === "CONFLICT" || error.code === "INVALID")
        ) {
          this.failed = true;
          diagnostics.error("audit.metadata_conflict", {}, error);
        } else diagnostics.warn("audit.delivery_unavailable", {}, error);
        break;
      }
      if (this.closed) return;
      const next = this.queue.slice(1);
      try {
        this.persist(next);
      } catch {
        return;
      }
      this.queue = next;
    }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
  middleware(owner: AuthenticateOwner): RequestHandler {
    return async (req, res, next) => {
      const actor = await owner(req.headers);
      if (!actor) {
        next();
        return;
      }
      res.setHeader(
        "X-Audit-Status",
        this.health().available ? (this.path ? "durable" : "memory") : "unavailable",
      );
      if (
        req.method !== "GET" &&
        (this.failed || this.closed || this.paused || this.queue.length >= 1000)
      ) {
        res.status(503).json({ error: "AUDIT_UNAVAILABLE" });
        return;
      }
      res.once("finish", () => {
        const declared = declaredRequestAudit(res);
        const context = requestAuditContext(res);
        const record = (entry: AuditEntry) => {
          try {
            this.record(actor, entry, declared?.scope ?? context?.scope ?? null);
          } catch (error) {
            diagnostics.error("audit.completed_request_unavailable", {}, error);
          }
        };
        if (res.statusCode === 403) {
          record({
            ...context?.identifiers,
            ...declared?.entry,
            event: "security.denied",
            outcome: "denied",
          });
          return;
        }
        if (!declared || req.method === "GET" || (declared.failureOnly && res.statusCode < 400))
          return;
        record({
          ...declared.entry,
          outcome: res.statusCode < 400 ? "success" : "failure",
        });
      });
      next();
    };
  }
  install(server: Express, owner: AuthenticateOwner) {
    server.get("/api/history/audit-health", async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!(await owner(req.headers))) {
        res.status(401).json({ error: "UNAUTHENTICATED" });
        return;
      }
      res.json(this.health());
    });
    for (const prefix of [
      "data-sources",
      "connectors",
      "model",
      "semantics",
      "workspaces",
      "history",
    ])
      server.use(`/api/${prefix}`, this.middleware(owner));
  }
}
