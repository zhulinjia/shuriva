import { createHash } from "node:crypto";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
export interface DiagnosticFields {
  requestId?: string;
  ownerId?: string;
  workspaceId?: string;
  sourceId?: string;
  connectorId?: string;
  taskId?: string;
  executionId?: string;
  code?: string;
  state?: string;
  operation?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  attempt?: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ids = [
  "requestId",
  "ownerId",
  "workspaceId",
  "sourceId",
  "connectorId",
  "taskId",
  "executionId",
] as const;
const states = new Set([
  "queued",
  "running",
  "registered",
  "accepted",
  "execution_started",
  "commit_intent",
  "committed",
  "rolled_back",
  "rejected",
  "outcome_unknown",
  "cancelled",
  "failed",
  "expired",
  "completed",
  "succeeded",
  "ok",
  "pending",
  "ready",
]);
const operations = new Set([
  "insert",
  "update",
  "delete",
  "read",
  "query",
  "read_query",
  "cancel_read",
  "preview",
  "execute",
  "status",
  "cancel",
  "recover",
  "claim",
  "permit",
  "model_schema",
  "model_authorize",
  "generate",
  "prepare",
  "scan",
  "export",
]);
const businessCodes = new Set([
  "UNKNOWN",
  "UNAVAILABLE",
  "INVALID",
  "DENIED",
  "CONFLICT",
  "CAPACITY",
  "STALE",
  "INVALID_PLAN",
  "MODEL_UNAVAILABLE",
  "FROZEN",
  "EXPIRED",
  "NOT_FOUND",
  "committed",
  "cancelled",
  "denied",
  "frozen",
  "expired",
  "unavailable",
  "commit_unknown",
  "delivery_unknown",
  "recovery_unproven",
  "preview_too_large",
  "retention_cleanup_failed",
  "lease_cleanup_failed",
  "schema_changed",
  "unsupported",
  "unknown",
]);
/** No generic object/err serializer: unknown keys and all free text are dropped. */
export function safeFields(input: DiagnosticFields = {}): Record<string, string | number> {
  const output: Record<string, string | number> = {};
  for (const key of ids)
    if (typeof input[key] === "string" && uuid.test(input[key])) output[key] = input[key];
  if (typeof input.code === "string")
    output.code =
      businessCodes.has(input.code) || errorCodes.has(input.code) ? input.code : "UNKNOWN";
  if (typeof input.state === "string")
    output.state = states.has(input.state) ? input.state : "unknown";
  if (typeof input.operation === "string")
    output.operation = operations.has(input.operation) ? input.operation : "unknown";
  if (
    input.method &&
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(input.method)
  )
    output.method = input.method;
  // Only route templates supplied by the framework, never originalUrl or query.
  if (input.route && input.route.length <= 200 && /^[a-zA-Z0-9_/:.*-]+$/.test(input.route))
    output.route = input.route;
  for (const key of ["status", "durationMs", "attempt"] as const) {
    const value = input[key];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER
    )
      output[key] = Math.round(value);
  }
  return output;
}

export function safeError(error: unknown): Record<string, unknown> {
  try {
    return classifyError(error);
  } catch {
    return { errorKind: "unreadable" };
  }
}
const errorCodes = new Set([
  "EACCES",
  "EPERM",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ENOENT",
  "EEXIST",
  "ENOSPC",
  "EMFILE",
  "ABORT_ERR",
  "ERR_ABORTED",
  "ER_ACCESS_DENIED_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_LOCK_DEADLOCK",
  "ER_DUP_ENTRY",
  "ER_NO_SUCH_TABLE",
  "INVALID",
  "DENIED",
  "NOT_FOUND",
  "CONFLICT",
  "UNAVAILABLE",
  "CAPACITY",
  "FROZEN",
  "EXPIRED",
]);
/** Capture our own logger call site; never inspect an external Error.stack. */
export function diagnosticLocations(): string[] {
  return (new Error("Diagnostic call site").stack ?? "")
    .split("\n")
    .slice(1, 20)
    .flatMap((line) => {
      const match = /(?:^|[/\\])(src[/\\][A-Za-z0-9_./\\-]+\.[cm]?[jt]s):([0-9]+):([0-9]+)/.exec(
        line,
      );
      if (!match || /^src[/\\]logging[/\\]/.test(match[1])) return [];
      return [`${match[1].replaceAll("\\", "/")}:${match[2]}:${match[3]}`];
    })
    .slice(0, 8);
}
function classifyError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { errorKind: "unknown" };
  const name = Reflect.get(error, "name"),
    code = Reflect.get(error, "code");
  const errorKind = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "AbortError",
    "TimeoutError",
  ].includes(name)
    ? name
    : "Error";
  const errorCode = typeof code === "string" && errorCodes.has(code) ? code : "UNCLASSIFIED";
  const frames = diagnosticLocations();
  return {
    errorKind,
    errorCode,
    locations: frames,
    errorFingerprint: createHash("sha256")
      .update(JSON.stringify([errorKind, errorCode, frames]))
      .digest("hex")
      .slice(0, 20),
  };
}
