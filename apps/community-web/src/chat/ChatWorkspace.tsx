import { MessageScroller } from "@shadcn/react/message-scroller";
import { Button } from "@workspace/ui";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Source } from "../datasources/source-types";
import { HistoryPanel } from "../HistoryPanel";
import {
  type Artifact,
  type Conversation,
  type HistoryRecord,
  type RestoredQueryDraft,
  restoreArtifact,
} from "../history-model";
import { ModelActivity } from "../models/ModelActivity";
import { MutationPanel } from "../mutations/MutationPanel";
import { ReadQueryPanel } from "../queries/ReadQueryPanel";
import { useHistoryCapability } from "../use-history-capability";
import type { ChatMessage } from "./chat-context";
import { useChatModel } from "./use-chat-model";
import { useConversationHistory } from "./use-conversation-history";

/** A preparation captures only a fresh Connector-attested schema, not rows. */
export function ChatWorkspace({
  workspaceId,
  workspaceName,
  onBack,
}: {
  workspaceId: string;
  workspaceName: string;
  onBack: () => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<(RestoredQueryDraft & { id: string }) | null>(null);
  const [queryBusy, setQueryBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const historyCapability = useHistoryCapability();
  const [historyVersion, setHistoryVersion] = useState(0);
  const historySaved = useCallback(() => setHistoryVersion((value) => value + 1), []);
  const conversation = useConversationHistory(
    workspaceId,
    sourceId,
    messages,
    historyCapability === "enabled",
    historySaved,
  );
  const chosen = sources.find((item) => item.id === sourceId);
  const base = `/api/data-sources/workspaces/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sourceId)}/queries`;
  const {
    phase,
    notice,
    setNotice,
    preview,
    prepared,
    activity,
    reset: resetModel,
    prepare,
    send,
  } = useChatModel({
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
  });
  useEffect(() => {
    let active = true;
    api<{ sources: Source[]; nextCursor: string | null }>(
      `/api/data-sources/workspaces/${encodeURIComponent(workspaceId)}`,
    )
      .then((value) => {
        if (active) {
          setSources(value.sources);
          setCursor(value.nextCursor);
        }
      })
      .catch(() => {
        if (active) setNotice("无法加载数据源，请检查连接后重新打开工作空间。");
      });
    return () => {
      active = false;
    };
  }, [workspaceId, setNotice]);

  async function more() {
    if (!cursor) return;
    try {
      const page = await api<{ sources: Source[]; nextCursor: string | null }>(
        `/api/data-sources/workspaces/${encodeURIComponent(workspaceId)}?after=${encodeURIComponent(cursor)}`,
      );
      setSources((items) => [...items, ...page.sources]);
      setCursor(page.nextCursor);
    } catch {
      setNotice("加载更多数据源失败，请重试。");
    }
  }

  function changeSource(value: string) {
    if (!canLeaveConversation()) return;
    resetModel("");
    setSourceId(value);
    setQuestion("");
    setMessages([]);
    setDraft(null);
    conversation.reset();
  }

  function canLeaveConversation() {
    return (
      (!conversation.hasUnsaved && !question.trim()) ||
      window.confirm(
        "当前会话有尚未确认保存的内容，或问题尚未发送。确定离开并丢弃本页内容？取消可保留。",
      )
    );
  }
  function openConversation(record: HistoryRecord<Conversation>) {
    if (!canLeaveConversation()) return;
    resetModel("已打开历史会话，未发送模型请求。");
    setMessages(record.content.messages);
    setDraft(null);
    setQuestion("");
    conversation.open(record);
  }
  function openArtifact(record: HistoryRecord<Artifact>) {
    resetModel("已打开保存的定义，请重新填写参数，核对后手动执行。", "keep");
    setDraft({ ...restoreArtifact(record), id: crypto.randomUUID() });
  }

  function cancelOperation() {
    const sending = phase === "sending";
    resetModel(
      sending
        ? "已取消；如果请求已经到达模型，供应商仍可能处理已接收的信息。"
        : "已取消结构准备，未向模型发送问题。",
      "cancel",
    );
  }

  return (
    <main className="settings-page">
      <Button
        type="button"
        disabled={conversation.status === "saving" || queryBusy || mutationBusy || phase !== "idle"}
        onClick={() => {
          if (canLeaveConversation()) onBack();
        }}
      >
        返回工作空间
      </Button>
      <div className="product-eyebrow">AI DATA WORKSPACE</div>
      <h1>{workspaceName} · AI 工作台</h1>
      {historyCapability === "enabled" && (
        <a className="history-shortcut" href="#workspace-history">
          查看会话、保存内容与执行历史
        </a>
      )}
      <p>
        模型只生成查询计划；SQL
        需要你检查并手动执行。目前支持单表、明确字段、简单条件和排序；聚合与多表查询暂不可用。
        {historyCapability === "enabled"
          ? "成功的对话会保存在本机平台数据库，可从历史列表打开、删除或恢复。"
          : "当前对话仅保留在本页，离开后清除。"}
      </p>
      <section className="settings-card product-form" aria-label="AI 对话">
        <label>
          选择数据源
          <select
            value={sourceId}
            onChange={(event) => changeSource(event.target.value)}
            disabled={
              phase === "sending" || queryBusy || mutationBusy || conversation.status === "saving"
            }
          >
            <option value="">请选择数据源</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          disabled={
            phase !== "idle" ||
            queryBusy ||
            mutationBusy ||
            conversation.status === "saving" ||
            messages.length === 0
          }
          onClick={() => {
            if (!canLeaveConversation()) return;
            resetModel("已开始新对话，本页之前的对话和查询结果已清除。");
            setMessages([]);
            setDraft(null);
            setQuestion("");
            conversation.reset();
          }}
        >
          新对话（清除本页内容）
        </Button>
        {cursor && (
          <Button type="button" onClick={() => void more()}>
            加载更多数据源
          </Button>
        )}
        {sources.length === 0 && <p>没有可用的数据源，请先在数据源管理中完成绑定。</p>}
        <MessageScroller.Provider autoScroll>
          <MessageScroller.Root className="chat-thread">
            <MessageScroller.Viewport className="chat-thread-viewport" aria-label="对话消息">
              <MessageScroller.Content>
                {messages.length === 0 && (
                  <p className="chat-empty">选择数据源并输入问题，开始一段对话。</p>
                )}
                {messages.map((message) => (
                  <MessageScroller.Item
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                    className={`chat-message chat-message-${message.role}`}
                  >
                    <strong>{message.role === "user" ? "你" : "AI"}</strong>
                    <p>{message.text}</p>
                  </MessageScroller.Item>
                ))}
                {prepared && phase !== "idle" && (
                  <MessageScroller.Item
                    messageId="pending-question"
                    scrollAnchor
                    className="chat-message chat-message-user"
                  >
                    <strong>你</strong>
                    <p>{prepared.question}</p>
                  </MessageScroller.Item>
                )}
              </MessageScroller.Content>
            </MessageScroller.Viewport>
            <MessageScroller.Button
              className="chat-scroll-end"
              direction="end"
              aria-label="滚动到最新消息"
            >
              查看最新消息
            </MessageScroller.Button>
          </MessageScroller.Root>
        </MessageScroller.Provider>
        <form className="product-form" onSubmit={(event) => void prepare(event)}>
          <label>
            你的问题
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={phase !== "idle"}
              rows={4}
              maxLength={8192}
              required
              placeholder="例如：查询客户编号和名称"
            />
          </label>
          <Button
            className="product-primary"
            type="submit"
            disabled={
              !sourceId ||
              !question.trim() ||
              phase !== "idle" ||
              queryBusy ||
              mutationBusy ||
              conversation.blocked ||
              historyCapability === "loading"
            }
          >
            查看发送范围
          </Button>
        </form>
        {activity && <ModelActivity activity={activity} onCancel={cancelOperation} />}
        {historyCapability === "enabled" && messages.length > 0 && (
          <section className="history-conversation-save" aria-label="当前会话保存">
            <label>
              会话名称
              <input
                value={conversation.title}
                maxLength={120}
                disabled={conversation.blocked || phase !== "idle"}
                onChange={(event) => conversation.setTitle(event.target.value)}
              />
            </label>
            <Button
              type="button"
              disabled={phase !== "idle" || conversation.blocked}
              onClick={() => void conversation.save(messages)}
            >
              保存当前会话
            </Button>
            {conversation.status === "uncertain" && (
              <>
                <Button type="button" onClick={() => void conversation.check()}>
                  核对历史保存状态
                </Button>
                <Button
                  type="button"
                  disabled={phase !== "idle"}
                  onClick={() => {
                    if (window.confirm("将本页对话另存为新会话，原会话保持不变。确定继续？"))
                      void conversation.save(messages, true);
                  }}
                >
                  另存为新会话
                </Button>
              </>
            )}
            {conversation.notice && <p role="status">{conversation.notice}</p>}
          </section>
        )}
        {historyCapability === "unavailable" && (
          <p role="alert">无法确认历史功能状态；当前对话保留在本页，暂未写入历史。</p>
        )}
        {notice && <p role="status">{notice}</p>}
        {queryBusy && <p role="status">请先等待或取消当前查询，再开始新的模型请求。</p>}
        {preview && phase === "preview" && (
          <section className="settings-card" aria-label="发送范围确认">
            <h2>发送前核对</h2>
            <p>
              目标：{preview.destination.baseUrl} · 模型 {preview.destination.model}
            </p>
            <p>
              将发送当前问题、最近的对话内容和以下数据库结构；不会自动发送查询结果或数据库密码，请勿在问题中输入敏感信息。
            </p>
            {prepared?.omitted && (
              <p role="status">
                部分较早对话超出长度限制，不会发送；请确认当前问题包含所需上下文。
              </p>
            )}
            <details>
              <summary>查看实际发送的对话内容</summary>
              <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {prepared?.text}
              </div>
            </details>
            <p>数据库：{preview.schema.database}</p>
            <ul>
              {preview.schema.tables.map((table) => (
                <li key={table.name}>
                  {table.name}：
                  {table.columns.map((column) => `${column.name} (${column.type})`).join("、")}
                </li>
              ))}
            </ul>
            {preview.semantics && (
              <div>
                <h3>同时发送的非敏感业务语义</h3>
                <p>
                  仅展示在本次授权字段范围内的内容；敏感标记的表、字段和语义不会发送。业务说明请勿填写敏感数据。
                </p>
                {Object.values(preview.semantics).every((items) => items.length === 0) ? (
                  <p>没有可发送的业务语义。</p>
                ) : (
                  <ul>
                    {preview.semantics.entities.map((item) => (
                      <li key={`entity:${item.table}`}>
                        实体 {item.name}（{item.table}）：{item.description}；别名：
                        {item.aliases.join("、") || "无"}
                      </li>
                    ))}
                    {preview.semantics.fields.map((item) => (
                      <li key={`field:${item.table}:${item.column}`}>
                        字段 {item.name}（{item.table}.{item.column}）：{item.description}；别名：
                        {item.aliases.join("、") || "无"}
                      </li>
                    ))}
                    {preview.semantics.relationships.map((item) => (
                      <li key={`relation:${item.name}`}>
                        关系 {item.name}（{item.from.table}.{item.from.column} → {item.to.table}.
                        {item.to.column}）：{item.description}；别名：
                        {item.aliases.join("、") || "无"}
                      </li>
                    ))}
                    {preview.semantics.metrics.map((item) => (
                      <li key={`metric:${item.name}`}>
                        指标 {item.name}（{item.aggregation}，{item.field.table}.{item.field.column}
                        ）：{item.description}；别名：{item.aliases.join("、") || "无"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <Button
              className="product-primary"
              type="button"
              disabled={queryBusy || mutationBusy}
              onClick={() => void send()}
            >
              发送问题给模型
            </Button>{" "}
            <Button
              type="button"
              onClick={() => {
                resetModel("已取消发送。", "cancel");
              }}
            >
              取消
            </Button>
          </section>
        )}
      </section>
      {draft && chosen && (
        <ReadQueryPanel
          key={draft.id}
          workspaceId={workspaceId}
          sourceId={chosen.id}
          sourceName={chosen.name}
          initialDraft={draft}
          onBusyChange={setQueryBusy}
          interactionBlocked={phase === "sending" || mutationBusy}
          onDefinitionSaved={historySaved}
        />
      )}
      {chosen && (
        <MutationPanel
          key={`mutation:${workspaceId}:${chosen.id}`}
          workspaceId={workspaceId}
          sourceId={chosen.id}
          sourceName={chosen.name}
          interactionBlocked={phase !== "idle" || queryBusy || conversation.status === "saving"}
          onBusyChange={setMutationBusy}
        />
      )}
      {historyCapability === "enabled" && (
        <HistoryPanel
          key={`${workspaceId}:${sourceId}`}
          workspaceId={workspaceId}
          sourceId={sourceId}
          refreshKey={historyVersion}
          busy={phase !== "idle" || queryBusy || mutationBusy || conversation.status === "saving"}
          onConversation={openConversation}
          onArtifact={openArtifact}
        />
      )}
    </main>
  );
}
