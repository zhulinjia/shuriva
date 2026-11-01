import { createHash, randomUUID } from "node:crypto";
import type { ModelRead } from "../queries/public.js";
import type { ModelStore } from "./model-store.js";
import { validateCandidate } from "./plan.js";
import { askModel } from "./provider.js";
import { decodeModelDisclosure, type ModelSchema } from "./schema.js";
import {
  semanticDisclosure,
  assertSemanticStructure,
  type SemanticReader,
} from "../semantic/public.js";
import type { PlanStage } from "./progress.js";
import type { SessionIdentity } from "../auth/public.js";

export type ModelScope = {
  ownerId: string;
  workspaceId: string;
  sourceId: string;
  connectorId: string;
};
export type ScopedAccess = <T>(
  ownerId: string,
  workspaceId: string,
  sourceId: string,
  action: (scope: ModelScope) => T | Promise<T>,
) => Promise<T>;
export type PlanRequest = {
  instanceId: unknown;
  scopeToken: unknown;
  submittedAt: unknown;
  question: string;
  schemaHash: string;
  baseUrl: string;
  model: string;
  configVersion: string;
};
export type AuthorizedModelInvocation = typeof askModel;
export type AuthorizedModelContext = {
  schema: ModelSchema;
  semantics: unknown;
  versions: ReadonlyMap<string, string>;
};

