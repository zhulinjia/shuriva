import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@workspace/ui";
import { api, post } from "../api";
import { MutationPanel } from "../mutations/MutationPanel";
import { decodeMutationAIPlan } from "../mutations/ai-client";
import type { Plan } from "../mutations/model";
import { withRequestTimeout } from "../models/model-session";
import {
  clearChangeRecovery,
  readChangeRecovery,
  sameChangeRecovery,
  saveChangeRecovery,
} from "../mutations/recovery";
import { recipient } from "./types";

type Change = { requestId: string; workspaceId: string; sourceId: string; plan: Plan };
type Review = {
  id: string;
  commitment: string;
  change: Change;
  recipient: { mode: string; clientId: string };
};
function parseChange(value: unknown, id: string): Change {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("草稿格式无效。");
  const data = value as Record<string, unknown>;
  const uuid = (input: unknown) => typeof input === "string" && /^[0-9a-f-]{36}$/i.test(input);
  if (data.requestId !== id || !uuid(data.workspaceId) || !uuid(data.sourceId))
    throw Error("草稿范围无效。");
  return {
    requestId: id,
    workspaceId: String(data.workspaceId),
    sourceId: String(data.sourceId),
    plan: decodeMutationAIPlan(data.plan),
  };
}

export function ChangeApproval({
  id,
  done,
  onBusyChange,
  originPreviewAvailable,
}: {
  id: string;
  done: () => void;
  onBusyChange?: (busy: boolean) => void;
  originPreviewAvailable: boolean | null;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [accepted, setAccepted] = useState<Change | null>(null);
  const [stored] = useState(() => {
    try {
      return { saved: readChangeRecovery(), error: false };
    } catch {
      return { saved: null, error: true };
    }
  });
  const restored = stored.saved?.invocationId === id ? stored.saved : null;
  const otherPending = !!stored.saved && stored.saved.invocationId !== id;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const scope = accepted ?? restored;
  const workspaceId = scope?.workspaceId;
  const sourceId = scope?.sourceId;
  const recovery = useMemo(() => {
    if (!workspaceId || !sourceId) return undefined;
    const base = { invocationId: id, workspaceId, sourceId };
    return {
      save: (confirmation: import("../mutations/model").Confirmation) =>
        saveChangeRecovery({ ...base, confirmation }),
      clear: (confirmation: import("../mutations/model").Confirmation) =>
        clearChangeRecovery({ ...base, confirmation }),
      canDefer: (confirmation: import("../mutations/model").Confirmation) => {
        const saved = readChangeRecovery();
        return sameChangeRecovery(saved, { ...base, confirmation });
      },
    };
  }, [id, workspaceId, sourceId]);
  const busyListener = useRef(onBusyChange);
  busyListener.current = onBusyChange;
  useEffect(() => {
    busyListener.current?.(busy || mutationBusy);
  }, [busy, mutationBusy]);
  useEffect(() => () => busyListener.current?.(false), []);
  useEffect(() => {
    if (restored || otherPending || stored.error) return;
    const controller = new AbortController();
    void api<Review>(`/api/mcp/change-drafts/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          value.id !== id ||
          !/^[0-9a-f]{64}$/.test(value.commitment) ||
          !value.recipient ||
          typeof value.recipient.clientId !== "string" ||
          typeof value.recipient.mode !== "string"
        )
          throw Error("草稿信息无效。");
        setReview({ ...value, change: parseChange(value.change, id) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("无法读取草稿，授权可能已撤销或请求已过期。");
      });
    return () => {
      controller.abort();
      const active = activeRequest.current;
      activeRequest.current = null;
      active?.abort();
    };
  }, [id, restored, otherPending, stored.error]);
  async function receive() {
    if (!review || attempted || busy) return;
    try {
      if (readChangeRecovery()) {
        setReview(null);
        setError("本标签页已有待核对确认，请先返回并处理原确认，不能领取新草稿。");
        return;
      }
    } catch {
      setReview(null);
      setError("无法读取本标签页的恢复记录，状态未知；不能领取新草稿，请先恢复浏览器存储权限。");
      return;
    }
    const commitment = review.commitment;
    setReview(null);
    setAttempted(true);
    setBusy(true);
    setError("");
    const controller = new AbortController();
    activeRequest.current = controller;
    let received: Change | null = null;
    try {
      const change = await withRequestTimeout(controller.signal, 15000, async (signal) => {
        let result: { id: string; change: unknown; receipt: string } | null = await api<{
          id: string;
          change: unknown;
          receipt: string;
        }>(`/api/mcp/change-drafts/${encodeURIComponent(id)}/claim`, {
          ...post({ commitment }),
          signal,
        });
        signal.throwIfAborted();
        if (!result || result.id !== id || !/^[0-9a-f]{64}$/.test(result.receipt))
          throw Error("回执无效。");
        received = parseChange(result.change, id);
        const receipt = result.receipt;
        result = null;
        await api(`/api/mcp/change-drafts/${encodeURIComponent(id)}/acknowledge`, {
          ...post({ receipt }),
          signal,
        });
        signal.throwIfAborted();
        const change = received;
        if (!change) throw Error("草稿已清除。");
        received = null;
        return change;
      });
      if (activeRequest.current === controller) setAccepted(change);
    } catch {
      if (activeRequest.current === controller) {
        setAccepted(null);
        setError("接收结果无法确认或授权已撤销，草稿已清除。请返回查看状态；不要重复提交。");
      }
    } finally {
      received = null;
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="mcp-card">
      <h2>核对外部变更草稿</h2>
      <p>
        请求编号：<code>{id}</code>
      </p>
      <p>草稿不授予写入或执行权限。接收后属于管理员自己的新操作，仍须独立核对、预览和确认。</p>
      {stored.error && (
        <p role="alert">
          无法读取本标签页的恢复记录，状态未知；不能领取新草稿，请先恢复浏览器存储权限。
        </p>
      )}
      {otherPending && (
        <p role="alert">本标签页已有待核对确认，请先返回并处理原确认，不能领取新草稿。</p>
      )}
      {error && (
        <p role="alert" className="product-error">
          {error}
        </p>
      )}
      {review && (
        <>
          <div className="mcp-warning">
            <strong>草稿来源</strong>
            <p>{recipient(review.recipient.mode)}</p>
            <code>{review.recipient.clientId}</code>
            <p>名称仅供展示，不能证明程序发布者身份。</p>
          </div>
          <p>工作区：{review.change.workspaceId}</p>
          <p>数据源：{review.change.sourceId}</p>
          <pre>{JSON.stringify(review.change.plan, null, 2)}</pre>
          <Button disabled={busy} onClick={() => void receive()}>
            接收草稿
          </Button>
        </>
      )}
      {busy && <p role="status">正在接收并确认，请勿关闭页面…</p>}
      {scope && (
        <>
          <p>
            {restored
              ? "已恢复本标签页保存的待核对编号。请重新登录并向服务器核对，不能据此判断执行结果。"
              : "本页已接收草稿；服务端持久交接状态仍为未知。原客户端授权撤销后，后续操作由当前管理员独立承担。"}
          </p>
          <p>
            {restored ? "待核对工作区 ID（来自本标签页）" : "已核验工作区 ID"}：
            <code>{scope.workspaceId}</code>
          </p>
          <p>
            {restored ? "待核对数据源 ID（来自本标签页）" : "已核验数据源 ID"}：
            <code>{scope.sourceId}</code>
          </p>
          {originPreviewAvailable !== true && (
            <p role="status">
              草稿来源预览不可用或尚无法确认，暂不能生成预览或确认写入；请勿重复提交草稿。
            </p>
          )}
          <MutationPanel
            workspaceId={scope.workspaceId}
            sourceId={scope.sourceId}
            sourceName={scope.sourceId}
            showScopeIdentity
            initialPlan={accepted?.plan}
            originInvocationId={id}
            onBusyChange={setMutationBusy}
            previewUnavailable={originPreviewAvailable !== true}
            restoredPending={restored?.confirmation}
            recovery={recovery}
            onDefer={() => {
              setMutationBusy(false);
              busyListener.current?.(false);
              done();
            }}
          />
          {!restored && (
            <p>每次预览都会核验草稿来源并记录是否修改。来源无法核验时，预览会被拒绝。</p>
          )}
        </>
      )}
      <Button
        disabled={busy || mutationBusy}
        onClick={() => {
          if (!busy && !mutationBusy) done();
        }}
      >
        返回 MCP 管理
      </Button>
    </section>
  );
}
