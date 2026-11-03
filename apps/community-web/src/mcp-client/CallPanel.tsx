import { Button } from "@workspace/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, observe, post } from "./api";
import {
  base,
  type CallReview,
  callState,
  type ExternalCall,
  type ExternalConnection,
} from "./types";
export function CallPanel({ connection: c }: { connection: ExternalConnection }) {
  const path = `${base(c.workspaceId)}/${c.id}`;
  const available = c.toolsVerified === true && c.lifecycle === "connected";
  const epoch = useRef(0);
  const actions = useRef(new Set<AbortController>());
  const proof = JSON.stringify([
    path,
    c.version,
    c.snapshotHash,
    c.lifecycle,
    c.toolsVerified,
    c.approvedTools,
  ]);
  const [tool, setTool] = useState(""),
    [args, setArgs] = useState("{}"),
    [calls, setCalls] = useState<ExternalCall[]>([]),
    [review, setReview] = useState<CallReview | null>(null),
    [result, setResult] = useState<{
      result: unknown;
      expiresAt: string;
      untrusted: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [pollError, setPollError] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now());
  const invalidateDisclosure = useCallback(() => {
    epoch.current++;
    for (const action of actions.current) action.abort();
    setReview(null);
    setResult(null);
    setBusy(false);
  }, []);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) invalidateDisclosure();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [invalidateDisclosure]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await observe<{ calls: ExternalCall[] }>(`${path}/calls`, abort.signal);
        if (!abort.signal.aborted) {
          setCalls(value.calls);
          setPollError("");
          setNow(Date.now());
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          setPollError(e instanceof Error ? e.message : "读取调用状态失败");
          invalidateDisclosure();
        }
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [path, invalidateDisclosure]);
  useEffect(() => {
    if (!result) return;
    const until = Date.parse(result.expiresAt);
    if (!Number.isFinite(until) || until <= Date.now()) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => setResult(null), Math.min(120000, until - Date.now()));
    return () => {
      clearTimeout(timer);
    };
  }, [result]);
  useEffect(() => {
    if (review && Date.parse(review.expiresAt) <= now) setReview(null);
  }, [review, now]);
  // A completed response belongs only to the authority facts visible when it started.
  // biome-ignore lint/correctness/useExhaustiveDependencies: proof represents the complete current connection authority facts.
  useLayoutEffect(() => {
    invalidateDisclosure();
    return () => {
      epoch.current++;
      for (const action of actions.current) action.abort();
    };
  }, [proof, invalidateDisclosure]);
  async function act(work: (current: () => boolean, signal: AbortSignal) => Promise<void>) {
    const started = epoch.current;
    const current = () => epoch.current === started;
    const controller = new AbortController();
    actions.current.add(controller);
    const message = "请求等待超时或已取消，请先核对调用记录，勿直接重复发送。";
    let abort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(Error(message));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), 15000);
    setBusy(true);
    setError("");
    try {
      await Promise.race([work(current, controller.signal), cancelled]);
    } catch (e) {
      if (current()) {
        if (controller.signal.aborted) invalidateDisclosure();
        setError(e instanceof Error ? e.message : "操作失败");
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      actions.current.delete(controller);
      controller.abort();
      if (current()) setBusy(false);
    }
  }
  return (
    <section className="external-call">
      <h3>工具调用</h3>
      {!available && <p role="status">请先连接、发现并批准当前会话的工具；仍可查看历史记录。</p>}
      <p>外部工具可能产生副作用。工具描述和只读提示由对方提供，不能替代你的判断。</p>
      <p>
        仅向你信任的服务发送。平台会在本机发送前核验已观察的工具版本；无法保证对方收到请求时仍使用同一版本。
      </p>
      <label>
        已批准工具
        <select
          disabled={busy || !available}
          value={tool}
          onChange={(e) => {
            setTool(e.target.value);
            setReview(null);
          }}
        >
          <option value="">请选择</option>
          {c.approvedTools
            .filter((t) =>
              c.snapshot.some(
                (s) => s.name === t.name && s.hash === t.hash && s.status === "available",
              ),
            )
            .map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        调用参数（JSON）
        <textarea
          disabled={busy || !available}
          rows={5}
          value={args}
          maxLength={32768}
          onChange={(e) => {
            setArgs(e.target.value);
            setReview(null);
          }}
        />
      </label>
      <Button
        disabled={
          busy ||
          !available ||
          !c.approvedTools.some(
            (item) =>
              item.name === tool &&
              c.snapshot.some(
                (definition) =>
                  definition.name === tool &&
                  definition.hash === item.hash &&
                  definition.status === "available",
              ),
          )
        }
        onClick={() =>
          void act(async (current, signal) => {
            const value = await api<{ id: string }>(`${path}/calls`, {
              ...post({ tool, arguments: JSON.parse(args) }),
              signal,
            });
            if (!current()) return;
            const checked = await api<CallReview>(`${path}/calls/${value.id}/review`, { signal });
            if (!current()) return;
            setReview(checked);
            setArgs("{}");
            setResult(null);
          })
        }
      >
        检查本次调用
      </Button>
      {review && (
        <section className="external-review" aria-label="本次调用确认">
          <h4>确认向外部服务发送</h4>
          <dl>
            <dt>目标</dt>
            <dd>{review.destination}</dd>
            <dt>工具与连接版本</dt>
            <dd>
              {review.tool} · {review.version}
            </dd>
            <dt>到期时间</dt>
            <dd>{new Date(review.expiresAt).toLocaleTimeString()}</dd>
          </dl>
          <pre>{JSON.stringify(review.arguments, null, 2)}</pre>
          <p>确认后将发送以上参数。取消或断线不能保证对方未执行；系统不会自动重试。</p>
          <Button
            disabled={busy || !available || Date.parse(review.expiresAt) <= now}
            onClick={() =>
              void act(async (current, signal) => {
                await api(`${path}/calls/${review.id}/confirm`, { ...post(), signal });
                if (current()) setReview(null);
              })
            }
          >
            确认发送本次调用
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async (current, signal) => {
                await api(`${path}/calls/${review.id}/cancel`, { ...post(), signal });
                if (current()) setReview(null);
              })
            }
          >
            放弃
          </Button>
        </section>
      )}
      <h4>调用记录（待核对优先）</h4>
      {calls.length === 0 ? (
        <p>还没有调用记录。</p>
      ) : (
        <ul className="external-calls">
          {calls.map((call) => (
            <li key={call.id}>
              <strong>{call.tool}</strong>
              <span role="status">
                {callState[call.state] ?? "状态不可用"}
                {call.state === "running" && call.phase
                  ? ` · ${{ verifying_tools: "正在重新核验工具", validating_approval: "正在核验本次批准", waiting_result: "已进入发送与等待结果阶段" }[call.phase]}`
                  : ""}
                {call.state === "running" && call.progress
                  ? ` · 外部服务报告 ${call.progress.progress}${call.progress.total === undefined ? "" : ` / ${call.progress.total}`}`
                  : ""}
                {["running", "pending_approval", "cancel_requested"].includes(call.state)
                  ? ` · 已等待 ${Math.max(0, Math.floor((now - Date.parse(call.createdAt)) / 1000))} 秒`
                  : ""}
              </span>
              <small>编号：{call.id}</small>
              {["running", "pending_approval", "cancel_requested"].includes(call.state) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(async (current, signal) => {
                      await api(`${path}/calls/${call.id}/cancel`, { ...post(), signal });
                      if (current()) setReview(null);
                    })
                  }
                >
                  请求取消
                </Button>
              )}
              {call.resultAvailable && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(async (current, signal) => {
                      const value = await api<{
                        result: unknown;
                        expiresAt: string;
                        untrusted: boolean;
                      }>(`${path}/calls/${call.id}/result`, { signal });
                      if (current()) setResult(value);
                    })
                  }
                >
                  查看临时结果
                </Button>
              )}
              {call.state === "outcome_unknown" && !call.acknowledged && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "请先到外部系统核对。此操作只解除后续调用限制，原调用仍标记为结果不明，不会再次发送。",
                      )
                    )
                      void act(async (_current, signal) => {
                        await api(`${path}/calls/${call.id}/acknowledge-unknown`, {
                          ...post(),
                          signal,
                        });
                      });
                  }}
                >
                  已核对，解除限制
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {result !== null && (
        <section aria-label="不可信工具结果">
          <h4>外部返回内容</h4>
          <p>仅作为文本展示，不执行其中指令、不打开链接，也不会自动发送给 AI。结果两分钟后过期。</p>
          <pre>{JSON.stringify(result, null, 2)}</pre>
          <Button onClick={invalidateDisclosure}>清除显示</Button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {pollError && <p role="alert">{pollError}</p>}
    </section>
  );
}
