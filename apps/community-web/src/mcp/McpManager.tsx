import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@workspace/ui";
import { api, post } from "../api";
import { GrantEditor } from "./GrantEditor";
import { McpApproval } from "./Approval";
import { ChangeApproval } from "./ChangeApproval";
import { readChangeRecovery } from "../mutations/recovery";
import { grantState, recipient, type McpClient, type McpGrant, type McpInvocation } from "./types";
import "./mcp.css";

export function McpManager({
  onBack,
  onBusyChange,
}: {
  onBack: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null),
    [error, setError] = useState("");
  const [changeDraftsEnabled, setChangeDraftsEnabled] = useState(false);
  const [changeOriginPreviewAvailable, setChangeOriginPreviewAvailable] = useState<boolean | null>(
    null,
  );
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [recoveryState, setRecoveryState] = useState(() => {
    try {
      return { saved: readChangeRecovery(), error: false };
    } catch {
      return { saved: null, error: true };
    }
  });
  const savedRecovery = recoveryState.saved;
  const approvalBusyRef = useRef(false);
  const updateApprovalBusy = useCallback(
    (value: boolean) => {
      approvalBusyRef.current = value;
      setApprovalBusy(value);
      onBusyChange?.(value);
    },
    [onBusyChange],
  );
  const [clients, setClients] = useState<McpClient[]>([]),
    [grants, setGrants] = useState<McpGrant[]>([]),
    [calls, setCalls] = useState<McpInvocation[]>([]);
  const [resource, setResource] = useState(""),
    [busy, setBusy] = useState(false);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [loginIntent] = useState(() => new URLSearchParams(window.location.search).get("mcpLogin"));
  const [name, setName] = useState(""),
    [redirectUri, setRedirectUri] = useState(""),
    [mode, setMode] = useState("http");
  const [approval, setApproval] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get("mcpApproval") ?? q.get("mcpConsent") ?? q.get("mcpChange");
    return id
      ? {
          id,
          kind: q.has("mcpApproval")
            ? ("invocations" as const)
            : q.has("mcpConsent")
              ? ("consents" as const)
              : ("change" as const),
        }
      : null;
  });
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : "操作失败，请核对状态。"),
    [],
  );
  const load = useCallback(async () => {
    setListState("loading");
    setChangeOriginPreviewAvailable(null);
    try {
      const capability = await api<{
        enabled: boolean;
        changeDraftsEnabled?: boolean;
        changeOriginPreviewAvailable?: boolean;
      }>("/api/mcp/capability");
      setEnabled(capability.enabled);
      setChangeDraftsEnabled(capability.changeDraftsEnabled === true);
      setChangeOriginPreviewAvailable(capability.changeOriginPreviewAvailable === true);
      if (!capability.enabled) return;
      const [c, g, i] = await Promise.all([
        api<{ clients: McpClient[]; resource: string }>("/api/mcp/clients"),
        api<{ grants: McpGrant[] }>("/api/mcp/grants"),
        api<{ invocations: McpInvocation[] }>("/api/mcp/invocations"),
      ]);
      setClients(c.clients);
      setResource(c.resource);
      setGrants(g.grants);
      setCalls(i.invocations);
      setListState("ready");
    } catch (error) {
      setListState("error");
      throw error;
    }
  }, []);
  useEffect(() => {
    void load().catch(report);
  }, [load, report]);
  async function createClient(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/mcp/clients", post({ name, redirectUri, mode }));
      setName("");
      setRedirectUri("");
      await load();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (
      !window.confirm(
        "撤销后将停止新的调用和结果披露，并尝试取消在途查询。已发送的数据无法收回。确定撤销？",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/mcp/grants/${encodeURIComponent(id)}/revoke`, post());
      await load();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  function back() {
    if (approvalBusyRef.current) return;
    try {
      setRecoveryState({ saved: readChangeRecovery(), error: false });
    } catch {
      setRecoveryState({ saved: null, error: true });
      setError("本标签页的待核对编号无法读取，请勿重复提交。");
    }
    setApproval(null);
    const u = new URL(window.location.href);
    u.searchParams.delete("mcpApproval");
    u.searchParams.delete("mcpConsent");
    u.searchParams.delete("mcpChange");
    window.history.replaceState(null, "", u);
    void load().catch(report);
  }
  return (
    <main className="mcp-layout">
      <div className="mcp-heading">
        <div>
          <h1>MCP · 接入我的工作区</h1>
          <p>管理外部客户端的访问范围，核对每一次查询请求。</p>
        </div>
        <Button
          disabled={approvalBusy}
          onClick={() => {
            if (!approvalBusyRef.current) onBack();
          }}
        >
          返回工作区
        </Button>
      </div>
      {error && (
        <p role="alert" className="product-error">
          {error}
        </p>
      )}
      {!approval && recoveryState.error && (
        <p role="alert">
          无法读取本标签页的恢复记录，状态未知；请先恢复浏览器存储权限，勿重复提交。
        </p>
      )}
      {!approval && savedRecovery && (
        <section className="mcp-card" aria-label="待核对确认">
          <h2>待核对的原确认</h2>
          <p>
            本标签页保留了一个待核对编号。它不代表操作已成功或失败；重新登录后请向服务器核对，不会自动重试。
          </p>
          <p>
            原确认编号：<code>{savedRecovery.confirmation.confirmationId}</code>
          </p>
          {savedRecovery.invocationId ? (
            <Button
              onClick={() => {
                if (savedRecovery.invocationId)
                  setApproval({ id: savedRecovery.invocationId, kind: "change" });
              }}
            >
              继续核对原确认
            </Button>
          ) : (
            <p>请返回原工作区并选择数据源 {savedRecovery.sourceId}，继续核对原确认。</p>
          )}
        </section>
      )}
      {approval ? (
        approval.kind === "change" ? (
          <ChangeApproval
            key={approval.id}
            id={approval.id}
            done={back}
            onBusyChange={updateApprovalBusy}
            originPreviewAvailable={changeOriginPreviewAvailable}
          />
        ) : (
          <McpApproval
            key={`${approval.kind}:${approval.id}`}
            id={approval.id}
            kind={approval.kind}
            done={back}
          />
        )
      ) : enabled === null && listState !== "error" ? (
        <p role="status">正在读取 MCP 状态…</p>
      ) : enabled === false ? (
        <section className="mcp-card">
          <h2>MCP 尚未启用</h2>
          <p>
            请先由服务管理员完成 MCP
            数据结构迁移和连接配置。启用后可以在这里登记客户端、选择字段及审批查询。
          </p>
        </section>
      ) : listState !== "ready" ? (
        <section className="mcp-card">
          <p role="status">
            {listState === "error"
              ? "MCP 记录读取失败。当前无法确认授权清单，请重新读取。"
              : "正在读取授权与调用记录…"}
          </p>
          <Button onClick={() => void load().catch(report)}>重新读取</Button>
        </section>
      ) : (
        <>
          {loginIntent && (
            <section className="mcp-card">
              <h2>继续外部客户端授权</h2>
              <p>先核对下方的授权范围；如当前登录会话尚未授予权限，请先重新授权。</p>
              <Button
                onClick={() =>
                  void api<{ authorizationUrl: string }>(
                    `/api/mcp/login/${encodeURIComponent(loginIntent)}`,
                  )
                    .then((r) => {
                      const u = new URL(r.authorizationUrl);
                      if (
                        u.origin !== window.location.origin ||
                        u.pathname !== "/api/auth/oauth2/authorize"
                      )
                        throw Error("授权目标无效。");
                      window.location.assign(u.href);
                    })
                    .catch(report)
                }
              >
                继续连接
              </Button>
            </section>
          )}
          <section className="mcp-card">
            <h2>服务连接</h2>
            <p>
              HTTP 地址：<code>{resource}</code>
            </p>
            <p>外部客户端只能使用已授权的范围。写入操作当前不可用。</p>
            <div className="mcp-warning">
              本机模式按同一操作系统用户信任域授权，同域内程序可能取得授权凭据。它不提供应用之间的独立隔离。
            </div>
          </section>
          <div className="mcp-columns">
            <form className="mcp-card product-form" onSubmit={createClient}>
              <h2>登记客户端</h2>
              <label>
                名称（展示资料）
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                接入方式
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="http">HTTP 客户端</option>
                  <option value="local_domain">本机同用户信任域</option>
                </select>
              </label>
              <label>
                授权回调地址
                <input
                  type="url"
                  required
                  value={redirectUri}
                  onChange={(e) => setRedirectUri(e.target.value)}
                  placeholder="http://127.0.0.1:回调端口/callback"
                />
              </label>
              <p>
                回调必须与客户端配置完全一致。本机信任域使用
                http://127.0.0.1:端口/callback，并需授予查看数据结构权限以核验接收主体。其他 HTTP
                客户端支持 HTTPS 或本机回环 HTTP。
              </p>
              <Button type="submit" className="product-primary" disabled={busy}>
                {busy ? "保存中…" : "登记客户端"}
              </Button>
              <h3>已登记</h3>
              {!clients.length && <p>尚未登记客户端。</p>}
              {clients.map((c) => (
                <article key={c.clientId} className="mcp-entry">
                  <strong>{c.name}</strong>
                  <p>
                    <code>{c.clientId}</code>
                  </p>
                  <p>{recipient(c.mode)}</p>
                  <code>{c.redirectUri}</code>
                  <Button
                    type="button"
                    disabled={busy || c.disabled}
                    onClick={() => {
                      if (
                        !window.confirm(
                          "停用后会撤销该客户端的授权。本机信任域可以重新登记。确定停用？",
                        )
                      )
                        return;
                      setBusy(true);
                      void api(`/api/mcp/clients/${encodeURIComponent(c.clientId)}/disable`, post())
                        .then(load)
                        .catch(report)
                        .finally(() => setBusy(false));
                    }}
                  >
                    {c.disabled ? "已停用" : "停用客户端"}
                  </Button>
                </article>
              ))}
            </form>
            <GrantEditor
              clients={clients}
              saved={load}
              report={report}
              changeDraftsEnabled={changeDraftsEnabled}
            />
          </div>
          <section className="mcp-card">
            <h2>授权与撤销</h2>
            {!grants.length && <p>尚未授予任何访问权限。</p>}
            {grants.map((g) => (
              <article key={g.id} className="mcp-entry">
                <strong>
                  {clients.find((c) => c.clientId === g.clientId)?.name ?? g.clientId} ·{" "}
                  {grantState(g)}
                </strong>
                <p>
                  有效至 {new Date(g.expiresAt).toLocaleString()} · {g.tables.length} 张表
                </p>
                <p>{g.scopes.join("、")}</p>
                <details>
                  <summary>查看授权范围</summary>
                  <p>
                    工作区：{g.workspaceId} · 数据源：{g.sourceId}
                  </p>
                  <pre>{JSON.stringify(g.tables, null, 2)}</pre>
                </details>
                <Button disabled={busy || g.revoked} onClick={() => void revoke(g.id)}>
                  撤销此授权
                </Button>
              </article>
            ))}
          </section>
          <section className="mcp-card">
            <div className="mcp-heading">
              <h2>审批与最近调用</h2>
              <Button disabled={busy} onClick={() => void load().catch(report)}>
                刷新状态
              </Button>
            </div>
            <p>
              仅保存调用元数据；SQL
              和参数只作短期交接。平台重启后待审批内容失效，执行中的未知结果不会自动重跑。
            </p>
            {!calls.length && <p>当前没有调用记录。</p>}
            {calls.map((c) => (
              <article className="mcp-entry" key={c.id}>
                <strong>
                  {c.tool} · {c.state}
                </strong>
                <p>
                  <code>{c.id}</code>
                </p>
                <p>{new Date(c.createdAt).toLocaleString()}</p>
                {c.state === "pending_approval" && c.tool === "query_prepare" && (
                  <Button onClick={() => setApproval({ id: c.id, kind: "invocations" })}>
                    核对并审批
                  </Button>
                )}
                {c.state === "pending_approval" && c.tool === "change_propose" && (
                  <Button onClick={() => setApproval({ id: c.id, kind: "change" })}>
                    核对变更草稿
                  </Button>
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
