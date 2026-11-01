import { Button } from "@workspace/ui";
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, post } from "../api";
import { ModelActivity } from "../models/ModelActivity";
import { receiveModelPlan } from "../models/model-plan-stream";
import type { ModelActivityState } from "../models/model-progress";
import { modelTransport, prepareModelSchema, withRequestTimeout } from "../models/model-session";
import {
  decodeMutationAICandidate,
  decodeMutationAIReview,
  type MutationAICandidate,
  type MutationAIReview,
  mutationSemanticLines,
} from "./ai-client";
import { operationLabels, type Plan } from "./model";

type Pending = { controller: AbortController; taskId: string; queryBase: string };

/** Independent, ephemeral draft assistance. No conversation persistence or execution call. */
export function MutationAI({
  workspaceId,
  sourceId,
  disabled,
  onPlan,
  onBusyChange,
}: {
  workspaceId: string;
  sourceId: string;
  disabled: boolean;
  onPlan: (plan: Plan) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [question, setQuestion] = useState("");
  const questionId = useId();
  const [review, setReview] = useState<MutationAIReview | null>(null);
  const [candidate, setCandidate] = useState<MutationAICandidate | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [activity, setActivity] = useState<ModelActivityState | null>(null);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const pending = useRef<Pending | null>(null);
  const listener = useRef(onBusyChange);
  listener.current = onBusyChange;
  const running = activity?.outcome === "running";
  const expired = !!review && now >= Date.parse(review.expiresAt);
  const base = `/api/mutations/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sourceId)}/ai`;
  const queryBase = `/api/data-sources/workspaces/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sourceId)}/queries`;
  const dispose = useCallback((scope?: string) => {
    const task = pending.current;
    if (scope && task?.queryBase !== scope) return;
    pending.current = null;
    if (!task) return;
    task.controller.abort();
    // Only the metadata task is cancelled. This component cannot dispatch database changes.
    void api(`${task.queryBase}/${task.taskId}`, { method: "DELETE" }).catch(() => {});
  }, []);
  useEffect(() => {
    listener.current?.(!!running);
  }, [running]);
  useEffect(() => {
    setQuestion("");
    setReview(null);
    setCandidate(null);
    setAcknowledged(false);
    setActivity(null);
    setNotice("");
    return () => {
      dispose(queryBase);
      listener.current?.(false);
    };
  }, [queryBase, dispose]);
  useEffect(() => {
    if (!review) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [review]);
  const finish = (outcome: ModelActivityState["outcome"]) =>
    setActivity((value) => (value ? { ...value, outcome, endedAt: Date.now() } : null));
  function cancel() {
    dispose();
    setReview(null);
    setAcknowledged(false);
    finish("cancelled");
    setNotice(
      activity?.kind === "prepare"
        ? "已停止整理发送范围，尚未向模型发送问题。"
        : "已停止本次生成。没有提交数据库变更；若模型请求已发出，内容无法撤回。",
    );
  }
  async function prepare() {
    if (disabled || running || !question.trim()) return;
    if (new TextEncoder().encode(question).byteLength > 8192) {
      setNotice("变更要求过长，请精简后重试。");
      return;
    }
    dispose();
    setReview(null);
    setCandidate(null);
    setAcknowledged(false);
    setNotice("");
    const task: Pending = {
      controller: new AbortController(),
      taskId: crypto.randomUUID(),
      queryBase,
    };
    pending.current = task;
    const submittedAt = Date.now();
    setActivity({
      kind: "prepare",
      stage: "checking_access",
      startedAt: submittedAt,
      outcome: "running",
    });
    try {
      const { scope } = await prepareModelSchema(
        modelTransport(queryBase),
        task.taskId,
        task.controller.signal,
        {
          onProgress: (stage) => {
            if (pending.current === task)
              setActivity((value) => (value ? { ...value, stage } : null));
          },
        },
      );
      const raw = await withRequestTimeout(task.controller.signal, 8000, (signal) =>
        api<unknown>(`${base}/prepare`, {
          ...post({ question, taskId: task.taskId, ...scope, submittedAt }),
          signal,
        }),
      );
      if (pending.current !== task) return;
      const disclosure = decodeMutationAIReview(raw);
      if (disclosure.question !== question) throw Error("发送问题已变化。");
      setReview(disclosure);
      finish("ready");
    } catch {
      if (pending.current !== task) return;
      dispose();
      finish("failed");
      setNotice(
        "无法整理发送范围。请检查模型配置、连接器及当前字段授权后重试；尚未向模型发送问题。",
      );
    }
  }
  async function send() {
    const task = pending.current;
    if (!task || !review || !acknowledged || expired || disabled || running) return;
    setReview(null);
    setAcknowledged(false);
    setNotice("");
    setActivity({
      kind: "generate",
      stage: "checking_context",
      startedAt: Date.now(),
      outcome: "running",
    });
    try {
      const result = await withRequestTimeout(task.controller.signal, 120000, (signal) =>
        receiveModelPlan(
          `${base}/generate`,
          { ticketId: review.ticketId, disclosureHash: review.disclosureHash, confirmed: true },
          signal,
          (stage) => {
            if (pending.current === task)
              setActivity((value) => (value ? { ...value, stage } : null));
          },
        ),
      );
      if (pending.current !== task) return;
      setCandidate(decodeMutationAICandidate(result.plan));
      finish("done");
      dispose();
    } catch {
      if (pending.current !== task) return;
      dispose();
      finish("failed");
      setNotice(
        "生成未完成或授权已变化，没有可用候选。若请求已发送，不会自动重试；请重新核对发送范围。",
      );
    }
  }
  return (
    <section className="mut-card mut-ai" aria-label="AI 变更草稿">
      <div className="mut-section-title">
        <h3>
          <Sparkles size={17} /> AI 帮我起草
        </h3>
        <span className="mut-muted">只生成候选，不自动执行</span>
      </div>
      <label htmlFor={questionId}>描述要修改的内容、具体值和目标条件</label>
      <textarea
        id={questionId}
        rows={3}
        value={question}
        maxLength={8192}
        disabled={disabled || running}
        placeholder="例如：将客户编号为 1001 的客户名称改为……"
        onChange={(event) => {
          dispose();
          setQuestion(event.target.value);
          setReview(null);
          setCandidate(null);
          setAcknowledged(false);
          setActivity(null);
          setNotice("");
        }}
      />
      <p className="mut-muted">
        需求中的待写值也会包含在发送内容里。此入口不保存聊天历史、参数或候选草稿。
      </p>
      {!review && (
        <Button
          type="button"
          className="outline-button"
          disabled={disabled || running || !question.trim()}
          onClick={() => void prepare()}
        >
          先查看发送范围
        </Button>
      )}
      {activity && <ModelActivity mode="mutation" activity={activity} onCancel={cancel} />}
      {notice && (
        <p className="mut-message" role="status">
          {notice}
        </p>
      )}
      {review && (
        <section className="mut-ai-disclosure" aria-label="本次发送范围">
          <h4>确认后才发送给模型</h4>
          <dl>
            <dt>接收服务</dt>
            <dd>{review.destination.baseUrl}</dd>
            <dt>模型</dt>
            <dd>{review.destination.model}</dd>
            <dt>完整问题（包括待写值）</dt>
            <dd className="mut-ai-question">{review.question}</dd>
            <dt>数据库名称</dt>
            <dd>{review.schema.database}</dd>
          </dl>
          <p>以下是本次发送的全部表、字段、类型和允许操作；不会发送查询结果或数据库密码。</p>
          {review.schema.tables.map((table) => {
            const scope = review.writeScope[table.name];
            return (
              <details open key={table.name}>
                <summary>
                  {table.name} · {table.columns.length} 个字段
                </summary>
                <ul>
                  {table.columns.map((column) => (
                    <li key={column.name}>
                      <code>{column.name}</code> · {column.type} ·{" "}
                      {[
                        scope.insert.includes(column.name) ? "可新增" : "",
                        scope.update.includes(column.name) ? "可修改" : "",
                        scope.filter.includes(column.name) ? "可筛选" : "",
                      ]
                        .filter(Boolean)
                        .join("、")}
                    </li>
                  ))}
                </ul>
                {scope.delete && <p>允许按条件生成删除候选</p>}
              </details>
            );
          })}
          <details open>
            <summary>本次发送的非敏感业务说明</summary>
            {mutationSemanticLines(review.semantics).length ? (
              <ul>
                {mutationSemanticLines(review.semantics).map((line) => (
                  <li key={`${line.label}:${line.text}`}>
                    <strong>{line.label}</strong> · {line.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p>没有业务说明。</p>
            )}
          </details>
          <p className="mut-muted">
            发送范围有效至 {new Date(review.expiresAt).toLocaleTimeString()}
            。权限、结构或模型变化后需要重新获取。
          </p>
          <label className="mut-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={expired || disabled}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            我同意将上面完整问题、结构、允许操作及业务说明发送给所列模型服务。
          </label>
          <div className="mut-inline-actions">
            <Button
              type="button"
              className="dialog-primary"
              disabled={disabled || !acknowledged || expired}
              onClick={() => void send()}
            >
              确认发送并生成候选
            </Button>
            <Button
              type="button"
              className="outline-button"
              disabled={disabled}
              onClick={() => void prepare()}
            >
              {expired ? "已过期，重新获取" : "重新获取发送范围"}
            </Button>
          </div>
        </section>
      )}
      {candidate && (
        <section className="mut-ai-candidate" aria-label="模型候选，尚未执行">
          <h4>{candidate.kind === "clarification" ? "需要补充要求" : "候选已生成，尚未执行"}</h4>
          <p>{candidate.kind === "clarification" ? candidate.question : candidate.explanation}</p>
          {candidate.kind === "mutation" && (
            <>
              <p>
                {operationLabels[candidate.plan.operation]} · {candidate.plan.table}
                。载入后请核对字段、值和筛选条件，再生成完整预览。
              </p>
              <Button
                type="button"
                className="outline-button"
                disabled={disabled}
                onClick={() => {
                  onPlan(candidate.plan);
                  setCandidate(null);
                  setQuestion("");
                  setActivity(null);
                }}
              >
                载入变更草稿
              </Button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
