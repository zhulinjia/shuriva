import { Button, ConfirmDialog } from "@workspace/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { changedParameterKind, parameterInputs, type RestoredQueryDraft } from "../history-model";
import { useHistoryCapability } from "../use-history-capability";
import { QuerySession, type QueryView, queryTransport } from "./query-session";
import { ResultPresentation } from "./ResultPresentation";
import type { VisualizationDefinition } from "./result-presentation";
import { SaveDefinition } from "./SaveDefinition";
import { useResultExport } from "./use-result-export";

type ParameterKind = "string" | "integer" | "decimal" | "boolean" | "null";
type Parameter = { id: string; kind: ParameterKind; value: string; needsInput?: boolean };
const truncationMessages = {
  rows: "结果达到行数上限。",
  bytes: "结果达到大小上限。",
  cell: "结果包含超过单个字段大小上限的数据。",
};

/** A query belongs to the selected workspace and source and is never persisted in the browser. */
export function ReadQueryPanel({
  workspaceId,
  sourceId,
  sourceName,
  unavailable = false,
  initialDraft,
  onBusyChange,
  interactionBlocked = false,
  onDefinitionSaved,
}: {
  workspaceId: string;
  sourceId: string;
  sourceName: string;
  unavailable?: boolean;
  initialDraft?: RestoredQueryDraft;
  onBusyChange?: (busy: boolean) => void;
  interactionBlocked?: boolean;
  onDefinitionSaved?: () => void;
}) {
  const [sql, setSql] = useState(initialDraft?.sql ?? "");
  const [parameters, setParameters] = useState<Parameter[]>(() =>
    parameterInputs(initialDraft).map((parameter) => ({ ...parameter, id: crypto.randomUUID() })),
  );
  const [maxRows, setMaxRows] = useState(initialDraft?.maxRows ?? 100);
  const historyCapability = useHistoryCapability();
  const [visualization, setVisualization] = useState<VisualizationDefinition>(
    initialDraft?.visualization ?? { kind: "table" },
  );
  const [parameterNotice, setParameterNotice] = useState("");
  const [definitionBusy, setDefinitionBusy] = useState(false);
  const [view, setView] = useState<QueryView>({
    phase: "idle",
    message: "",
    notice: "",
    result: null,
    canCancel: false,
    cancelling: false,
    scopeStatus: "loading",
  });
  const session = useRef<QuerySession | null>(null);
  const { phase: state, message, result, cancelling } = view;
  const base = `/api/data-sources/workspaces/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sourceId)}/queries`;
  const resultExport = useResultExport({
    workspaceId,
    sourceId,
    base,
    result,
    session,
    definitionBusy,
    allowed: !unavailable && !interactionBlocked && view.scopeStatus === "ready",
    capability: historyCapability,
  });
  const exportBusy = resultExport.busy;
  useEffect(() => {
    const current = new QuerySession(queryTransport(base), setView);
    session.current = current;
    void current.prepare();
    return () => {
      current.close();
      if (session.current === current) session.current = null;
    };
  }, [base]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (unavailable || interactionBlocked || definitionBusy || exportBusy) return;
    if (parameters.some((parameter) => parameter.needsInput)) {
      setParameterNotice("保存的查询不保留参数值，请逐项重新填写；空文本可明确选择“使用空文本”。");
      return;
    }
    setParameterNotice("");
    void session.current?.start({
      sql,
      parameters: parameters.map(({ kind, value }) => ({ kind, value })),
      maxRows,
      schemaVersion: initialDraft?.schemaVersion ?? null,
    });
  }
  const pending =
    state === "submitting" ||
    state === "queued" ||
    state === "running" ||
    state === "reconnecting" ||
    state === "unknown";
  useEffect(() => {
    onBusyChange?.(pending || cancelling || definitionBusy || exportBusy);
    return () => onBusyChange?.(false);
  }, [pending, cancelling, definitionBusy, exportBusy, onBusyChange]);
  return (
    <section className="settings-card read-query" aria-labelledby="read-query-heading">
      <h2 id="read-query-heading">只读查询</h2>
      <p>
        当前数据源：<strong>{sourceName}</strong>
        。只支持已授权的单表、明确字段、参数条件和排序；不支持写入、视图或函数。
      </p>
      {unavailable && <p role="status">暂时无法确认数据源或连接器状态，查询会话和输入已保留。</p>}
      {view.scopeStatus === "loading" && <p role="status">正在确认数据源授权…</p>}
      {view.scopeStatus === "unavailable" && (
        <p role="alert">
          无法确认数据源授权。
          <Button type="button" onClick={() => void session.current?.prepare()}>
            重新获取授权
          </Button>
        </p>
      )}
      {view.scopeStatus === "stale" && <p role="alert">授权已变化，请刷新页面并确认数据源。</p>}
      {initialDraft?.requiresParameterInput && (
        <p role="status">
          保存的定义不会自动执行，也不保存参数值；请检查
          SQL、当前数据源及重新填写的参数后手动执行。原结构发生变化时，模型生成的定义可能需要重新生成。
        </p>
      )}
      {parameterNotice && <p role="alert">{parameterNotice}</p>}
      <p>
        请先在 Connector
        本机授予工作空间对应的表和字段读取范围。查询和结果可能包含敏感信息，请谨慎使用。
      </p>
      <details>
        <summary>如何配置可读取的表和字段</summary>
        <p>先停止 Connector，将下面的表名和字段名替换成实际名称，配置成功后重新运行 Connector。</p>
        <code className="connector-command">
          go run ./cmd/connector source read-allow --id {sourceId} --workspace {workspaceId} --table
          TABLE_NAME --columns COLUMN_A,COLUMN_B
        </code>
        <p>该范围只允许已配置的基础表与字段；数据库账号仍须限制为只读。</p>
      </details>
      <form className="product-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={definitionBusy || exportBusy} className="read-query-fields">
          <label>
            SQL 语句
            <textarea
              required
              value={sql}
              disabled={pending || cancelling}
              onChange={(event) => setSql(event.target.value)}
              placeholder="例如：SELECT id, name FROM customers WHERE id = ?"
              maxLength={16384}
              rows={5}
              spellCheck={false}
            />
          </label>
          <div className="read-query-parameters">
            <div className="read-query-heading">
              <strong>参数</strong>
              <Button
                type="button"
                disabled={pending || cancelling || parameters.length >= 64}
                onClick={() =>
                  setParameters((items) => [
                    ...items,
                    { id: crypto.randomUUID(), kind: "string", value: "" },
                  ])
                }
              >
                添加参数
              </Button>
            </div>
            <small>
              按 SQL 中问号的顺序填写，数字以文本输入以避免精度损失。空值请使用
              <code> 字段 &lt;=&gt; ? </code>，或直接使用 <code>字段 IS NULL</code>。
            </small>
            {parameters.map((parameter, index) => (
              <div className="read-query-parameter" key={parameter.id}>
                <label>
                  参数 {index + 1} 类型
                  <select
                    value={parameter.kind}
                    disabled={pending || cancelling}
                    onChange={(event) =>
                      setParameters((items) =>
                        items.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                ...changedParameterKind(event.target.value as ParameterKind),
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="string">文本</option>
                    <option value="integer">整数</option>
                    <option value="decimal">小数</option>
                    <option value="boolean">布尔值</option>
                    <option value="null">空值</option>
                  </select>
                </label>
                {parameter.kind !== "null" &&
                  (parameter.kind === "boolean" ? (
                    <label>
                      值
                      <select
                        value={parameter.value}
                        disabled={pending || cancelling}
                        onChange={(event) =>
                          setParameters((items) =>
                            items.map((item, i) =>
                              i === index
                                ? { ...item, value: event.target.value, needsInput: false }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="" disabled>
                          请重新选择
                        </option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    </label>
                  ) : (
                    <label>
                      值
                      <input
                        value={parameter.value}
                        maxLength={4096}
                        required={parameter.needsInput || parameter.kind !== "string"}
                        disabled={pending || cancelling}
                        onChange={(event) =>
                          setParameters((items) =>
                            items.map((item, i) =>
                              i === index
                                ? { ...item, value: event.target.value, needsInput: false }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                {parameter.kind === "string" && parameter.needsInput && (
                  <Button
                    type="button"
                    disabled={pending || cancelling}
                    onClick={() =>
                      setParameters((items) =>
                        items.map((item) =>
                          item.id === parameter.id
                            ? { ...item, value: "", needsInput: false }
                            : item,
                        ),
                      )
                    }
                  >
                    使用空文本
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={pending || cancelling}
                  onClick={() => setParameters((items) => items.filter((_, i) => i !== index))}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
          <label>
            最多返回行数
            <input
              type="number"
              required
              min={1}
              max={1000}
              value={maxRows}
              disabled={pending || cancelling}
              onChange={(event) => setMaxRows(Number(event.target.value))}
            />
          </label>
          <div className="read-query-actions">
            <Button
              className="product-primary"
              type="submit"
              disabled={
                pending ||
                cancelling ||
                unavailable ||
                interactionBlocked ||
                view.scopeStatus !== "ready"
              }
            >
              执行只读查询
            </Button>
            {view.canCancel && (
              <Button
                type="button"
                disabled={cancelling}
                onClick={() => void session.current?.cancel()}
              >
                取消查询
              </Button>
            )}
            {state === "unknown" && (
              <Button type="button" onClick={() => session.current?.resume()}>
                重新获取状态
              </Button>
            )}
          </div>
        </fieldset>
      </form>
      {historyCapability === "enabled" && (
        <SaveDefinition
          key={`${workspaceId}:${sourceId}:${initialDraft?.artifact?.id ?? "new"}`}
          workspaceId={workspaceId}
          sourceId={sourceId}
          sql={sql}
          parameters={parameters}
          maxRows={maxRows}
          schemaVersion={initialDraft?.schemaVersion ?? null}
          visualization={visualization}
          disabled={
            pending ||
            cancelling ||
            unavailable ||
            exportBusy ||
            interactionBlocked ||
            view.scopeStatus !== "ready"
          }
          initial={initialDraft?.artifact}
          onSaved={onDefinitionSaved}
          onBusyChange={setDefinitionBusy}
        />
      )}
      {view.notice && <p role="status">{view.notice}</p>}
      {state === "idle" && message && <p role="status">{message}</p>}
      {state !== "idle" && (
        <div className="read-query-status" role="status" aria-live="polite">
          {state === "submitting"
            ? "正在提交…"
            : state === "queued"
              ? "等待连接器…"
              : state === "running"
                ? "等待连接器处理或返回结果…"
                : state === "completed"
                  ? `查询完成，共返回 ${result?.rows.length ?? 0} 行。`
                  : message}
        </div>
      )}
      {state !== "idle" &&
        message &&
        (state === "queued" || state === "running" || state === "completed") && <p>{message}</p>}
      {result && (
        <div className="read-query-result">
          <div className="read-query-heading">
            <strong>查询结果</strong>
            <Button
              type="button"
              disabled={
                exportBusy ||
                definitionBusy ||
                unavailable ||
                interactionBlocked ||
                view.scopeStatus !== "ready" ||
                (historyCapability !== "enabled" && historyCapability !== "disabled")
              }
              onClick={resultExport.begin}
            >
              导出当前结果（JSON）
            </Button>
            <Button
              type="button"
              disabled={definitionBusy || exportBusy}
              onClick={() => session.current?.clear()}
            >
              清除结果
            </Button>
          </div>
          {resultExport.message && <p role="alert">{resultExport.message}</p>}
          {historyCapability === "unavailable" && (
            <p role="alert">无法确认历史和审计功能状态，暂时不能导出。请检查连接后重新打开页面。</p>
          )}
          {result.truncated && result.reason && (
            <p role="status">{truncationMessages[result.reason]} 返回结果已截断。</p>
          )}
          <p>时间按 UTC 返回；二进制数据以 Base64 显示。</p>
          <ResultPresentation
            result={result}
            definition={visualization}
            onDefinitionChange={setVisualization}
            disabled={pending || cancelling || interactionBlocked || definitionBusy || exportBusy}
          />
          {result.rows.length === 0 && <p>查询完成，没有符合条件的数据。</p>}
        </div>
      )}
      <ConfirmDialog
        open={resultExport.confirmation !== null}
        title="导出当前查询结果"
        description="查询结果可能包含敏感信息，导出的 JSON 文件将保存在你的设备上。请确认当前结果及数据源后再导出。"
        confirmLabel="确认导出"
        busy={resultExport.exporting}
        onCancel={resultExport.cancel}
        onConfirm={() => void resultExport.confirm()}
      >
        {resultExport.confirmation && (
          <p>
            数据源：<strong>{sourceName}</strong> · {resultExport.confirmation.result.rows.length}{" "}
            行{resultExport.confirmation.result.truncated ? "（结果已截断）" : ""}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}
