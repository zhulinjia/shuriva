import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { type BoundSourceAccess, DataSourceError, validId } from "../datasources/public.js";
import {
  type AuditEntry,
  auditSchema,
  type ExecutionState,
  executionSchema,
  type HistoryKind,
  type HistoryScope,
  parseHistoryContent,
} from "./model.js";

type RecordRow = RowDataPacket & {
  id: string;
  ownerId: string;
  kind: HistoryKind;
  sequence: string;
  revision: number;
  content: unknown;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  workspaceId: string | null;
  sourceId: string | null;
};
const decode = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);
function afterCursor(after: unknown): string {
  if (after === undefined || after === null || after === "") return "18446744073709551615";
  if (
    typeof after !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(after) ||
    BigInt(after) > 18446744073709551615n
  )
    throw new DataSourceError("INVALID");
  return after;
}
function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 4294967295)
    throw new DataSourceError("INVALID");
  return Number(value);
}
function record(row: RecordRow, kind: HistoryKind) {
  return {
    id: row.id,
    revision: Number(row.revision),
    content: parseHistoryContent(kind, decode(row.content)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** Owns only history_entry. Scope ownership and locks are supplied by the datasource port. */
export class HistoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly sources: BoundSourceAccess,
  ) {}

  async list(scope: HistoryScope, kind: HistoryKind, after?: unknown, deleted = false) {
    const cursor = afterCursor(after);
    return this.sources.withBoundSnapshot(
      scope.ownerId,
      scope.workspaceId,
      scope.sourceId,
      async (c) => {
        const [rows] = await c.execute<RecordRow[]>(
          `SELECT *, CAST(sequence AS CHAR) AS sequence FROM history_entry WHERE ownerId=? AND workspaceId=? AND sourceId=? AND kind=? AND deletedAt IS ${deleted ? "NOT NULL" : "NULL"} AND sequence<? ORDER BY history_entry.sequence DESC LIMIT 51`,
          [scope.ownerId, scope.workspaceId, scope.sourceId, kind, cursor],
        );
        const page = rows.slice(0, 50);
        return {
          items: page.map((row) => record(row, kind)),
          nextCursor: rows.length > 50 ? (page.at(-1)?.sequence ?? null) : null,
        };
      },
    );
  }

  async get(scope: HistoryScope, kind: HistoryKind, id: string, includeDeleted = false) {
    if (!validId(id)) throw new DataSourceError("INVALID");
    return this.sources.withBoundSnapshot(
      scope.ownerId,
      scope.workspaceId,
      scope.sourceId,
      async (c) => {
        const [rows] = await c.execute<RecordRow[]>(
          `SELECT * FROM history_entry WHERE id=? AND ownerId=? AND workspaceId=? AND sourceId=? AND kind=? ${includeDeleted ? "" : "AND deletedAt IS NULL"}`,
          [id, scope.ownerId, scope.workspaceId, scope.sourceId, kind],
        );
        if (!rows[0]) throw new DataSourceError("NOT_FOUND");
        return record(rows[0], kind);
      },
    );
  }

  async save(
    scope: HistoryScope,
    kind: "conversation" | "artifact",
    id: string,
    revision: unknown,
    input: unknown,
  ) {
    if (!validId(id)) throw new DataSourceError("INVALID");
    const expected = expectedRevision(revision);
    let content: unknown;
    try {
      content = parseHistoryContent(kind, input);
    } catch {
      throw new DataSourceError("INVALID");
    }
    return this.sources.withBoundSnapshot(
      scope.ownerId,
      scope.workspaceId,
      scope.sourceId,
      async (c) => {
        const [rows] = await c.execute<RecordRow[]>(
          "SELECT * FROM history_entry WHERE id=? FOR UPDATE",
          [id],
        );
        const existing = rows[0];
        if (
          existing &&
          (existing.ownerId !== scope.ownerId ||
            existing.workspaceId !== scope.workspaceId ||
            existing.sourceId !== scope.sourceId ||
            existing.kind !== kind)
        )
          throw new DataSourceError("NOT_FOUND");
        if ((existing ? Number(existing.revision) : 0) !== expected || existing?.deletedAt)
          throw new DataSourceError("CONFLICT");
        if (existing)
          await c.execute(
            "UPDATE history_entry SET revision=revision+1,content=?,updatedAt=UTC_TIMESTAMP(3) WHERE id=?",
            [JSON.stringify(content), id],
          );
        else await this.insert(c, scope, kind, id, content);
        await this.writeAudit(c, scope.ownerId, scope, {
          event: kind === "conversation" ? "conversation.saved" : "artifact.saved",
          outcome: "success",
          targetId: id,
        });
        return { id, revision: expected + 1 };
      },
    );
  }

  async setDeleted(
    scope: HistoryScope,
    kind: "conversation" | "artifact",
    id: string,
    revision: unknown,
    deleted: boolean,
  ) {
    if (!validId(id) || typeof deleted !== "boolean") throw new DataSourceError("INVALID");
    const expected = expectedRevision(revision);
    return this.sources.withBoundSnapshot(
      scope.ownerId,
      scope.workspaceId,
      scope.sourceId,
      async (c) => {
        const [changed] = await c.execute<ResultSetHeader>(
          `UPDATE history_entry SET deletedAt=${deleted ? "UTC_TIMESTAMP(3)" : "NULL"},revision=revision+1,updatedAt=UTC_TIMESTAMP(3) WHERE id=? AND ownerId=? AND workspaceId=? AND sourceId=? AND kind=? AND revision=?`,
          [id, scope.ownerId, scope.workspaceId, scope.sourceId, kind, expected],
        );
        if (changed.affectedRows !== 1) throw new DataSourceError("CONFLICT");
        const event =
          kind === "conversation"
            ? deleted
              ? "conversation.deleted"
              : "conversation.restored"
            : deleted
              ? "artifact.deleted"
              : "artifact.restored";
        await this.writeAudit(c, scope.ownerId, scope, { event, outcome: "success", targetId: id });
        return { id, revision: expected + 1 };
      },
    );
  }

  private async insert(
    c: PoolConnection,
    scope: HistoryScope,
    kind: HistoryKind,
    id: string,
    content: unknown,
  ) {
    await c.execute(
      "INSERT INTO history_entry (id,ownerId,workspaceId,sourceId,kind,revision,content,createdAt,updatedAt) VALUES (?,?,?,?,?,1,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [id, scope.ownerId, scope.workspaceId, scope.sourceId, kind, JSON.stringify(content)],
    );
  }
  private async writeAudit(
    c: Pick<PoolConnection, "execute">,
    ownerId: string,
    scope: Pick<HistoryScope, "workspaceId" | "sourceId"> | null,
    input: AuditEntry,
    eventId: string = randomUUID(),
  ) {
    const entry = auditSchema.parse(input);
    await c.execute(
      "INSERT INTO history_entry (id,ownerId,workspaceId,sourceId,kind,revision,content,createdAt,updatedAt) VALUES (?,?,?,?,'audit',1,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [
        eventId,
        ownerId,
        scope?.workspaceId ?? null,
        scope?.sourceId ?? null,
        JSON.stringify(entry),
      ],
    );
  }
  async appendAudit(
    ownerId: string,
    scope: Pick<HistoryScope, "workspaceId" | "sourceId"> | null,
    input: AuditEntry,
    eventId?: string,
  ) {
    if (
      !ownerId ||
      ownerId.length > 128 ||
      (scope && (!validId(scope.workspaceId) || !validId(scope.sourceId))) ||
      (eventId !== undefined && !validId(eventId))
    )
      throw new DataSourceError("INVALID");
    const entry = auditSchema.parse(input);
    try {
      await this.writeAudit(this.pool, ownerId, scope, entry, eventId);
    } catch (error) {
      if (
        eventId === undefined ||
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ER_DUP_ENTRY"
      )
        throw error;
      // Audit rows are immutable. A duplicate ID may acknowledge an earlier commit,
      // but must never conceal a different event or a collision with another kind.
      const [rows] = await this.pool.execute<RecordRow[]>(
        "SELECT * FROM history_entry WHERE id=?",
        [eventId],
      );
      const row = rows[0];
      const previous = auditSchema.safeParse(row ? decode(row.content) : null);
      if (
        row?.kind !== "audit" ||
        row.ownerId !== ownerId ||
        row.workspaceId !== (scope?.workspaceId ?? null) ||
        row.sourceId !== (scope?.sourceId ?? null) ||
        row.deletedAt !== null ||
        !previous.success ||
        previous.data.event !== entry.event ||
        previous.data.outcome !== entry.outcome ||
        previous.data.connectorId !== entry.connectorId ||
        previous.data.executionId !== entry.executionId ||
        previous.data.targetId !== entry.targetId
      )
        throw new DataSourceError("CONFLICT");
    }
  }

  async recordExport(scope: HistoryScope) {
    await this.sources.withBoundSnapshot(scope.ownerId, scope.workspaceId, scope.sourceId, (c) =>
      this.writeAudit(c, scope.ownerId, scope, { event: "result.exported", outcome: "success" }),
    );
  }
  async listAudit(ownerId: string, after?: unknown) {
    const cursor = afterCursor(after);
    const [rows] = await this.pool.execute<RecordRow[]>(
      "SELECT *, CAST(sequence AS CHAR) AS sequence FROM history_entry WHERE ownerId=? AND kind='audit' AND sequence<? ORDER BY history_entry.sequence DESC LIMIT 51",
      [ownerId, cursor],
    );
    const page = rows.slice(0, 50);
    return {
      items: page.map((row) => ({
        ...record(row, "audit"),
        workspaceId: row.workspaceId,
        sourceId: row.sourceId,
      })),
      nextCursor: rows.length > 50 ? (page.at(-1)?.sequence ?? null) : null,
    };
  }

  async beginExecution(
    scope: HistoryScope,
    taskId: string,
    connectorId: string,
    instanceId: string,
  ) {
    const content = executionSchema.parse({
      taskId,
      connectorId,
      instanceId,
      state: "queued",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      rowCount: null,
      truncated: false,
      reason: null,
      code: null,
    });
    return this.sources.withBoundSnapshot(
      scope.ownerId,
      scope.workspaceId,
      scope.sourceId,
      async (c) => {
        const [rows] = await c.execute<RecordRow[]>(
          "SELECT * FROM history_entry WHERE id=? FOR UPDATE",
          [taskId],
        );
        if (rows[0]) {
          if (
            rows[0].ownerId !== scope.ownerId ||
            rows[0].workspaceId !== scope.workspaceId ||
            rows[0].sourceId !== scope.sourceId ||
            rows[0].kind !== "execution"
          )
            throw new DataSourceError("CONFLICT");
          const existing = executionSchema.parse(decode(rows[0].content));
          if (existing.instanceId !== instanceId) throw new DataSourceError("CONFLICT");
          return { created: false, state: existing.state };
        }
        await this.insert(c, scope, "execution", taskId, content);
        await this.writeAudit(c, scope.ownerId, scope, {
          event: "query.submitted",
          outcome: "success",
          executionId: taskId,
          connectorId,
        });
        return { created: true, state: content.state };
      },
    );
  }

  /** Trusted lifecycle publication must survive binding revocation to record the final outcome. */
  async setExecutionState(
    scope: HistoryScope,
    taskId: string,
    state: ExecutionState,
    summary: Partial<
      Pick<
        import("./model.js").Execution,
        "rowCount" | "truncated" | "reason" | "code" | "durationMs"
      >
    > = {},
  ) {
    if (!validId(taskId)) throw new DataSourceError("INVALID");
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.execute<RecordRow[]>(
        "SELECT * FROM history_entry WHERE id=? AND ownerId=? AND workspaceId=? AND sourceId=? AND kind='execution' FOR UPDATE",
        [taskId, scope.ownerId, scope.workspaceId, scope.sourceId],
      );
      const row = rows[0];
      if (!row) {
        await c.commit();
        return;
      }
      const previous = executionSchema.parse(decode(row.content));
      if (!["queued", "running"].includes(previous.state)) {
        await c.commit();
        return;
      }
      if (previous.state === "running" && state === "queued") {
        await c.commit();
        return;
      }
      const terminal = !["queued", "running"].includes(state);
      const now = Date.now();
      const content = executionSchema.parse({
        ...previous,
        ...summary,
        state,
        finishedAt: terminal ? new Date(now).toISOString() : null,
        durationMs: terminal
          ? (summary.durationMs ?? Math.max(0, now - Date.parse(previous.startedAt)))
          : null,
      });
      await c.execute(
        "UPDATE history_entry SET content=?,revision=revision+1,updatedAt=UTC_TIMESTAMP(3) WHERE id=?",
        [JSON.stringify(content), taskId],
      );
      if (terminal)
        await this.writeAudit(c, scope.ownerId, scope, {
          event:
            state === "completed"
              ? "query.completed"
              : state === "cancelled"
                ? "query.cancelled"
                : state === "expired"
                  ? "query.expired"
                  : state === "outcome_unknown"
                    ? "query.unknown"
                    : "query.failed",
          outcome:
            state === "completed" || state === "cancelled"
              ? "success"
              : state === "outcome_unknown"
                ? "unknown"
                : "failure",
          executionId: taskId,
          connectorId: previous.connectorId,
        });
      await c.commit();
    } catch (error) {
      await c.rollback();
      throw error;
    } finally {
      c.release();
    }
  }

  async listExecutions(ownerId: string, after?: unknown) {
    const cursor = afterCursor(after);
    const [rows] = await this.pool.execute<RecordRow[]>(
      "SELECT *, CAST(sequence AS CHAR) AS sequence FROM history_entry WHERE ownerId=? AND kind='execution' AND sequence<? ORDER BY history_entry.sequence DESC LIMIT 51",
      [ownerId, cursor],
    );
    const page = rows.slice(0, 50);
    return {
      items: page.map((row) => ({
        ...record(row, "execution"),
        workspaceId: row.workspaceId,
        sourceId: row.sourceId,
      })),
      nextCursor: rows.length > 50 ? (page.at(-1)?.sequence ?? null) : null,
    };
  }

  async recoverExecutions(instanceId: string) {
    if (!validId(instanceId)) throw new DataSourceError("INVALID");
    // An old process cannot establish whether the Connector executed its task.
    // Recovered records never become eligible for an automatic retry.
    let after = "0";
    for (;;) {
      const c = await this.pool.getConnection();
      try {
        await c.beginTransaction();
        const [rows] = await c.execute<RecordRow[]>(
          "SELECT *, CAST(sequence AS CHAR) AS sequence FROM history_entry WHERE sequence>? AND kind='execution' AND JSON_UNQUOTE(JSON_EXTRACT(content,'$.instanceId'))<>? AND JSON_UNQUOTE(JSON_EXTRACT(content,'$.state')) IN ('queued','running') ORDER BY history_entry.sequence LIMIT 100 FOR UPDATE",
          [after, instanceId],
        );
        for (const row of rows) {
          if (!row.workspaceId || !row.sourceId) throw Error("Invalid execution scope");
          const previous = executionSchema.parse(decode(row.content));
          const now = Date.now();
          const content = executionSchema.parse({
            ...previous,
            state: "outcome_unknown",
            code: "outcome_unknown",
            finishedAt: new Date(now).toISOString(),
            durationMs: Math.max(0, now - Date.parse(previous.startedAt)),
          });
          await c.execute(
            "UPDATE history_entry SET content=?,revision=revision+1,updatedAt=UTC_TIMESTAMP(3) WHERE id=?",
            [JSON.stringify(content), row.id],
          );
          await this.writeAudit(
            c,
            row.ownerId,
            { workspaceId: row.workspaceId, sourceId: row.sourceId },
            {
              event: "query.unknown",
              outcome: "unknown",
              executionId: row.id,
              connectorId: previous.connectorId,
            },
          );
        }
        await c.commit();
        if (rows.length < 100) return;
        after = rows.at(-1)?.sequence ?? after;
      } catch (error) {
        await c.rollback();
        throw error;
      } finally {
        c.release();
      }
    }
  }
}
