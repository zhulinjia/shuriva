import { post as jsonPost, api as request } from "../api";

export function post(body: unknown = {}) {
  return jsonPost(body);
}

const messages: Readonly<Record<string, string>> = {
  EXTERNAL_MCP_CLEANUP_UNKNOWN: "连接清理结果尚不确定，请查看日志并重新核对服务状态。",
  EXTERNAL_MCP_UNKNOWN_CALL_PENDING:
    "此连接有尚未核对的未知调用，请先核对原编号及外部系统，再确认已完成核对。",
  EXTERNAL_MCP_SUBSCRIPTION_UNAVAILABLE:
    "此服务未确认支持工具变更通知，当前无法安全发现和调用工具。请检查服务的 MCP 订阅能力。",
  EXTERNAL_MCP_DISCOVERY_SAFETY_UNAVAILABLE:
    "外部工具发现的安全验证尚未完成，目前无法发现或批准工具。",
  EXTERNAL_MCP_CALL_SAFETY_UNAVAILABLE: "外部工具调用的安全验证尚未完成，当前不能发送调用。",
  EXTERNAL_MCP_STORAGE_TIMEOUT:
    "元数据处理超时，变更结果可能未确定。请重新加载连接核对；不要据此重发工具调用。",
  EXTERNAL_MCP_AUTH_TIMEOUT: "授权核验超时，本次操作已停止。已发送的调用请查看原记录。",
  EXTERNAL_MCP_SCHEMA_REJECTED:
    "工具定义使用了未支持或超限的结构，本次发现已拒绝。请检查服务提供的工具定义。",
  EXTERNAL_MCP_RESPONSE_REJECTED: "外部服务回复不符合已支持的结构，连接已关闭。",
  EXTERNAL_MCP_SNAPSHOT_CHANGED: "工具内容已经变化。请重新发现、检查并批准工具。",
  EXTERNAL_MCP_TOOL_NOT_APPROVED: "请先检查并批准当前版本的工具。",
  EXTERNAL_MCP_CALL_ALREADY_CLAIMED: "这次调用已经处理，请查看原记录，不要重复发送。",
  EXTERNAL_MCP_CALL_EXPIRED: "本次确认已经过期，请重新检查调用参数。",
  EXTERNAL_MCP_CALL_NOT_FOUND: "此会话已无法使用本次确认或结果，请查看调用记录。",
  EXTERNAL_MCP_CONNECTION_BUSY: "此连接正在处理其他调用，请先查看原调用。",
  EXTERNAL_MCP_RESULT_EXPIRED: "临时结果已过期或授权已改变。",
  EXTERNAL_MCP_PROGRAM_APPROVAL_REQUIRED: "请先批准当前安装包、程序参数与执行权限。",
  EXTERNAL_MCP_PROGRAM_CHANGED: "程序或依赖已变化，请重新载入页面并检查安装包。",
  EXTERNAL_MCP_EXECUTION_HOST_CHANGED: "连接属于其他执行主机，请在当前电脑重新创建连接。",
  EXTERNAL_MCP_RECONNECT_REQUIRED: "请先断开原连接，再重新发现并批准工具。",
  EXTERNAL_MCP_VAULT_UNAVAILABLE:
    "系统凭据库读写失败，请检查平台运行身份、凭据大小与系统凭据服务。",
  EXTERNAL_MCP_CREDENTIAL_REQUIRED: "请先配置此连接的凭据。",
  EXTERNAL_MCP_CREDENTIAL_PROFILE: "凭据与所选认证方式不匹配，请检查输入。",
  EXTERNAL_MCP_OAUTH_REQUIRED: "OAuth 尚未完成或已过期，请重新发起授权。",
  EXTERNAL_MCP_OAUTH_METADATA_CHANGED: "授权机构或资源的元数据与批准配置不一致，授权已停止。",
  EXTERNAL_MCP_DESTINATION_REJECTED: "目标地址未在批准范围内，连接已拒绝。",
  EXTERNAL_MCP_ADDRESS_REJECTED: "解析的 IP 未被批准或属于受限地址，连接已拒绝。",
  EXTERNAL_MCP_CONTROL_PLANE_REJECTED: "目标指向平台控制面，连接已拒绝。",
  EXTERNAL_MCP_HTTPS_REQUIRED: "公网连接必须使用 HTTPS；私网需要单独批准地址。",
  EXTERNAL_MCP_NETWORK_FAILED: "连接失败或回复中断。已发送的调用请检查原记录，避免重复操作。",
  EXTERNAL_MCP_URL_CANONICAL_REQUIRED:
    "请使用服务提供的准确、规范地址，检查大小写、编码和末尾路径。",
};
export function api<T>(path: string, options?: RequestInit) {
  return request<T>(path, options, messages);
}

/** Observations must settle even when a cancelled underlying request does not. */
export async function observe<T>(path: string, parent: AbortSignal): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(Error("连接状态读取超时或已取消，请重新核对连接。"));
    signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await Promise.race([api<T>(path, { signal }), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
