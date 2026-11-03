import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@workspace/ui";
import { api, post } from "../api";
import type { Snapshot } from "../datasources/SnapshotPanel";
import type { Source } from "../datasources/source-types";
import { permissions, type McpClient } from "./types";

export function GrantEditor({
  clients,
  saved,
  report,
  changeDraftsEnabled = false,
}: {
  clients: McpClient[];
  saved: () => Promise<void>;
  report: (e: unknown) => void;
  changeDraftsEnabled?: boolean;
}) {
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [workspace, setWorkspace] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState("");
  const [client, setClient] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [workspaceCursor, setWorkspaceCursor] = useState<string | null>(null),
    [sourceCursor, setSourceCursor] = useState<string | null>(null);
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;
  useEffect(() => {
    const abort = new AbortController();
    void api<{ workspaces: typeof workspaces; nextCursor: string | null }>("/api/workspaces", {
      signal: abort.signal,
    })
      .then((r) => {
        if (!abort.signal.aborted) {
          setWorkspaces(r.workspaces);
          setWorkspaceCursor(r.nextCursor);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) report(e);
      });
    return () => abort.abort();
  }, [report]);
  useEffect(() => {
    setSource("");
    setSources([]);
    setSourceCursor(null);
    setSnapshot(null);
    setColumns([]);
    if (!workspace) return;
    const abort = new AbortController();
    void api<{ sources: Source[]; nextCursor: string | null }>(
      `/api/data-sources/workspaces/${encodeURIComponent(workspace)}`,
      { signal: abort.signal },
    )
      .then((r) => {
        if (!abort.signal.aborted) {
          setSources(r.sources);
          setSourceCursor(r.nextCursor);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) report(e);
      });
    return () => abort.abort();
  }, [workspace, report]);
  useEffect(() => {
    setSnapshot(null);
    setColumns([]);
    if (!source) return;
    const abort = new AbortController();
    void api<{ snapshot: Snapshot }>(
      `/api/data-sources/workspaces/${encodeURIComponent(workspace)}/${encodeURIComponent(source)}/snapshot`,
      { signal: abort.signal },
    )
      .then((r) => {
        if (!abort.signal.aborted) setSnapshot(r.snapshot);
      })
      .catch((e) => {
        if (!abort.signal.aborted) report(e);
      });
    return () => abort.abort();
  }, [workspace, source, report]);
  async function more(kind: "workspace" | "source") {
    const cursor = kind === "workspace" ? workspaceCursor : sourceCursor;
    if (!cursor) return;
    const selected = workspace;
    setBusy(true);
    try {
      if (kind === "workspace") {
        const page = await api<{ workspaces: typeof workspaces; nextCursor: string | null }>(
          `/api/workspaces?after=${encodeURIComponent(cursor)}`,
        );
        setWorkspaces((old) => [
          ...old,
          ...page.workspaces.filter((w) => !old.some((x) => x.id === w.id)),
        ]);
        setWorkspaceCursor(page.nextCursor);
      } else {
        const page = await api<{ sources: Source[]; nextCursor: string | null }>(
          `/api/data-sources/workspaces/${encodeURIComponent(selected)}?after=${encodeURIComponent(cursor)}`,
        );
        if (latestWorkspace.current === selected) {
          setSources((old) => [
            ...old,
            ...page.sources.filter((s) => !old.some((x) => x.id === s.id)),
          ]);
          setSourceCursor(page.nextCursor);
        }
      }
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!snapshot || !columns.length || !scopes.length) return;
    setBusy(true);
    try {
      const tables: [string, string[]][] = snapshot.content.tables
        .map(
          (t) =>
            [
              t.name,
              snapshot.content.columns
                .filter((c) => c.table === t.name && columns.includes(`${c.table}.${c.name}`))
                .map((c) => c.name),
            ] as [string, string[]],
        )
        .filter(([, c]) => c.length > 0);
      await api(
        "/api/mcp/grants",
        post({
          clientId: client,
          workspaceId: workspace,
          sourceId: source,
          tables,
          scopes,
          durationMinutes: minutes,
        }),
      );
      setColumns([]);
      setScopes([]);
      await saved();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="product-form mcp-card" onSubmit={save}>
      {workspaceCursor && (
        <Button type="button" disabled={busy} onClick={() => void more("workspace")}>
          加载更多工作区
        </Button>
      )}
      {sourceCursor && (
        <Button type="button" disabled={busy} onClick={() => void more("source")}>
          加载更多数据源
        </Button>
      )}
      <h3>授予访问范围</h3>
      <p>
        选择允许外部客户端访问的字段。每次查询仍需单独确认；更换授权会撤销这个客户端原有的授权。
      </p>
      <label>
        客户端
        <select required value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">请选择</option>
          {clients
            .filter((c) => !c.disabled)
            .map((c) => (
              <option key={c.clientId} value={c.clientId}>
                {c.name} · {c.mode === "local_domain" ? "本机用户信任域" : "HTTP"}
              </option>
            ))}
        </select>
      </label>
      <label>
        工作区
        <select required value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
          <option value="">请选择</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        数据源
        <select required value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">请选择已绑定的数据源</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {source && !snapshot && <p role="status">需要可用的结构快照。请在数据源页面完成结构扫描。</p>}
      {snapshot && (
        <fieldset>
          <legend>允许访问的字段</legend>
          {snapshot.content.tables.map((t) => (
            <div key={t.name}>
              <strong>{t.name}</strong>
              {snapshot.content.columns
                .filter((c) => c.table === t.name)
                .map((c) => {
                  const id = `${c.table}.${c.name}`;
                  return (
                    <label className="mcp-check" key={id}>
                      <input
                        type="checkbox"
                        checked={columns.includes(id)}
                        onChange={(e) =>
                          setColumns((old) =>
                            e.target.checked ? [...old, id] : old.filter((v) => v !== id),
                          )
                        }
                      />
                      {c.name} <small>{c.type}</small>
                    </label>
                  );
                })}
            </div>
          ))}
        </fieldset>
      )}
      <fieldset>
        <legend>允许的操作</legend>
        {[
          ...permissions,
          ...(changeDraftsEnabled
            ? [["change:propose", "提交变更草稿，等待管理员接收"] as const]
            : []),
        ].map(([value, label]) => (
          <label className="mcp-check" key={value}>
            <input
              type="checkbox"
              checked={scopes.includes(value)}
              onChange={(e) =>
                setScopes((old) =>
                  e.target.checked ? [...old, value] : old.filter((v) => v !== value),
                )
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label>
        授权时长（分钟，最长不超过当前登录会话）
        <input
          type="number"
          min={5}
          max={480}
          required
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        />
      </label>
      <Button
        type="submit"
        className="product-primary"
        disabled={busy || !columns.length || !scopes.length}
      >
        {busy ? "保存中…" : "确认授权范围"}
      </Button>
    </form>
  );
}