/** Keep both the disclosed fields and Connector-signed table versions bound to the preview. */
function schemaDigest(
  schema: unknown,
  versions: ReadonlyMap<string, string>,
  semantics?: unknown,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema,
        versions: [...versions.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ...(semantics === undefined ? {} : { semantics }),
      }),
    )
    .digest("hex");
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("STALE"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 150);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("STALE"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Orchestrates model requests; transport, HTTP and final SQL checks remain separate. */
export class ModelPlanner {
  private readonly now: () => number;
  private readonly invoke: typeof askModel;
  constructor(
    private readonly read: ModelRead,
    private readonly models: ModelStore,
    private readonly access: ScopedAccess,
    options: { now?: () => number; invoke?: typeof askModel; semantics?: SemanticReader } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.invoke = options.invoke ?? askModel;
    this.semantics = options.semantics;
  }

  private readonly semantics?: SemanticReader;
  private async context(
    scope: ModelScope,
    schema: ModelSchema,
    structures: ReadonlyMap<string, string>,
  ) {
    if (!this.semantics) return { schema, semantics: undefined };
    const model = await this.semantics.get(scope.ownerId, scope.workspaceId, scope.sourceId);
    if (model.stale.length) throw new Error("STALE");
    assertSemanticStructure(model.document, model.snapshot, structures);
    return semanticDisclosure(schema, model.document);
  }

  async preview(actor: SessionIdentity, workspaceId: string, sourceId: string, taskId: string) {
    const { ownerId, sessionId } = actor;
    return this.access(ownerId, workspaceId, sourceId, async (scope) => {
      await this.read.assertSession(scope, taskId, sessionId);
      const authorized = this.read.jobs.modelSchema(scope, taskId);
      const destination = this.models.versioned(ownerId);
      if (!authorized || !destination) return null;
      const context = await this.context(scope, authorized.schema, authorized.structures);
      return {
        schema: context.schema,
        ...(context.semantics === undefined ? {} : { semantics: context.semantics }),
        schemaHash: schemaDigest(context.schema, authorized.versions, context.semantics),
        destination: {
          baseUrl: destination.config.baseUrl,
          model: destination.config.model,
          configVersion: destination.configVersion,
        },
      };
    });
  }

  async generate(
    actor: SessionIdentity,
    workspaceId: string,
    sourceId: string,
    taskId: string,
    input: PlanRequest,
    requestSignal: AbortSignal,
    progress: (stage: PlanStage) => void = () => {},
  ) {
    return this.generateAuthorized(
      actor,
      workspaceId,
      sourceId,
      taskId,
      input,
      requestSignal,
      this.invoke,
      (answer, context) => {
        const candidate = validateCandidate(answer, decodeModelDisclosure(context.schema).scope);
        if (candidate.kind === "clarification") return candidate;
        const schemaVersion = context.versions.get(candidate.table);
        if (!schemaVersion) throw new Error("STALE");
        const { table: _table, ...plan } = candidate;
        return { ...plan, schemaVersion };
      },
      progress,
    );
  }

  /** Shared attested disclosure lifecycle. Custom planners cannot bypass the
   * persisted Connector lease, current binding/model watches or final recheck.
   * Their validator must be synchronous and never perform an external action.
   */
  async generateAuthorized<T>(
    actor: SessionIdentity,
    workspaceId: string,
    sourceId: string,
    taskId: string,
    input: PlanRequest,
    requestSignal: AbortSignal,
    invoke: AuthorizedModelInvocation,
    validate: (answer: unknown, context: AuthorizedModelContext) => T,
    progress: (stage: PlanStage) => void = () => {},
  ): Promise<T> {
    const { ownerId, sessionId } = actor;
    const confirmationId = randomUUID();
    let prepared: {
      scope: ModelScope;
      config: NonNullable<ReturnType<ModelStore["versioned"]>>["config"];
      binding: ReturnType<ModelRead["watchBinding"]>;
      model: ReturnType<ModelStore["watch"]>;
      session: Awaited<ReturnType<ModelRead["watchSession"]>>;
    } | null = null;
    try {
      progress("checking_context");
      prepared = await this.access(ownerId, workspaceId, sourceId, async (scope) => {
        const identity = await this.read.assertSession(scope, taskId, sessionId);
        if (
          requestSignal.aborted ||
          !this.read.validScope(scope, input.instanceId, input.scopeToken, input.submittedAt)
        )
          throw new Error("STALE");
        const schema = this.read.jobs.modelSchema(scope, taskId);
        const stored = this.models.versioned(ownerId);
        const context = schema ? await this.context(scope, schema.schema, schema.structures) : null;
        if (
          !schema ||
          !stored ||
          stored.configVersion !== input.configVersion ||
          stored.config.baseUrl !== input.baseUrl ||
          stored.config.model !== input.model ||
          !context ||
          schemaDigest(context.schema, schema.versions, context.semantics) !== input.schemaHash
        )
          throw new Error("STALE");
        const binding = this.read.watchBinding(scope);
        let model: ReturnType<ModelStore["watch"]>;
        try {
          model = this.models.watch(ownerId, input.configVersion);
        } catch (error) {
          binding.dispose();
          throw error;
        }
        let session: Awaited<ReturnType<ModelRead["watchSession"]>> | undefined;
        try {
          session = await this.read.watchSession(scope, taskId, sessionId);
          this.read.jobs.createModelAuthorization(
            { ...scope, sessionId: identity.sessionId },
            confirmationId,
          );
        } catch (error) {
          session?.dispose();
          binding.dispose();
          model.dispose();
          throw error;
        }
        return { scope, config: stored.config, binding, model, session };
      });
      const signal = AbortSignal.any([
        requestSignal,
        prepared.binding.signal,
        prepared.model.signal,
        prepared.session.signal,
      ]);
      const deadline = this.now() + 25_000;
      progress("waiting_connector");
      let confirmation = this.read.jobs.modelAuthorization(prepared.scope, confirmationId);
      let observedRunning = false;
      while (!confirmation && this.now() < deadline && !signal.aborted) {
        const state = this.read.jobs.status(prepared.scope, confirmationId);
        if (!state || !["queued", "running", "completed"].includes(state.state))
          throw new Error("STALE");
        if (state.state === "completed") throw new Error("STALE");
        if (state.state === "running" && !observedRunning) {
          observedRunning = true;
          progress("confirming_access");
        }
        await delay(signal);
        confirmation = this.read.jobs.modelAuthorization(prepared.scope, confirmationId);
      }
      if (!confirmation || signal.aborted) throw new Error("STALE");
      const remaining = confirmation.leaseExpiresAt * 1000 - this.now();
      if (remaining < 5000) throw new Error("STALE");
      progress("confirming_access");
      // Recheck while serialized with platform unbind/revoke and before model contact.
      const permitted = await this.access(ownerId, workspaceId, sourceId, async (scope) => {
        await this.read.assertSession(scope, taskId, sessionId);
        const current = this.read.jobs.modelSchema(scope, taskId);
        const context = await this.context(scope, confirmation.schema, confirmation.structures);
        const currentContext = current
          ? await this.context(scope, current.schema, current.structures)
          : null;
        return !signal.aborted &&
          scope.connectorId === prepared?.scope.connectorId &&
          this.read.validScope(scope, input.instanceId, input.scopeToken, input.submittedAt) &&
          this.models.versioned(ownerId)?.configVersion === input.configVersion &&
          current &&
          currentContext &&
          schemaDigest(context.schema, confirmation.versions, context.semantics) ===
            input.schemaHash &&
          schemaDigest(currentContext.schema, current.versions, currentContext.semantics) ===
            input.schemaHash
          ? context
          : null;
      });
      if (!permitted || signal.aborted || confirmation.leaseExpiresAt * 1000 - this.now() < 5000)
        throw new Error("STALE");
      // The persisted Connector lease protects disclosure until the request
      // has been handed to the local network stack. A slow model response may
      // outlive it; binding and configuration watchers remain active.
      const sendCutoff = confirmation.leaseExpiresAt * 1000 - 2000;
      const sending = new AbortController();
      const sendTimer = setTimeout(() => sending.abort(), Math.max(0, sendCutoff - this.now()));
      const combined = AbortSignal.any([signal, sending.signal]);
      let sent = false;
      let answer: unknown;
      const checkSendingDeadline = () => {
        if (combined.aborted || this.now() >= sendCutoff) throw new Error("STALE");
      };
      try {
        progress("contacting_model");
        const sendingScope = prepared.scope;
        answer = await invoke(prepared.config, input.question, permitted.schema, combined, {
          beforeRequest: async () => {
            await this.read.assertSession(sendingScope, taskId, sessionId);
            checkSendingDeadline();
          },
          semantics: permitted.semantics,
          onRequestSent: () => {
            checkSendingDeadline();
            sent = true;
            clearTimeout(sendTimer);
            progress("awaiting_model");
          },
        });
        if (!sent) throw new Error("STALE");
      } catch (error) {
        if (combined.aborted || (!sent && this.now() >= sendCutoff)) throw new Error("STALE");
        throw error;
      } finally {
        clearTimeout(sendTimer);
      }
      progress("validating_plan");
      const candidate = validate(answer, {
        schema: permitted.schema,
        semantics: permitted.semantics,
        versions: confirmation.versions,
      });
      const stillValid = await this.access(ownerId, workspaceId, sourceId, async (scope) => {
        await this.read.assertSession(scope, taskId, sessionId);
        const currentContext = await this.context(
          scope,
          confirmation.schema,
          confirmation.structures,
        );
        return (
          !combined.aborted &&
          scope.connectorId === prepared?.scope.connectorId &&
          this.read.validScope(scope, input.instanceId, input.scopeToken, input.submittedAt) &&
          this.models.versioned(ownerId)?.configVersion === input.configVersion &&
          schemaDigest(currentContext.schema, confirmation.versions, currentContext.semantics) ===
            input.schemaHash
        );
      });
      if (!stillValid) throw new Error("STALE");
      return candidate;
    } finally {
      if (prepared) {
        try {
          this.read.jobs.cancel(prepared.scope, confirmationId);
        } catch {
          /* task already gone */
        }
        prepared.binding.dispose();
        prepared.model.dispose();
        prepared.session.dispose();
      }
    }
  }
}
