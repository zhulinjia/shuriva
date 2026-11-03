import { Button } from "@workspace/ui";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { canCancel, type Execution, labels, operationLabels, type TargetReceipt } from "./model";

export function ExecutionRecord({
  record,
  busy,
  onRefresh,
  onCancel,
  readOnly = false,
}: {
  record: Execution;
  busy: boolean;
  onRefresh: () => void;
  onCancel: () => void;
  readOnly?: boolean;
}) {
  const unknown = record.state === "outcome_unknown";
  return (
    <section className={`mut-record ${unknown ? "mut-unknown" : ""}`} aria-label="本次执行状态">
      <div className="mut-section-title">
        <div>
          <span className="mut-eyebrow">{readOnly ? "历史记录（上次读取快照）" : "本次操作"}</span>
          <h3>{labels[record.state]}</h3>
        </div>
        <span className={`mut-state mut-state-${record.state}`}>
          {record.permitIssued && record.state === "running"
            ? "提交许可已签发"
            : labels[record.state]}
        </span>
      </div>
      <dl className="mut-identities">
        <div>
          <dt>确认编号</dt>
          <dd>{record.confirmationId}</dd>
        </div>
        <div>
          <dt>执行编号</dt>
          <dd>{record.executionId}</dd>
        </div>
        <div>
          <dt>操作与目标</dt>
          <dd>
            {operationLabels[record.operation]} · {record.table} · {record.rowCount} 行
          </dd>
        </div>
        <div>
          <dt>登记时间</dt>
          <dd>{new Date(record.createdAt).toLocaleString()}</dd>
        </div>
        {record.state === "committed" && (
          <div>
            <dt>实际变更</dt>
            <dd>{record.affectedRows === null ? "回执未提供计数" : `${record.affectedRows} 行`}</dd>
          </div>
        )}
      </dl>
      {unknown ? (
        <p className="mut-caution">
          <ShieldAlert size={17} />
          尚无足够证据确定是否提交，新的写入已冻结。请核对原回执，不要重新提交或删除执行日志。
        </p>
      ) : record.state === "committed" ? (
        <p>已取得原操作的提交事实。没有自动撤销；逆向修改需要新的预览和确认。</p>
      ) : record.state === "rolled_back" ? (
        <p>本次事务已明确回滚。执行编号仍保留，重新操作需要新预览。</p>
      ) : record.state === "rejected" ? (
        <p>本次执行已拒绝，执行编号仍保留；请查看授权与目标状态后再决定下一步。</p>
      ) : (
        <p>页面关闭、网络超时或取消请求不代表事务已经回滚；请等待原操作的确定结果。</p>
      )}
      {record.cancelRequested && (
        <p role="status">已登记取消请求，正在核对结果；不能据此认定“已取消”。</p>
      )}
      {unknown && record.reconciliationExpiresAt && (
        <p className="mut-muted">
          本机加密核对资料保留至 {new Date(record.reconciliationExpiresAt).toLocaleString()}
          。到期清理资料不会使旧操作可重新执行。
        </p>
      )}
      {record.code && <small className="mut-muted">核对代码：{record.code}</small>}
      {!readOnly && (
        <div className="mut-inline-actions">
          <Button className="outline-button" type="button" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={14} />
            核对原结果
          </Button>
          {canCancel(record) && (
            <Button className="outline-button" type="button" disabled={busy} onClick={onCancel}>
              请求取消
            </Button>
          )}
          {record.permitIssued &&
            !["committed", "rolled_back", "rejected"].includes(record.state) && (
              <span className="mut-muted">已进入提交核对，取消不可用。</span>
            )}
        </div>
      )}
    </section>
  );
}

export function RecoveredReceipts({
  receipts,
  cursor,
  busy,
  onMore,
}: {
  receipts: TargetReceipt[];
  cursor: string | null;
  busy: boolean;
  onMore: () => void;
}) {
  if (!receipts.length && !cursor) return null;
  return (
    <section className="mut-recent" aria-label="目标回执">
      <h3>从目标数据库找回的回执</h3>
      <p className="mut-muted">
        下列提交记录没有完整的平台确认资料，仅用于核对原结果。不能据此恢复旧确认或再次执行，也不会自动解除写入冻结。
      </p>
      <div className="mut-recent-list">
        {receipts.map((receipt) => (
          <div key={receipt.executionId} className="mut-recent-item">
            <span>
              <strong>原提交回执 · {receipt.rowCount} 行</strong>
              <code>{receipt.executionId}</code>
            </span>
            <span className="mut-state mut-state-committed">目标回执存在</span>
          </div>
        ))}
      </div>
      {cursor && (
        <Button type="button" className="outline-button" disabled={busy} onClick={onMore}>
          继续核对目标回执
        </Button>
      )}
    </section>
  );
}

export function RecentExecutions({
  records,
  busy,
  nextCursor,
  onOpen,
  onMore,
  snapshot = false,
  onReload,
}: {
  records: Execution[];
  busy: boolean;
  nextCursor: string | null;
  onOpen: (id: string) => void;
  onMore: () => void;
  snapshot?: boolean;
  onReload?: () => void;
}) {
  return (
    <section className="mut-recent" aria-label="待处理与最近执行">
      <div className="mut-section-title">
        <h3>待处理与最近执行</h3>
        <span className="mut-muted">
          {snapshot ? "上次读取的历史快照，可能已变化" : "只展示元数据，不保存原始值"}
        </span>
      </div>
      {snapshot && onReload && (
        <Button className="outline-button" type="button" disabled={busy} onClick={onReload}>
          重新读取执行历史
        </Button>
      )}
      {!records.length ? (
        <p className="mut-muted">当前读取未见执行记录；这不能单独证明旧确认未被登记。</p>
      ) : (
        <div className="mut-recent-list">
          {records.map((record) => (
            <Button
              type="button"
              className="mut-recent-item"
              key={record.executionId}
              disabled={busy}
              onClick={() => onOpen(record.executionId)}
            >
              <span>
                <strong>
                  {operationLabels[record.operation]} {record.table}
                </strong>
                <small>
                  {new Date(record.createdAt).toLocaleString()} · {record.rowCount} 行
                </small>
                <code>{record.executionId}</code>
              </span>
              <span className={`mut-state mut-state-${record.state}`}>{labels[record.state]}</span>
            </Button>
          ))}
        </div>
      )}
      {nextCursor && (
        <Button type="button" className="outline-button" disabled={busy} onClick={onMore}>
          查看更早记录
        </Button>
      )}
    </section>
  );
}
