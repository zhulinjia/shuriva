import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { historyBase, historyRequest, putHistory } from "../history-api";
import { type Conversation, type HistoryRecord, sameConversation } from "../history-model";
import type { ChatMessage } from "./chat-context";

type Identity = { id: string; revision: number; pending: Conversation | null };
export function useConversationHistory(
  workspace: string,
  source: string,
  messages: ChatMessage[],
  enabled: boolean,
  onSaved: () => void,
) {
  const [title, updateTitle] = useState(""),
    [status, setStatus] = useState<"empty" | "saving" | "saved" | "unsaved" | "uncertain">("empty"),
    [notice, setNotice] = useState("");
  function setTitle(value: string) {
    updateTitle(value);
    setStatus((prior) => (prior === "saved" ? "unsaved" : prior));
  }
  const identity = useRef<Identity>({ id: crypto.randomUUID(), revision: 0, pending: null });
  const persisted = useRef<Conversation | null>(null);
  const currentContent: Conversation = {
    title: title.trim() || messages[0]?.text.slice(0, 120) || "新会话",
    messages: messages.map(({ id, role, text }) => ({ id, role, text })),
  };
  const hasUnsaved =
    status === "saving" ||
    status === "uncertain" ||
    (messages.length > 0 && !sameConversation(persisted.current, currentContent));
  const scope = useRef(""),
    active = useRef(true),
    flight = useRef(false);
  const base = historyBase(workspace, source, "conversation");
  scope.current = base;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsaved]);
  const reset = useCallback(() => {
    identity.current = { id: crypto.randomUUID(), revision: 0, pending: null };
    persisted.current = null;
    updateTitle("");
    setStatus("empty");
    setNotice("");
  }, []);
  const open = useCallback((record: HistoryRecord<Conversation>) => {
    identity.current = { id: record.id, revision: record.revision, pending: null };
    persisted.current = record.content;
    updateTitle(record.content.title);
    setStatus("saved");
    setNotice("已读取本机会话；重新发送前仍需确认当前数据范围。");
  }, []);
  async function save(messages: ChatMessage[], asNew = false) {
    if (!source || !messages.length || flight.current) return;
    if (!enabled) {
      setStatus("unsaved");
      setNotice("当前对话仅保存在本页，离开或刷新前请确认保留方式。");
      return;
    }
    if (status === "uncertain" && !asNew) {
      setNotice("上次保存结果未确认，请先核对保存状态，避免覆盖。");
      return;
    }
    if (asNew) identity.current = { id: crypto.randomUUID(), revision: 0, pending: null };
    const target = identity.current,
      requestBase = base;
    const content: Conversation = {
      title: title.trim() || messages[0]?.text.slice(0, 120) || "新会话",
      messages: messages.map((item) => ({ id: item.id, role: item.role, text: item.text })),
    };
    target.pending = content;
    flight.current = true;
    setStatus("saving");
    setNotice("正在保存会话到本机…");
    try {
      const result = await putHistory(`${base}/${target.id}`, target.revision, content);
      if (!active.current || scope.current !== requestBase || identity.current !== target) return;
      target.revision = result.revision;
      target.pending = null;
      persisted.current = content;
      updateTitle(content.title);
      setStatus("saved");
      setNotice("会话已保存在本机。");
      onSaved();
    } catch (error) {
      if (active.current && scope.current === requestBase && identity.current === target) {
        const definite =
          error instanceof ApiError && [400, 401, 403, 404, 413].includes(error.status);
        setStatus(definite ? "unsaved" : "uncertain");
        setNotice(
          definite
            ? "本页对话未保存，请检查访问权限和内容容量后重试。"
            : "历史保存结果未确认，本页对话仍保留。请先核对保存状态。",
        );
      }
    } finally {
      flight.current = false;
    }
  }
  async function check() {
    if (flight.current) return;
    const target = identity.current,
      requestBase = base;
    flight.current = true;
    try {
      const record = await historyRequest<HistoryRecord<Conversation>>(`${base}/${target.id}`);
      if (!active.current || scope.current !== requestBase || identity.current !== target) return;
      if (!sameConversation(target.pending, record.content)) {
        setNotice("服务端会话与本页不同。请从历史列表重新打开并核对；本页内容尚未覆盖服务端。");
        return;
      }
      target.revision = record.revision;
      target.pending = null;
      persisted.current = record.content;
      setStatus("saved");
      setNotice("已核对：上次会话保存成功。");
      onSaved();
    } catch (error) {
      if (active.current && scope.current === requestBase && identity.current === target) {
        if (error instanceof ApiError && error.status === 404) {
          setStatus("unsaved");
          setNotice("未找到已保存会话，可重新保存本页内容。");
        } else setNotice("无法核对历史保存状态，请检查连接后重试。");
      }
    } finally {
      flight.current = false;
    }
  }
  return {
    title,
    setTitle,
    status: status === "saved" && hasUnsaved ? ("unsaved" as const) : status,
    notice,
    save,
    check,
    reset,
    open,
    blocked: status === "saving" || status === "uncertain",
    hasUnsaved,
  };
}
