import type { IncomingHttpHeaders } from "node:http";
import type {
  MutationBinding,
  ConfirmationInput,
  MutationExecution,
  MutationExecutionBinding,
  MutationIdentity,
  MutationPermit,
  MutationPlan,
  MutationPermitRequest,
  MutationReceiptSummary,
  MutationScope,
  MutationState,
  PreviewMetadata,
} from "./model.js";

/** Auth owns session validation. Only its opaque reference crosses this boundary. */
export interface MutationAccess {
  authenticate(headers: IncomingHttpHeaders): Promise<MutationIdentity | undefined>;
  /** Serialize the entire callback with workspace binding changes and Connector
   * identity rotation/revocation. Resolve the current owner and Connector while
   * holding those locks, and retain them until the returned Promise settles.
   */
  withScope<T>(
    scope: MutationScope,
    operation: (binding: MutationBinding) => Promise<T>,
  ): Promise<T>;
}
/** Recheck an already authenticated message against the current Connector key.
 * Called synchronously inside MutationAccess.withScope, before durable claim or
 * permit writes; it must not acquire the same Connector lock again.
 */
export type MutationIdentityGuard = () => void;
/** Use-case persistence contract. Session checks execute inside adapter-owned transactions. */
export interface MutationRepository {
  readonly apiBoot: string;
  targetFrozen(scope: MutationScope, identity: string): Promise<boolean>;
  savePreview(binding: MutationBinding, input: PreviewMetadata): Promise<void>;
  confirm(
    binding: MutationBinding,
    sessionId: string,
    input: ConfirmationInput,
  ): Promise<{ execution: MutationExecution; created: boolean }>;
  get(scope: MutationScope, id: string): Promise<MutationExecution>;
  cancel(scope: MutationScope, id: string): Promise<MutationExecution>;
  confirmation(
    scope: MutationScope,
    id: string,
  ): Promise<{ state: "unseen" | "closed" | "registered"; execution: MutationExecution | null }>;
  closeConfirmation(
    scope: MutationScope,
    input: ConfirmationInput,
  ): Promise<MutationExecution | null>;
  list(
    scope: MutationScope,
    after?: string,
  ): Promise<{ items: MutationExecution[]; nextCursor: string | null }>;
  recovery(
    scope: MutationScope,
  ): Promise<{ items: MutationExecution[]; nextCursor: string | null }>;
  reconcileReceipts(
    scope: MutationBinding,
    receipts: MutationReceiptSummary[],
  ): Promise<{
    items: MutationReceiptSummary[];
    metadataError: "orphaned_receipt" | "receipt_mismatch" | null;
  }>;
  claim(scope: MutationScope, submitted: MutationExecutionBinding): Promise<void>;
  permit(
    scope: MutationScope,
    request: MutationPermitRequest,
    signer: MutationPermitSigner,
  ): Promise<MutationPermit>;
  update(
    scope: MutationScope,
    id: string,
    state: MutationState,
    code: string | null,
    reconciliationExpiresAt?: string | null,
    affectedRows?: number | null,
  ): Promise<MutationExecution>;
}
export type MutationPreview = { metadata: PreviewMetadata; presentation: unknown };
export type MutationCapability = {
  available: boolean;
  code: string;
  connectorBoot?: string;
  targetIdentity?: string;
  tables?: string[];
  writeColumns?: Record<
    string,
    { insert: string[]; update: string[]; filter: string[]; delete: boolean }
  >;
  policyGeneration?: string;
  installationGeneration?: string;
  targetEpoch?: string;
};
export interface MutationTransport {
  capability(binding: MutationBinding, apiBoot: string): Promise<MutationCapability>;
  preview(binding: MutationBinding, apiBoot: string, plan: MutationPlan): Promise<MutationPreview>;
  execute(binding: MutationBinding, execution: MutationExecution): Promise<void>;
  status(
    binding: MutationBinding,
    execution: MutationExecution,
  ): Promise<{
    state: MutationState;
    code: string | null;
    reconciliationExpiresAt?: string | null;
    affectedRows?: number | null;
  }>;
  cancel(binding: MutationBinding, execution: MutationExecution): Promise<void>;
  recover?(
    binding: MutationBinding,
    apiBoot: string,
    after?: string,
  ): Promise<{ items: MutationReceiptSummary[]; nextCursor: string | null }>;
}
/** Uses the platform identity signer, not a new private key in the database. */
export interface MutationPermitSigner {
  sign(request: Omit<MutationPermit, "signature">): Promise<string>;
}
export interface MutationAuditSink {
  append(
    scope: MutationScope,
    eventId: string,
    event:
      | "mutation.confirmed"
      | "mutation.cancelled"
      | "mutation.state_changed"
      | "mutation.target_frozen",
    executionId: string,
  ): Promise<void>;
}
