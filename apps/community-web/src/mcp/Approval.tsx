import { useEffect, useState } from "react";
import { Button } from "@workspace/ui";
import { api, post } from "../api";
import { recipient, type McpClient, type McpGrant } from "./types";

type Review = {
  id: string;
  commitment: string;
  query: {
    sql: string;
    parameters: { kind: string; value: string }[];
    maxRows: number;
    workspaceId: string;
    sourceId: string;
  };
  recipient: { mode: string; clientId: string };
  grant: McpGrant;
};
type Consent = {
  id: string;
  client: McpClient;
  grant: McpGrant;
  scopes: string[];
  expiresAt: number;
};
export function McpApproval({
  id,
  kind,
  done,
}: {
  id: string;
  kind: "consents" | "invocations";
  done: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null),
    [consent, setConsent] = useState<Consent | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [finished, setFinished] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setReview(null);
    setConsent(null);
    setError("");
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      setError("审批编号无效。");
      return;
    }
    void api<Review | Consent>(`/api/mcp/${kind}/${encodeURIComponent(id)}`, {
      signal: abort.signal,
    })
      .then((r) => {
        if (kind === "invocations" && "query" in r) setReview(r);
        else if (kind === "consents" && "client" in r) setConsent(r);
        else throw Error("审批内容格式无效。");
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "无法读取审批。授权可能已撤销或请求已过期。");
      });
    return () => abort.abort();
  }, [id, kind]);
  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ redirectUrl?: string }>(
        `/api/mcp/${kind}/${encodeURIComponent(id)}${kind === "invocations" ? "/decision" : ""}`,
        post(kind === "invocations" ? { accept, commitment: review?.commitment } : { accept }),
      );
      if (result.redirectUrl && consent) {
        const url = new URL(result.redirectUrl),
          expected = new URL(consent.client.redirectUri);
        if (
          url.origin !== expected.origin ||
          url.pathname !== expected.pathname ||
          !["http:", "https:"].includes(url.protocol)
        )
          throw Error("回调目标与已批准的客户端不一致。");
        window.location.assign(url.href);
        return;
      }
      setFinished(accept ? "已批准。你可以返回管理页面查看调用状态。" : "已拒绝此次请求。");
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message} 请回到管理页面核对状态，勿重复提交。`
          : "结果暂时无法确认，请回到管理页面核对。",
      );
    } finally {
      setBusy(false);
    }
  }
  const target = review ? review.recipient : consent?.client;
  return (
    <section className="mcp-card">
      <h2>{kind === "invocations" ? "核对外部查询请求" : "确认外部客户端连接"}</h2>
      <p>
        请求编号：<code>{id}</code>
      </p>
      {error && (
        <p role="alert" className="product-error">
          {error}
        </p>
      )}
      {!review && !consent && !error && <p role="status">正在核对当前授权…</p>}
      {target && (
        <div className="mcp-warning">
          <strong>数据接收方</strong>
          <p>{recipient(target.mode)}</p>
          <code>{target.clientId}</code>
          <p>客户端名称仅为展示资料，不能证明程序发布者身份。</p>
        </div>
      )}
      {consent && (
        <>
          <p>客户端：{consent.client.name}</p>
          <p>
            回调：<code>{consent.client.redirectUri}</code>
          </p>
          <p>权限：{consent.scopes.join("、")}</p>
          <p>授权有效至：{new Date(consent.grant.expiresAt).toLocaleString()}</p>
          <pre>{JSON.stringify(consent.grant.tables, null, 2)}</pre>
        </>
      )}
      {review && (
        <>
          <p>工作区：{review.query.workspaceId}</p>
          <p>数据源：{review.query.sourceId}</p>
          <h3>SQL 与实际参数</h3>
          <pre>{review.query.sql}</pre>
          <pre>{JSON.stringify(review.query.parameters, null, 2)}</pre>
          <p>最多 {review.query.maxRows} 行。批准后，本次查询结果可以交给上述接收方。</p>
        </>
      )}
      {finished ? (
        <p role="status">{finished}</p>
      ) : (
        (review || consent) && (
          <div className="mcp-actions">
            <Button disabled={busy} onClick={() => void decide(false)}>
              拒绝
            </Button>
            <Button className="product-primary" disabled={busy} onClick={() => void decide(true)}>
              {busy ? "处理中…" : kind === "invocations" ? "批准查询并允许返回结果" : "确认连接"}
            </Button>
          </div>
        )
      )}
      <Button disabled={busy} onClick={done}>
        返回 MCP 管理
      </Button>
    </section>
  );
}
