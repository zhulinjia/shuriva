export const valueKinds = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "null",
  "binary",
  "date",
  "datetime",
] as const;
export type ValueKind = (typeof valueKinds)[number];
export type Value = { kind: ValueKind; value: string };
export type Row = Record<string, Value>;
export type Change = {
  before: Row | null;
  after: Row | null;
  generatedColumns?: string[];
  defaultColumns?: string[];
};
export type Operation = "insert" | "update" | "delete";
export type Assignment = { column: string; value: Value };
export type Predicate = {
  column: string;
  operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "is_null" | "not_null";
  value?: Value;
};
export type Plan =
  | { operation: "insert"; table: string; rows: Assignment[][] }
  | { operation: "update"; table: string; changes: Assignment[]; where: Predicate[] }
  | { operation: "delete"; table: string; where: Predicate[] };
export type Preview = {
  previewId: string;
  commitment: string;
  revision: number;
  operation: Operation;
  table: string;
  rowCount: number;
  expiresAt: string;
  rows: Change[];
};
export type ExecutionState =
  | "registered"
  | "running"
  | "commit_intent"
  | "committed"
  | "rolled_back"
  | "rejected"
  | "outcome_unknown";
export type Execution = Omit<Preview, "rows"> & {
  executionId: string;
  confirmationId: string;
  state: ExecutionState;
  permitIssued: boolean;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  code: string | null;
  reconciliationExpiresAt: string | null;
  affectedRows: number | null;
};
export type Capability = {
  enabled: boolean;
  available: boolean;
  executionEnabled: boolean;
  code: string;
  tables: string[];
};
export type Confirmation = {
  confirmationId: string;
  previewId: string;
  commitment: string;
  revision: number;
};
export type TargetReceipt = { executionId: string; rowCount: number; targetIdentity: string };
export type Discovery = {
  items: Execution[];
  nextCursor: string | null;
  recoveredReceipts?: TargetReceipt[];
  receiptCursor?: string | null;
  metadataError?: string | null;
};
export type ConfirmationResult = {
  state: "unseen" | "closed" | "registered";
  execution: Execution | null;
};
export const labels: Record<ExecutionState, string> = {
  registered: "已登记，等待本机核验",
  running: "正在核验与执行",
  commit_intent: "正在提交核对",
  committed: "已提交",
  rolled_back: "已回滚",
  rejected: "已拒绝",
  outcome_unknown: "结果未知，写入已冻结",
};
export const operationLabels: Record<Operation, string> = {
  insert: "新增",
  update: "修改",
  delete: "删除",
};
export const terminalStates: ReadonlySet<ExecutionState> = new Set([
  "committed",
  "rolled_back",
  "rejected",
]);
export function canCancel(execution: Execution): boolean {
  return (
    !execution.permitIssued &&
    !execution.cancelRequested &&
    ["registered", "running"].includes(execution.state)
  );
}
export function hasUnresolved(records: Execution[]): boolean {
  return records.some((record) => !terminalStates.has(record.state));
}
export function isFrozen(records: Execution[]): boolean {
  return records.some((record) => record.state === "outcome_unknown");
}
export function displayValue(value: Value | undefined): string {
  if (!value) return "—";
  if (value.kind === "null") return "NULL";
  if (value.kind === "string" && value.value === "") return "（空文本）";
  return value.value;
}
export function previewCounts(preview: Preview): {
  selected: number;
  changed: number;
  unchanged: number;
} {
  const changed =
    preview.operation === "update"
      ? preview.rows.filter((row) =>
          [...new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})])].some(
            (column) =>
              row.before?.[column]?.kind !== row.after?.[column]?.kind ||
              row.before?.[column]?.value !== row.after?.[column]?.value,
          ),
        ).length
      : preview.rowCount;
  return { selected: preview.rowCount, changed, unchanged: preview.rowCount - changed };
}
export function mayConfirm(
  preview: Preview | null,
  capability: Capability | null,
  acknowledged: boolean,
  tableName: string,
  now = Date.now(),
): boolean {
  return (
    !!preview &&
    !!capability?.available &&
    capability.executionEnabled &&
    preview.rows.length === preview.rowCount &&
    preview.rowCount > 0 &&
    Date.parse(preview.expiresAt) > now &&
    acknowledged &&
    (preview.operation !== "delete" || tableName === preview.table)
  );
}
export type FieldDraft = { id: string; column: string; kind: ValueKind; value: string };
export type PredicateDraft = FieldDraft & { operator: Predicate["operator"] };
export type Draft = {
  operation: Operation;
  table: string;
  rows: FieldDraft[][];
  changes: FieldDraft[];
  where: PredicateDraft[];
};
export function emptyField(): FieldDraft {
  return { id: crypto.randomUUID(), column: "", kind: "string", value: "" };
}
export function emptyDraft(): Draft {
  return {
    operation: "update",
    table: "",
    rows: [[emptyField()]],
    changes: [emptyField()],
    where: [{ ...emptyField(), operator: "eq" }],
  };
}
/** Loading a candidate only fills the editor; preview and confirmation stay separate. */
export function draftFromPlan(plan: Plan): Draft {
  const field = (item: Assignment): FieldDraft => ({
    id: crypto.randomUUID(),
    column: item.column,
    kind: item.value.kind,
    value: item.value.value,
  });
  const draft = emptyDraft();
  draft.operation = plan.operation;
  draft.table = plan.table;
  if (plan.operation === "insert") draft.rows = plan.rows.map((row) => row.map(field));
  else {
    draft.where = plan.where.map((item) => ({
      id: crypto.randomUUID(),
      column: item.column,
      operator: item.operator,
      kind: item.value?.kind ?? "null",
      value: item.value?.value ?? "",
    }));
    if (plan.operation === "update") draft.changes = plan.changes.map(field);
  }
  return draft;
}
function assignments(fields: FieldDraft[]): Assignment[] {
  if (
    !fields.length ||
    fields.length > 256 ||
    fields.some((field) => !field.column.trim() || field.column.length > 64) ||
    new Set(fields.map((field) => field.column.trim())).size !== fields.length
  )
    throw Error("请填写字段名称，且同一行不能重复填写字段。");
  return fields.map((field) => ({
    column: field.column.trim(),
    value: { kind: field.kind, value: field.kind === "null" ? "" : field.value },
  }));
}
export function buildPlan(draft: Draft): Plan {
  const table = draft.table.trim();
  if (!table || table.length > 64) throw Error("请先选择或填写目标表。");
  if (draft.operation === "insert") {
    if (!draft.rows.length || draft.rows.length > 100)
      throw Error("一次新增必须为 1 至 100 行，仍以本机授权上限为准。");
    return { operation: "insert", table, rows: draft.rows.map(assignments) };
  }
  if (
    !draft.where.length ||
    draft.where.length > 32 ||
    draft.where.some((field) => !field.column.trim() || field.column.length > 64)
  )
    throw Error("请填写至少一个筛选条件，不能直接操作整张表。");
  const where: Predicate[] = draft.where.map((field) => ({
    column: field.column.trim(),
    operator: field.operator,
    ...(field.operator === "is_null" || field.operator === "not_null"
      ? {}
      : { value: { kind: field.kind, value: field.kind === "null" ? "" : field.value } }),
  }));
  return draft.operation === "delete"
    ? { operation: "delete", table, where }
    : { operation: "update", table, changes: assignments(draft.changes), where };
}
