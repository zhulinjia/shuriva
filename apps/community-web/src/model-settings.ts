import { ApiError } from "./api.ts";

export type DisplayModel =
  | { configured: false }
  | { configured: true; baseUrl: string; model: string; configVersion: string };
export type SettingsAction = "load" | "save" | "check" | "remove";

const pendingKey = "model-settings-write-pending";

// Keep the uncertainty marker when the user leaves this page in the same tab.
// It contains no configuration or credential data.
export function settingsWritePending(): boolean {
  try {
    return sessionStorage.getItem(pendingKey) === "1";
  } catch {
    return false;
  }
}

export function setSettingsWritePending(pending: boolean): void {
  try {
    if (pending) sessionStorage.setItem(pendingKey, "1");
    else sessionStorage.removeItem(pendingKey);
  } catch {
    // In-memory state still protects this open page when storage is unavailable.
  }
}

export function hasUnsavedModelChanges(
  config: DisplayModel | null,
  baseUrl: string,
  model: string,
  apiKey: string,
): boolean {
  return (
    !!config?.configured && (baseUrl !== config.baseUrl || model !== config.model || apiKey !== "")
  );
}

/** A lost write response does not prove that the credential store was unchanged. */
export function settingsFailure(
  action: SettingsAction,
  error: unknown,
  cancelled: boolean,
): { message: string; uncertain: boolean } {
  if (action === "check") {
    if (cancelled)
      return { message: "已取消连接检查；模型服务可能已经收到请求。", uncertain: false };
    if (error instanceof Error && error.message === "request timeout")
      return {
        message: "连接检查超时，模型服务可能已经收到请求；请确认后重试。",
        uncertain: false,
      };
    if (error instanceof ApiError && error.status === 429)
      return { message: "检查过于频繁，请等待至少 5 秒后再试。", uncertain: false };
    if (error instanceof ApiError && error.status === 409)
      return { message: "模型配置已变化，请重新读取配置后再检查。", uncertain: false };
    return { message: "连接未完成，请检查接口、密钥、模型名称或稍后再试。", uncertain: false };
  }
  if (action === "load")
    return {
      message: "无法读取模型配置，请检查平台服务及本机凭据库后重新读取。",
      uncertain: false,
    };
  const label = action === "save" ? "保存" : "移除";
  if (error instanceof ApiError && [400, 401, 403, 429].includes(error.status))
    return { message: `${label}未完成，请检查输入和登录状态后重试。`, uncertain: false };
  return {
    message: `${label}结果未确认，操作可能已经完成，也可能仍在处理。请稍后重新读取配置并核对。`,
    uncertain: true,
  };
}
