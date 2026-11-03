export type Program = {
  executable: string;
  arguments: string[];
  workingDirectoryRoot: string;
  id: string;
  name: string;
  installationHash: string;
  secretEnvironment: string[];
};
export type HttpConfig = {
  kind: "http";
  resource: string;
  authentication: "none" | "bearer" | "api_key" | "oauth";
  privateApprovals: Array<{ origin: string; addresses: string[] }>;
  oauth: null | {
    issuer: string;
    resourceMetadataUrl: string;
    metadataUrl: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    scopes: string[];
  };
};
export type ExternalConnection = {
  executionHostChanged: boolean;
  id: string;
  workspaceId: string;
  name: string;
  config: HttpConfig | { kind: "stdio"; programId: string };
  version: number;
  disabled: boolean;
  snapshot: Array<
    {
      name: string;
      description: string;
      hash: string;
    } & (
      | { status: "available"; inputSchema: Record<string, unknown> }
      | { status: "unsupported"; reason: "unsupported_schema" }
    )
  >;
  snapshotHash: string | null;
  approvedTools: Array<{ name: string; hash: string }>;
  installationHash: string | null;
  credentialConfigured: boolean;
  connected: boolean | null;
  lifecycle: "connected" | "closing" | "cleanup_unknown" | "disconnected";
  toolsVerified: boolean;
};
export type BlockedConnection = Pick<
  ExternalConnection,
  "id" | "workspaceId" | "name" | "disabled"
> & {
  config: null;
  cleanupRequired: boolean;
};
export type ExternalCall = {
  id: string;
  tool: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  acknowledged: boolean;
  resultAvailable: boolean;
  error: string | null;
  phase?: "verifying_tools" | "validating_approval" | "waiting_result" | null;
  progress?: { progress: number; total?: number } | null;
};
export type CallReview = {
  id: string;
  tool: string;
  arguments: unknown;
  destination: string;
  version: number;
  toolHash: string;
  expiresAt: string;
};
export const base = (workspace: string) =>
  `/api/external-mcp/workspaces/${encodeURIComponent(workspace)}/connections`;
export const callState: Record<string, string> = {
  pending_approval: "等待逐次确认",
  running: "已批准，正在处理",
  succeeded: "已收到工具结果",
  failed: "处理失败",
  cancel_requested: "已请求取消",
  outcome_unknown: "执行结果不明，请核对外部系统",
  expired: "确认已过期",
  cancelled: "发送前已取消",
};
