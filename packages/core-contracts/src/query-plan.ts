import type { AuthorizedSchema } from "./model-schema.js";

type ParameterKind = "string" | "integer" | "decimal" | "boolean" | "null";
type Parameter = { kind: ParameterKind; value: string };

export type CandidatePlan =
  | { kind: "clarification"; question: string }
  | {
      kind: "query";
      explanation: string;
      table: string;
      columns: string[];
      filters: Array<
        | { column: string; operator: "is_null" | "is_not_null" }
        | {
            column: string;
            operator: "eq" | "null_safe_eq" | "ne" | "lt" | "le" | "gt" | "ge";
            parameter: Parameter;
          }
      >;
      orderBy: Array<{ column: string; direction: "asc" | "desc" }>;
      maxRows: number;
    };

export type ValidatedPlan =
  | { kind: "clarification"; question: string }
  | {
      kind: "query";
      explanation: string;
      table: string;
      sql: string;
      parameters: Parameter[];
      maxRows: number;
    };

const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const integer = /^-?(?:0|[1-9][0-9]*)$/;
const decimal = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const operators = {
  eq: "=",
  null_safe_eq: "<=>",
  ne: "<>",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
} as const;

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function text(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxBytes &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).length <= maxBytes &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
  );
}

function parameter(value: unknown, nullSafe: boolean): Parameter {
  if (
    !object(value, ["kind", "value"]) ||
    typeof value.kind !== "string" ||
    typeof value.value !== "string" ||
    value.value.length > 4096 ||
    new TextEncoder().encode(value.value).length > 4096
  )
    throw new Error("INVALID_PLAN");
  const { kind, value: raw } = value;
  if (kind === "string") return { kind, value: raw };
  if (kind === "null" && nullSafe && raw === "") return { kind, value: raw };
  if (kind === "boolean" && (raw === "true" || raw === "false")) return { kind, value: raw };
  if (kind === "integer" && integer.test(raw) && raw.length <= 20) {
    const number = BigInt(raw);
    if (number >= -9_223_372_036_854_775_808n && number <= 18_446_744_073_709_551_615n)
      return { kind, value: raw };
  }
  if (kind === "decimal" && decimal.test(raw) && raw.length <= 65) return { kind, value: raw };
  throw new Error("INVALID_PLAN");
}

/**
 * Decode untrusted model output and construct SQL only from authorized identifiers
 * and a small fixed grammar. Execution still requires the Connector's local policy.
 */
export function validateCandidate(value: unknown, schema: AuthorizedSchema): ValidatedPlan {
  if (object(value, ["kind", "question"]) && value.kind === "clarification") {
    if (!text(value.question, 4096)) throw new Error("INVALID_PLAN");
    return { kind: "clarification", question: value.question };
  }
  if (
    !object(value, ["kind", "explanation", "table", "columns", "filters", "orderBy", "maxRows"]) ||
    value.kind !== "query" ||
    !text(value.explanation, 4096) ||
    typeof value.table !== "string" ||
    !identifier.test(value.table) ||
    !Array.isArray(value.columns) ||
    value.columns.length < 1 ||
    value.columns.length > 256 ||
    !Array.isArray(value.filters) ||
    value.filters.length > 64 ||
    !Array.isArray(value.orderBy) ||
    value.orderBy.length > 32 ||
    !Number.isSafeInteger(value.maxRows) ||
    Number(value.maxRows) < 1 ||
    Number(value.maxRows) > 1000
  )
    throw new Error("INVALID_PLAN");
  const allowed = schema.get(value.table);
  if (!allowed || allowed.size === 0) throw new Error("INVALID_PLAN");
  const column = (name: unknown): string => {
    if (typeof name !== "string" || !identifier.test(name) || !allowed.has(name))
      throw new Error("INVALID_PLAN");
    return `\`${name}\``;
  };
  const columns = value.columns.map(column);
  if (new Set(columns).size !== columns.length) throw new Error("INVALID_PLAN");
  const parameters: Parameter[] = [];
  const filters = value.filters.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_PLAN");
    const filter = item as Record<string, unknown>;
    if (filter.operator === "is_null" || filter.operator === "is_not_null") {
      if (!object(filter, ["column", "operator"])) throw new Error("INVALID_PLAN");
      return `${column(filter.column)} ${filter.operator === "is_null" ? "IS NULL" : "IS NOT NULL"}`;
    }
    if (
      !object(filter, ["column", "operator", "parameter"]) ||
      typeof filter.operator !== "string" ||
      !Object.hasOwn(operators, filter.operator)
    )
      throw new Error("INVALID_PLAN");
    const operation = filter.operator as keyof typeof operators;
    parameters.push(parameter(filter.parameter, operation === "null_safe_eq"));
    return `${column(filter.column)} ${operators[operation]} ?`;
  });
  const order = value.orderBy.map((item: unknown) => {
    if (
      !object(item, ["column", "direction"]) ||
      (item.direction !== "asc" && item.direction !== "desc")
    )
      throw new Error("INVALID_PLAN");
    return `${column(item.column)} ${item.direction.toUpperCase()}`;
  });
  const sql = `SELECT ${columns.join(", ")} FROM \`${value.table}\`${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}${order.length ? ` ORDER BY ${order.join(", ")}` : ""}`;
  if (new TextEncoder().encode(sql).length > 16384) throw new Error("INVALID_PLAN");
  return {
    kind: "query",
    explanation: value.explanation,
    table: value.table,
    sql,
    parameters,
    maxRows: Number(value.maxRows),
  };
}
