import { Button } from "@workspace/ui";
import { type FormEvent, useState } from "react";
import { api, post } from "./api";
import { base, type HttpConfig, type Program } from "./types";
export function ConnectionEditor({
  workspace,
  programs,
  onSaved,
}: {
  workspace: string;
  programs: Program[];
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState("http"),
    [name, setName] = useState(""),
    [resource, setResource] = useState(""),
    [privateIPs, setPrivateIPs] = useState(""),
    [auth, setAuth] = useState<HttpConfig["authentication"]>("none"),
    [program, setProgram] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [connectSeconds, setConnectSeconds] = useState(10),
    [callSeconds, setCallSeconds] = useState(60);
  const [oauthIPs, setOauthIPs] = useState<Record<string, string>>({});
  const [oauth, setOauth] = useState({
    issuer: "",
    resourceMetadataUrl: "",
    metadataUrl: "",
    authorizationEndpoint: "",
    tokenEndpoint: "",
    clientId: "",
    scopes: "",
  });
  const originOf = (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  };
  const oauthOrigins =
    auth === "oauth"
      ? [
          ...new Set(
            [
              oauth.resourceMetadataUrl,
              oauth.metadataUrl,
              oauth.tokenEndpoint,
              oauth.authorizationEndpoint,
            ].map(originOf),
          ),
        ].filter((o) => o && o !== originOf(resource))
      : [];
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const config =
        kind === "http"
          ? {
              kind,
              resource,
              authentication: auth,
              privateApprovals: [
                { origin: new URL(resource).origin, ips: privateIPs },
                ...oauthOrigins.map((origin) => ({ origin, ips: oauthIPs[origin] ?? "" })),
              ]
                .filter((v) => v.ips.trim())
                .map((v) => ({
                  origin: v.origin,
                  addresses: v.ips
                    .split(",")
                    .map((a) => a.trim())
                    .filter(Boolean),
                })),
              oauth:
                auth === "oauth"
                  ? { ...oauth, scopes: oauth.scopes.split(" ").filter(Boolean) }
                  : null,
            }
          : { kind, programId: program };
      await api(
        base(workspace),
        post({
          name,
          config: {
            ...config,
            connectTimeoutMs: connectSeconds * 1000,
            callTimeoutMs: callSeconds * 1000,
          },
        }),
      );
      setName("");
      setResource("");
      setPrivateIPs("");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="external-editor" onSubmit={submit}>
      <h3>新增外部连接</h3>
      <label>
        连接名称
        <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        连接方式
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="http">HTTP 服务</option>
          <option value="stdio" disabled={!programs.length}>
            本机受信程序
          </option>
        </select>
      </label>
      {kind === "http" ? (
        <>
          <label>
            MCP 服务地址
            <input
              type="url"
              required
              placeholder="https://mcp.example.com/mcp"
              value={resource}
              onChange={(e) => setResource(e.target.value)}
            />
          </label>
          <label>
            凭据方式
            <select
              value={auth}
              onChange={(e) => setAuth(e.target.value as HttpConfig["authentication"])}
            >
              <option value="none">无需凭据</option>
              <option value="bearer">Bearer 令牌</option>
              <option value="api_key">API Key（x-api-key）</option>
              <option value="oauth">OAuth 授权码与 PKCE</option>
            </select>
          </label>
          <label>
            允许的私网 IP（可选，英文逗号分隔）
            <input
              value={privateIPs}
              onChange={(e) => setPrivateIPs(e.target.value)}
              placeholder="仅在你信任该私网服务时填写"
            />
          </label>
          <p className="muted">填写后仅批准此服务来源和这些 IP。控制面和云元数据地址仍被拒绝。</p>
          {auth === "oauth" && (
            <fieldset>
              <legend>预先登记的 OAuth 客户端</legend>
              {(
                [
                  "issuer",
                  "resourceMetadataUrl",
                  "metadataUrl",
                  "authorizationEndpoint",
                  "tokenEndpoint",
                  "clientId",
                  "scopes",
                ] as const
              ).map((k) => (
                <label key={k}>
                  {
                    {
                      issuer: "授权机构",
                      resourceMetadataUrl: "资源元数据地址",
                      metadataUrl: "授权机构元数据地址",
                      authorizationEndpoint: "登录授权地址",
                      tokenEndpoint: "令牌地址",
                      clientId: "客户端 ID",
                      scopes: "请求权限（空格分隔）",
                    }[k]
                  }
                  <input
                    required={k !== "scopes"}
                    type={k === "clientId" || k === "scopes" ? "text" : "url"}
                    value={oauth[k]}
                    onChange={(e) => setOauth((v) => ({ ...v, [k]: e.target.value }))}
                  />
                </label>
              ))}
              <p>
                当前不自动登记客户端。以下许可只批准列出的来源和 IP；未批准的私网地址仍会被拒绝。
              </p>
              {oauthOrigins.map((origin) => (
                <label key={origin}>
                  允许 {origin} 的私网 IP（可选，英文逗号分隔）
                  <input
                    value={oauthIPs[origin] ?? ""}
                    onChange={(e) => setOauthIPs((v) => ({ ...v, [origin]: e.target.value }))}
                  />
                </label>
              ))}
            </fieldset>
          )}
        </>
      ) : (
        <>
          <label>
            已安装程序
            <select required value={program} onChange={(e) => setProgram(e.target.value)}>
              <option value="">请选择</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <p>
            程序运行在平台服务电脑，拥有该系统用户的权限。仅使用你信任的安装包；网页不能安装程序或执行下载命令。
          </p>
        </>
      )}
      <p>地址中不要放密钥；访问密钥请使用连接的凭据配置。</p>
      <label>
        连接与发现时限（秒，上限 10）
        <input
          type="number"
          min={1}
          max={10}
          required
          value={connectSeconds}
          onChange={(e) => setConnectSeconds(Number(e.target.value))}
        />
      </label>
      <label>
        本次调用最长等待（秒，上限 60）
        <input
          type="number"
          min={1}
          max={60}
          required
          value={callSeconds}
          onChange={(e) => setCallSeconds(Number(e.target.value))}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy || !workspace} type="submit">
        {busy ? "正在保存…" : "保存连接"}
      </Button>
      <small>保存后不会连接服务或运行程序。</small>
    </form>
  );
}
