/** Design-only state model. It neither authorizes nor executes a database operation. */
export type Operation = "update" | "insert" | "delete";
export type Scenario =
  | "success"
  | "changed"
  | "revoked"
  | "overLimit"
  | "expired"
  | "rollback"
  | "unknown"
  | "confirmationLost"
  | "rowScope"
  | "permitExpired";
export type Phase =
  | "draft"
  | "preparing"
  | "preview"
  | "confirming"
  | "reconciling"
  | "recovery"
  | "executing"
  | "success"
  | "invalid"
  | "rolledBack"
  | "unknown";
export type ExecutionStatus = "running" | "rejected" | "rolledBack" | "committed" | "unknown";
/** Fake server metadata, kept independently of the currently displayed page. No row values. */
export type ReviewExecution = Readonly<{
  id: string;
  confirmationId: string;
  previewId: string;
  operation: Operation;
  scenario: Scenario;
  status: ExecutionStatus;
  step: number;
  reason: string;
}>;
export type ReviewState = {
  operation: Operation;
  scenario: Scenario;
  phase: Phase;
  step: number;
  acknowledged: boolean;
  tableInput: string;
  generation: number;
  reason: string;
  confirmationId: string | null;
  executionId: string | null;
  executionRecords: readonly ReviewExecution[];
};
export type ReviewEvent =
  | { type: "RESET"; operation?: Operation; scenario?: Scenario }
  | { type: "PREVIEW" }
  | { type: "EDIT" }
  | { type: "OPEN_CONFIRM" }
  | { type: "CLOSE_CONFIRM" }
  | { type: "ACK"; value: boolean }
  | { type: "TABLE"; value: string }
  | { type: "CONFIRM"; generation: number }
  | { type: "CANCEL" }
  | { type: "CHECK_RECEIPT" }
  | { type: "CHECK_CONFIRMATION" }
  | { type: "SIMULATE_RELOAD" }
  | { type: "OPEN_RECOVERY" }
  | { type: "OPEN_EXECUTION"; id: string }
  | { type: "RETURN_TO_DRAFT" }
  | { type: "TICK"; generation: number; phase: Phase; step: number };
