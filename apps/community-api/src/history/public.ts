import type { AuditTrail } from "./audit.js";
export type AuditRecorder = Pick<AuditTrail, "record">;
export { declareRequestAudit, declareRequestAuditContext } from "./request-audit.js";
