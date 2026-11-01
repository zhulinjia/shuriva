import { Button } from "@workspace/ui";
import { ArrowLeft, Database, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, post } from "../api";
import { ReadQueryPanel } from "../queries/ReadQueryPanel";
import { SemanticPanel } from "../SemanticPanel";
import { confirmSemanticLeave, emptySemanticGuard, type SemanticGuard } from "../semantic-editor";
import { SnapshotPanel } from "./SnapshotPanel";
import { SourceListItem } from "./SourceListItem";
import { commitAndRefresh, sourceViewKey, sourceViewReady } from "./source-state";
import { type Connector, connectorStatus, type Source } from "./source-types";
import { useSourceBindings } from "./use-source-bindings";

type Workspace = { id: string; name: string };

export function DataSourceManager({
  onBack,
  onSemanticGuardChange,
}: {
  onBack: () => void;
  onSemanticGuardChange?: (guard: SemanticGuard) => void;
}) {
  const semanticGuard = useRef(emptySemanticGuard());
  const updateSemanticGuard = useCallback(
    (guard: SemanticGuard) => {
      semanticGuard.current = guard;
      onSemanticGuardChange?.(guard);
    },
    [onSemanticGuardChange],
  );
  const canChangeSemanticScope = () => confirmSemanticLeave(semanticGuard.current, window);
  useEffect(() => () => onSemanticGuardChange?.(emptySemanticGuard()), [onSemanticGuardChange]);
  const [sources, setSources] = useState<Source[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [connector, setConnector] = useState("");
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [archived, setArchived] = useState(false);
  const [pages, setPages] = useState<string[]>([""]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [loadedView, setLoadedView] = useState<string | null>(null);
  const [listPending, setListPending] = useState(false);
  const [workspacePages, setWorkspacePages] = useState<string[]>([""]);
  const [workspaceNext, setWorkspaceNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const connectorSequence = useRef(0);
  const [queryCapability, setQueryCapability] = useState<
    "loading" | "enabled" | "disabled" | "error"
  >("loading");
  const [querySource, setQuerySource] = useState("");
  const selectedView = sourceViewKey(archived, pages[pages.length - 1] ?? "");
  const {
    bound,
    boundOptions,
    boundPages,
    boundNext,
    setBoundPages,
    snapshot,
    setSnapshot,
    versions,
    versionCursor,
    changes,
    scans,
    state,
    bindingError,
    bindingsLoading,
    refreshBindings,
    view,
    selectVersion,
    comparePrevious,
    moreVersions,
  } = useSourceBindings({
    workspace,
    sources,
    selectedView,
    loadedView,
    querySource,
    setQuerySource,
    setBusy,
    setError,
  });
  useEffect(() => {
    let current = true;
    api<unknown>("/api/data-sources/query-capability", { signal: AbortSignal.timeout(4000) })
      .then((value) => {
        if (!current) return;
        if (
          !value ||
          typeof value !== "object" ||
          !("enabled" in value) ||
          typeof value.enabled !== "boolean"
        ) {
          setQueryCapability("error");
          return;
        }
        setQueryCapability(value.enabled ? "enabled" : "disabled");
      })
      .catch(() => {
        if (current) setQueryCapability("error");
      });
    return () => {
      current = false;
    };
  }, []);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    const query = new URLSearchParams();
    if (archived) query.set("archived", "true");
    const after = pages[pages.length - 1];
    if (after) query.set("after", after);
    const all = await api<{ sources: Source[]; nextCursor: string | null }>(
      `/api/data-sources?${query}`,
    );
    const workspaceQuery = new URLSearchParams({ archived: "false" });
    const workspaceAfter = workspacePages[workspacePages.length - 1];
    if (workspaceAfter) workspaceQuery.set("after", workspaceAfter);
    const page = await api<{ workspaces: Workspace[]; nextCursor: string | null }>(
      `/api/workspaces?${workspaceQuery}`,
    );
    if (request !== sequence.current) return;
    setSources(all.sources);
    setNextPage(all.nextCursor);
    setLoadedView(selectedView);
    setWorkspaces(page.workspaces);
    setWorkspaceNext(page.nextCursor);
    setWorkspace((current) =>
      page.workspaces.some((item) => item.id === current)
        ? current
        : (page.workspaces[0]?.id ?? ""),
    );
  }, [archived, pages, selectedView, workspacePages]);
  const loadConnectors = useCallback(async () => {
    const request = ++connectorSequence.current;
    try {
      const devices = await api<{ connectors: Connector[] }>("/api/connectors", {
        signal: AbortSignal.timeout(4000),
      });
      if (request !== connectorSequence.current) return;
      setConnectors(devices.connectors);
      setConnector((current) =>
        devices.connectors.some((item) => item.id === current && item.status !== "revoked")
          ? current
          : (devices.connectors.find((item) => item.status !== "revoked")?.id ?? ""),
      );
    } catch (error) {
      if (request === connectorSequence.current)
        setConnectors((items) => items.map((item) => ({ ...item, status: "unknown" })));
      throw error;
    }
  }, []);
  useEffect(() => {
    let active = true;
    setError("");
    setListPending(true);
    void Promise.all([load(), loadConnectors()])
      .catch(() => {
        if (active) setError("无法访问数据源服务，请检查登录状态、服务和数据库配置。");
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setListPending(false);
        }
      });
    return () => {
      active = false;
      sequence.current++;
      connectorSequence.current++;
    };
  }, [load, loadConnectors]);
  useEffect(() => {
    const timer = window.setInterval(() => void loadConnectors().catch(() => {}), 5000);
    return () => window.clearInterval(timer);
  }, [loadConnectors]);
  async function perform(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await commitAndRefresh(fn, () =>
        Promise.all([load(), loadConnectors(), refreshBindings(workspace, true)]),
      );
      if (result === "refresh-failed") {
        setError("操作已完成，但刷新状态失败。请刷新页面查看最新结果。");
      }
      return true;
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? "操作与已有数据或进行中的任务冲突，请刷新后重试。"
          : e instanceof ApiError
            ? e.message
            : "无法确认操作结果，请刷新状态后再决定是否重试。",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    await perform(async () => {
      await api("/api/data-sources", post({ id: sourceId.trim(), connectorId: connector, name }));
      setSourceId("");
      setName("");
    });
  }
  return (
    <main className="settings-page connector-page source-page">
      <Button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> 返回工作空间
      </Button>
      <div className="product-eyebrow">DATA SOURCES</div>
      <h1>数据源</h1>
      <p className="settings-intro">
        数据库密码只保存在 Connector 所在机器。结构扫描不读取业务数据。
      </p>
      {error && (
        <div className="product-error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p>正在加载数据源…</p>
      ) : (
        <>
          <section className="settings-card">
            <div className="settings-title">
              <span className="card-icon">
                <Database size={20} />
              </span>
              <div>
                <h2>配置数据源</h2>
                <p>
                  先停止 Connector，在其所在机器上配置只读账号；完成后重新启动，并将生成的 ID
                  填入这里。
                </p>
              </div>
            </div>
            <label>
              允许访问的工作空间{" "}
              <select
                value={workspace}
                disabled={busy}
                onChange={(e) => {
                  if (!canChangeSemanticScope()) return;
                  state.current.select(e.target.value);
                  setSnapshot(null);
                  setWorkspace(e.target.value);
                }}
              >
                <option value="">请选择</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <Button
                disabled={busy || workspacePages.length === 1}
                onClick={() => {
                  if (!canChangeSemanticScope()) return;
                  state.current.select("");
                  setWorkspace("");
                  setLoading(true);
                  setWorkspacePages((items) => items.slice(0, -1));
                }}
              >
                上一组工作空间
              </Button>
              <Button
                disabled={busy || !workspaceNext}
                onClick={() => {
                  if (!workspaceNext) return;
                  if (!canChangeSemanticScope()) return;
                  state.current.select("");
                  setWorkspace("");
                  setLoading(true);
                  setWorkspacePages((items) => [...items, workspaceNext]);
                }}
              >
                下一组工作空间
              </Button>
            </div>
            {workspace && (
              <div className="connector-offer">
                <p>在 Connector 的项目目录运行，将数据库名和账号替换为你的配置：</p>
                <code className="connector-command">
                  go run ./cmd/connector source add --database YOUR_DB --user READ_ONLY_USER
                  --workspaces {workspace} --tls local
                </code>
                <p>
                  此示例使用未加密的本机回环连接；远程连接还需设置 <code>--host</code>{" "}
                  和受信任证书，并使用 <code>--tls required</code>。 密码在终端输入，不会回显。
                </p>
              </div>
            )}
            <form className="product-form" onSubmit={(e) => void create(e)}>
              <label>
                连接器
                <select required value={connector} onChange={(e) => setConnector(e.target.value)}>
                  <option value="">请选择</option>
                  {connectors
                    .filter((c) => c.status !== "revoked")
                    .map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name}（{connectorStatus[c.status] ?? "状态未知"}）
                      </option>
                    ))}
                </select>
              </label>
              <label>
                数据源名称
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                本机生成的数据源 ID
                <input
                  required
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                  placeholder="粘贴 Connector 返回的 ID"
                />
              </label>
              <Button className="product-primary" type="submit" disabled={busy || !connector}>
                添加数据源
              </Button>
            </form>
          </section>
          <section className="settings-card">
            <div className="connector-list-head">
              <div>
                <h2>工作空间数据源</h2>
                <p>只有完成双向授权的连接器才能扫描结构。</p>
              </div>
              <Button
                className="subtle-button"
                disabled={busy}
                onClick={() => void perform(async () => {})}
              >
                <RefreshCw size={16} />
                刷新
              </Button>
            </div>
            <div>
              <Button
                disabled={busy || !archived}
                onClick={() => {
                  setArchived(false);
                  setPages([""]);
                }}
              >
                使用中
              </Button>
              <Button
                disabled={busy || archived}
                onClick={() => {
                  setArchived(true);
                  setPages([""]);
                }}
              >
                已归档
              </Button>
            </div>
            {!workspace && <p>请选择工作空间后绑定数据源。</p>}
            {!sourceViewReady(loadedView, selectedView) ? (
              <p role={listPending ? undefined : "alert"}>
                {listPending ? "正在加载当前数据源列表…" : "当前列表加载失败，请刷新重试。"}
              </p>
            ) : bindingsLoading ? (
              <p>正在加载绑定状态…</p>
            ) : bindingError ? (
              <p role="alert">绑定状态暂时无法获取，请检查连接后重试。</p>
            ) : sources.length === 0 ? (
              <p>还没有数据源。</p>
            ) : (
              <ul className="session-list">
                {sources.map((item) => (
                  <SourceListItem
                    key={`${workspace}:${archived}:${item.id}:${bound.some((source) => source.id === item.id)}`}
                    item={item}
                    context={{
                      archived,
                      busy,
                      workspace,
                      connectors,
                      binding: bound.find((b) => b.id === item.id),
                      scan: scans[item.id] ?? null,
                    }}
                    actions={{
                      restore: () =>
                        perform(() => api(`/api/data-sources/${item.id}/restore`, post())),
                      reassign: (connectorId) =>
                        perform(() =>
                          api(`/api/data-sources/${item.id}/connector`, {
                            ...post({ connectorId }),
                            method: "PUT",
                          }),
                        ),
                      rename: (name) =>
                        perform(() =>
                          api(`/api/data-sources/${item.id}`, {
                            ...post({ name }),
                            method: "PATCH",
                          }),
                        ),
                      archive: () =>
                        perform(() => api(`/api/data-sources/${item.id}`, { method: "DELETE" })),
                      bind: () =>
                        perform(() =>
                          api(`/api/data-sources/workspaces/${workspace}/${item.id}`, {
                            ...post(),
                            method: "PUT",
                          }),
                        ),
                      setDefault: () =>
                        perform(() =>
                          api(`/api/data-sources/workspaces/${workspace}/${item.id}/default`, {
                            ...post(),
                            method: "PUT",
                          }),
                        ),
                      scan: () =>
                        perform(() =>
                          api(`/api/data-sources/workspaces/${workspace}/${item.id}/scan`, post()),
                        ),
                      view: () => void view(item),
                      unbind: () => {
                        if (querySource === item.id && !canChangeSemanticScope())
                          return Promise.resolve(false);
                        return perform(async () => {
                          await api(`/api/data-sources/workspaces/${workspace}/${item.id}`, {
                            method: "DELETE",
                          });
                          setQuerySource((current) => (current === item.id ? "" : current));
                          state.current.invalidateSnapshot();
                          setSnapshot(null);
                        });
                      },
                    }}
                  />
                ))}
              </ul>
            )}
            <div>
              <Button
                disabled={busy || pages.length === 1}
                onClick={() => setPages((items) => items.slice(0, -1))}
              >
                上一页
              </Button>
              <Button
                disabled={busy || !nextPage || !sourceViewReady(loadedView, selectedView)}
                onClick={() => {
                  if (nextPage) setPages((items) => [...items, nextPage]);
                }}
              >
                下一页
              </Button>
            </div>
          </section>
          <section className="settings-card read-query-selector">
            <h2>只读查询</h2>
            {queryCapability === "loading" ? (
              <p>正在检查查询功能…</p>
            ) : queryCapability === "error" ? (
              <p role="alert">无法确认查询功能状态，请检查服务后重新打开数据源页面。</p>
            ) : queryCapability === "disabled" ? (
              <p>只读查询暂未启用。</p>
            ) : !workspace ? (
              <p>请选择工作空间。</p>
            ) : bindingsLoading ? (
              <p>正在加载数据源绑定…</p>
            ) : bindingError ? (
              <p role="alert">无法确认数据源绑定，请检查连接。</p>
            ) : boundOptions.length === 0 && !querySource ? (
              <p>请先绑定数据源。</p>
            ) : (
              <label>
                选择数据源
                <select
                  value={querySource}
                  disabled={busy}
                  onChange={(event) => {
                    if (canChangeSemanticScope()) setQuerySource(event.target.value);
                  }}
                >
                  <option value="">请选择</option>
                  {boundOptions.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                  {querySource &&
                    !boundOptions.some((item) => item.id === querySource) &&
                    bound
                      .filter((item) => item.id === querySource)
                      .map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.name}（当前选择）
                        </option>
                      ))}
                </select>
              </label>
            )}
            {queryCapability === "enabled" && workspace && !bindingsLoading && !bindingError && (
              <div>
                <Button
                  disabled={busy || boundPages.length === 1}
                  onClick={() => setBoundPages((items) => items.slice(0, -1))}
                >
                  上一组已绑定数据源
                </Button>
                <Button
                  disabled={busy || !boundNext}
                  onClick={() => {
                    if (boundNext) setBoundPages((items) => [...items, boundNext]);
                  }}
                >
                  下一组已绑定数据源
                </Button>
              </div>
            )}
          </section>
          {queryCapability === "enabled" &&
            workspace &&
            (() => {
              const selected = bound.find((item) => item.id === querySource);
              const linked =
                selected && connectors.find((item) => item.id === selected.connectorId);
              return selected && linked && linked.status !== "revoked" ? (
                <ReadQueryPanel
                  key={`${workspace}:${selected.id}:${selected.connectorId}`}
                  workspaceId={workspace}
                  sourceId={selected.id}
                  sourceName={selected.name}
                  unavailable={bindingsLoading || bindingError || linked.status === "unknown"}
                />
              ) : querySource ? (
                <p role="alert">连接器状态不可用，暂时不能打开查询。</p>
              ) : null;
            })()}
          {workspace && bound.some((item) => item.id === querySource) && (
            <SemanticPanel
              key={`${workspace}:${querySource}`}
              workspaceId={workspace}
              sourceId={querySource}
              sourceName={bound.find((item) => item.id === querySource)?.name ?? "数据源"}
              unavailable={bindingsLoading || bindingError}
              interactionBlocked={busy}
              onGuardChange={updateSemanticGuard}
            />
          )}
          {snapshot && (
            <SnapshotPanel
              snapshot={snapshot}
              versions={versions}
              versionCursor={versionCursor}
              changes={changes}
              busy={busy}
              actions={{ selectVersion, moreVersions, comparePrevious }}
            />
          )}
        </>
      )}
    </main>
  );
}
