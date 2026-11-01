import { Button } from "@workspace/ui";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, post } from "./api";

type SessionItem = {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
};

export function SecurityPanel({
  onBack,
  onSignedOut,
}: {
  onBack: () => void;
  onSignedOut: () => void;
}) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const load = useCallback(async () => {
    const data = await api<{ sessions: SessionItem[] }>("/api/security/sessions");
    setSessions(data.sessions);
  }, []);
  useEffect(() => {
    void load()
      .catch(() => setError("无法读取会话，请重新登录或稍后重试。"))
      .finally(() => setLoading(false));
  }, [load]);
  async function revoke(item: SessionItem) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`/api/security/sessions/${encodeURIComponent(item.id)}/revoke`, post());
      if (item.current) {
        onSignedOut();
        return;
      }
      await load();
      setMessage("会话已退出。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成。");
    } finally {
      setBusy(false);
    }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (newPassword !== confirm) {
      setError("两次输入的新密码不一致。");
      return;
    }
    if (newPassword.length < 12 || newPassword.length > 128) {
      setError("新密码长度须为 12 至 128 个字符。");
      return;
    }
    setBusy(true);
    try {
      await api(
        "/api/auth/change-password",
        post({ currentPassword: oldPassword, newPassword, revokeOtherSessions: true }),
      );
      setOldPassword("");
      setNewPassword("");
      setConfirm("");
      await load();
      setMessage("密码已修改，其他会话已退出。");
    } catch {
      setError("密码修改失败，请检查当前密码后重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="settings-page">
      <Button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> 返回工作空间
      </Button>
      <div className="product-eyebrow">ACCOUNT SECURITY</div>
      <h1>账号安全</h1>
      <p className="settings-intro">管理密码与已登录设备。</p>
      {error && (
        <div className="product-error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="product-success" role="status">
          {message}
        </div>
      )}
      <section className="settings-card">
        <div className="settings-title">
          <span className="card-icon">
            <ShieldCheck size={20} />
          </span>
          <div>
            <h2>修改密码</h2>
            <p>修改后，其他已登录会话会退出。</p>
          </div>
        </div>
        <form className="product-form settings-form" onSubmit={changePassword}>
          <label>
            当前密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label>
            确认新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <Button className="product-primary" type="submit" disabled={busy}>
            更新密码
          </Button>
        </form>
        <p className="settings-hint">忘记密码时，可由本机管理员在终端重设；当前未开通邮箱找回。</p>
      </section>
      <section className="settings-card">
        <h2>已登录会话</h2>
        <p>可以退出不再使用的设备。</p>
        {loading ? (
          <p>正在加载会话…</p>
        ) : sessions.length === 0 ? (
          <p>没有可显示的会话。</p>
        ) : (
          <ul className="session-list">
            {sessions.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.current ? "当前会话" : "其他会话"}</strong>
                  <small>{item.userAgent || "未知设备"}</small>
                  <small>
                    登录时间：{new Date(item.createdAt).toLocaleString()} · 到期时间：
                    {new Date(item.expiresAt).toLocaleString()}
                  </small>
                </div>
                <Button className="subtle-button" onClick={() => void revoke(item)} disabled={busy}>
                  {item.current ? "退出当前会话" : "退出该会话"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
