import { Button } from "@workspace/ui";
import { useState } from "react";
import { api, post } from "./api";
import { CallPanel } from "./CallPanel";
import { base, type ExternalConnection, type Program } from "./types";
export function ConnectionDetails({
  connection: c,
  programs,
  reload,
}: {
  connection: ExternalConnection;
  programs: Program[];
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [stage, setStage] = useState(""),
    [error, setError] = useState(""),
    [secret, setSecret] = useState(""),
    [environment, setEnvironment] = useState<Record<string, string>>({}),
    [selectedTools, setSelectedTools] = useState<string[]>([]),
    [authURL, setAuthURL] = useState("");
  const path = `${base(c.workspaceId)}/${c.id}`,
    program =
      c.config.kind === "stdio"
        ? programs.find((p) => c.config.kind === "stdio" && p.id === c.config.programId)
        : undefined;
  async function act(label: string, work: () => Promise<void>) {
    setBusy(true);
    setStage(label);
    setError("");
    try {
      await work();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
      setStage("");
    }
  }
  if (c.disabled)
    return (
      <section>
        <h3>{c.name}</h3>
        <p>此连接已停用。</p>
      </section>
    );
  if (c.executionHostChanged)
    return (
      <section>
        <h2>{c.name}</h2>
        <p>
          此连接属于其他执行主机，旧批准在当前电脑不可使用。请在当前主机重新创建连接；旧主机上的凭据仍需由原主机清理。
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            void act("正在停用…", async () => {
              await api(`${path}/disable`, post());
            })
          }
        >
          停用原主机连接
        </Button>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <section className="external-detail">
      <h2>{c.name}</h2>
      <p>
        {c.config.kind === "http" ? c.config.resource : (program?.name ?? "本机程序不可用")} · 版本{" "}
        {c.version}
      </p>
      <p>
        执行位置：运行平台服务的电脑。
        {{
          connected: "连接已建立",
          closing: "正在关闭连接",
          cleanup_unknown: "连接清理结果不明，需要核对",
          disconnected: "尚未连接",
        }[c.lifecycle] ?? "连接状态不可用"}
        ；凭据
        {c.credentialConfigured ? "已配置" : "未配置"}。
      </p>
      {c.config.kind === "stdio" && program && (
        <div className="external-review">
          <p>批准此程序意味着信任它以平台服务用户身份运行，拥有该用户的系统权限。</p>
          <small>安装完整性：{program.installationHash}</small>
          <dl>
            <dt>程序</dt>
            <dd>{program.executable}</dd>
            <dt>固定参数</dt>
            <dd>{program.arguments.join(" ")}</dd>
            <dt>工作目录</dt>
            <dd>{program.workingDirectoryRoot} / 每次新建的唯一目录</dd>
          </dl>
          <Button
            disabled={busy || c.installationHash === program.installationHash}
            onClick={() => {
              if (window.confirm("已确认信任此程序及其依赖，允许在平台服务电脑运行？"))
                void act("正在记录程序批准…", async () => {
                  await api(
                    `${path}/program-approval`,
                    post({ installationHash: program.installationHash }),
                  );
                });
            }}
          >
            批准当前安装包
          </Button>
        </div>
      )}
      {(c.config.kind === "stdio" || c.config.authentication !== "none") && (
        <details>
          <summary>配置或替换凭据</summary>
          <p>仅保存到执行电脑的系统凭据库；不会返回明文。替换将清除旧工具批准并中止在途调用。</p>
          {c.config.kind === "stdio" ? (
            program?.secretEnvironment.map((key) => (
              <label key={key}>
                {key}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={environment[key] ?? ""}
                  onChange={(e) => setEnvironment((v) => ({ ...v, [key]: e.target.value }))}
                />
              </label>
            ))
          ) : (
            <label>
              {c.config.authentication === "oauth" ? "客户端秘密（公共客户端可留空）" : "访问密钥"}
              <input
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                maxLength={4096}
              />
            </label>
          )}
          <Button
            disabled={busy}
            onClick={() =>
              void act("正在替换凭据…", async () => {
                const value =
                  c.config.kind === "stdio"
                    ? { environment }
                    : c.config.authentication === "bearer"
                      ? { bearer: secret }
                      : c.config.authentication === "api_key"
                        ? { apiKey: secret }
                        : secret
                          ? { clientSecret: secret }
                          : {};
                await api(`${path}/credentials`, post(value));
                setSecret("");
                setEnvironment({});
              })
            }
          >
            保存新凭据
          </Button>
        </details>
      )}
      {c.config.kind === "http" && c.config.authentication === "oauth" && (
        <div>
          <Button
            disabled={busy}
            onClick={() =>
              void act("正在核验授权机构…", async () => {
                const value = await api<{ authorizationUrl: string }>(
                  `${path}/oauth/start`,
                  post(),
                );
                setAuthURL(value.authorizationUrl);
              })
            }
          >
            开始 OAuth 授权
          </Button>
          {authURL && (
            <div>
              <p>
                即将离开平台，前往 {new URL(authURL).origin}
                。浏览器导航及后续跳转由该网站控制；平台无法固定浏览器的 DNS
                或限制其跳转。请检查浏览器实际地址，仅向你信任的授权机构登录。
              </p>
              <a href={authURL} rel="noreferrer">
                前往配置的授权网站
              </a>
            </div>
          )}
        </div>
      )}
      <div className="external-actions">
        <Button
          disabled={busy || c.lifecycle === "closing" || c.lifecycle === "cleanup_unknown"}
          onClick={() =>
            void act("正在连接服务并发现工具…", async () => {
              await api(`${path}/discover`, post());
            })
          }
        >
          连接并发现工具
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void act("正在断开…", async () => {
              await api(`${path}/disconnect`, post());
            })
          }
        >
          断开连接
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            if (window.confirm("停用此连接并清除批准？已经发送的内容无法收回。"))
              void act("正在停用…", async () => {
                await api(`${path}/disable`, post());
              });
          }}
        >
          停用连接
        </Button>
      </div>
      {busy && <p role="status">{stage}</p>}
      {error && <p role="alert">{error}</p>}
      <h3>{c.toolsVerified ? "当前会话已核验工具" : "工具历史快照"}</h3>
      <p>
        {c.toolsVerified
          ? "上次读取时，服务已确认工具变更订阅；批准与发送时仍会重新核验。"
          : "以下仅为历史记录，不能代表当前工具或授权状态。请重新连接并发现工具。"}
      </p>
      {c.snapshot.length === 0 ? (
        <p>没有可显示的历史工具记录。</p>
      ) : (
        <>
          <div className="external-tools">
            {c.snapshot.map((t) => (
              <article key={t.hash}>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy || !c.toolsVerified || t.status !== "available"}
                    checked={selectedTools.includes(t.name)}
                    onChange={(event) =>
                      setSelectedTools((items) =>
                        event.target.checked
                          ? [...items.filter((name) => name !== t.name), t.name]
                          : items.filter((name) => name !== t.name),
                      )
                    }
                  />
                  {t.name}
                </label>
                <p>{t.description}</p>
                {t.status === "available" ? (
                  <details>
                    <summary>查看输入结构</summary>
                    <pre>{JSON.stringify(t.inputSchema, null, 2)}</pre>
                  </details>
                ) : (
                  <p>此工具的输入或输出结构暂不受支持，无法批准或调用。</p>
                )}
              </article>
            ))}
          </div>
          <Button
            disabled={busy || !c.toolsVerified || selectedTools.length === 0}
            onClick={() =>
              void act("正在批准当前工具…", async () => {
                const tools = c.snapshot
                  .filter(
                    (tool) => tool.status === "available" && selectedTools.includes(tool.name),
                  )
                  .map((tool) => tool.name);
                await api(`${path}/tools-approval`, post({ snapshotHash: c.snapshotHash, tools }));
                setSelectedTools([]);
              })
            }
          >
            批准选中工具
          </Button>
        </>
      )}
      <Button
        disabled={busy}
        onClick={() =>
          void act("正在撤销批准…", async () => {
            await api(`${path}/tools-approval`, post({ tools: [] }));
          })
        }
      >
        撤销所有工具批准
      </Button>
      <CallPanel
        key={`${c.id}:${c.version}:${c.snapshotHash}:${JSON.stringify(c.approvedTools)}`}
        connection={c}
      />
    </section>
  );
}
