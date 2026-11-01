import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../api";
import { MutationPanel } from "../mutations/MutationPanel";
import "../styles.css";
import "../product.css";
import "./mutation-lab.css";

type ReviewContext = { workspaceId: string; sourceId: string; sourceName: string };
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function context(value: unknown): ReviewContext {
  if (
    !value ||
    typeof value !== "object" ||
    !("workspaceId" in value) ||
    !("sourceId" in value) ||
    typeof value.workspaceId !== "string" ||
    typeof value.sourceId !== "string" ||
    !id.test(value.workspaceId) ||
    !id.test(value.sourceId)
  )
    throw Error("INVALID_REVIEW_CONTEXT");
  const name = "sourceName" in value ? value.sourceName : "G3 独立测试数据源";
  if (typeof name !== "string" || name.length > 160) throw Error("INVALID_REVIEW_CONTEXT");
  return { workspaceId: value.workspaceId, sourceId: value.sourceId, sourceName: name };
}

/** Separate browser fixture: no product bootstrap, credentials or database configuration. */
export function MutationLab() {
  const [scope, setScope] = useState<ReviewContext | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<unknown>("/api/g3-review/context", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setScope(context(value));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  return (
    <main className="mutation-lab">
      <aside className="mutation-lab-banner">
        <strong>G3 隔离组件评审</strong>
        <span>独立测试环境 · 正式写入未开放</span>
        <p>此页直接使用真实变更组件；工作区和数据源仅由当前隔离评审服务提供。</p>
      </aside>
      {scope ? (
        <MutationPanel
          workspaceId={scope.workspaceId}
          sourceId={scope.sourceId}
          sourceName={scope.sourceName}
        />
      ) : (
        <p className="mutation-lab-status" role="status">
          {failed
            ? "无法读取隔离评审范围。请检查专用评审服务，页面不会回退到原平台。"
            : "正在读取隔离评审范围…"}
        </p>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw Error("Review root is missing");
createRoot(root).render(
  <StrictMode>
    <MutationLab />
  </StrictMode>,
);
