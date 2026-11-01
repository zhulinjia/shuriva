import { Button } from "@workspace/ui";
import { ArrowLeft, Link2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, post } from "./api";
import {
  type Connector,
  connectorListReducer,
  connectorListView,
  connectorStatus,
  initialConnectorList,
} from "./connector-list-state";

type Offer = { pairingId: string; secret: string; platformPublicKey: string; expiresAt: number };
const labels: Record<Connector["status"], string> = {
  online: "在线",
  offline: "离线",
  incompatible: "版本不兼容",
  revoked: "已撤销",
};
export function ConnectorManager({ onBack }: { onBack: () => void }) {
  const [list, dispatchList] = useReducer(connectorListReducer, initialConnectorList);
  const { items, refreshError } = list;
  const view = connectorListView(list);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const requestSequence = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    if (mounted.current) dispatchList({ type: "start", request: sequence });
    try {
      const result = await api<{ connectors: Connector[] }>("/api/connectors", {
        signal: AbortSignal.timeout(4000),
      });
      if (mounted.current && sequence === requestSequence.current) {
        dispatchList({ type: "success", request: sequence, items: result.connectors });
      }
    } catch {
      if (mounted.current && sequence === requestSequence.current) {
        dispatchList({ type: "failure", request: sequence });
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 5000);
    return () => {
      mounted.current = false;
      requestSequence.current++;
      window.clearInterval(timer);
    };
  }, [refresh]);
  async function makeOffer() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      setOffer(await api<Offer>("/api/connectors/pairings", post()));
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "配对码生成失败");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(item: Connector) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/connectors/${encodeURIComponent(item.id)}/revoke`, post());
      await refresh();
      setConfirmId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销失败");
    } finally {
      setBusy(false);
    }
  }
  async function diagnose(item: Connector) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/connectors/${encodeURIComponent(item.id)}/diagnostics`, post());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接诊断发起失败");
    } finally {
      setBusy(false);
    }
  }
  async function copyCode() {
    if (!offer || now >= offer.expiresAt) return;
    try {
      await navigator.clipboard.writeText(
        `${offer.pairingId}.${offer.secret}.${offer.platformPublicKey}`,
      );
      setCopied(true);
    } catch {
      setError("复制失败，请手动选择并复制配对码。");
    }
  }
  return (
    <main className="settings-page connector-page">
      <Button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> 返回工作空间
      </Button>
      <div className="product-eyebrow">CONNECTORS</div>
      <h1>连接器</h1>
      <p className="settings-intro">配对运行在数据所在环境中的 Connector，并查看连接状态。</p>
      {error && (
        <div className="product-error" role="alert">
          {error}
        </div>
      )}
      {refreshError && (
        <div className="product-error" role="alert">
          连接器状态更新失败，当前状态未知；正在重试。
        </div>
      )}
      <section className="settings-card">
        <div className="settings-title">
          <span className="card-icon">
            <Link2 size={20} />
          </span>
          <div>
            <h2>配对连接器</h2>
            <p>配对码只能使用一次，5 分钟后失效。</p>
          </div>
        </div>
        {!offer || now >= offer.expiresAt ? (
          <div className="connector-offer">
            <Button className="product-primary" onClick={() => void makeOffer()} disabled={busy}>
              生成配对码
            </Button>
            {offer && <p>配对码已过期，请重新生成。</p>}
          </div>
        ) : (
          <div className="connector-offer">
            <p>在 Connector 所在机器的终端运行以下命令，然后输入配对码：</p>
            <code className="connector-command">
              go run ./cmd/connector pair --server {window.location.origin}
            </code>
            <label className="connector-code-label">
              一次性配对码
              <input
                readOnly
                value={`${offer.pairingId}.${offer.secret}.${offer.platformPublicKey}`}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <div className="connector-offer-actions">
              <Button className="subtle-button" onClick={() => void copyCode()}>
                {copied ? "已复制" : "复制配对码"}
              </Button>
              <span>有效期至 {new Date(offer.expiresAt).toLocaleTimeString()}</span>
              <Button className="subtle-button" onClick={() => setOffer(null)}>
                关闭
              </Button>
            </div>
            <p>请勿将配对码发送给不信任的人。执行命令前需进入项目的 connector/go 目录。</p>
          </div>
        )}
      </section>
      <section className="settings-card">
        <div className="connector-list-head">
          <div>
            <h2>已配对的连接器</h2>
            <p>在线状态约每 5 秒更新。</p>
          </div>
          <Button
            className="subtle-button"
            onClick={() => void refresh()}
            aria-label="刷新连接器列表"
          >
            <RefreshCw size={17} />
            刷新
          </Button>
        </div>
        {view === "loading" ? (
          <p>正在加载连接器…</p>
        ) : view === "unavailable" ? (
          <div className="workspace-empty">暂时无法获取连接器列表。</div>
        ) : view === "empty" ? (
          <div className="workspace-empty">还没有连接器，生成配对码开始连接。</div>
        ) : (
          <ul className="session-list">
            {items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {item.name}{" "}
                    <span className={`connector-status ${connectorStatus(list, item)}`}>
                      {connectorStatus(list, item) === "unknown" ? "状态未知" : labels[item.status]}
                    </span>
                  </strong>
                  <small>
                    版本 {item.agentVersion} ·{" "}
                    {item.lastSeenAt === null
                      ? "暂无心跳记录"
                      : `上次心跳 ${new Date(item.lastSeenAt).toLocaleString()}`}
                  </small>
                  {item.diagnosticStatus && (
                    <small>
                      {refreshError ? "上次诊断记录（可能已过期）：" : "连接诊断："}
                      {item.diagnosticStatus === "pending"
                        ? "等待连接器响应"
                        : item.diagnosticStatus === "completed"
                          ? "已完成"
                          : "已过期，请重试"}
                    </small>
                  )}
                </div>
                {item.status !== "revoked" && item.status !== "incompatible" && (
                  <Button
                    className="subtle-button"
                    onClick={() => void diagnose(item)}
                    disabled={busy || !!refreshError || item.diagnosticStatus === "pending"}
                  >
                    连接诊断
                  </Button>
                )}
                {item.status !== "revoked" &&
                  (confirmId === item.id ? (
                    <section
                      className="connector-revoke-confirm"
                      aria-label={`确认撤销 ${item.name}`}
                    >
                      <span>撤销后需要重新配对。</span>
                      <Button
                        className="subtle-button"
                        onClick={() => void revoke(item)}
                        disabled={busy || !!refreshError}
                      >
                        确认撤销
                      </Button>
                      <Button
                        className="subtle-button"
                        onClick={() => setConfirmId(null)}
                        disabled={busy}
                      >
                        取消
                      </Button>
                    </section>
                  ) : (
                    <Button
                      className="subtle-button"
                      onClick={() => setConfirmId(item.id)}
                      disabled={busy || !!refreshError}
                    >
                      撤销连接
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="settings-hint">
        连接诊断仅验证平台与连接器之间的通信，不读取数据库。数据源连接和数据库操作将在后续阶段实现。
      </p>
    </main>
  );
}
