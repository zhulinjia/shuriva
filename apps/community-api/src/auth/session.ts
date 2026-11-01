import type { IncomingHttpHeaders } from "node:http";
/** Opaque reference only; a Cookie or bearer token is never a task identity. */
export type SessionIdentity = { ownerId: string; sessionId: string };
export interface SessionAccess {
  authenticate(headers: IncomingHttpHeaders): Promise<SessionIdentity | undefined>;
  active(identity: SessionIdentity): Promise<boolean>;
}
