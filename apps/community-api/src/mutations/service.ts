import { z } from "zod";
import { diagnostics } from "../logging/public.js";
import {
  type ConfirmationInput,
  type MutationBinding,
  MutationError,
  type MutationExecutionBinding,
  type MutationIdentity,
  type MutationPermitRequest,
  type MutationScope,
  type MutationState,
  mutationPlanSchema,
  mutationReceiptSchema,
  mutationStates,
  mutationValueSchema,
  previewMetadataSchema,
  publicExecution,
} from "./model.js";
import type {
  MutationAccess,
  MutationIdentityGuard,
  MutationPermitSigner,
  MutationRepository,
  MutationTransport,
} from "./ports.js";

const row = z
  .record(z.string().min(1).max(64), mutationValueSchema)
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 256);
const previewColumns = z
  .array(z.string().min(1).max(64))
  .max(256)
  .refine((value) => new Set(value).size === value.length);
const presentationSchema = z
  .array(
    z.strictObject({
      before: row.nullable(),
      after: row.nullable(),
      generatedColumns: previewColumns.optional(),
      defaultColumns: previewColumns.optional(),
    }),
  )
  .max(100);
const resultSchema = z.strictObject({
  state: z.enum(mutationStates),
  code: z
    .string()
    .regex(/^[a-z_]{1,48}$/)
    .nullable(),
  reconciliationExpiresAt: z.string().datetime().nullable().optional(),
  affectedRows: z.number().int().min(0).max(100).nullable().optional(),
});

