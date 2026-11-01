import { Button } from "@workspace/ui";
import { FileCheck2, RefreshCw, Search, TriangleAlert } from "lucide-react";
import {
  currentExecution,
  operations,
  pendingExecutions,
  type ReviewEvent,
  type ReviewState,
  submissionLabel,
} from "./flow";

type Props = { state: ReviewState; dispatch: (event: ReviewEvent) => void };
const statusNames = {
  running: "演示执行中",
  rejected: "检查拒绝，未提交",
  rolledBack: "已确认回滚",
  committed: "已取得提交回执",
  unknown: "结果未知，先核对",
} as const;

export function ExecutionIdentity({ state }: { state: ReviewState }) {
  const record = currentExecution(state);
  return (
    <dl className="wr-execution-identity">
      <div>
        <dt>执行编号</dt>
        <dd>{record?.id ?? "尚未创建执行"}</dd>
      </div>
      <div>
        <dt>确认编号</dt>
        <dd>{record?.confirmationId ?? "尚未登记确认"}</dd>
      </div>
      <div>
        <dt>提交情况</dt>
        <dd>{submissionLabel(state)}</dd>
      </div>
    </dl>
  );
}

export function ReconcilingConfirmation({ state, dispatch }: Props) {
  return (
    <section className="wr-card wr-reconcile" aria-live="polite">
      <span className="wr-eyebrow">CONFIRMATION RECOVERY · DEMO</span>
      <h2>确认应答丢失，先找回原操作</h2>
      <p>{state.reason}</p>
      <dl className="wr-execution-identity">
        <div>
          <dt>客户端保留的原确认编号</dt>
          <dd>{state.confirmationId}</dd>
        </div>
        <div>
          <dt>客户端已知执行编号</dt>
          <dd>尚未取得；不代表未执行</dd>
        </div>
      </dl>
      <div className="wr-warning">
        <TriangleAlert size={17} />
        <p>
          原确认可能已登记并执行。核对只读取现有登记，不重发确认、不生成新执行编号；查不到也不能直接判定未执行。
        </p>
      </div>
      <div className="wr-result-actions">
        <Button className="wr-primary" onClick={() => dispatch({ type: "CHECK_CONFIRMATION" })}>
          <Search size={15} />
          核对原确认（模拟）
        </Button>
        <Button className="wr-secondary" onClick={() => dispatch({ type: "OPEN_RECOVERY" })}>
          从列表找回原操作
        </Button>
      </div>
    </section>
  );
}

export function RecoveryList({ state, dispatch }: Props) {
  const pending = pendingExecutions(state).length;
  return (
    <section className="wr-card wr-recovery-list" aria-live="polite">
      <div className="wr-card-heading">
        <div>
          <span className="wr-eyebrow">RECOVERY CENTER · DEMO</span>
          <h2>
            <FileCheck2 size={18} />
            待处理与最近执行
          </h2>
        </div>
        <span className="wr-chip">{pending} 项待核对</span>
      </div>
      <p>{state.reason}</p>
      <div className="wr-inline-note">
        <RefreshCw size={16} />
        <p>
          这是当前管理员 / 客户运营演示 /
          演示客户库的独立内存账本。“模拟刷新”清除页面身份后，仍可查回原记录。
          真实浏览器刷新会重置全部演示，正式产品须从服务端恢复；本页没有持久化存储。
        </p>
      </div>
      {state.executionRecords.length ? (
        <ul className="wr-records" aria-label="当前范围的演示执行记录">
          {state.executionRecords.map((record) => (
            <li key={record.id}>
              <div className="wr-record-title">
                <strong>{record.id}</strong>
                <span className={`wr-chip ${record.status === "unknown" ? "wr-unknown" : ""}`}>
                  {statusNames[record.status]}
                </span>
              </div>
              <p>{operations[record.operation]} · 演示客户库 / demo_customers</p>
              <p className="wr-mono">原确认：{record.confirmationId}</p>
              <Button
                className="wr-secondary"
                onClick={() => dispatch({ type: "OPEN_EXECUTION", id: record.id })}
              >
                查看 {record.id}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wr-empty-records">
          当前演示账本没有执行记录。真实产品仍须完成服务端核对，不能只凭空列表认定从未执行。
        </p>
      )}
      <div className="wr-card-footer">
        <span>
          {pending
            ? "存在未决执行：先核对原记录，不能创建新的确认。"
            : "查看记录不会创建确认或派发新执行。"}
        </span>
        <Button
          className="wr-secondary"
          disabled={pending > 0}
          onClick={() => dispatch({ type: "RETURN_TO_DRAFT" })}
        >
          返回草稿
        </Button>
      </div>
    </section>
  );
}
