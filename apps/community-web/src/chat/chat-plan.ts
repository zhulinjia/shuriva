type ParameterKind = "string" | "integer" | "decimal" | "boolean" | "null";
type Parameter = { kind: ParameterKind; value: string };
export type ChatPlan =
  | { kind: "clarification"; question: string }
  | {
      kind: "query";
      explanation: string;
      sql: string;
      parameters: Parameter[];
      maxRows: number;
      schemaVersion: string;
    };

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).length <= limit
  );
}

/** A damaged response must never downgrade an AI-bound query into a manual query. */
export function decodeChatPlan(value: unknown): ChatPlan {
  if (
    object(value, ["kind", "question"]) &&
    value.kind === "clarification" &&
    text(value.question, 4096)
  )
    return { kind: "clarification", question: value.question };
  if (
    !object(value, ["kind", "explanation", "sql", "parameters", "maxRows", "schemaVersion"]) ||
    value.kind !== "query" ||
    !text(value.explanation, 4096) ||
    !text(value.sql, 16384) ||
    !Array.isArray(value.parameters) ||
    value.parameters.length > 64 ||
    !Number.isSafeInteger(value.maxRows) ||
    Number(value.maxRows) < 1 ||
    Number(value.maxRows) > 1000 ||
    typeof value.schemaVersion !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.schemaVersion)
  )
    throw new Error("invalid model plan");
  const kinds = new Set(["string", "integer", "decimal", "boolean", "null"]);
  const parameters: Parameter[] = [];
  for (const item of value.parameters as unknown[]) {
    if (
      !object(item, ["kind", "value"]) ||
      typeof item.kind !== "string" ||
      !kinds.has(item.kind) ||
      typeof item.value !== "string" ||
      new TextEncoder().encode(item.value).length > 4096
    )
      throw new Error("invalid model plan");
    parameters.push({ kind: item.kind as ParameterKind, value: item.value });
  }
  return {
    kind: "query",
    explanation: value.explanation,
    sql: value.sql,
    parameters,
    maxRows: Number(value.maxRows),
    schemaVersion: value.schemaVersion,
  };
}
