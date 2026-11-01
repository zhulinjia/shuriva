import { Button } from "@workspace/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { historyBase, historyRequest, setHistoryDeleted } from "./history-api";
import {
  type Artifact,
  type Conversation,
  decodeArtifact,
  decodeConversation,
  type HistoryRecord,
} from "./history-model";

type Section = "conversation" | "artifact" | "execution" | "audit";
type RecordContent = Conversation | Artifact | Record<string, unknown>;
type Entry = HistoryRecord<RecordContent>;
type AuditHealth = { available: boolean; durable: boolean; pending: number };
function decodeAuditHealth(value: unknown): AuditHealth {
  if (
    !value ||
    typeof value !== "object" ||
    !("available" in value) ||
    typeof value.available !== "boolean" ||
    !("durable" in value) ||
    typeof value.durable !== "boolean" ||
    !("pending" in value) ||
    !Number.isSafeInteger(value.pending) ||
    Number(value.pending) < 0
  )
    throw Error("Invalid audit health");
  return { available: value.available, durable: value.durable, pending: Number(value.pending) };
}
const labels: Record<Section, string> = {
  conversation: "会话历史",
  artifact: "保存的查询与图表",
  execution: "执行历史",
  audit: "审计记录",
};
const statuses: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期",
  unknown: "结果未知",
  outcome_unknown: "结果未知",
  succeeded: "成功",
  denied: "拒绝",
  allowed: "允许",
  accepted: "已接受",
  success: "成功",
  failure: "失败",
};
const events: Record<string, string> = {
  "conversation.saved": "保存会话",
  "conversation.deleted": "删除会话",
  "conversation.restored": "恢复会话",
  "artifact.saved": "保存定义",
  "artifact.deleted": "删除定义",
  "artifact.restored": "恢复定义",
  "query.submitted": "提交查询",
  "query.completed": "查询完成",
  "query.failed": "查询失败",
  "query.cancelled": "取消查询",
  "query.expired": "查询过期",
  "query.unknown": "查询结果未知",
  "source.created": "创建数据源",
  "source.bound": "绑定数据源",
  "source.unbound": "解绑数据源",
  "source.scanned": "扫描数据源结构",
  "source.changed": "更新数据源",
  "connection.pairing_created": "创建配对码",
  "connection.paired": "连接器配对",
  "connection.revoked": "撤销连接器",
  "connection.rotated": "轮换连接凭据",
  "connection.checked": "完成连接检查",
  "connection.check_requested": "请求连接检查",
  "workspace.archived": "归档工作空间",
  "workspace.restored": "恢复工作空间",
  "model.changed": "更新模型配置",
  "model.checked": "检查模型连接",
  "model.requested": "调用模型",
  "model.completed": "模型生成完成",
  "model.failed": "模型生成失败",
  "security.denied": "权限拒绝",
  "result.exported": "结果导出请求",
  "mutation.confirmed": "登记数据变更",
  "mutation.cancelled": "请求取消变更",
  "mutation.state_changed": "变更状态更新",
  "mutation.target_frozen": "冻结数据源写入",
};
function shown(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "—";
}
function localDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function HistoryPanel({
  workspaceId,
  sourceId,
  refreshKey,
  busy,
  onConversation,
  onArtifact,
}: {
  workspaceId: string;
  sourceId: string;
  refreshKey: number;
  busy: boolean;
  onConversation: (record: HistoryRecord<Conversation>) => void;
  onArtifact: (record: HistoryRecord<Artifact>) => void;
}) {
  const [section, setSection] = useState<Section>(sourceId ? "conversation" : "execution");
  const [deleted, setDeleted] = useState(false);
  const [items, setItems] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<Entry | null>(null);
  const [auditHealth, setAuditHealth] = useState<AuditHealth | "loading" | "unavailable">(
    "loading",
  );
  const request = useRef(0),
    mounted = useRef(true);
  const interaction = useRef({ busy, onConversation, onArtifact });
  interaction.current = { busy, onConversation, onArtifact };
  const scoped = section === "conversation" || section === "artifact";
  const base =
    section === "audit"
      ? "/api/history/audit"
      : section === "execution"
        ? "/api/history/executions"
        : historyBase(workspaceId, sourceId, section);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  const load = useCallback(
    async (after?: string) => {
      const sequence = ++request.current;
      setLoading(true);
      setNotice("");
      const audit = base === "/api/history/audit";
      if (audit) setAuditHealth("loading");
      if (scoped && !sourceId) {
        setItems([]);
        setCursor(null);
        setLoading(false);
        return;
      }
      try {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        if (deleted && scoped) params.set("deleted", "true");
        const [pageResult, healthResult] = await Promise.allSettled([
          historyRequest<{ items: Entry[]; nextCursor: string | null }>(`${base}?${params}`),
          audit
            ? historyRequest<unknown>("/api/history/audit-health").then(decodeAuditHealth)
            : Promise.resolve(null),
        ]);
        if (!mounted.current || sequence !== request.current) return;
        if (audit)
          setAuditHealth(
            healthResult.status === "fulfilled" && healthResult.value
              ? healthResult.value
              : "unavailable",
          );
        if (pageResult.status === "rejected") throw pageResult.reason;
        const page = pageResult.value;
        setItems((prior) => (after ? [...prior, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch {
        if (mounted.current && sequence === request.current) {
          if (!after) {
            setItems([]);
            setCursor(null);
          }
          setNotice("无法读取历史。请检查当前权限、数据源绑定和连接后重试。");
        }
      } finally {
        if (mounted.current && sequence === request.current) setLoading(false);
      }
    },
    [base, deleted, scoped, sourceId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: A completed local save invalidates the server list even when its URL is unchanged.
  useEffect(() => {
    setItems([]);
    setDetail(null);
    setCursor(null);
    void load();
  }, [load, refreshKey]);
  async function open(entry: Entry) {
    if (section === "execution") {
      setDetail(entry);
      return;
    }
    const sequence = ++request.current;
    setLoading(true);
    setNotice("");
    try {
      const record = await historyRequest<Entry>(`${base}/${entry.id}`);
      if (!mounted.current || request.current !== sequence) return;
      if (interaction.current.busy) {
        setNotice("当前操作仍在进行，请等待完成后重新打开历史。");
        return;
      }
      if (section === "conversation")
        interaction.current.onConversation({
          ...record,
          content: decodeConversation(record.content),
        });
      else if (section === "artifact")
        interaction.current.onArtifact({ ...record, content: decodeArtifact(record.content) });
      else setDetail(record);
    } catch {
      if (mounted.current && request.current === sequence)
        setNotice("不能重新打开该记录，请检查当前授权或刷新列表。");
    } finally {
      if (mounted.current && request.current === sequence) setLoading(false);
    }
  }
  async function toggle(entry: Entry) {
    setLoading(true);
    setNotice("");
    try {
      await setHistoryDeleted(`${base}/${entry.id}`, entry.revision, !deleted);
      await load();
    } catch {
      if (mounted.current) {
        setNotice("更改未确认，可能存在版本冲突。请刷新后核对。");
        setLoading(false);
      }
    }
  }
  return (
    <section
      id="workspace-history"
      className="settings-card history-panel"
      aria-label="历史与保存内容"
    >
      <h2>历史与保存内容</h2>
      <p>
        对话正文和定义保存在本机平台数据库。保存的定义不含参数值或完整结果；重新打开不会自动执行。删除的会话和定义可在“已删除”中恢复。
      </p>
      <fieldset className="read-query-actions history-tabs" aria-label="历史分类">
        {(Object.keys(labels) as Section[]).map((key) => (
          <Button
            key={key}
            type="button"
            disabled={busy || loading}
            aria-pressed={section === key}
            onClick={() => {
              setSection(key);
              setDeleted(false);
            }}
          >
            {labels[key]}
          </Button>
        ))}
      </fieldset>
      {section === "audit" && (
        <>
          <p>
            审计显示当前管理员的实例事件，不含对话正文、SQL、参数或结果。“结果导出请求”表示已授权下载请求，不代表文件已写入设备。
          </p>
          {auditHealth === "loading" ? (
            <p role="status">正在确认审计存储状态…</p>
          ) : auditHealth === "unavailable" ? (
            <p role="alert">
              无法确认审计存储状态，请检查当前权限与连接后刷新；当前列表不能代表审计已全部写入。
            </p>
          ) : (
            <>
              <p role={auditHealth.available ? "status" : "alert"}>
                {auditHealth.available ? "审计存储正常。" : "平台审计写入已暂停，请查看平台日志。"}
              </p>
              {auditHealth.pending > 0 && (
                <p role="status">
                  已有 {auditHealth.pending}{" "}
                  条审计事件在本机保留，等待写入平台数据库；当前列表可能尚未包含这些记录。
                </p>
              )}
              {!auditHealth.durable && (
                <p role="alert">审计缓冲当前仅保存在内存，重启可能丢失待写事件。</p>
              )}
            </>
          )}
        </>
      )}
      {section === "execution" && (
        <p>
          显示当前管理员的全部执行记录，包括已解绑的数据源；记录只含状态及耗时，不含
          SQL、参数值或原始结果。
        </p>
      )}
      {scoped && !sourceId && (
        <p>选择当前工作空间中已绑定的数据源后，可查看对应会话和保存的定义。</p>
      )}
      {scoped && (
        <label>
          <input
            type="checkbox"
            checked={deleted}
            disabled={busy || loading || !sourceId}
            onChange={(event) => setDeleted(event.target.checked)}
          />
          显示已删除记录
        </label>
      )}
      <Button type="button" disabled={busy || loading} onClick={() => void load()}>
        刷新历史
      </Button>
      {notice && <p role="alert">{notice}</p>}
      {loading && <p role="status">正在读取历史…</p>}
      {!loading && items.length === 0 && !notice && <p>暂无{labels[section]}。</p>}
      <ul>
        {items.map((entry) => {
          const content = entry.content as Record<string, unknown>;
          return (
            <li key={entry.id}>
              <strong>
                {section === "conversation"
                  ? shown(content.title)
                  : section === "artifact"
                    ? shown(content.name)
                    : section === "audit"
                      ? (events[shown(content.event)] ?? shown(content.event))
                      : `查询 ${shown(content.taskId ?? entry.id)}`}
              </strong>
              <p>
                {localDate(entry.updatedAt ?? entry.createdAt)} ·{" "}
                {section === "execution" || section === "audit"
                  ? (statuses[shown(content.state ?? content.status ?? content.outcome)] ??
                    shown(content.state ?? content.status ?? content.outcome))
                  : `修订 ${entry.revision}`}
              </p>
              {section === "execution" && (
                <p>
                  耗时 {shown(content.durationMs)} ms · 返回 {shown(content.rowCount)} 行
                  {content.truncated ? " · 结果截断" : ""}
                </p>
              )}
              {!deleted && section !== "audit" && (
                <Button type="button" disabled={busy || loading} onClick={() => void open(entry)}>
                  {section === "conversation"
                    ? "打开会话"
                    : section === "artifact"
                      ? "打开定义"
                      : "查看详情"}
                </Button>
              )}
              {(section === "conversation" || section === "artifact") && (
                <Button type="button" disabled={busy || loading} onClick={() => void toggle(entry)}>
                  {deleted ? "恢复" : "删除（可恢复）"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {cursor && (
        <Button type="button" disabled={busy || loading} onClick={() => void load(cursor)}>
          加载更多
        </Button>
      )}
      {detail && (
        <div className="history-detail">
          <h3>执行记录</h3>
          <p>执行 ID：{shown((detail.content as Record<string, unknown>).taskId ?? detail.id)}</p>
          <p>
            状态：
            {statuses[shown((detail.content as Record<string, unknown>).state)] ??
              shown((detail.content as Record<string, unknown>).state)}
          </p>
          <p>该记录不保存 SQL、参数值或原始查询结果。</p>
          <Button type="button" onClick={() => setDetail(null)}>
            关闭详情
          </Button>
        </div>
      )}
    </section>
  );
}
