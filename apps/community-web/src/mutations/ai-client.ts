import type { Plan, Predicate, Value, ValueKind } from "./model.ts";
import { valueKinds } from "./model.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("AI 返回的草稿不完整。");
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw Error("AI 返回的草稿不完整。");
  return value;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw Error("AI 返回了不支持的属性。");
}
function array(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw Error("AI 返回的草稿超过支持范围。");
  return value;
}
function identifier(value: unknown): string {
  const result = string(value, 64);
  if (
    !result ||
    Array.from(result).some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  )
    throw Error("AI 返回了无效字段。");
  return result;
}
function typedValue(value: unknown): Value {
  const input = object(value);
  exact(input, ["kind", "value"]);
  const kind = string(input.kind, 16);
  if (!valueKinds.includes(kind as ValueKind)) throw Error("AI 返回了不支持的值类型。");
  const raw = string(input.value, 32768);
  if (new TextEncoder().encode(raw).byteLength > 32768) throw Error("AI 返回的值过大。");
  return { kind: kind as ValueKind, value: raw };
}
export function decodeMutationAIPlan(value: unknown): Plan {
  const input = object(value),
    operation = string(input.operation, 8),
    table = identifier(input.table);
  const assignments = (value: unknown) => {
    const result = array(value, 1, 256).map((item) => {
      const input = object(item);
      exact(input, ["column", "value"]);
      return { column: identifier(input.column), value: typedValue(input.value) };
    });
    if (new Set(result.map((item) => item.column)).size !== result.length)
      throw Error("AI 返回了重复字段。");
    return result;
  };
  if (operation === "insert") {
    exact(input, ["operation", "table", "rows"]);
    return { operation, table, rows: array(input.rows, 1, 100).map(assignments) };
  }
  if (operation !== "update" && operation !== "delete") throw Error("AI 返回了不支持的操作。");
  exact(
    input,
    operation === "update"
      ? ["operation", "table", "changes", "where"]
      : ["operation", "table", "where"],
  );
  const where = array(input.where, 1, 32).map((item): Predicate => {
    const filter = object(item),
      op = string(filter.operator, 16),
      column = identifier(filter.column);
    if (op === "is_null" || op === "not_null") {
      exact(filter, ["column", "operator"]);
      return { column, operator: op };
    }
    if (!["eq", "ne", "lt", "lte", "gt", "gte"].includes(op))
      throw Error("AI 返回了不支持的筛选条件。");
    exact(filter, ["column", "operator", "value"]);
    return {
      column,
      operator: op as "eq" | "ne" | "lt" | "lte" | "gt" | "gte",
      value: typedValue(filter.value),
    };
  });
  return operation === "update"
    ? { operation, table, changes: assignments(input.changes), where }
    : { operation, table, where };
}
export type MutationAICandidate =
  | { kind: "clarification"; question: string }
  | { kind: "mutation"; explanation: string; plan: Plan };
