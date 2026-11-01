import { type RefObject, useRef, useState } from "react";
import { api } from "../api";
import { historyRequest } from "../history-api";
import type { QueryResult } from "./query-result";
import type { QuerySession } from "./query-session";
import { downloadResult, exportReviewedResult } from "./result-export";

type Capability = "loading" | "enabled" | "disabled" | "unavailable";
type Intent = {
  result: QueryResult;
  base: string;
  auditPath: string;
  capability: "enabled" | "disabled";
  session: QuerySession;
};

/** A confirmation is bound to the exact result, scope, session and audit mode.
 * Recheck them after the server authorization and before downloading. */
export function useResultExport(options: {
  workspaceId: string;
  sourceId: string;
  base: string;
  result: QueryResult | null;
  session: RefObject<QuerySession | null>;
  allowed: boolean;
  definitionBusy: boolean;
  capability: Capability;
}) {
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<Intent | null>(null);
  const intentRef = useRef<Intent | null>(null);
  const inFlight = useRef(false);
  const current = useRef(options);
  current.current = options;
  const matches = (intent: Intent) => {
    const value = current.current;
    return (
      value.session.current === intent.session &&
      value.result === intent.result &&
      value.base === intent.base &&
      value.allowed &&
      value.capability === intent.capability
    );
  };
  function begin() {
    const value = current.current;
    if (
      !value.result ||
      !value.session.current ||
      value.definitionBusy ||
      intentRef.current ||
      inFlight.current ||
      !value.allowed ||
      (value.capability !== "enabled" && value.capability !== "disabled")
    )
      return;
    const intent: Intent = {
      result: value.result,
      base: value.base,
      auditPath: `/api/history/${encodeURIComponent(value.workspaceId)}/${encodeURIComponent(value.sourceId)}/export`,
      capability: value.capability,
      session: value.session.current,
    };
    intentRef.current = intent;
    setConfirmation(intent);
    setMessage("");
  }
  function cancel() {
    if (inFlight.current) return;
    intentRef.current = null;
    setConfirmation(null);
  }
  async function confirm() {
    const intent = intentRef.current;
    if (!intent || inFlight.current) return;
    if (!matches(intent)) {
      cancel();
      setMessage("当前结果或授权范围已变化，已取消导出。请重新核对。");
      return;
    }
    inFlight.current = true;
    setExporting(true);
    setMessage("");
    try {
      const outcome = await exportReviewedResult(
        intent,
        matches,
        async (reviewed) => {
          if (reviewed.capability === "enabled")
            await historyRequest(reviewed.auditPath, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            });
          else await api(`${reviewed.base}/scope`, { signal: AbortSignal.timeout(8000) });
        },
        downloadResult,
      );
      if (outcome === "stale") {
        if (current.current.session.current) setMessage("当前结果或授权范围已变化，已取消导出。");
        return;
      }
      if (outcome === "download-failed") {
        setMessage("无法生成导出文件，请检查浏览器设置后重试。");
      }
    } catch {
      if (current.current.session.current)
        setMessage("无法确认当前数据源授权，未导出结果。请检查连接后重试。");
    } finally {
      inFlight.current = false;
      intentRef.current = null;
      if (current.current.session.current) {
        setExporting(false);
        setConfirmation(null);
      }
    }
  }
  return {
    busy: exporting || confirmation !== null,
    exporting,
    message,
    confirmation,
    begin,
    cancel,
    confirm,
  };
}
