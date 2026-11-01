import { Button, ConfirmDialog, InfoDialog } from "@workspace/ui";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  FileCheck2,
  LockKeyhole,
  PencilLine,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import {
  currentExecution,
  demoRows,
  initialReview,
  mayConfirm,
  type Operation,
  operations,
  progress,
  reviewReducer,
  reviewStage,
  type Scenario,
  scenarios,
  tableName,
  tickingExecution,
} from "./flow";
import { ExecutionIdentity, ReconcilingConfirmation, RecoveryList } from "./Recovery";

const operationIcons = { update: PencilLine, insert: Plus, delete: Trash2 };
const visibleStages = ["编写草稿", "核对预览", "确认执行", "结果与审计"];

export function WriteReview() {
  const [state, dispatch] = useReducer(reviewReducer, undefined, initialReview);
  const [panel, setPanel] = useState<"policy" | "principles" | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [newLevel, setNewLevel] = useState("重点");
  const running = tickingExecution(state);
  useEffect(() => {
    if (state.phase !== "preparing" && !running) return;
    const timer = window.setTimeout(
      () =>
        dispatch({
          type: "TICK",
          generation: state.generation,
          phase: state.phase,
          step: state.step,
        }),
      state.phase === "preparing" ? 700 : 850,
    );
    return () => window.clearTimeout(timer);
  }, [state.phase, state.step, state.generation, running]);
  const busy = state.phase === "preparing" || !!running;
  const preview = state.phase === "preview" || state.phase === "confirming";
  const terminal = ["success", "invalid", "rolledBack", "unknown"].includes(state.phase);
  const activeStage = reviewStage(state);
  const changedCount = state.operation === "insert" ? 2 : 3;
  const Icon = operationIcons[state.operation];
  const selectedExecution = currentExecution(state);
  const reset = (operation?: Operation, scenario?: Scenario) => {
    setRecovery(false);
    setNewLevel("重点");
    dispatch({ type: "RESET", operation, scenario });
  };
  return (
    <main className="write-review">
      <div className="wr-review-strip">
        <span className="wr-review-tag">DESIGN REVIEW · 08</span>
        <strong>交互原型，不连接任何数据库</strong>
        <span>全部为虚构数据；模拟成功不代表实际执行。</span>
      </div>
      <div className="wr-shell">
        <aside className="wr-sidebar">
          <div className="wr-brand">
            <span>S</span>
            <div>
              Stackoryn<small>数据工作空间</small>
            </div>
          </div>
          <div className="wr-space-label">当前工作空间</div>
          <div className="wr-space">
            <span className="wr-space-icon">演</span>
            <div>
              客户运营演示<small>虚构环境 · Community</small>
            </div>
          </div>
          <nav aria-label="设计评审导航">
            <div className="wr-nav-selected">
              <PencilLine size={17} />
              受控写入<span>设计</span>
            </div>
            <Button className="wr-nav-button" onClick={() => setPanel("policy")}>
              <ShieldCheck size={17} />
              本机授权说明
            </Button>
            <Button className="wr-nav-button" onClick={() => setPanel("principles")}>
              <FileCheck2 size={17} />
              本次审核要点
            </Button>
          </nav>
          <div className="wr-side-note">
            <LockKeyhole size={18} />
            <strong>先预览，再确认</strong>
            <p>模型只生成候选草稿。真正执行前仍须平台、本机策略和数据库共同校验。</p>
          </div>
          <div className="wr-version">
            第八阶段 · 设计待审核
            <br />
            正式写入能力尚未开放
          </div>
        </aside>
        <div className="wr-content">
          <header className="wr-header">
            <div className="wr-breadcrumb">
              客户运营演示
              <ChevronRight size={14} />
              <span>受控写入</span>
            </div>
            <div className="wr-avatar">
              管<span>本地管理员</span>
            </div>
          </header>
          <section className="wr-page-heading">
            <div>
              <p className="wr-eyebrow">CONTROLLED CHANGES</p>
              <h1>每一次变更，都先看清影响</h1>
              <p>核对完整目标和前后差异，再确认当前这一次操作。</p>
            </div>
            <span className="wr-status">
              <LockKeyhole size={14} />
              正式入口关闭
            </span>
          </section>
          <section className="wr-controls" aria-label="评审演示控制">
            <label>
              演示场景
              <select
                value={state.scenario}
                disabled={busy}
                onChange={(event) => reset(undefined, event.target.value as Scenario)}
              >
                {Object.entries(scenarios).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span>这里的控制只用于走查设计，不是正式产品的重试入口。</span>
            <Button className="wr-link" onClick={() => reset()}>
              <RefreshCw size={14} />
              重置演示
            </Button>
          </section>
          <div className="wr-recovery-toolbar">
            <Button className="wr-secondary" onClick={() => dispatch({ type: "OPEN_RECOVERY" })}>
              <FileCheck2 size={15} />
              待处理与最近执行（模拟）
            </Button>
            <Button className="wr-link" onClick={() => dispatch({ type: "SIMULATE_RELOAD" })}>
              <RefreshCw size={14} />
              模拟刷新／重新登录
            </Button>
            <span>只清空演示页面身份，独立内存账本继续保留；不触发新执行。</span>
          </div>
          {state.phase !== "recovery" && (
            <ol className="wr-stepper" aria-label="变更流程">
              {visibleStages.map((label, index) => (
                <li
                  key={label}
                  aria-current={activeStage === index ? "step" : undefined}
                  className={index < activeStage ? "done" : index === activeStage ? "active" : ""}
                >
                  <span>{index < activeStage ? <Check size={14} /> : index + 1}</span>
                  {label}
                </li>
              ))}
            </ol>
          )}
          <div className="wr-grid">
            <div>
              <section className="wr-card wr-source">
                <div className="wr-source-icon">
                  <Database size={20} />
                </div>
                <div>
                  <span className="wr-muted">目标数据源</span>
                  <strong>
                    演示客户库 <small>review_crm</small>
                  </strong>
                  <p>本机 Connector · 授权状态仅作示意</p>
                </div>
                <span className="wr-chip">虚构环境</span>
              </section>
              {state.phase === "draft" || state.phase === "preparing" ? (
                <section className="wr-card wr-draft">
                  <div className="wr-card-heading">
                    <h2>编写变更草稿</h2>
                    <span className="wr-muted">步骤 1 / 4</span>
                  </div>
                  <fieldset disabled={busy}>
                    <legend className="wr-label">操作类型</legend>
                    <div className="wr-operation-picker">
                      {(Object.keys(operations) as Operation[]).map((operation) => {
                        const OIcon = operationIcons[operation];
                        return (
                          <Button
                            key={operation}
                            aria-pressed={state.operation === operation}
                            className={state.operation === operation ? "selected" : ""}
                            onClick={() => reset(operation)}
                          >
                            <OIcon size={17} />
                            {operations[operation]}
                          </Button>
                        );
                      })}
                    </div>
                    <div className="wr-field-row">
                      <label>
                        目标表
                        <input value={tableName} readOnly />
                      </label>
                      <label>
                        本机影响行数上限
                        <input value="20 行（建议默认）" readOnly />
                      </label>
                    </div>
                    {state.operation === "update" && (
                      <label className="wr-full-label">
                        客户等级的新值（可修改演示草稿）
                        <select
                          value={newLevel}
                          onChange={(event) => setNewLevel(event.target.value)}
                        >
                          <option>重点</option>
                          <option>潜力</option>
                        </select>
                      </label>
                    )}
                    <label className="wr-full-label">
                      {state.operation === "insert"
                        ? "待新增内容（预设示例）"
                        : "变更草稿（预设示例）"}
                      <textarea
                        readOnly
                        value={
                          state.operation === "update"
                            ? `将本次选中的 3 位演示客户，从“普通”调整为“${newLevel}”。`
                            : state.operation === "delete"
                              ? "删除本次选中的 3 位虚构客户。请先展示完整目标，由我核对。"
                              : "新增 2 位虚构客户：周演示（成都）、李演示（苏州），客户等级为普通。"
                        }
                      />
                    </label>
                    <div className="wr-inline-note">
                      <ShieldCheck size={17} />
                      <p>
                        本次原型不调用模型。正式产品发送模型前会逐项确认问题与结构范围；预览行和数据库凭据不发送。
                      </p>
                    </div>
                    {state.operation === "delete" && (
                      <div className="wr-warning">
                        <TriangleAlert size={18} />
                        <p>删除成功后不能通过平台撤销。正式执行前需确认目标与所需备份。</p>
                      </div>
                    )}
                    <div className="wr-card-footer">
                      <span>草稿本身不会产生数据变更。</span>
                      <Button
                        className="wr-primary"
                        disabled={busy}
                        onClick={() => dispatch({ type: "PREVIEW" })}
                      >
                        {busy ? (
                          <>
                            <span className="wr-spinner" />
                            正在生成模拟预览
                          </>
                        ) : (
                          <>
                            生成模拟预览
                            <ArrowRight size={16} />
                          </>
                        )}
                      </Button>
                    </div>
                  </fieldset>
                </section>
              ) : null}
              {preview && (
                <section className="wr-card wr-preview">
                  <div className="wr-card-heading">
                    <div>
                      <span className="wr-eyebrow">PREVIEW · DEMO</span>
                      <h2>核对本次{operations[state.operation]}</h2>
                    </div>
                    <span className="wr-chip wr-purple">
                      <Clock3 size={13} />2 分钟有效期 · 演示不计时
                    </span>
                  </div>
                  <div className="wr-preview-summary">
                    <span>
                      目标表<strong>{tableName}</strong>
                    </span>
                    <span>
                      完整目标<strong>{changedCount} 条</strong>
                    </span>
                    <span>
                      实际变更<strong>{changedCount} 条</strong>
                    </span>
                    <span>
                      无需修改<strong>0 条</strong>
                    </span>
                  </div>
                  <p className="wr-table-description">
                    {state.operation === "insert"
                      ? "以下是输入预览。主键和默认生成时间在执行时才可确认。"
                      : "仅针对以下完整主键集合；之后新增的匹配行不会自动加入。"}
                  </p>
                  <ChangeRows operation={state.operation} newLevel={newLevel} />
                  <div className="wr-preview-caption">
                    已展示全部 {changedCount} 条 · 未截断 · 只包含虚构、非敏感字段
                  </div>
                  <div className={state.operation === "delete" ? "wr-warning" : "wr-inline-note"}>
                    {state.operation === "delete" ? (
                      <TriangleAlert size={18} />
                    ) : (
                      <ShieldCheck size={18} />
                    )}
                    <p>
                      {state.operation === "delete"
                        ? "这次删除无法通过平台撤销。确认后仍会重新核对权限、目标和事务条件。"
                        : "执行时完整行值须与预览一致；无法检测期间先改变又恢复等所有中间变更。"}
                    </p>
                  </div>
                  <div className="wr-card-footer">
                    <Button className="wr-secondary" onClick={() => dispatch({ type: "EDIT" })}>
                      <ArrowLeft size={15} />
                      返回修改
                    </Button>
                    <Button
                      className={state.operation === "delete" ? "wr-danger" : "wr-primary"}
                      onClick={() => dispatch({ type: "OPEN_CONFIRM" })}
                    >
                      核对并确认
                      <ArrowRight size={16} />
                    </Button>
                  </div>
                </section>
              )}
              {state.phase === "reconciling" && (
                <ReconcilingConfirmation state={state} dispatch={dispatch} />
              )}
              {state.phase === "recovery" && <RecoveryList state={state} dispatch={dispatch} />}
              {state.phase === "executing" && (
                <section className="wr-card wr-execution" aria-live="polite">
                  <div className="wr-card-heading">
                    <h2>正在演示执行过程</h2>
                    <span className="wr-chip">原执行编号 {selectedExecution?.id}</span>
                  </div>
                  <p>这里的进度是模拟。正式实现只显示 Connector 的真实步骤和回执。</p>
                  <ExecutionIdentity state={state} />
                  <ol className="wr-progress">
                    {progress.map((label, index) => (
                      <li
                        className={
                          index < state.step ? "done" : index === state.step ? "current" : ""
                        }
                        key={label}
                      >
                        <span>
                          {index < state.step ? (
                            <Check size={16} />
                          ) : index === state.step ? (
                            <span className="wr-spinner" />
                          ) : (
                            index + 1
                          )}
                        </span>
                        <div>
                          <strong>{label}</strong>
                          {index === state.step && (
                            <p>
                              {index === 4
                                ? "提交可能已经发生，不能保证取消。"
                                : "模拟正在处理，尚无确定提交结果。"}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                  <div className="wr-card-footer">
                    <span>
                      {state.step >= 4
                        ? "请等待原执行回执，不要再次发起。"
                        : "请求取消后仍须等待确定回滚。"}
                    </span>
                    <Button
                      className="wr-secondary"
                      disabled={state.step >= 4}
                      onClick={() => dispatch({ type: "CANCEL" })}
                    >
                      模拟请求取消
                    </Button>
                  </div>
                </section>
              )}
              {terminal && (
                <section className={`wr-card wr-result ${state.phase}`} aria-live="polite">
                  <div className="wr-result-icon">
                    {state.phase === "success" ? (
                      <CheckCircle2 size={30} />
                    ) : (
                      <TriangleAlert size={30} />
                    )}
                  </div>
                  <span className="wr-eyebrow">SIMULATED RESULT</span>
                  <h2>
                    {state.phase === "success"
                      ? "模拟已取得提交成功回执"
                      : state.phase === "unknown"
                        ? "结果未知，请先核对原执行"
                        : state.phase === "rolledBack"
                          ? "模拟已确认回滚"
                          : "本次预览或执行已停止"}
                  </h2>
                  <p>
                    {state.phase === "success"
                      ? `模拟实际变更 ${changedCount} 条；这不是数据库真实结果，没有执行任何 SQL。`
                      : state.reason}
                  </p>
                  <div className="wr-result-summary">
                    <span>
                      操作
                      <strong>
                        <Icon size={15} />
                        {operations[state.operation]}
                      </strong>
                    </span>
                    <span>
                      数据源<strong>演示客户库</strong>
                    </span>
                  </div>
                  <ExecutionIdentity state={state} />
                  {state.phase === "unknown" ? (
                    <>
                      <div className="wr-warning">
                        <LockKeyhole size={18} />
                        <p>
                          该来源的新写入应被冻结。没有自动重试或“假定失败再次执行”；查询原状态也不会触发新操作。
                        </p>
                      </div>
                      <div className="wr-result-actions">
                        <Button
                          className="wr-secondary"
                          onClick={() => dispatch({ type: "CHECK_RECEIPT" })}
                        >
                          <RefreshCw size={15} />
                          仅核对原回执（模拟）
                        </Button>
                        <Button className="wr-link" onClick={() => setRecovery((value) => !value)}>
                          查看核对指引
                        </Button>
                      </div>
                      {recovery && (
                        <div className="wr-recovery">
                          <ol>
                            <li>恢复本机 Connector 和持久日志的可用性。</li>
                            <li>核对原执行编号的签名回执，不重新执行 SQL。</li>
                            <li>没有回执时由管理员核对数据库与备份；人工备注不是提交证明。</li>
                            <li>保持未知并停止新写入；解除冻结需另行明确确认风险。</li>
                          </ol>
                          <p>
                            待审核方案：未知时的加密核对包仅在本机保留，最多 24
                            小时，到期清除敏感负载。它不延长执行授权。本原型没有创建核对包。
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="wr-result-actions">
                      <Button className="wr-secondary" onClick={() => dispatch({ type: "EDIT" })}>
                        {state.phase === "success" ? "返回草稿" : "返回修改并重新预览"}
                      </Button>
                    </div>
                  )}
                  <details className="wr-audit">
                    <summary>查看脱敏审计示意</summary>
                    <dl>
                      <dt>事件</dt>
                      <dd>
                        {state.phase === "success"
                          ? "写入提交已确认"
                          : state.phase === "unknown"
                            ? "写入结果未知"
                            : state.phase === "rolledBack"
                              ? "已确认回滚"
                              : "预览或执行被拒绝"}
                      </dd>
                      <dt>操作者</dt>
                      <dd>当前本地管理员</dd>
                      <dt>保留内容</dt>
                      <dd>范围、状态、数量和原执行编号</dd>
                      <dt>不保留</dt>
                      <dd>密码、SQL、参数值和原始行</dd>
                    </dl>
                  </details>
                </section>
              )}
            </div>
            <aside className="wr-context">
              <section className="wr-card">
                <div className="wr-card-heading">
                  <h2>
                    <ShieldCheck size={18} />
                    确认前会检查
                  </h2>
                </div>
                <ul>
                  {[
                    "工作区与数据源当前绑定",
                    "Connector 身份和本机写策略",
                    "受限账号与可写表、字段",
                    "完整目标、结构与预览期限",
                  ].map((label) => (
                    <li key={label}>
                      <span className="wr-check">
                        <Check size={12} />
                      </span>
                      {label}
                    </li>
                  ))}
                </ul>
                <p className="wr-context-note">这些是设计要求，原型没有执行真实校验。</p>
                <Button className="wr-link" onClick={() => setPanel("policy")}>
                  查看授权说明
                  <ArrowRight size={14} />
                </Button>
              </section>
              <section className="wr-card wr-rule-card">
                <span className="wr-rule-icon">
                  <LockKeyhole size={19} />
                </span>
                <h3>确认只对这一次有效</h3>
                <p>修改草稿、执行时行值不一致、权限撤销或预览过期，都需要重新预览。</p>
                <p>整行比对不证明期间从未变更；不把这种限制隐藏成“检测所有变化”。</p>
                <div className="wr-rule-divider" />
                <h3>没有回执，就不猜结果</h3>
                <p>提交后断线不等于失败；保持结果未知，先核对，禁止自动重试。</p>
              </section>
            </aside>
          </div>
          <footer className="wr-bottom-note">
            设计评审原型 · 复用 React / Base UI / Lucide · 无 API 连接、无数据库操作、无本地持久化
          </footer>
        </div>
      </div>
      <ConfirmDialog
        open={state.phase === "confirming"}
        title={state.operation === "delete" ? "确认本次删除（模拟）" : "确认当前变更（模拟）"}
        description={`仅针对演示客户库 / ${tableName}，本次完整目标 ${changedCount} 条。${state.operation === "update" ? `客户等级：普通 → ${newLevel}。` : ""}确认将推进模拟流程，不会修改数据库。`}
        confirmLabel={state.operation === "delete" ? "确认删除并模拟执行" : "确认并模拟执行"}
        confirmDisabled={!mayConfirm(state)}
        onCancel={() => dispatch({ type: "CLOSE_CONFIRM" })}
        onConfirm={() => dispatch({ type: "CONFIRM", generation: state.generation })}
      >
        <div className="wr-confirm-fields">
          <label>
            <input
              type="checkbox"
              checked={state.acknowledged}
              onChange={(event) => dispatch({ type: "ACK", value: event.target.checked })}
            />
            我已核对本次预览中的全部目标与变更内容
          </label>
          {state.operation === "delete" && (
            <>
              <p className="wr-confirm-warning">删除成功后无法通过平台撤销，请确认已有所需备份。</p>
              <label>
                输入表名 {tableName}
                <input
                  value={state.tableInput}
                  autoComplete="off"
                  onChange={(event) => dispatch({ type: "TABLE", value: event.target.value })}
                />
              </label>
            </>
          )}
        </div>
      </ConfirmDialog>
      <InfoDialog
        open={panel !== null}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
        title={panel === "policy" ? "本机写入授权 · 设计说明" : "本次请审核这些规则"}
      >
        {panel === "policy" ? (
          <div className="wr-explanation">
            <p>
              正式写入尚未开放。未来需要在 Connector
              所在机器单独配置受限写入账号和本机策略，平台不接收数据库密码。
            </p>
            <ul>
              <li>区分新增、修改、删除权限，明确可写字段和行数上限。</li>
              <li>新增核对新行；修改核对旧行和新行；删除核对旧行。行范围依赖字段默认受保护。</li>
              <li>事务内按数据库真实回读值检查新行范围和默认值，无法证明则整笔回滚。</li>
              <li>受限凭据、表结构和完整副作用证明均须通过检查。</li>
              <li>不把元数据不可见当作没有触发器或外键。</li>
              <li>平台、Connector 和数据库共同校验，前端不能扩权。</li>
            </ul>
            <p>这里没有授权开关或凭据输入；本次只审核流程。</p>
          </div>
        ) : (
          <div className="wr-explanation">
            <p>建议：单个本地管理员确认，默认上限20行、硬上限100行，预览2分钟有效。</p>
            <ul>
              <li>修改和删除冻结完整主键集合，执行时当前完整行值与预览一致。</li>
              <li>不能检测所有中间变更，例如先改为其他值又恢复；本阶段不擅自给源表加版本列。</li>
              <li>确认应答丢失后查原确认；模拟刷新后从独立账本找回原执行，不创建第二次执行。</li>
              <li>提交许可绑定请求挑战和本机单调计时预算，重取同一许可不延期；本页仅预设演示。</li>
              <li>删除需要额外表名确认，没有平台一键撤销。</li>
              <li>提交中不保证取消；未知时暂停新写入，不自动重试。</li>
              <li>参数与预览不自动进入会话历史或长期日志。</li>
            </ul>
            <p>这些仍是待你审核的设计，尚未用于真实数据库。</p>
          </div>
        )}
      </InfoDialog>
    </main>
  );
}

function ChangeRows({ operation, newLevel }: { operation: Operation; newLevel: string }) {
  const rows =
    operation === "insert"
      ? [
          { id: "执行时生成", name: "周演示", city: "成都", before: "—" },
          { id: "执行时生成", name: "李演示", city: "苏州", before: "—" },
        ]
      : demoRows;
  return (
    <div className="wr-table-scroll">
      <table>
        <caption className="wr-sr-only">完整变更差异预览，全部为虚构记录</caption>
        <thead>
          <tr>
            <th>主键</th>
            <th>客户</th>
            <th>城市</th>
            <th>变更前</th>
            <th>变更后</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="wr-mono">{row.id}</td>
              <td>{row.name}</td>
              <td>{row.city}</td>
              <td>
                <span className="wr-before">{row.before}</span>
              </td>
              <td>
                {operation === "delete" ? (
                  <span className="wr-delete-tag">整行删除</span>
                ) : (
                  <span className="wr-after">
                    {operation === "insert" ? "普通 · 新增" : newLevel}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