export function decodeMutationAICandidate(value: unknown): MutationAICandidate {
  const input = object(value);
  if (input.kind === "clarification") {
    exact(input, ["kind", "question"]);
    const question = string(input.question, 4096);
    if (!question.trim()) throw Error("AI 没有返回可用澄清问题。");
    return { kind: "clarification", question };
  }
  exact(input, ["kind", "explanation", "plan"]);
  if (input.kind !== "mutation") throw Error("AI 没有返回变更候选。");
  return {
    kind: "mutation",
    explanation: string(input.explanation, 4096),
    plan: decodeMutationAIPlan(input.plan),
  };
}
export type MutationAIReview = {
  ticketId: string;
  disclosureHash: string;
  question: string;
  expiresAt: string;
  destination: { baseUrl: string; model: string; configVersion: string };
  schema: {
    database: string;
    tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
  };
  writeScope: Record<
    string,
    { insert: string[]; update: string[]; filter: string[]; delete: boolean }
  >;
  semantics?: unknown;
};
/** Includes every disclosed semantic value, using readable labels rather than raw JSON. */
export function mutationSemanticLines(value: unknown): Array<{ label: string; text: string }> {
  if (value === undefined) return [];
  const input = object(value);
  exact(input, ["entities", "fields", "relationships", "metrics"]);
  const common = (item: Record<string, unknown>) =>
    `${string(item.name, 160)}；说明：${string(item.description, 8192)}；同义词：${
      array(item.aliases, 0, 100)
        .map((alias) => string(alias, 160))
        .join("、") || "无"
    }`;
  const field = (value: unknown) => {
    const item = object(value);
    exact(item, ["table", "column"]);
    return `${identifier(item.table)}.${identifier(item.column)}`;
  };
  const lines: Array<{ label: string; text: string }> = [];
  for (const value of array(input.entities, 0, 256)) {
    const item = object(value);
    exact(item, ["name", "description", "aliases", "table"]);
    lines.push({ label: "业务对象", text: `${identifier(item.table)} · ${common(item)}` });
  }
  for (const value of array(input.fields, 0, 4096)) {
    const item = object(value);
    exact(item, ["name", "description", "aliases", "table", "column"]);
    lines.push({
      label: "字段说明",
      text: `${identifier(item.table)}.${identifier(item.column)} · ${common(item)}`,
    });
  }
  for (const value of array(input.relationships, 0, 4096)) {
    const item = object(value);
    exact(item, ["name", "description", "aliases", "from", "to"]);
    lines.push({
      label: "业务关联",
      text: `${field(item.from)} → ${field(item.to)} · ${common(item)}`,
    });
  }
  for (const value of array(input.metrics, 0, 4096)) {
    const item = object(value);
    exact(item, ["name", "description", "aliases", "field", "aggregation"]);
    lines.push({
      label: "指标说明",
      text: `${field(item.field)} · ${string(item.aggregation, 80)} · ${common(item)}`,
    });
  }
  return lines;
}
export function decodeMutationAIReview(value: unknown): MutationAIReview {
  const input = object(value),
    destination = object(input.destination),
    schema = object(input.schema);
  const tables = array(schema.tables, 1, 256).map((item) => {
    const table = object(item);
    return {
      name: identifier(table.name),
      columns: array(table.columns, 1, 256).map((item) => {
        const column = object(item);
        return { name: identifier(column.name), type: string(column.type, 64) };
      }),
    };
  });
  if (tables.reduce((count, table) => count + table.columns.length, 0) > 4096)
    throw Error("本次发送范围过大。");
  const writeScope: MutationAIReview["writeScope"] = Object.create(null);
  const scopes = object(input.writeScope);
  for (const table of tables) {
    const allowed = object(scopes[table.name]);
    const names = (raw: unknown) => array(raw, 0, 256).map(identifier);
    if (typeof allowed.delete !== "boolean") throw Error("发送范围不完整。");
    writeScope[table.name] = {
      insert: names(allowed.insert),
      update: names(allowed.update),
      filter: names(allowed.filter),
      delete: allowed.delete,
    };
  }
  const ticketId = string(input.ticketId, 36),
    disclosureHash = string(input.disclosureHash, 43),
    expiresAt = string(input.expiresAt, 40);
  if (
    !/^[0-9a-f-]{36}$/.test(ticketId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(disclosureHash) ||
    !Number.isFinite(Date.parse(expiresAt))
  )
    throw Error("发送范围已失效。");
  if (
    input.semantics !== undefined &&
    new TextEncoder().encode(JSON.stringify(input.semantics)).byteLength > 32768
  )
    throw Error("业务说明超过发送范围上限。");
  mutationSemanticLines(input.semantics);
  return {
    ticketId,
    disclosureHash,
    expiresAt,
    question: string(input.question, 8192),
    destination: {
      baseUrl: string(destination.baseUrl, 2048),
      model: string(destination.model, 256),
      configVersion: string(destination.configVersion, 128),
    },
    schema: { database: identifier(schema.database), tables },
    writeScope,
    ...(input.semantics === undefined ? {} : { semantics: input.semantics }),
  };
}