export const tableName = "demo_customers";
export const operations = { update: "修改数据", insert: "新增数据", delete: "删除数据" } as const;
export const scenarios: Record<Scenario, string> = {
  success: "正常完成",
  changed: "执行时目标值不一致",
  revoked: "执行前权限撤销",
  overLimit: "影响范围超过上限",
  expired: "预览已过期",
  rollback: "执行失败并明确回滚",
  unknown: "提交后断线 · 结果未知",
  confirmationLost: "确认应答丢失 · 找回原执行",
  rowScope: "写入后行范围不合格",
  permitExpired: "提交许可超过本机时限",
};
export const progress = [
  "重新确认授权",
  "锁定并核对目标",
  "事务内执行及写后范围核验",
  "申请限时提交许可",
  "提交中",
  "核对执行回执",
];
export const demoRows = [
  { id: "1001", name: "林示例", city: "上海", before: "普通" },
  { id: "1002", name: "陈示例", city: "杭州", before: "普通" },
  { id: "1003", name: "王示例", city: "北京", before: "普通" },
];
export function initialReview(): ReviewState {
  return {
    operation: "update",
    scenario: "success",
    phase: "draft",
    step: 0,
    acknowledged: false,
    tableInput: "",
    generation: 1,
    reason: "",
    confirmationId: null,
    executionId: null,
    executionRecords: [],
  };
}
export function currentExecution(state: ReviewState): ReviewExecution | null {
  return state.executionRecords.find((record) => record.id === state.executionId) ?? null;
}
export function pendingExecutions(state: ReviewState): readonly ReviewExecution[] {
  return state.executionRecords.filter(
    (record) => record.status === "running" || record.status === "unknown",
  );
}
export function tickingExecution(state: ReviewState): ReviewExecution | undefined {
  return state.executionRecords.find((record) => record.status === "running");
}
export function submissionLabel(state: ReviewState): string {
  const record = currentExecution(state);
  if (!record) return "尚未创建执行";
  switch (record.status) {
    case "running":
      return "等待确定结果";
    case "rejected":
      return "检查拒绝，本次未提交";
    case "rolledBack":
      return "已确认回滚，本次未提交";
    case "committed":
      return "已取得提交成功回执";
    case "unknown":
      return "结果未知，尚无确定回执";
  }
}
export function mayConfirm(state: ReviewState): boolean {
  return (
    state.phase === "confirming" &&
    pendingExecutions(state).length === 0 &&
    state.acknowledged &&
    (state.operation !== "delete" || state.tableInput === tableName)
  );
}
export function reviewStage(state: ReviewState): number {
  switch (state.phase) {
    case "draft":
    case "preparing":
      return 0;
    case "preview":
    case "confirming":
      return 1;
    case "invalid":
      return state.executionId ? 2 : 1;
    case "executing":
    case "reconciling":
    case "rolledBack":
      return 2;
    case "recovery":
    case "success":
    case "unknown":
      return 3;
  }
}
function recordPhase(record: ReviewExecution): Phase {
  switch (record.status) {
    case "running":
      return "executing";
    case "rejected":
      return "invalid";
    case "rolledBack":
      return "rolledBack";
    case "committed":
      return "success";
    case "unknown":
      return "unknown";
  }
}
function openRecord(state: ReviewState, record: ReviewExecution): ReviewState {
  return {
    ...state,
    phase: recordPhase(record),
    operation: record.operation,
    scenario: record.scenario,
    step: record.step,
    reason: record.reason,
    confirmationId: record.confirmationId,
    executionId: record.id,
    acknowledged: false,
    tableInput: "",
    generation: state.generation + 1,
  };
}
function publishRecord(state: ReviewState, record: ReviewExecution): ReviewState {
  const next = {
    ...state,
    step: record.step,
    executionRecords: state.executionRecords.map((entry) =>
      entry.id === record.id ? record : entry,
    ),
  };
  return state.phase === "executing" && state.executionId === record.id
    ? { ...next, phase: recordPhase(record), reason: record.reason }
    : next;
}
function advanceExecution(record: ReviewExecution): ReviewExecution {
  if (record.step === 0 && record.scenario === "revoked")
    return {
      ...record,
      status: "rejected",
      reason: "模拟写入权限已撤销，未进入 DML。旧预览不能恢复使用。",
    };
  if (record.step === 1 && record.scenario === "changed")
    return {
      ...record,
      status: "rejected",
      reason: "模拟编号 1002 执行时的完整行值与预览不一致，本次未提交；请重新预览全部目标。",
    };
  if (record.step === 1 && record.scenario === "rowScope" && record.operation === "delete")
    return {
      ...record,
      status: "rejected",
      reason: "预设演示：删除前旧行不满足本机行范围，整笔拒绝，未进入 DML。",
    };
  if (record.step === 2 && record.scenario === "rowScope")
    return {
      ...record,
      status: "rolledBack",
      reason:
        "预设演示：新增行或修改后行不满足本机行范围，已模拟确认整笔回滚；不是数据库真实校验结果。",
    };
  if (record.step === 2 && record.scenario === "rollback")
    return {
      ...record,
      status: "rolledBack",
      reason: "模拟执行失败并收到明确回滚确认；不自动重试。",
    };
  if (record.step === 3 && record.scenario === "permitExpired")
    return {
      ...record,
      status: "rolledBack",
      reason:
        "预设演示：本机单调计时预算已耗尽，旧许可不再有效；已模拟确认回滚，不重复申请以延长期限。",
    };
  if (record.step === 4 && record.scenario === "unknown")
    return {
      ...record,
      status: "unknown",
      reason: "模拟提交后连接中断，未取得确定回执。数据可能已改变，请先核对原执行。",
    };
  return record.step === 5
    ? { ...record, status: "committed" }
    : { ...record, step: record.step + 1 };
}
export function reviewReducer(state: ReviewState, event: ReviewEvent): ReviewState {
  if (event.type === "RESET")
    return {
      ...initialReview(),
      operation: event.operation ?? state.operation,
      scenario: event.scenario ?? state.scenario,
      generation: state.generation + 1,
    };
  if (event.type === "SIMULATE_RELOAD" || event.type === "OPEN_RECOVERY")
    return {
      ...state,
      phase: "recovery",
      confirmationId: null,
      executionId: null,
      acknowledged: false,
      tableInput: "",
      step: 0,
      reason:
        event.type === "SIMULATE_RELOAD"
          ? "模拟页面临时身份已清空。请从当前管理员、工作区与来源的演示记录找回原操作。"
          : "只读查看当前范围的演示记录，不创建确认、不再次执行。",
      generation: state.generation + 1,
    };
  if (event.type === "OPEN_EXECUTION" && state.phase === "recovery") {
    const record = state.executionRecords.find((entry) => entry.id === event.id);
    return record ? openRecord(state, record) : state;
  }
  if (event.type === "CHECK_CONFIRMATION" && state.phase === "reconciling") {
    const record = state.executionRecords.find(
      (entry) => entry.confirmationId === state.confirmationId,
    );
    return record
      ? openRecord(state, record)
      : { ...state, reason: "尚未取得原确认的登记结果；保持待核对，不把未查到当成未执行。" };
  }
  if (
    (event.type === "EDIT" || event.type === "RETURN_TO_DRAFT") &&
    !pendingExecutions(state).length
  )
    return {
      ...state,
      phase: "draft",
      step: 0,
      acknowledged: false,
      tableInput: "",
      reason: "",
      confirmationId: null,
      executionId: null,
      generation: state.generation + 1,
    };
  if (event.type === "PREVIEW" && state.phase === "draft" && !pendingExecutions(state).length)
    return { ...state, phase: "preparing", reason: "" };
  if (event.type === "OPEN_CONFIRM" && state.phase === "preview")
    return { ...state, phase: "confirming", acknowledged: false, tableInput: "" };
  if (event.type === "CLOSE_CONFIRM" && state.phase === "confirming")
    return { ...state, phase: "preview", acknowledged: false, tableInput: "" };
  if (event.type === "ACK" && state.phase === "confirming")
    return { ...state, acknowledged: event.value };
  if (event.type === "TABLE" && state.phase === "confirming")
    return { ...state, tableInput: event.value };
  if (event.type === "CONFIRM" && event.generation === state.generation && mayConfirm(state)) {
    const suffix = String(state.generation).padStart(4, "0");
    const record: ReviewExecution = {
      id: `DEMO-W${suffix}`,
      confirmationId: `DEMO-C${suffix}`,
      previewId: `DEMO-P${suffix}`,
      operation: state.operation,
      scenario: state.scenario,
      status: "running",
      step: 0,
      reason: "",
    };
    return {
      ...state,
      phase: state.scenario === "confirmationLost" ? "reconciling" : "executing",
      step: 0,
      confirmationId: record.confirmationId,
      executionId: state.scenario === "confirmationLost" ? null : record.id,
      executionRecords: [...state.executionRecords, record],
      reason:
        state.scenario === "confirmationLost"
          ? "模拟确认应答丢失。客户端尚未拿到执行编号，不能据此判断是否执行；先核对原确认。"
          : "",
    };
  }
  const selected = currentExecution(state);
  if (
    event.type === "CANCEL" &&
    state.phase === "executing" &&
    selected?.status === "running" &&
    selected.step < 4
  )
    return publishRecord(state, {
      ...selected,
      status: "rolledBack",
      reason: "模拟已收到回滚确认，本次未提交。",
    });
  if (event.type === "CHECK_RECEIPT" && state.phase === "unknown")
    return { ...state, reason: "模拟核对：仍未取得确定回执，保持结果未知，不重新执行。" };
  if (
    event.type !== "TICK" ||
    event.generation !== state.generation ||
    event.phase !== state.phase ||
    event.step !== state.step
  )
    return state;
  if (state.phase === "preparing") {
    if (state.scenario === "overLimit")
      return {
        ...state,
        phase: "invalid",
        reason: "模拟发现 21 条记录，超过本机上限 20 条；整笔拒绝，没有截取前 20 条继续。",
      };
    if (state.scenario === "expired")
      return {
        ...state,
        phase: "invalid",
        reason: "模拟预览已过期，原确认无效。请重新预览并核对。",
      };
    return { ...state, phase: "preview" };
  }
  const running = tickingExecution(state);
  return running ? publishRecord(state, advanceExecution(running)) : state;
}