/** Orchestrates scoped metadata, authenticated transport and the current process. No DML or raw values are persisted here. */
export class MutationService {
  constructor(
    readonly store: MutationRepository,
    private readonly access: MutationAccess,
    private readonly transport: MutationTransport,
    private readonly signer: MutationPermitSigner,
    private readonly options: {
      enabled: boolean;
      executionEnabled?: boolean;
    },
  ) {}
  private enabled(execution = false): void {
    if (!this.options.enabled || (execution && this.options.executionEnabled !== true))
      throw new MutationError("UNAVAILABLE");
  }
  private binding(scope: MutationScope): Promise<MutationBinding> {
    return this.access.withScope(scope, async (binding) => binding);
  }
  async capability(scope: MutationScope) {
    const binding = await this.binding(scope);
    if (!this.options.enabled || !binding.bindingGeneration)
      return {
        enabled: this.options.enabled,
        available: false,
        executionEnabled: false,
        code: this.options.enabled ? "binding_identity_required" : "feature_disabled",
        apiBoot: this.store.apiBoot,
        tables: [],
      };
    // No registry/workspace lock is held while waiting for a Connector reply.
    const response = await this.transport.capability(binding, this.store.apiBoot);
    await this.access.withScope(scope, async (current) => {
      if (
        current.connectorId !== binding.connectorId ||
        current.bindingGeneration !== binding.bindingGeneration
      )
        throw new MutationError("DENIED");
    });
    if (response.targetIdentity && (await this.store.targetFrozen(scope, response.targetIdentity)))
      return {
        ...response,
        available: false,
        enabled: true,
        executionEnabled: this.options.executionEnabled === true,
        apiBoot: this.store.apiBoot,
        code: "frozen",
      };
    return {
      ...response,
      enabled: true,
      executionEnabled: this.options.executionEnabled === true,
      apiBoot: this.store.apiBoot,
    };
  }
  async preview(
    scope: MutationScope,
    input: unknown,
    expectedBinding?: { connectorId: string; bindingGeneration: string },
  ) {
    this.enabled();
    const plan = mutationPlanSchema.parse(input);
    const binding = await this.binding(scope);
    if (!binding.bindingGeneration) throw new MutationError("UNAVAILABLE");
    if (
      expectedBinding &&
      (binding.connectorId !== expectedBinding.connectorId ||
        binding.bindingGeneration !== expectedBinding.bindingGeneration)
    )
      throw new MutationError("DENIED");
    const response = await this.transport.preview(binding, this.store.apiBoot, plan);
    const metadata = previewMetadataSchema.parse(response.metadata);
    const rows = presentationSchema.parse(response.presentation);
    if (
      metadata.operation !== plan.operation ||
      metadata.table !== plan.table ||
      rows.length !== metadata.rowCount ||
      rows.some((change) =>
        plan.operation === "insert"
          ? change.before !== null || change.after === null
          : plan.operation === "delete"
            ? change.before === null || change.after !== null
            : change.before === null || change.after === null,
      ) ||
      (plan.operation === "update" &&
        rows.some((change) =>
          plan.changes.some(
            (field) =>
              !Object.hasOwn(change.before ?? {}, field.column) ||
              !Object.hasOwn(change.after ?? {}, field.column),
          ),
        )) ||
      rows.some((change) =>
        plan.operation !== "insert"
          ? !!change.generatedColumns?.length || !!change.defaultColumns?.length
          : change.generatedColumns?.some((column) => Object.hasOwn(change.after ?? {}, column)) ||
            change.defaultColumns?.some((column) => !Object.hasOwn(change.after ?? {}, column)) ||
            change.generatedColumns?.some((column) => change.defaultColumns?.includes(column)),
      ) ||
      Buffer.byteLength(JSON.stringify(rows), "utf8") > 1048576
    )
      throw new MutationError("DENIED");
    await this.access.withScope(scope, async (current) => {
      if (
        current.connectorId !== binding.connectorId ||
        current.bindingGeneration !== binding.bindingGeneration ||
        (expectedBinding && current.bindingGeneration !== expectedBinding.bindingGeneration)
      )
        throw new MutationError("DENIED");
      await this.store.savePreview(current, metadata);
    });
    return { ...metadata, rows };
  }
  async confirm(scope: MutationScope, identity: MutationIdentity, input: ConfirmationInput) {
    this.enabled(true);
    if (identity.ownerId !== scope.ownerId) throw new MutationError("DENIED");
    const registered = await this.access.withScope(scope, (binding) =>
      this.store.confirm(binding, identity.sessionId, input),
    );
    diagnostics.info("mutation.confirmed", {
      executionId: registered.execution.executionId,
      sourceId: scope.sourceId,
      connectorId: registered.execution.connectorId,
      state: registered.execution.state,
    });
    if (registered.created) {
      try {
        await this.transport.execute(registered.execution, registered.execution);
      } catch (error) {
        // Enqueue acknowledgement may have been lost. Preserve execution identity;
        // never turn uncertainty into another confirmation or an automatic retry.
        await this.store.update(
          scope,
          registered.execution.executionId,
          "outcome_unknown",
          "delivery_unknown",
        );
        diagnostics.warn(
          "mutation.delivery_unknown",
          {
            executionId: registered.execution.executionId,
            sourceId: scope.sourceId,
            connectorId: registered.execution.connectorId,
            state: "outcome_unknown",
          },
          error,
        );
      }
    }
    return publicExecution(await this.store.get(scope, registered.execution.executionId));
  }
  async get(scope: MutationScope, id: string) {
    this.enabled();
    const record = await this.access.withScope(scope, () => this.store.get(scope, id));
    // A new API process may still ask for the original receipt. The transport
    // must use its read-only recovery path; this never renews an old execution.
    try {
      const response = resultSchema.parse(await this.transport.status(record, record));
      if (
        response.state !== record.state ||
        response.code !== record.code ||
        (response.affectedRows !== undefined && response.affectedRows !== record.affectedRows) ||
        (response.reconciliationExpiresAt !== undefined &&
          response.reconciliationExpiresAt !== record.reconciliationExpiresAt)
      )
        await this.access.withScope(scope, () =>
          this.store.update(
            scope,
            id,
            response.state,
            response.code,
            response.reconciliationExpiresAt ?? null,
            response.affectedRows ?? null,
          ),
        );
    } catch (error) {
      if (error instanceof MutationError && error.code === "CONFLICT") throw error;
      // A failed status read does not change a known result or dispatch another task.
    }
    return publicExecution(await this.store.get(scope, id));
  }
  async cancel(scope: MutationScope, id: string) {
    this.enabled();
    const record = await this.access.withScope(scope, () => this.store.cancel(scope, id));
    try {
      await this.transport.cancel(record, record);
    } catch {
      /* Persisted cancellation still prevents the first permit. */
    }
    return publicExecution(record);
  }
  async confirmation(scope: MutationScope, id: string) {
    this.enabled();
    return this.access.withScope(scope, async () => {
      const found = await this.store.confirmation(scope, id);
      return {
        state: found.state,
        execution: found.execution ? publicExecution(found.execution) : null,
      };
    });
  }
  async closeConfirmation(scope: MutationScope, input: ConfirmationInput) {
    this.enabled();
    const record = await this.access.withScope(scope, () =>
      this.store.closeConfirmation(scope, input),
    );
    return {
      state: record ? "registered" : "closed",
      execution: record ? publicExecution(record) : null,
    };
  }
  async list(scope: MutationScope, after?: string) {
    this.enabled();
    return this.access.withScope(scope, async () => {
      const result = await this.store.list(scope, after);
      return { items: result.items.map(publicExecution), nextCursor: result.nextCursor };
    });
  }
  async recovery(scope: MutationScope) {
    this.enabled();
    const recovered = await this.access.withScope(scope, async () => {
      const result = await this.store.recovery(scope);
      return { items: result.items.map(publicExecution), nextCursor: result.nextCursor };
    });
    const found = await this.receipts(scope);
    diagnostics.info("mutation.recovery_checked", {
      sourceId: scope.sourceId,
      workspaceId: scope.workspaceId,
      ...(found.metadataError ? { code: found.metadataError } : {}),
    });
    return {
      ...recovered,
      recoveredReceipts: found.items,
      receiptCursor: found.nextCursor,
      metadataError: found.metadataError,
    };
  }
  async receipts(scope: MutationScope, after?: string) {
    this.enabled();
    const binding = await this.binding(scope);
    if (!this.transport.recover) return { items: [], nextCursor: null, metadataError: null };
    const received = await this.transport.recover(binding, this.store.apiBoot, after);
    const found = z
      .strictObject({
        items: z.array(mutationReceiptSchema).max(100),
        nextCursor: z.string().max(80).nullable(),
      })
      .parse(received);
    const reconciled = await this.access.withScope(scope, async (current) => {
      if (
        current.connectorId !== binding.connectorId ||
        found.items.some(
          (item) =>
            item.scope.ownerId !== current.ownerId ||
            item.scope.workspaceId !== current.workspaceId ||
            item.scope.sourceId !== current.sourceId ||
            item.scope.connectorId !== current.connectorId,
        )
      )
        throw new MutationError("DENIED");
      return this.store.reconcileReceipts(current, found.items);
    });
    return { ...reconciled, nextCursor: found.nextCursor };
  }
  /** The caller must authenticate the Connector signature before reaching these methods. */
  async claim(
    binding: MutationBinding,
    submitted: MutationExecutionBinding,
    identityCurrent: MutationIdentityGuard,
  ): Promise<void> {
    this.enabled(true);
    await this.access.withScope(binding, async (current) => {
      if (
        current.connectorId !== binding.connectorId ||
        submitted.connectorId !== current.connectorId
      )
        throw new MutationError("DENIED");
      identityCurrent();
      await this.store.claim(binding, submitted);
    });
    diagnostics.info("mutation.claimed", {
      executionId: submitted.executionId,
      sourceId: binding.sourceId,
      connectorId: binding.connectorId,
    });
  }
  async permit(
    binding: MutationBinding,
    request: MutationPermitRequest,
    identityCurrent: MutationIdentityGuard,
  ) {
    this.enabled(true);
    const permit = await this.access.withScope(binding, async (current) => {
      if (
        current.connectorId !== binding.connectorId ||
        request.connectorId !== current.connectorId
      )
        throw new MutationError("DENIED");
      identityCurrent();
      return this.store.permit(binding, request, this.signer);
    });
    diagnostics.info("mutation.permit_issued", {
      executionId: request.executionId,
      sourceId: binding.sourceId,
      connectorId: binding.connectorId,
    });
    return permit;
  }
  async result(
    binding: MutationBinding,
    id: string,
    input: {
      state: MutationState;
      code: string | null;
      reconciliationExpiresAt?: string | null;
      affectedRows?: number | null;
    },
  ) {
    this.enabled();
    const status = resultSchema.parse(input);
    const result = await this.access.withScope(binding, async (current) => {
      const record = await this.store.get(binding, id);
      if (record.connectorId !== current.connectorId || binding.connectorId !== current.connectorId)
        throw new MutationError("DENIED");
      return publicExecution(
        await this.store.update(
          binding,
          id,
          status.state,
          status.code,
          status.reconciliationExpiresAt ?? null,
          status.affectedRows ?? null,
        ),
      );
    });
    diagnostics.info("mutation.result_recorded", {
      executionId: id,
      sourceId: binding.sourceId,
      connectorId: binding.connectorId,
      state: result.state,
      ...(result.code ? { code: result.code } : {}),
    });
    return result;
  }
}
