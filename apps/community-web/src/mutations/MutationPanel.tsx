import { Button, ConfirmDialog } from "@workspace/ui";
import {
  ArrowLeft,
  ArrowRight,
  FileCheck2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { mutationClient } from "./client";
import { initialMutationView, MutationController, type MutationView } from "./controller";
import { MutationEditor } from "./Editor";
import { MutationAI } from "./MutationAI";
import {
  buildPlan,
  displayValue,
  draftFromPlan,
  emptyDraft,
  isFrozen,
  mayConfirm,
  operationLabels,
  type Confirmation,
  type Preview,
  type Plan,
  previewCounts,
  terminalStates,
} from "./model";
import { ExecutionRecord, RecentExecutions, RecoveredReceipts } from "./Records";
import {
  clearChangeRecovery,
  readChangeRecovery,
  sameChangeRecovery,
  saveChangeRecovery,
} from "./recovery";
import "./mutations.css";

function PreviewRows({ preview }: { preview: Preview }) {
  const [page, setPage] = useState(0);
  const rows = useMemo(
    () => preview.rows.map((change) => ({ id: crypto.randomUUID(), change })),
    [preview.rows],
  );
  const totalPages = Math.ceil(preview.rowCount / 10);
  const counts = previewCounts(preview);
  return (
    <section className="mut-preview-rows" aria-label="全部目标与前后差异">
      <div className="mut-section-title">
        <h3>全部目标与前后差异</h3>
        <span>
          选中 {counts.selected} 行 · 变化 {counts.changed} 行 · 无变化 {counts.unchanged} 行
        </span>
      </div>
      {rows.slice(page * 10, page * 10 + 10).map(({ id, change }, index) => {
        const columns = [
          ...new Set([
            ...Object.keys(change.before ?? {}),
            ...Object.keys(change.after ?? {}),
            ...(change.generatedColumns ?? []),
          ]),
        ].sort();
        return (
          <div className="mut-change" key={id}>
            <div className="mut-change-title">
              目标 {page * 10 + index + 1}
              <span>{operationLabels[preview.operation]}</span>
            </div>
            <div className="mut-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>修改前</th>
                    <th>{preview.operation === "delete" ? "删除后" : "修改后"}</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((column) => {
                    const before = change.before?.[column],
                      after = change.after?.[column];
                    const changed = before?.kind !== after?.kind || before?.value !== after?.value;
                    return (
                      <tr key={column} className={changed ? "mut-changed" : ""}>
                        <th>{column}</th>
                        <td>
                          <code>{displayValue(before)}</code>
                        </td>
                        <td>
                          <code>
                            {change.generatedColumns?.includes(column)
                              ? "数据库生成（尚未分配）"
                              : `${displayValue(after)}${change.defaultColumns?.includes(column) ? "（数据库默认）" : ""}`}
                          </code>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {totalPages > 1 && (
        <div className="mut-pagination">
          <Button
            className="outline-button"
            type="button"
            disabled={page === 0}
            onClick={() => setPage((old) => old - 1)}
          >
            <ArrowLeft size={14} />
            上一页
          </Button>
          <span>
            第 {page + 1} / {totalPages} 页 · 全部 {preview.rowCount} 行均可查看
          </span>
          <Button
            className="outline-button"
            type="button"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((old) => old + 1)}
          >
            下一页
            <ArrowRight size={14} />
          </Button>
        </div>
      )}
    </section>
  );
}

/** Real API view; all sensitive draft/preview values live only in this mounted panel's memory. */
export function MutationPanel({
  workspaceId,
  sourceId,
  sourceName = "当前数据源",
  unavailable = false,
  interactionBlocked = false,
  onBusyChange,
  initialPlan,
  originInvocationId,
  showScopeIdentity = false,
  previewUnavailable = false,
  restoredPending,
  recovery,
  onDefer,
}: {
  workspaceId: string;
  sourceId: string;
  sourceName?: string;
  unavailable?: boolean;
  interactionBlocked?: boolean;
  onBusyChange?: (busy: boolean) => void;
  initialPlan?: Plan;
  originInvocationId?: string;
  showScopeIdentity?: boolean;
  previewUnavailable?: boolean;
  restoredPending?: Confirmation;
  recovery?: {
    save(pending: Confirmation): void;
    clear(pending: Confirmation): void;
    canDefer(pending: Confirmation): boolean;
  };
  onDefer?: () => void;
}) {
  const [view, setView] = useState<MutationView>(initialMutationView);
  const [draft, setDraft] = useState(emptyDraft);
  const [confirming, setConfirming] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedTable, setTypedTable] = useState("");
  const [localError, setLocalError] = useState("");
  const [aiBusy, setAIBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [deferred, setDeferred] = useState(false);
  const [localRecovery] = useState(() => {
    if (recovery) return { saved: null, error: false };
    try {
      return { saved: readChangeRecovery(), error: false };
    } catch {
      return { saved: null, error: true };
    }
  });
  const localPending =
    !recovery &&
    localRecovery.saved?.invocationId === null &&
    localRecovery.saved.workspaceId === workspaceId &&
    localRecovery.saved.sourceId === sourceId
      ? localRecovery.saved.confirmation
      : undefined;
  const otherPending = !recovery && !!localRecovery.saved && !localPending;
  const localPersistence = useMemo(() => {
    const base = { invocationId: null, workspaceId, sourceId };
    return {
      save: (confirmation: Confirmation) => saveChangeRecovery({ ...base, confirmation }),
      clear: (confirmation: Confirmation) => clearChangeRecovery({ ...base, confirmation }),
      canDefer: (confirmation: Confirmation) =>
        sameChangeRecovery(readChangeRecovery(), { ...base, confirmation }),
    };
  }, [workspaceId, sourceId]);
  const persistence = recovery ?? localPersistence;
  const pendingAtMount = restoredPending ?? localPending;
  const controller = useRef<MutationController | null>(null);
  const busyListener = useRef(onBusyChange);
  busyListener.current = onBusyChange;
  useEffect(() => {
    const instance = new MutationController(
      mutationClient(workspaceId, sourceId, { originInvocationId }),
      setView,
      undefined,
      persistence,
    );
    controller.current = instance;
    setView(initialMutationView());
    setDraft(initialPlan ? draftFromPlan(initialPlan) : emptyDraft());
    setConfirming(false);
    setRecovering(false);
    setAcknowledged(false);
    setTypedTable("");
    setLocalError("");
    setAIBusy(false);
    if (pendingAtMount) void instance.restorePending(pendingAtMount);
    else void instance.prepare();
    return () => {
      instance.close();
      if (controller.current === instance) controller.current = null;
    };
  }, [workspaceId, sourceId, initialPlan, originInvocationId, pendingAtMount, persistence]);
  const pendingId = view.pending?.confirmationId;
  useEffect(() => {
    if (pendingId) setDeferred(false);
  }, [pendingId]);
  useEffect(() => {
    busyListener.current?.(
      view.busy ||
        confirming ||
        recovering ||
        aiBusy ||
        (view.phase === "reconciling" && !deferred) ||
        view.phase === "confirming",
    );
  }, [view.busy, view.phase, confirming, recovering, aiBusy, deferred]);
  useEffect(() => () => busyListener.current?.(false), []);
  const selectedId = view.selected?.executionId;
  const selectedState = view.selected?.state;
  const previewId = view.preview?.previewId;
  useEffect(() => {
    if (
      !selectedId ||
      !selectedState ||
      terminalStates.has(selectedState) ||
      selectedState === "outcome_unknown"
    )
      return;
    const timer = window.setInterval(() => void controller.current?.refresh(selectedId), 1500);
    return () => window.clearInterval(timer);
  }, [selectedId, selectedState]);
  useEffect(() => {
    if (view.phase !== "preview" || !previewId) return;
    setAcknowledged(false);
    setTypedTable("");
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [view.phase, previewId]);
  const blocked = unavailable || interactionBlocked || view.busy || aiBusy;
  const recoveryBlocked = interactionBlocked || view.busy || aiBusy;
  const frozen =
    isFrozen(view.records) || view.receiptMetadataError || view.capability?.code === "frozen";
  const canDraft =
    !!controller.current?.canDraft() &&
    !unavailable &&
    !interactionBlocked &&
    !previewUnavailable &&
    !localRecovery.error &&
    !otherPending;
  const p = view.preview;
  const canConfirm =
    !blocked &&
    !previewUnavailable &&
    !localRecovery.error &&
    !otherPending &&
    !frozen &&
    view.phase === "preview" &&
    mayConfirm(p, view.capability, acknowledged, typedTable, now);
  function preview(event: FormEvent) {
    event.preventDefault();
    setLocalError("");
    if (!canDraft || aiBusy) return;
    try {
      void controller.current?.preview(buildPlan(draft));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "请检查草稿。");
    }
  }
  return (
    <section className="mutation-panel" aria-label="受控写入">
      <header className="mut-heading">
        <div>
          <span className="mut-eyebrow">受控变更</span>
          <h2>看清影响，再确认执行</h2>
          <p>{sourceName} · 草稿与预览不进入聊天历史</p>
        </div>
        <span className="mut-safety-badge">
          <ShieldCheck size={15} />
          默认保护数据
        </span>
      </header>
      <ol className="mut-stepper" aria-label="变更步骤">
        <li className={view.phase === "draft" ? "active" : ""}>1 编写草稿</li>
        <li className={view.phase === "preview" ? "active" : ""}>2 核对全部目标</li>
        <li className={view.phase === "confirming" || view.phase === "reconciling" ? "active" : ""}>
          3 确认登记
        </li>
        <li className={view.phase === "execution" ? "active" : ""}>4 核对结果</li>
      </ol>
      {view.phase === "loading" && (
        <p className="mut-notice" role="status">
          正在核对当前数据源的写入能力…
        </p>
      )}
      {view.capabilityLoading && <p role="status">正在核对 Connector 能力，执行历史可独立读取。</p>}
      {view.capabilityError && (
        <p role="status">
          {view.capabilityAccessError === "login_required"
            ? "登录已过期，请保留原编号并重新登录后核对能力。"
            : view.capabilityAccessError === "access_denied"
              ? "当前账号无权读取数据源能力，请检查账号及权限。"
              : "Connector 能力暂不可用；仍可核对已登记的执行历史和原确认。"}
        </p>
      )}
      {view.capability &&
        (!view.capability.enabled ||
          !view.capability.available ||
          !view.capability.executionEnabled) && (
          <div className="mut-notice">
            <LockKeyhole size={18} />
            <div>
              <strong>
                {view.capability.code === "binding_identity_required"
                  ? "需先由管理员完成绑定身份迁移"
                  : frozen
                    ? "该目标的新写入已冻结"
                    : !view.capability.executionEnabled
                      ? "正式写入尚未开放"
                      : "当前数据源尚不具备写入条件"}
              </strong>
              <p>
                {view.capability.code === "binding_identity_required"
                  ? "当前平台库尚未安装绑定身份记录，新预览与写入已关闭。请由管理员按迁移文档核对所选环境；这里不会自动修改数据库。"
                  : frozen
                    ? "存在未决或不一致证据。请核对原结果；找回记录不会自动解冻。"
                    : "只有本机授权、安全核验和阶段验收全部满足后，才允许确认执行。界面不会绕过这项限制。"}
              </p>
            </div>
          </div>
        )}
      {localRecovery.error && (
        <p role="alert">
          无法读取本标签页的待核对记录，状态未知。当前不能开始新的变更，请恢复浏览器存储权限。
        </p>
      )}
      {otherPending && (
        <p role="alert">
          本标签页已有另一项待核对确认，请先回到其原工作区和数据源核对，不能开始新的变更。
        </p>
      )}
      {!view.recovered && view.phase === "recovery" && (
        <div className="mut-recovery-start">
          <FileCheck2 size={22} />
          <div>
            <h3>先找回已有操作</h3>
            <p>
              找回当前范围的原记录，并封存其他页面尚未确认的旧预览。已登记操作继续按原编号核对，不会重复执行。
            </p>
            <Button
              type="button"
              className="outline-button"
              disabled={blocked || !view.capability?.enabled}
              onClick={() => setRecovering(true)}
            >
              找回操作并封存旧预览
            </Button>
          </div>
        </div>
      )}
      {(localError || view.message) && (
        <p className="mut-message" role="status">
          {localError || view.message}
        </p>
      )}
      {frozen && (
        <p className="mut-caution">
          <TriangleAlert size={18} />
          请勿重复提交、删除日志或把旧操作改成新编号继续执行。
        </p>
      )}
      {view.phase === "draft" && (
        <MutationAI
          key={`${workspaceId}:${sourceId}`}
          workspaceId={workspaceId}
          sourceId={sourceId}
          disabled={!canDraft}
          onBusyChange={setAIBusy}
          onPlan={(plan) => {
            if (!controller.current?.canDraft() || unavailable || interactionBlocked) return;
            setDraft(draftFromPlan(plan));
            setLocalError("已载入 AI 候选。请核对具体字段、值和筛选条件，再生成完整变更预览。");
          }}
        />
      )}
      {view.phase === "draft" && (
        <form onSubmit={preview} className="mut-card">
          <MutationEditor
            draft={draft}
            setDraft={setDraft}
            disabled={!canDraft || aiBusy}
            tables={view.capability?.tables ?? []}
          />
          <div className="mut-editor-footer">
            <p>先生成完整预览；本机策略可能进一步收紧行数、字段及行范围。</p>
            <Button className="dialog-primary" type="submit" disabled={!canDraft || aiBusy}>
              {view.busy ? "正在核验目标…" : "生成变更预览"}
            </Button>
          </div>
        </form>
      )}
      {p && view.phase === "preview" && (
        <section className="mut-card">
          <div className="mut-section-title">
            <div>
              <span className="mut-eyebrow">不可变预览</span>
              <h3>
                {operationLabels[p.operation]} {p.table} · {p.rowCount} 行
              </h3>
            </div>
            <span className="mut-muted">
              {Date.parse(p.expiresAt) <= now
                ? "预览已过期"
                : `有效至 ${new Date(p.expiresAt).toLocaleTimeString()}`}
            </span>
          </div>
          <p className="mut-muted">
            执行时再次核对当前完整行值。值不一致则停止；不能保证识别期间先修改再恢复原值的全部过程。
            {p.operation === "insert"
              ? "数据库生成值以事务内实际核验为准。"
              : "新出现的匹配记录不加入本次操作。"}
          </p>
          <PreviewRows key={p.previewId} preview={p} />
          <div className="mut-inline-actions">
            <Button
              type="button"
              className="outline-button"
              disabled={blocked}
              onClick={() => void controller.current?.edit()}
            >
              作废预览并编辑
            </Button>
            <Button
              type="button"
              className="dialog-primary"
              disabled={
                blocked ||
                frozen ||
                previewUnavailable ||
                localRecovery.error ||
                otherPending ||
                !view.capability?.executionEnabled ||
                Date.parse(p.expiresAt) <= now
              }
              onClick={() => {
                setAcknowledged(false);
                setTypedTable("");
                setConfirming(true);
              }}
            >
              核对并确认本次变更
            </Button>
          </div>
        </section>
      )}
      {view.phase === "reconciling" && view.pending && (
        <section className="mut-card mut-unknown">
          <h3>正在核对本次确认</h3>
          <p>请求可能已经登记。当前没有收到结果，不代表未执行；不会自动创建第二次确认。</p>
          <dl className="mut-identities">
            <div>
              <dt>原确认编号</dt>
              <dd>{view.pending.confirmationId}</dd>
            </div>
          </dl>
          <div className="mut-inline-actions">
            <Button
              className="outline-button"
              type="button"
              disabled={recoveryBlocked}
              onClick={() => void controller.current?.lookup()}
            >
              核对原确认
            </Button>
            <Button
              className="outline-button"
              type="button"
              disabled={recoveryBlocked}
              onClick={() => void controller.current?.lookup(true)}
            >
              结束待核对确认
            </Button>
            {persistence && (
              <Button
                className="outline-button"
                type="button"
                disabled={recoveryBlocked}
                onClick={() => {
                  try {
                    if (!view.pending || !persistence.canDefer(view.pending))
                      throw Error("不可恢复");
                    if (onDefer) onDefer();
                    else setDeferred(true);
                  } catch {
                    setLocalError("无法保留原确认编号，请留在本页继续核对。");
                  }
                }}
              >
                保留编号，稍后核对
              </Button>
            )}
          </div>
          <small>
            结束操作会封存尚未登记的原预览；已经登记时返回原执行记录，不会取消数据库任务。
          </small>
          {persistence && (
            <p>
              编号仅保存在本浏览器当前标签页，关闭标签页或清除站点数据后可能丢失；请记录上面的编号。
            </p>
          )}
        </section>
      )}
      {view.selected && (
        <ExecutionRecord
          record={view.selected}
          busy={blocked}
          onRefresh={() => void controller.current?.refresh()}
          onCancel={() => void controller.current?.cancel()}
        />
      )}
      {view.recordsLoaded && view.historySelected && (
        <>
          <p>以下为上次读取的历史快照，可能已经变化；查看快照不会改变原确认。</p>
          <ExecutionRecord
            record={view.historySelected}
            busy={false}
            onRefresh={() => {}}
            onCancel={() => {}}
            readOnly
          />
        </>
      )}
      {view.phase === "execution" && (
        <Button
          type="button"
          className="outline-button"
          disabled={recoveryBlocked}
          onClick={() => void controller.current?.prepare()}
        >
          返回找回操作
        </Button>
      )}
      {view.phase === "execution" && view.selected && terminalStates.has(view.selected.state) && (
        <Button
          className="outline-button"
          type="button"
          disabled={!canDraft}
          onClick={() => controller.current?.newDraft()}
        >
          编写新的变更草稿
        </Button>
      )}
      {view.recordsLoaded ? (
        <RecentExecutions
          records={view.records}
          busy={recoveryBlocked || view.phase === "preview" || view.phase === "confirming"}
          nextCursor={view.nextCursor}
          onOpen={(id) => controller.current?.inspectHistory(id)}
          onMore={() => void controller.current?.more()}
          snapshot={view.phase === "reconciling"}
          onReload={() => void controller.current?.retryHistory()}
        />
      ) : (
        <div role="status">
          <p>执行历史尚未加载或不可用，不能据此判断没有记录。</p>
          <Button
            className="outline-button"
            type="button"
            disabled={recoveryBlocked || view.phase === "confirming"}
            onClick={() => void controller.current?.retryHistory()}
          >
            重新读取执行历史
          </Button>
        </div>
      )}
      {view.historyError === "login_required" && (
        <p role="alert">执行历史需要重新登录；保留原编号，登录后可以重新读取。</p>
      )}
      {view.historyError === "access_denied" && (
        <p role="alert">
          当前账号无权读取执行历史；请检查账号和数据源权限，恢复权限后可以重新读取。
        </p>
      )}
      <RecoveredReceipts
        receipts={view.receipts}
        cursor={view.receiptCursor}
        busy={blocked}
        onMore={() => void controller.current?.moreReceipts()}
      />
      {view.phase === "recovery" && view.capability === null && (
        <Button
          className="outline-button"
          type="button"
          disabled={blocked}
          onClick={() => void controller.current?.prepare()}
        >
          <RefreshCw size={14} />
          重新核对能力
        </Button>
      )}
      <ConfirmDialog
        open={confirming && !!p}
        title={p?.operation === "delete" ? "确认删除全部目标？" : "确认本次数据变更？"}
        description={`${showScopeIdentity ? `工作区：${workspaceId}；` : ""}数据源：${sourceName}；目标表：${p?.table ?? ""}；${p ? operationLabels[p.operation] : ""} ${p?.rowCount ?? 0} 行。确认只适用于当前预览，不是提交成功的回执。`}
        confirmLabel="确认登记本次变更"
        confirmDisabled={!canConfirm}
        busy={view.busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          if (!canConfirm) return;
          setConfirming(false);
          void controller.current?.confirm();
        }}
      >
        {p && Date.parse(p.expiresAt) <= now && (
          <p role="status" className="mut-notice">
            预览已过期，本次确认已停用。请取消并重新生成预览，核对后再确认。
          </p>
        )}
        <label className="mut-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          我已核对全部 {p?.rowCount ?? 0} 行及前后差异，确认本次操作。
        </label>
        {p?.operation === "delete" && (
          <label className="mut-delete-name">
            删除后没有平台撤销。请输入表名 <code>{p.table}</code>
            <input
              autoComplete="off"
              value={typedTable}
              onChange={(event) => setTypedTable(event.target.value)}
            />
          </label>
        )}
        {!view.capability?.executionEnabled && (
          <p className="mut-caution">当前正式写入未开放，不能登记执行。</p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={recovering}
        title="找回原操作并封存旧预览"
        description="这会使本工作区、该数据源下你其他页面尚未确认的预览失效。已登记操作继续按原编号核对，不会重新执行，也不自动解除未知冻结。"
        confirmLabel="找回并封存旧预览"
        busy={view.busy}
        onCancel={() => setRecovering(false)}
        onConfirm={() => {
          setRecovering(false);
          void controller.current?.recover();
        }}
      />
    </section>
  );
}
