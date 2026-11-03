export type McpClient = {
  clientId: string;
  name: string;
  redirectUri: string;
  mode: string;
  disabled: boolean;
};
export type McpGrant = {
  id: string;
  clientId: string;
  workspaceId: string;
  sourceId: string;
  connectorId: string;
  tables: [string, string[]][];
  scopes: string[];
  generation: number;
  expiresAt: number;
  revoked: boolean;
};
export type McpInvocation = {
  id: string;
  grantId: string;
  tool: string;
  state: string;
  createdAt: string;
  expiresAt: string;
};
export function recipient(mode: string) {
  return mode === "local_domain"
    ? "该主机同一操作系统用户信任域内的程序"
    : "持有该客户端授权凭据的程序";
}
export function grantState(g: McpGrant) {
  return g.revoked ? "已撤销" : g.expiresAt <= Date.now() ? "已过期" : "有效";
}
export const permissions = [
  ["metadata:read", "查看授权范围内的数据结构"],
  ["query:prepare", "提交查询，等待你逐次审批"],
  ["operation:read", "查看已批准调用的状态和结果"],
  ["operation:cancel", "请求取消自己的调用"],
] as const;
