import { withRequestTimeout } from "../models/model-session.ts";
import type {
  Capability,
  Change,
  Confirmation,
  ConfirmationResult,
  Discovery,
  Execution,
  ExecutionState,
  Plan,
  Preview,
  Row,
  TargetReceipt,
  Value,
  ValueKind,
} from "./model";
import { valueKinds } from "./model.ts";

export interface MutationClient {
  /** Stops this page's HTTP waits; does not cancel or retry a database operation. */
  dispose(): void;
  capability(): Promise<Capability>;
  preview(plan: Plan): Promise<Preview>;
  confirm(confirmation: Confirmation): Promise<Execution>;
  lookup(id: string): Promise<ConfirmationResult>;
  close(confirmation: Confirmation): Promise<ConfirmationResult>;
  executions(after?: string): Promise<Discovery>;
  recover(): Promise<Discovery>;
  execution(id: string): Promise<Execution>;
  cancel(id: string): Promise<Execution>;
  receipts(
    after?: string,
  ): Promise<{ items: TargetReceipt[]; nextCursor: string | null; metadataError: string | null }>;
}
export class MutationAccessError extends Error {
  readonly reason: "login_required" | "access_denied";
  constructor(reason: "login_required" | "access_denied") {
    super(
      reason === "login_required"
        ? "登录已过期。重新登录后请找回原操作，不要重复提交。"
        : "当前没有权限核对或操作该数据源，请勿重复提交。",
    );
    this.reason = reason;
  }
}
const invalid = () => Error("服务返回的数据不完整，当前操作仍需核对，请勿重新提交。");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length > max) throw invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid();
  return value;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw invalid();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result))
    throw invalid();
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (!Number.isFinite(Date.parse(result))) throw invalid();
  return result;
}
function parsedRow(value: unknown): Row | null {
  if (value === null) return null;
  const row = object(value);
  if (Object.keys(row).length > 256) throw invalid();
  const result: Row = Object.create(null);
  for (const [key, raw] of Object.entries(row)) {
    if (!key || key.length > 64) throw invalid();
    const item = object(raw),
      kind = text(item.kind, 16);
    if (!valueKinds.includes(kind as ValueKind)) throw invalid();
    const entry: Value = { kind: kind as ValueKind, value: text(item.value, 32768) };
    if (new TextEncoder().encode(entry.value).byteLength > 32768) throw invalid();
    result[key] = entry;
  }
  return result;
}
function previewMetadata(value: unknown): Omit<Preview, "rows"> {
  const body = object(value),
    operation = text(body.operation, 8);
  if (!["insert", "update", "delete"].includes(operation)) throw invalid();
  const commitment = text(body.commitment, 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(commitment)) throw invalid();
  const table = text(body.table, 64);
  if (!table) throw invalid();
  const revision = integer(body.revision, 4294967295);
  if (revision < 1) throw invalid();
  return {
    previewId: id(body.previewId),
    commitment,
    revision,
    operation: operation as Preview["operation"],
    table,
    rowCount: integer(body.rowCount, 100),
    expiresAt: timestamp(body.expiresAt),
  };
}
export function parsePreview(value: unknown): Preview {
  const body = object(value),
    metadata = previewMetadata(body);
  if (!Array.isArray(body.rows) || body.rows.length !== metadata.rowCount || !metadata.rowCount)
    throw invalid();
  const rows: Change[] = body.rows.map((item: unknown) => {
    const change = object(item);
    const columns = (raw: unknown): string[] | undefined => {
      if (raw === undefined) return undefined;
      if (!Array.isArray(raw) || raw.length > 256) throw invalid();
      const result = raw.map((column) => text(column, 64));
      if (result.some((column) => !column) || new Set(result).size !== result.length)
        throw invalid();
      return result;
    };
    const parsed: Change = {
      before: parsedRow(change.before),
      after: parsedRow(change.after),
      generatedColumns: columns(change.generatedColumns),
      defaultColumns: columns(change.defaultColumns),
    };
    if (
      metadata.operation !== "insert" &&
      (parsed.generatedColumns?.length || parsed.defaultColumns?.length)
    )
      throw invalid();
    if (
      parsed.generatedColumns?.some((column) => Object.hasOwn(parsed.after ?? {}, column)) ||
      parsed.defaultColumns?.some((column) => !Object.hasOwn(parsed.after ?? {}, column)) ||
      parsed.generatedColumns?.some((column) => parsed.defaultColumns?.includes(column))
    )
      throw invalid();
    return parsed;
  });
  return { ...metadata, rows };
}
export function parseExecution(value: unknown): Execution {
  const body = object(value),
    state = text(body.state, 32);
  if (
    ![
      "registered",
      "running",
      "commit_intent",
      "committed",
      "rolled_back",
      "rejected",
      "outcome_unknown",
    ].includes(state)
  )
    throw invalid();
  return {
    ...previewMetadata(body),
    executionId: id(body.executionId),
    confirmationId: id(body.confirmationId),
    state: state as ExecutionState,
    permitIssued: bool(body.permitIssued),
    cancelRequested: bool(body.cancelRequested),
    createdAt: timestamp(body.createdAt),
    updatedAt: timestamp(body.updatedAt),
    code: body.code === null ? null : text(body.code, 48),
    reconciliationExpiresAt:
      body.reconciliationExpiresAt === null ? null : timestamp(body.reconciliationExpiresAt),
    affectedRows: body.affectedRows === null ? null : integer(body.affectedRows, 100),
  };
}
function targetReceipt(value: unknown): TargetReceipt {
  const body = object(value);
  return {
    executionId: id(body.executionId),
    rowCount: integer(body.rowCount, 100),
    targetIdentity: text(body.targetIdentity, 256),
  };
}
function metadataError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value !== "orphaned_receipt" && value !== "receipt_mismatch") throw invalid();
  return value;
}
function discovery(value: unknown): Discovery {
  const body = object(value);
  if (
    !Array.isArray(body.items) ||
    body.items.length > 100 ||
    (body.recoveredReceipts !== undefined &&
      (!Array.isArray(body.recoveredReceipts) || body.recoveredReceipts.length > 100))
  )
    throw invalid();
  return {
    items: body.items.map(parseExecution),
    nextCursor: body.nextCursor === null ? null : text(body.nextCursor, 20),
    metadataError: metadataError(body.metadataError),
    ...(Array.isArray(body.recoveredReceipts)
      ? {
          recoveredReceipts: body.recoveredReceipts.map(targetReceipt),
          receiptCursor: body.receiptCursor === null ? null : text(body.receiptCursor, 80),
        }
      : {}),
  };
}
function confirmationResult(value: unknown): ConfirmationResult {
  const body = object(value),
    state = text(body.state, 16);
  if (state !== "unseen" && state !== "closed" && state !== "registered") throw invalid();
  if ((state === "registered") !== (body.execution !== null)) throw invalid();
  return { state, execution: body.execution === null ? null : parseExecution(body.execution) };
}
async function request(
  url: string,
  body: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(url, {
    signal,
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      if (signal.aborted) throw Error("cancelled");
      const item = await reader.read();
      if (signal.aborted) throw Error("cancelled");
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 1200000) {
        void reader.cancel().catch(() => {});
        throw invalid();
      }
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (!response.ok) {
    if (response.status === 401) throw new MutationAccessError("login_required");
    if (response.status === 403 || response.status === 404)
      throw new MutationAccessError("access_denied");
    if (response.status === 409) throw Error("操作状态或授权已变化。请核对原确认和执行记录。");
    if (response.status === 503) {
      if (length <= 2048) {
        let originUnavailable = false;
        try {
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          originUnavailable =
            !!body &&
            typeof body === "object" &&
            "error" in body &&
            body.error === "MCP_CHANGE_ORIGIN_UNAVAILABLE";
        } catch {
          /* Treat malformed error bodies as generic unavailability. */
        }
        if (originUnavailable)
          throw Error("草稿来源校验当前不可用，已停止生成预览；请勿重复提交草稿。");
      }
      throw Error("受控写入暂不可用；原操作结果请从记录中继续核对。");
    }
    throw Error("请求未完成，请核对原操作，勿直接重复提交。");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export const mutationRequestTimeoutMs = 30_000;
export function mutationClient(
  workspace: string,
  source: string,
  options: { fetch?: typeof fetch; requestTimeoutMs?: number; originInvocationId?: string } = {},
): MutationClient {
  const base = `/api/mutations/${encodeURIComponent(workspace)}/${encodeURIComponent(source)}`;
  const lifetime = new AbortController();
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? mutationRequestTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > mutationRequestTimeoutMs)
    throw Error("Invalid mutation request timeout");
  const boundedRequest = async (url: string, body?: unknown): Promise<unknown> => {
    let operationSignal: AbortSignal | undefined;
    try {
      return await withRequestTimeout(lifetime.signal, timeoutMs, (signal) => {
        operationSignal = signal;
        return request(url, body, signal, fetcher);
      });
    } catch (error) {
      if (lifetime.signal.aborted)
        throw Error("已停止本页面的网络等待；这不代表数据库操作已取消，请按原编号核对。");
      if (operationSignal?.aborted)
        throw Error(
          "等待响应超时，原操作仍可能已登记或执行。请核对原确认和执行记录，不要重复提交。",
        );
      throw error;
    }
  };
  return {
    dispose() {
      lifetime.abort();
    },
    async capability() {
      const body = object(await boundedRequest(`${base}/capability`));
      const tables = body.tables;
      if (!Array.isArray(tables) || tables.length > 500) throw invalid();
      return {
        enabled: bool(body.enabled),
        available: bool(body.available),
        executionEnabled: bool(body.executionEnabled),
        code: text(body.code, 80),
        tables: tables.map((item) => text(item, 64)),
      };
    },
    async preview(plan) {
      return parsePreview(
        await boundedRequest(`${base}/previews`, {
          plan,
          ...(options.originInvocationId ? { originInvocationId: options.originInvocationId } : {}),
        }),
      );
    },
    async confirm(input) {
      return parseExecution(
        await boundedRequest(
          `${base}/previews/${encodeURIComponent(input.previewId)}/confirm`,
          input,
        ),
      );
    },
    async lookup(confirmationId) {
      return confirmationResult(
        await boundedRequest(`${base}/confirmations/${encodeURIComponent(confirmationId)}`),
      );
    },
    async close(input) {
      return confirmationResult(
        await boundedRequest(
          `${base}/confirmations/${encodeURIComponent(input.confirmationId)}/close`,
          input,
        ),
      );
    },
    async executions(after) {
      return discovery(
        await boundedRequest(
          `${base}/executions${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        ),
      );
    },
    async recover() {
      return discovery(await boundedRequest(`${base}/recovery`, {}));
    },
    async execution(executionId) {
      return parseExecution(
        await boundedRequest(`${base}/executions/${encodeURIComponent(executionId)}`),
      );
    },
    async cancel(executionId) {
      return parseExecution(
        await boundedRequest(`${base}/executions/${encodeURIComponent(executionId)}/cancel`, {}),
      );
    },
    async receipts(after) {
      const body = object(
        await boundedRequest(
          `${base}/receipts${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        ),
      );
      if (!Array.isArray(body.items) || body.items.length > 100) throw invalid();
      return {
        items: body.items.map(targetReceipt),
        nextCursor: body.nextCursor === null ? null : text(body.nextCursor, 80),
        metadataError: metadataError(body.metadataError),
      };
    },
  };
}
