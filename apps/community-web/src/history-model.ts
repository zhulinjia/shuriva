import type { ChatMessage } from "./chat/chat-context.ts";
import type { VisualizationDefinition } from "./queries/result-presentation.ts";

export type ParameterKind = "string" | "integer" | "decimal" | "boolean" | "null";
export type Conversation = { title: string; messages: ChatMessage[] };
export type Artifact = {
  name: string;
  kind: "query" | "analysis" | "chart";
  sql: string;
  parameterKinds: ParameterKind[];
  maxRows: number;
  schemaVersion: string | null;
  notes: string;
  chart: { type: "bar" | "line"; x: string; y: string } | null;
};
export type HistoryRecord<T> = {
  id: string;
  revision: number;
  content: T;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type RestoredQueryDraft = {
  sql: string;
  parameters: Array<{ kind: ParameterKind; value: string }>;
  maxRows: number;
  schemaVersion: string | null;
  requiresParameterInput?: boolean;
  visualization?: VisualizationDefinition;
  artifact?: HistoryRecord<Artifact>;
};
export type QueryParameterInput = { kind: ParameterKind; value: string; needsInput?: boolean };
export function parameterInputs(draft: RestoredQueryDraft | undefined): QueryParameterInput[] {
  return (
    draft?.parameters.map((parameter) => ({
      kind: parameter.kind,
      value: draft.requiresParameterInput ? "" : parameter.value,
      needsInput: !!draft.requiresParameterInput && parameter.kind !== "null",
    })) ?? []
  );
}
export function changedParameterKind(kind: ParameterKind): QueryParameterInput {
  return { kind, value: "", needsInput: kind !== "null" };
}

const kinds = new Set(["string", "integer", "decimal", "boolean", "null"]);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function decodeHistoryCapability(value: unknown): boolean {
  if (!object(value) || typeof value.enabled !== "boolean")
    throw Error("Invalid history capability");
  return value.enabled;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}
export function decodeConversation(value: unknown): Conversation {
  if (
    !object(value) ||
    !text(value.title, 120) ||
    !value.title.trim() ||
    !Array.isArray(value.messages) ||
    value.messages.length > 200
  )
    throw Error("Invalid conversation");
  const seen = new Set<string>();
  const messages = value.messages.map((item: unknown): ChatMessage => {
    if (
      !object(item) ||
      !text(item.id, 36) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.id) ||
      seen.has(item.id) ||
      !["user", "assistant"].includes(String(item.role)) ||
      !text(item.text, 16384) ||
      !item.text.length
    )
      throw Error("Invalid conversation");
    seen.add(item.id);
    return { id: item.id, role: item.role as ChatMessage["role"], text: item.text };
  });
  return { title: value.title, messages };
}
/** MySQL JSON may reorder object keys; compare the explicit message fields in order. */
export function sameConversation(expected: Conversation | null, actual: unknown): boolean {
  if (!expected) return false;
  try {
    const conversation = decodeConversation(actual);
    return (
      conversation.title === expected.title &&
      conversation.messages.length === expected.messages.length &&
      conversation.messages.every((message, index) => {
        const prior = expected.messages[index];
        return (
          prior?.id === message.id && prior.role === message.role && prior.text === message.text
        );
      })
    );
  } catch {
    return false;
  }
}
export function decodeArtifact(value: unknown): Artifact {
  if (
    !object(value) ||
    !text(value.name, 120) ||
    !value.name.trim() ||
    !["query", "analysis", "chart"].includes(String(value.kind)) ||
    !text(value.sql, 16384) ||
    !value.sql.trim() ||
    !Array.isArray(value.parameterKinds) ||
    value.parameterKinds.length > 64 ||
    !value.parameterKinds.every((kind) => typeof kind === "string" && kinds.has(kind)) ||
    !Number.isSafeInteger(value.maxRows) ||
    Number(value.maxRows) < 1 ||
    Number(value.maxRows) > 1000 ||
    !text(value.notes, 4000) ||
    (value.schemaVersion !== null &&
      (typeof value.schemaVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.schemaVersion)))
  )
    throw Error("Invalid artifact");
  let chart: Artifact["chart"] = null;
  if (value.kind === "chart") {
    const candidate = value.chart;
    if (
      !object(candidate) ||
      !["bar", "line"].includes(String(candidate.type)) ||
      !text(candidate.x, 64) ||
      !candidate.x ||
      !text(candidate.y, 64) ||
      !candidate.y
    )
      throw Error("Invalid chart");
    chart = { type: candidate.type as "bar" | "line", x: candidate.x, y: candidate.y };
  } else if (value.chart !== null) throw Error("Invalid chart");
  return {
    name: value.name,
    kind: value.kind as Artifact["kind"],
    sql: value.sql,
    parameterKinds: value.parameterKinds as ParameterKind[],
    maxRows: Number(value.maxRows),
    schemaVersion: value.schemaVersion as string | null,
    notes: value.notes,
    chart,
  };
}

/** Saved definitions never carry parameter values or cached rows into a new execution. */
export function restoreArtifact(record: HistoryRecord<Artifact>): RestoredQueryDraft {
  const artifact = decodeArtifact(record.content);
  return {
    sql: artifact.sql,
    parameters: artifact.parameterKinds.map((kind) => ({ kind, value: "" })),
    maxRows: artifact.maxRows,
    schemaVersion: artifact.schemaVersion,
    requiresParameterInput: true,
    visualization: artifact.chart
      ? { kind: artifact.chart.type, x: artifact.chart.x, y: artifact.chart.y }
      : { kind: "table" },
    artifact: { ...record, content: artifact },
  };
}

/** Explicit allowlist prevents draft parameters, query results and UI state from being persisted. */
export function artifactContent(input: {
  name: string;
  kind: Artifact["kind"];
  sql: string;
  parameters: Array<{ kind: ParameterKind; value: string }>;
  maxRows: number;
  schemaVersion: string | null;
  notes: string;
  visualization: VisualizationDefinition;
}): Artifact {
  const chart =
    input.kind === "chart" &&
    input.visualization.kind !== "table" &&
    input.visualization.x &&
    input.visualization.y
      ? { type: input.visualization.kind, x: input.visualization.x, y: input.visualization.y }
      : null;
  return decodeArtifact({
    name: input.name.trim(),
    kind: input.kind,
    sql: input.sql,
    parameterKinds: input.parameters.map((parameter) => parameter.kind),
    maxRows: input.maxRows,
    schemaVersion: input.schemaVersion,
    notes: input.notes,
    chart,
  });
}
