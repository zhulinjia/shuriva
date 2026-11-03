import { z } from "zod";

export class ExternalMcpError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export const uuid = z.string().uuid();
const url = z.string().min(1).max(2048);
const oauth = z.strictObject({
  issuer: url,
  resourceMetadataUrl: url,
  metadataUrl: url,
  authorizationEndpoint: url,
  tokenEndpoint: url,
  clientId: z.string().min(1).max(255),
  scopes: z.array(z.string().regex(/^[a-zA-Z0-9:._/-]{1,80}$/)).max(16),
});
const http = z
  .strictObject({
    connectTimeoutMs: z.number().int().min(1000).max(10000).default(10000),
    callTimeoutMs: z.number().int().min(1000).max(60000).default(60000),
    kind: z.literal("http"),
    resource: url,
    privateApprovals: z
      .array(
        z.strictObject({
          origin: url,
          addresses: z.array(z.string().min(1).max(64)).min(1).max(16),
        }),
      )
      .max(8),
    authentication: z.enum(["none", "bearer", "api_key", "oauth"]),
    oauth: oauth.nullable(),
  })
  .superRefine((v, c) => {
    if ((v.authentication === "oauth") !== !!v.oauth)
      c.addIssue({ code: "custom", message: "OAUTH_CONFIG_REQUIRED" });
  });
const stdio = z.strictObject({
  kind: z.literal("stdio"),
  programId: uuid,
  connectTimeoutMs: z.number().int().min(1000).max(10000).default(10000),
  callTimeoutMs: z.number().int().min(1000).max(60000).default(60000),
});
export const connectionConfig = z.union([http, stdio]);
export type ConnectionConfig = z.infer<typeof connectionConfig>;
export const connectionInput = z.strictObject({
  workspaceId: uuid,
  name: z.string().trim().min(1).max(80),
  config: connectionConfig,
});
export const credentialsInput = z.strictObject({
  bearer: z.string().min(1).max(4096).optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  clientSecret: z.string().min(1).max(4096).optional(),
  environment: z
    .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(4096))
    .optional(),
});
export const storedCredentials = credentialsInput.extend({
  tokens: z
    .object({
      access_token: z.string().min(1).max(4096),
      token_type: z.string().min(1).max(32),
      expires_in: z.number().positive().optional(),
      refresh_token: z.string().max(4096).optional(),
      scope: z.string().max(2048).optional(),
      issuer: z.string().max(2048).optional(),
    })
    .optional(),
  tokenExpiresAt: z.number().finite().optional(),
});
export type Credentials = z.infer<typeof storedCredentials>;
const toolIdentity = {
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  description: z.string().max(4096),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
};
export const toolSnapshotSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...toolIdentity,
    status: z.literal("available"),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    ...toolIdentity,
    status: z.literal("unsupported"),
    reason: z.literal("unsupported_schema"),
  }),
]);
export const approvalsSchema = z
  .array(
    z.strictObject({
      name: z.string().min(1).max(128),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      sessionId: z.string().min(1).max(36),
    }),
  )
  .max(100);
export type ToolSnapshot = z.infer<typeof toolSnapshotSchema>;
export type AvailableTool = Extract<ToolSnapshot, { status: "available" }>;
export type Connection = {
  executionHostId: string;
  id: string;
  ownerId: string;
  workspaceId: string;
  name: string;
  config: ConnectionConfig;
  version: number;
  credentialRef: string;
  disabled: boolean;
  snapshot: ToolSnapshot[];
  snapshotHash: string | null;
  approvedTools: Array<{ name: string; hash: string; sessionId: string }>;
  installationHash: string | null;
};
export const callStates = [
  "pending_approval",
  "running",
  "succeeded",
  "failed",
  "cancel_requested",
  "outcome_unknown",
  "expired",
  "cancelled",
] as const;
export type CallState = (typeof callStates)[number];
/** Durable intermediate phase, never a public outcome or audit terminal state. */
export const storedCallStates = [...callStates, "result_retained"] as const;
export type StoredCallState = (typeof storedCallStates)[number];
export type CallRecord = {
  id: string;
  ownerId: string;
  connectionId: string;
  version: number;
  tool: string;
  toolHash: string;
  state: StoredCallState;
  sessionId: string;
  bootId: string;
  commitment: string;
  createdAt: string;
  updatedAt: string;
  acknowledged: boolean;
};
export type ClientAudit = (
  owner: string,
  event:
    | "connection_save_requested"
    | "connection_disable_requested"
    | "credential_change_requested"
    | "discovery_requested"
    | "tool_approval_requested"
    | "tool_approval_revocation_requested"
    | "authorization_requested"
    | "authorization_finished"
    | "call_prepare_requested"
    | "call_approval_requested"
    | "call_dispatch_requested"
    | "call_finished"
    | "call_cancel_requested"
    | "unknown_acknowledgment_requested",
  workspaceId: string,
  connectionId: string,
  callId?: string,
  state?: CallState,
) => Promise<void>;
