import { Button } from "@workspace/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, observe, post } from "./api";
import { ConnectionDetails } from "./ConnectionDetails";
import { ConnectionEditor } from "./ConnectionEditor";
import { base, type BlockedConnection, type ExternalConnection, type Program } from "./types";
import "./external-mcp.css";

type Workspace = { id: string; name: string };
export function ExternalMcpManager({ onBack }: { onBack: () => void }) {
  const workspaceRef = useRef(""),
    generation = useRef(0);
  const [retry, setRetry] = useState(0);
  const [enabled, setEnabled] = useState<boolean | null>(null),
    [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [workspace, setWorkspace] = useState(""),
    [programs, setPrograms] = useState<Program[]>([]),
    [connections, setConnections] = useState<Array<ExternalConnection | BlockedConnection>>([]),
    [cleaning, setCleaning] = useState(false),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [oauth, setOauth] = useState<{ id: string; ready: boolean; denied: boolean } | null>(null);
  const [attempt] = useState(() => new URLSearchParams(location.search).get("externalMcpOAuth"));
  workspaceRef.current = workspace;
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry restarts failed capability/bootstrap requests.
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const cap = await api<{ enabled: boolean }>("/api/external-mcp/capability", {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setEnabled(cap.enabled);
        if (!cap.enabled) return;
        const items: Workspace[] = [];
        let after: string | null = null;
        do {
          const result: { workspaces: Workspace[]; nextCursor: string | null } = await api(
            `/api/workspaces${after ? `?after=${encodeURIComponent(after)}` : ""}`,
            { signal: abort.signal },
          );
          items.push(...result.workspaces);
          after = result.nextCursor;
          if (items.length > 500) throw Error("工作区过多，请缩小管理范围。");
        } while (after);
        if (abort.signal.aborted) return;
        setWorkspaces(items);
        if (items[0]) setWorkspace(items[0].id);
        try {
          const p = await api<{ programs: Program[] }>("/api/external-mcp/programs", {
            signal: abort.signal,
          });
          if (!abort.signal.aborted) setPrograms(p.programs);
        } catch {
          if (!abort.signal.aborted) setError("本机程序列表不可用，HTTP 连接仍可使用。");
        }
        if (attempt) {
          const a = await api<{
            id: string;
            workspaceId: string;
            connectionId: string;
            ready: boolean;
            denied: boolean;
          }>(`/api/external-mcp/oauth/attempts/${encodeURIComponent(attempt)}`, {
            signal: abort.signal,
          });
          if (!abort.signal.aborted) {
            setWorkspace(a.workspaceId);
            setSelected(a.connectionId);
            setOauth(a);
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "读取失败");
      }
    })();
    return () => abort.abort();
  }, [attempt, retry]);
  const load = useCallback(
    async (signal?: AbortSignal, background = false) => {
      if (!workspace || workspaceRef.current !== workspace) return;
      const current = ++generation.current;
      if (!background) setLoading(true);
      try {
        const value = await observe<{ connections: Array<ExternalConnection | BlockedConnection> }>(
          base(workspace),
          signal ?? new AbortController().signal,
        );
        if (
          !signal?.aborted &&
          workspaceRef.current === workspace &&
          generation.current === current
        )
          setConnections(value.connections);
      } catch (error) {
        if (
          !signal?.aborted &&
          workspaceRef.current === workspace &&
          generation.current === current
        ) {
          setConnections([]);
          throw error;
        }
      } finally {
        if (
          !signal?.aborted &&
          workspaceRef.current === workspace &&
          generation.current === current
        )
          setLoading(false);
      }
    },
    [workspace],
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setConnections([]);
    const poll = async (background = false) => {
      try {
        await load(abort.signal, background);
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "读取失败");
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void poll(true), 2500);
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [load]);
  const current = connections.find((c) => c.id === selected);
  return (
    <main className="external-layout">
      <div className="external-heading">
        <div>
          <h1>外部 MCP 工具</h1>
          <p>在明确批准的连接上使用外部工具</p>
        </div>
        <Button onClick={onBack}>返回工作区</Button>
      </div>
      <p className="external-notice">
        外部内容不可信；发现、批准工具和确认本次调用分别进行。不会自动将结果发给
        AI。平台自身的数据库写入门禁保持关闭；外部工具可能产生副作用，需要逐次确认。
      </p>
      {error && <p role="alert">{error}</p>}
      {enabled === null ? (
        error ? (
          <Button
            onClick={() => {
              setError("");
              setRetry((n) => n + 1);
            }}
          >
            重新读取功能状态
          </Button>
        ) : (
          <p role="status">正在读取功能状态…</p>
        )
      ) : !enabled ? (
        <p>外部 MCP Client 尚未启用。管理员完成独立迁移和部署配置后可开启。</p>
      ) : (
        <>
          <label>
            工作区
            <select
              value={workspace}
              onChange={(e) => {
                setSelected("");
                setWorkspace(e.target.value);
                setError("");
              }}
            >
              <option value="">请选择工作区</option>
              {workspaces.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          {oauth && (
            <section className="external-review">
              <p>
                {oauth.denied
                  ? "外部授权已被拒绝。"
                  : oauth.ready
                    ? "登录回跳已核验。请由发起授权的管理员会话继续完成令牌交换。"
                    : "授权尚未就绪。"}
              </p>
              {oauth.ready && (
                <Button
                  onClick={() =>
                    void (async () => {
                      try {
                        await api(`/api/external-mcp/oauth/attempts/${oauth.id}/finish`, post());
                        setOauth(null);
                        history.replaceState(null, "", location.pathname);
                        await load();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "授权未完成");
                      }
                    })()
                  }
                >
                  完成授权
                </Button>
              )}
            </section>
          )}
          {workspace && (
            <div className="external-columns">
              <aside>
                <h2>连接</h2>
                <Button
                  disabled={loading}
                  onClick={() =>
                    void load().catch((error) =>
                      setError(error instanceof Error ? error.message : "读取连接状态失败"),
                    )
                  }
                >
                  刷新连接状态
                </Button>
                {loading && <p role="status">正在刷新…</p>}
                {connections.map((c) => (
                  <Button
                    key={c.id}
                    aria-pressed={selected === c.id}
                    onClick={() => setSelected(c.id)}
                  >
                    {c.name}
                    {c.disabled ? "（已停用）" : ""}
                  </Button>
                ))}
                <ConnectionEditor
                  key={workspace}
                  workspace={workspace}
                  programs={programs}
                  onSaved={load}
                />
              </aside>
              {current?.config === null ? (
                <section>
                  <h3>{current.name}</h3>
                  <p>该配置无法安全使用，连接地址已隐藏。请使用符合要求的地址重新创建连接。</p>
                  {current.cleanupRequired && (
                    <Button
                      disabled={cleaning}
                      onClick={() => {
                        setCleaning(true);
                        void api(`${base(current.workspaceId)}/${current.id}/disable`, post())
                          .then(() => load())
                          .catch((cause: unknown) =>
                            setError(cause instanceof Error ? cause.message : "清理连接失败"),
                          )
                          .finally(() => setCleaning(false));
                      }}
                    >
                      停用并清除原配置
                    </Button>
                  )}
                </section>
              ) : current ? (
                <ConnectionDetails
                  key={`${current.id}:${current.version}:${current.snapshotHash}:${JSON.stringify(current.approvedTools)}`}
                  connection={current}
                  programs={programs}
                  reload={load}
                />
              ) : (
                <p>选择一个连接，检查目标与工具后开始调用。</p>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
