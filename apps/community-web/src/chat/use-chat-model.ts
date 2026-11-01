import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiError, api } from "../api";
import type { RestoredQueryDraft } from "../history-model";
import { receiveModelPlan } from "../models/model-plan-stream";
import type { ModelActivityState } from "../models/model-progress";
import {
  type ModelPreview,
  modelTransport,
  prepareModelSchema,
  type QueryScope,
  withRequestTimeout,
} from "../models/model-session";
import { type ChatMessage, type PreparedContext, prepareContext } from "./chat-context";
import { decodeChatPlan } from "./chat-plan";

type Pending = { base: string; id: string; controller: AbortController };
type Draft = RestoredQueryDraft & { id: string };
type Options = {
  workspaceId: string;
  sourceId: string;
  base: string;
  question: string;
  messages: ChatMessage[];
  queryBusy: boolean;
  mutationBusy: boolean;
  historyCapability: "loading" | "enabled" | "disabled" | "unavailable";
  conversation: { blocked: boolean; save(messages: ChatMessage[]): Promise<void> };
  setQuestion: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
};

/** Owns the in-flight model preparation/send lifecycle and its cancellation.
 * The page supplies the current scope, draft, conversation and interlocks. */
export function useChatModel(options: Options) {
  const {
    workspaceId,
    sourceId,
    base,
    question,
    messages,
    queryBusy,
    mutationBusy,
    historyCapability,
    conversation,
    setQuestion,
    setMessages,
    setDraft,
  } = options;
  const [phase, setPhase] = useState<"idle" | "loading" | "preview" | "sending">("idle");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<ModelPreview | null>(null);
  const [scope, setScope] = useState<QueryScope | null>(null);
  const [prepared, setPrepared] = useState<PreparedContext | null>(null);
  const [activity, setActivity] = useState<ModelActivityState | null>(null);
  const pending = useRef<Pending | null>(null);
  const current = useRef(true);
  const finishActivity = (outcome: ModelActivityState["outcome"]) =>
    setActivity((value) => (value ? { ...value, outcome, endedAt: Date.now() } : null));
  const dispose = useCallback(() => {
    const task = pending.current;
    pending.current = null;
    if (!task) return;
    task.controller.abort();
    void api(`${task.base}/${task.id}`, { method: "DELETE" }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!workspaceId) {
      current.current = false;
      return;
    }
    current.current = true;
    return () => {
      current.current = false;
      dispose();
    };
  }, [workspaceId, dispose]);
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (
      !sourceId ||
      !question.trim() ||
      phase !== "idle" ||
      queryBusy ||
      mutationBusy ||
      conversation.blocked ||
      historyCapability === "loading"
    )
      return;
    if (
      messages.length >= 198 ||
      new TextEncoder().encode(JSON.stringify(messages)).length > 230 * 1024
    ) {
      setNotice("当前会话已接近历史容量上限，请新建会话继续。");
      return;
    }
    const context = prepareContext(messages, question);
    if (!context) {
      setNotice("当前问题过长，请缩短后重试。");
      return;
    }
    dispose();
    setPreview(null);
    setPrepared(context);
    setNotice("正在向 Connector 确认可发送的结构…");
    setPhase("loading");
    const controller = new AbortController();
    const id = crypto.randomUUID();
    const task = { base, id, controller };
    pending.current = task;
    setActivity({
      kind: "prepare",
      stage: "checking_access",
      startedAt: Date.now(),
      outcome: "running",
    });
    try {
      const { scope: grant, preview: value } = await prepareModelSchema(
        modelTransport(base),
        id,
        controller.signal,
        {
          onProgress: (stage) => {
            if (current.current && pending.current === task)
              setActivity((value) => (value ? { ...value, stage } : null));
          },
        },
      );
      if (!current.current || pending.current !== task) return;
      setScope(grant);
      setPreview(value);
      setPrepared(context);
      setNotice("请核对发送目标和结构。授权结构有时效，过期后需重新获取。");
      setPhase("preview");
      finishActivity("ready");
    } catch (error) {
      if (!current.current || pending.current !== task) return;
      dispose();
      setPhase("idle");
      finishActivity("failed");
      setPrepared(null);
      setNotice(
        error instanceof ApiError && error.code === "SEMANTIC_STALE"
          ? "业务语义引用的结构已变化，请在数据源页面更新语义后重试。"
          : error instanceof ApiError && error.code === "NO_MODEL_FIELDS"
            ? "当前授权范围内的字段均被标记为敏感，无法发送给模型。"
            : error instanceof ApiError && error.code === "SEMANTICS_TOO_LARGE"
              ? "可发送的业务语义过多，请精简后重试。"
              : "无法取得可发送的授权结构。请检查模型配置、数据源绑定和 Connector 本地字段授权后重试。",
      );
    }
  }

  async function send() {
    const task = pending.current;
    if (
      !task ||
      !scope ||
      !preview ||
      !prepared ||
      phase !== "preview" ||
      queryBusy ||
      mutationBusy
    )
      return;
    setPhase("sending");
    setActivity({
      kind: "generate",
      stage: "checking_context",
      startedAt: Date.now(),
      outcome: "running",
    });
    setNotice("正在重新确认授权并等待模型生成计划，暂未执行查询…");
    try {
      const response = await withRequestTimeout(task.controller.signal, 120_000, (signal) =>
        receiveModelPlan(
          `${task.base}/${task.id}/model-plan`,
          {
            ...scope,
            submittedAt: Date.now(),
            question: prepared.text,
            schemaHash: preview.schemaHash,
            ...preview.destination,
          },
          signal,
          (stage) => {
            if (current.current && pending.current === task)
              setActivity((value) => (value ? { ...value, stage } : null));
          },
        ),
      );
      if (!current.current || pending.current !== task) return;
      const plan = decodeChatPlan(response.plan);
      const nextMessages: ChatMessage[] = [
        ...messages,
        { id: crypto.randomUUID(), role: "user", text: prepared.question },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: plan.kind === "clarification" ? plan.question : plan.explanation,
        },
      ];
      setMessages(nextMessages);
      setQuestion("");
      if (plan.kind === "query") setDraft({ ...plan, id: crypto.randomUUID() });
      setNotice(
        plan.kind === "query" ? "请检查下方 SQL 和参数，再决定是否执行。" : "请补充信息后继续。",
      );
      setPreview(null);
      setScope(null);
      setPrepared(null);
      setPhase("idle");
      finishActivity("done");
      dispose();
      void conversation.save(nextMessages);
    } catch (error) {
      if (!current.current || pending.current !== task) return;
      dispose();
      setPreview(null);
      setScope(null);
      setPrepared(null);
      setPhase("idle");
      finishActivity("failed");
      setNotice(
        error instanceof ApiError && error.status === 409
          ? "授权、结构或模型配置已变化，或连接器离线；请重新查看发送范围。模型可能已经收到请求，重新发送可能产生额外费用。"
          : "模型请求未完成，可能是连接失败或模型返回了不受支持的计划。模型可能已经收到请求，重新发送可能产生额外费用；请核对后再试。",
      );
    }
  }

  function reset(message: string, activityAction: "clear" | "cancel" | "keep" = "clear") {
    dispose();
    setPreview(null);
    setScope(null);
    setPrepared(null);
    setPhase("idle");
    if (activityAction === "clear") setActivity(null);
    else if (activityAction === "cancel") finishActivity("cancelled");
    setNotice(message);
  }
  return { phase, notice, setNotice, preview, prepared, activity, reset, prepare, send };
}
