import { Button } from "@workspace/ui";
import { ArrowRight, Bot, Database, Layers3, Link2, LogOut, ShieldCheck } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, post } from "./api";
import { ConnectorManager } from "./ConnectorManager";
import { ChatWorkspace } from "./chat/ChatWorkspace";
import { DataSourceManager } from "./datasources/DataSourceManager";
import { ModelSettings } from "./ModelSettings";
import { SecurityPanel } from "./SecurityPanel";
import { confirmSemanticLeave, emptySemanticGuard, type SemanticGuard } from "./semantic-editor";
import { type Workspace, WorkspaceManager } from "./WorkspaceManager";

type Session = { user: { name: string; username?: string } };
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [security, setSecurity] = useState(false);
  const [connectors, setConnectors] = useState(false);
  const [dataSources, setDataSources] = useState(false);
  const [models, setModels] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const semanticGuard = useRef(emptySemanticGuard());
  const updateSemanticGuard = useCallback((guard: SemanticGuard) => {
    semanticGuard.current = guard;
  }, []);
  const canLeaveDataSources = () => confirmSemanticLeave(semanticGuard.current, window);
  useEffect(() => {
    let active = true;
    api<Session | null>("/api/auth/get-session")
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => {
        if (active) setError("无法连接服务，请检查后端是否已启动。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  function signedOut() {
    setSession(null);
    setSelected(null);
    setSecurity(false);
    setConnectors(false);
    setDataSources(false);
    setModels(false);
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/sign-in/username", post({ username, password }));
      setPassword("");
      const value = await api<Session | null>("/api/auth/get-session");
      if (!value) throw new Error("登录未完成，请重试。");
      setSession(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (!canLeaveDataSources()) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/sign-out", post());
      signedOut();
    } catch {
      setError("退出失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  if (selected && session)
    return (
      <ChatWorkspace
        workspaceId={selected.id}
        workspaceName={selected.name}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <div className="product-shell">
      <header className="product-header">
        <div className="product-brand">
          <span className="product-logo">
            <Database size={18} />
          </span>
          <span>
            AI <b>Workspace</b>
            <small>DATABASE WORKSPACE</small>
          </span>
        </div>
        {session && (
          <div className="product-account">
            <span>{session.user.name}</span>
            <Button
              className="product-signout"
              aria-label="数据源"
              onClick={() => {
                setDataSources(true);
                setConnectors(false);
                setSecurity(false);
                setModels(false);
              }}
            >
              <Database size={16} />
              <span className="account-action-label">数据源</span>
            </Button>
            <Button
              className="product-signout"
              aria-label="连接器"
              onClick={() => {
                if (!canLeaveDataSources()) return;
                setConnectors(true);
                setSecurity(false);
                setDataSources(false);
                setModels(false);
              }}
            >
              <Link2 size={16} />
              <span className="account-action-label">连接器</span>
            </Button>
            <Button
              className="product-signout"
              aria-label="账号安全"
              onClick={() => {
                if (!canLeaveDataSources()) return;
                setSecurity(true);
                setConnectors(false);
                setDataSources(false);
                setModels(false);
              }}
            >
              <ShieldCheck size={16} />
              <span className="account-action-label">账号安全</span>
            </Button>
            <Button
              className="product-signout"
              aria-label="模型配置"
              onClick={() => {
                if (!canLeaveDataSources()) return;
                setModels(true);
                setDataSources(false);
                setConnectors(false);
                setSecurity(false);
              }}
            >
              <Bot size={16} />
              <span className="account-action-label">模型配置</span>
            </Button>
            <Button
              className="product-signout"
              aria-label="退出登录"
              onClick={logout}
              disabled={busy}
            >
              <LogOut size={16} />
              <span className="account-action-label">退出登录</span>
            </Button>
          </div>
        )}
      </header>
      {loading ? (
        <main className="product-loading">正在连接工作区…</main>
      ) : !session ? (
        <main className="login-layout">
          <section className="login-intro">
            <div className="product-eyebrow">YOUR DATA, IN CONTEXT</div>
            <h1>
              从一个问题开始，
              <br />
              发现数据的价值<span>。</span>
            </h1>
            <p>在安全的工作空间里探索数据，让想法更快变成答案。</p>
            <div className="login-decoration">
              <Layers3 size={26} />
              <div>
                <strong>为你的数据工作而设计</strong>
                <small>工作空间 · 数据连接 · AI 助手</small>
              </div>
            </div>
          </section>
          <section className="login-card">
            <div className="card-icon">
              <Database size={22} />
            </div>
            <h2>欢迎回来</h2>
            <p>使用管理员账号登录你的工作空间。</p>
            <form onSubmit={login} className="product-form">
              <label>
                用户名
                <input
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              {error && (
                <div className="product-error" role="alert">
                  {error}
                </div>
              )}
              <Button className="product-primary" disabled={busy} type="submit">
                {busy ? "登录中…" : "登录"} <ArrowRight size={17} />
              </Button>
            </form>
            <div className="login-help">首次使用？请先在服务器终端初始化管理员账号。</div>
          </section>
        </main>
      ) : models ? (
        <ModelSettings onBack={() => setModels(false)} />
      ) : dataSources ? (
        <DataSourceManager
          onBack={() => {
            if (canLeaveDataSources()) setDataSources(false);
          }}
          onSemanticGuardChange={updateSemanticGuard}
        />
      ) : connectors ? (
        <ConnectorManager onBack={() => setConnectors(false)} />
      ) : security ? (
        <SecurityPanel onBack={() => setSecurity(false)} onSignedOut={signedOut} />
      ) : (
        <WorkspaceManager onSelect={setSelected} />
      )}
    </div>
  );
}
