import { randomBytes, randomUUID } from "node:crypto";
import express, { type Express, type ErrorRequestHandler } from "express";
import { z } from "zod";
import {
  decodeMutationPayload,
  mutationPayload,
  type MutationConnector,
  type MutationMessage,
  type MutationOperation,
} from "../connectors/public.js";
import {
  executionBindingSchema,
  MutationError,
  type MutationBinding,
  type MutationExecution,
  type MutationExecutionBinding,
  type MutationPlan,
  type MutationState,
  mutationStates,
  mutationReceiptSchema,
  permitRequestSchema,
  previewMetadataSchema,
} from "./model.js";
import type {
  MutationAccess,
  MutationCapability,
  MutationPreview,
  MutationTransport,
} from "./ports.js";
import type { MutationService } from "./service.js";

const executionKeys = [
  "ownerId",
  "workspaceId",
  "sourceId",
  "connectorId",
  "executionId",
  "previewId",
  "commitment",
  "revision",
  "apiBoot",
  "connectorBoot",
  "targetIdentity",
  "targetEpoch",
  "policyGeneration",
  "installationGeneration",
] as const;
function executionBinding(value: MutationExecution): MutationExecutionBinding {
  return executionBindingSchema.parse(
    Object.fromEntries(executionKeys.map((key) => [key, value[key]])),
  );
}
const capabilitySchema = z.strictObject({
  available: z.boolean(),
  code: z.string().regex(/^[a-z_]{1,48}$/),
  connectorBoot: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  targetIdentity: z.string().min(1).max(256).optional(),
  tables: z.array(z.string().min(1).max(64)).max(128).optional(),
  writeColumns: z
    .record(
      z.string().min(1).max(64),
      z.strictObject({
        insert: z.array(z.string().min(1).max(64)).max(256),
        update: z.array(z.string().min(1).max(64)).max(256),
        filter: z.array(z.string().min(1).max(64)).max(256),
        delete: z.boolean(),
      }),
    )
    .optional(),
  policyGeneration: z.string().min(1).max(128).optional(),
  installationGeneration: z.string().min(1).max(128).optional(),
  targetEpoch: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
const resultPacket = z.strictObject({
  ok: z.boolean(),
  result: z.unknown().optional(),
  code: z
    .string()
    .regex(/^[a-z_]{1,48}$/)
    .optional(),
});
const executionResultSchema = executionBindingSchema.extend({
  state: z.enum(mutationStates),
  code: z.string().regex(/^(?:[a-z_]{1,48})?$/),
  rowCount: z.number().int().min(0).max(100),
  reconciliationExpiresAt: z.string().datetime().optional(),
});
type MutationOutcome = {
  state: MutationState;
  code: string | null;
  reconciliationExpiresAt?: string | null;
  affectedRows: number | null;
};
function executionOutcome(input: unknown, expected: MutationExecution): MutationOutcome {
  const result = executionResultSchema.parse(input);
  if (executionKeys.some((key) => result[key] !== expected[key])) throw new MutationError("DENIED");
  return {
    state: result.state,
    code: result.code || null,
    affectedRows: ["committed", "rolled_back", "rejected"].includes(result.state)
      ? result.rowCount
      : null,
    ...(result.reconciliationExpiresAt
      ? { reconciliationExpiresAt: result.reconciliationExpiresAt }
      : {}),
  };
}
interface Job {
  binding: MutationBinding;
  operation: MutationOperation;
  message: MutationMessage;
  lastDispatch: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Sensitive plans/previews exist only in this bounded, short-lived mailbox. */
export class ConnectorMutationTransport implements MutationTransport {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  private resultSink?: (
    binding: MutationBinding,
    execution: MutationExecution,
    result: MutationOutcome,
  ) => Promise<void>;
  constructor(
    private readonly registry: Pick<MutationConnector, "signMutationMessage">,
    private readonly access: MutationAccess,
  ) {}
  onExecutionResult(sink: NonNullable<ConnectorMutationTransport["resultSink"]>): void {
    this.resultSink = sink;
  }
  close(): void {
    this.closed = true;
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(new MutationError("UNAVAILABLE"));
    }
    this.jobs.clear();
  }
  private async enqueue(
    binding: MutationBinding,
    operation: MutationOperation,
    data: unknown,
  ): Promise<{ result: Promise<unknown> }> {
    if (this.closed) throw new MutationError("UNAVAILABLE");
    binding = {
      ownerId: binding.ownerId,
      workspaceId: binding.workspaceId,
      sourceId: binding.sourceId,
      connectorId: binding.connectorId,
    };
    if (
      this.jobs.size >= 32 ||
      [...this.jobs.values()].filter((job) => job.binding.connectorId === binding.connectorId)
        .length >= 8
    )
      throw new MutationError("CAPACITY");
    const now = Math.floor(Date.now() / 1000);
    const message = await this.registry.signMutationMessage({
      id: randomUUID(),
      ...binding,
      kind: "task",
      operation,
      payload: mutationPayload(data),
      issuedAt: now,
      expiresAt: now + 30,
      nonce: randomBytes(32).toString("base64url"),
      replyTo: "",
      protocol: 1,
    });
    if (this.closed) throw new MutationError("UNAVAILABLE");
    // poll_reply carries this already encoded task inside its own payload.
    // Refuse a task that cannot cross that outer envelope before it is queued.
    try {
      mutationPayload({ apiBoot: "0".repeat(64), task: message });
    } catch {
      throw new MutationError("CAPACITY");
    }
    // Recheck after signing, so concurrent callers cannot overfill the mailbox.
    if (
      this.jobs.size >= 32 ||
      [...this.jobs.values()].filter((job) => job.binding.connectorId === binding.connectorId)
        .length >= 8
    )
      throw new MutationError("CAPACITY");
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const result = new Promise<unknown>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => {
      this.jobs.delete(message.id);
      reject(new MutationError("UNAVAILABLE"));
    }, 30_000);
    timer.unref();
    this.jobs.set(message.id, {
      binding,
      operation,
      message,
      lastDispatch: 0,
      resolve,
      reject,
      timer,
    });
    return { result };
  }
  private async request(
    binding: MutationBinding,
    operation: MutationOperation,
    data: unknown,
  ): Promise<unknown> {
    return (await this.enqueue(binding, operation, data)).result;
  }
  async capability(binding: MutationBinding, apiBoot: string): Promise<MutationCapability> {
    return capabilitySchema.parse(await this.request(binding, "capability", { apiBoot }));
  }
  async preview(
    binding: MutationBinding,
    apiBoot: string,
    plan: MutationPlan,
  ): Promise<MutationPreview> {
    const result = z
      .record(z.string(), z.unknown())
      .parse(await this.request(binding, "preview", { apiBoot, plan }));
    const { rows, ownerId, workspaceId, sourceId, connectorId, ...metadata } = result;
    if (
      ownerId !== binding.ownerId ||
      workspaceId !== binding.workspaceId ||
      sourceId !== binding.sourceId ||
      connectorId !== binding.connectorId
    )
      throw new MutationError("DENIED");
    return { metadata: previewMetadataSchema.parse(metadata), presentation: rows };
  }
  async execute(binding: MutationBinding, execution: MutationExecution): Promise<void> {
    const queued = await this.enqueue(binding, "execute", {
      execution: executionBinding(execution),
    });
    void queued.result
      .then((result) => this.resultSink?.(binding, execution, executionOutcome(result, execution)))
      .catch(async () => {
        try {
          await this.resultSink?.(binding, execution, {
            state: "outcome_unknown",
            code: "delivery_unknown",
            affectedRows: null,
          });
        } catch {
          /* Durable registration remains pending/unknown; never enqueue again. */
        }
      });
  }
  async status(binding: MutationBinding, execution: MutationExecution) {
    return executionOutcome(
      await this.request(binding, "status", { execution: executionBinding(execution) }),
      execution,
    );
  }
  async cancel(binding: MutationBinding, execution: MutationExecution): Promise<void> {
    executionOutcome(
      await this.request(binding, "cancel", { execution: executionBinding(execution) }),
      execution,
    );
  }
  async recover(binding: MutationBinding, apiBoot: string, after?: string) {
    const page = z
      .strictObject({
        items: z.array(mutationReceiptSchema).max(100),
        nextCursor: z.string().uuid().nullable(),
      })
      .parse(await this.request(binding, "recover", { apiBoot, after: after ?? "" }));
    if (
      page.items.some(
        (receipt) =>
          receipt.scope.ownerId !== binding.ownerId ||
          receipt.scope.workspaceId !== binding.workspaceId ||
          receipt.scope.sourceId !== binding.sourceId ||
          receipt.scope.connectorId !== binding.connectorId,
      )
    )
      throw new MutationError("DENIED");
    return page;
  }
  async next(connectorId: string, active: readonly string[]): Promise<MutationMessage | null> {
    if (this.closed) return null;
    const now = Date.now();
    const job = [...this.jobs.values()]
      .filter(
        (item) =>
          item.binding.connectorId === connectorId &&
          !active.includes(item.message.id) &&
          now - item.lastDispatch >= 2000,
      )
      // Polling must never overtake a previously confirmed execution forever.
      // Prefer cancellation, then undispatched work in insertion order. Retries
      // follow the oldest dispatch so one missing reply cannot monopolize polls.
      .sort(
        (a, b) =>
          Number(b.operation === "cancel") - Number(a.operation === "cancel") ||
          Number(a.lastDispatch !== 0) - Number(b.lastDispatch !== 0) ||
          a.lastDispatch - b.lastDispatch,
      )[0];
    if (!job) return null;
    await this.access.withScope(job.binding, async (current) => {
      if (current.connectorId !== connectorId) throw new MutationError("DENIED");
    });
    if (!this.jobs.has(job.message.id)) return null;
    job.lastDispatch = now;
    return job.message;
  }
  async accept(message: MutationMessage): Promise<void> {
    const job = this.jobs.get(message.id);
    if (!job) return; // Late delivery is acknowledged and discarded, never executed.
    if (
      message.replyTo !== job.message.nonce ||
      message.connectorId !== job.binding.connectorId ||
      message.ownerId !== job.binding.ownerId ||
      message.workspaceId !== job.binding.workspaceId ||
      message.sourceId !== job.binding.sourceId ||
      message.operation !== job.operation
    )
      throw new MutationError("DENIED");
    await this.access.withScope(job.binding, async (current) => {
      if (current.connectorId !== job.binding.connectorId) throw new MutationError("DENIED");
    });
    const packet = resultPacket.parse(decodeMutationPayload(message));
    clearTimeout(job.timer);
    this.jobs.delete(message.id);
    if (!packet.ok || packet.result === undefined)
      job.reject(
        new MutationError(
          packet.code === "frozen"
            ? "FROZEN"
            : packet.code === "denied"
              ? "DENIED"
              : packet.code === "preview_too_large"
                ? "CAPACITY"
                : "UNAVAILABLE",
        ),
      );
    else job.resolve(packet.result);
  }
}

/** Connector-only signed endpoints; no browser Cookie grants access here. */
export function mountMutationAgentRoutes(
  server: Express,
  registry: MutationConnector,
  channel: ConnectorMutationTransport,
  service: MutationService,
): void {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "2100kb" }));
  const route = (kind: "poll" | "result" | "claim" | "permit") => {
    router.post(`/${kind}`, async (req, res) => {
      const message = await registry.authenticateMutationMessage(req.body);
      if (message.kind !== kind) throw new MutationError("DENIED");
      const binding = {
        ownerId: message.ownerId,
        workspaceId: message.workspaceId,
        sourceId: message.sourceId,
        connectorId: message.connectorId,
      };
      let payload: unknown;
      if (kind === "poll") {
        const input = z
          .strictObject({ active: z.array(z.string().uuid()).max(8) })
          .parse(decodeMutationPayload(message));
        payload = {
          apiBoot: service.store.apiBoot,
          task: await channel.next(message.connectorId, input.active),
        };
      } else if (kind === "result") {
        await channel.accept(message);
        payload = { accepted: true };
      } else if (kind === "claim") {
        const input = executionBindingSchema.parse(decodeMutationPayload(message));
        if (
          input.ownerId !== binding.ownerId ||
          input.workspaceId !== binding.workspaceId ||
          input.sourceId !== binding.sourceId ||
          input.connectorId !== binding.connectorId
        )
          throw new MutationError("DENIED");
        await service.claim(binding, input, () => registry.assertCurrentMutationMessage(message));
        payload = { accepted: true };
      } else {
        const input = permitRequestSchema.parse(decodeMutationPayload(message));
        if (
          input.ownerId !== binding.ownerId ||
          input.workspaceId !== binding.workspaceId ||
          input.sourceId !== binding.sourceId ||
          input.connectorId !== binding.connectorId
        )
          throw new MutationError("DENIED");
        payload = await service.permit(binding, input, () =>
          registry.assertCurrentMutationMessage(message),
        );
      }
      const now = Math.floor(Date.now() / 1000);
      const reply = await registry.signMutationMessage({
        ...message,
        kind:
          kind === "result"
            ? "result_reply"
            : kind === "poll"
              ? "poll_reply"
              : kind === "claim"
                ? "claim_reply"
                : "permit_reply",
        payload: mutationPayload(payload),
        issuedAt: now,
        expiresAt: now + 30,
        nonce: randomBytes(32).toString("base64url"),
        replyTo: message.nonce,
      });
      res.json(reply);
    });
  };
  for (const kind of ["poll", "result", "claim", "permit"] as const) route(kind);
  const handler: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(409).json({ error: "MUTATION_REJECTED" });
  };
  router.use(handler);
  server.use("/api/connector-agent/mutations", router);
}
