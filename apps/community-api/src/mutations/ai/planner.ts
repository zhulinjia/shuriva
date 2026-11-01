import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelPlanner, PlanRequest, PlanStage } from "../../ai/public.js";
import { mutationBoot, mutationId, type MutationBinding, type MutationScope } from "../model.js";
import type { MutationAccess, MutationCapability } from "../ports.js";
import { assertMutationAIPlan, mutationAIContext, type MutationAIContext } from "./context.js";
import { askMutationCandidate, decodeMutationCandidate } from "./provider.js";

export const mutationAIPrepareSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 8192),
  taskId: mutationId,
  instanceId: mutationId,
  scopeToken: z.string().min(1).max(128),
  submittedAt: z.number().int().nonnegative(),
});
export const mutationAISendSchema = z.strictObject({
  ticketId: mutationId,
  disclosureHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  confirmed: z.literal(true),
});
type DisclosurePlanner = Pick<ModelPlanner, "preview" | "generateAuthorized">;
type Preview = NonNullable<Awaited<ReturnType<ModelPlanner["preview"]>>>;
type PreparedInput = z.infer<typeof mutationAIPrepareSchema>;
type Ticket = {
  id: string;
  binding: MutationBinding;
  input: PreparedInput;
  readPreview: Preview;
  context: MutationAIContext;
  disclosureHash: string;
  expiresAt: number;
  sending: boolean;
};
export class MutationAIError extends Error {
  constructor(readonly code: "INVALID" | "STALE" | "CAPACITY" | "UNAVAILABLE") {
    super(code);
  }
}
function sameScope(a: MutationBinding, b: MutationBinding) {
  return (
    a.ownerId === b.ownerId &&
    a.workspaceId === b.workspaceId &&
    a.sourceId === b.sourceId &&
    a.connectorId === b.connectorId
  );
}

/** A two-step, single-send disclosure consent. Memory only; neither requests nor
 * candidates enter conversations, SQL history, audit payloads or platform rows.
 */
export class MutationAIPlanner {
  private readonly tickets = new Map<string, Ticket>();
  private readonly fingerprintKey = randomBytes(32);
  private readonly now: () => number;
  private readonly invoke: typeof askMutationCandidate;
  constructor(
    private readonly base: DisclosurePlanner,
    private readonly access: MutationAccess,
    private readonly capability: (scope: MutationScope) => Promise<MutationCapability>,
    readonly apiBoot: string,
    options: { now?: () => number; invoke?: typeof askMutationCandidate } = {},
  ) {
    mutationBoot.parse(apiBoot);
    this.now = options.now ?? Date.now;
    this.invoke = options.invoke ?? askMutationCandidate;
  }
  private prune() {
    for (const [id, ticket] of this.tickets)
      if (ticket.expiresAt <= this.now() && !ticket.sending) this.tickets.delete(id);
  }
  private digest(question: string, preview: Preview, context: MutationAIContext): string {
    return createHmac("sha256", this.fingerprintKey)
      .update(
        JSON.stringify({
          apiBoot: this.apiBoot,
          question,
          destination: preview.destination,
          sourceSchemaHash: preview.schemaHash,
          schema: context.schema,
          semantics: context.semantics ?? null,
          writes: context.writes,
          attestation: context.attestation,
        }),
      )
      .digest("base64url");
  }
  private async current(scope: MutationScope, input: PreparedInput) {
    const binding = await this.access.withScope(scope, async (value) => value);
    const preview = await this.base.preview(
      scope.ownerId,
      scope.workspaceId,
      scope.sourceId,
      input.taskId,
    );
    if (!preview) throw new MutationAIError("STALE");
    // Neither the registry lock nor a platform transaction is held over a reply.
    const capability = await this.capability(scope);
    const context = mutationAIContext(preview.schema, capability, preview.semantics);
    await this.access.withScope(scope, async (value) => {
      if (!sameScope(binding, value)) throw new MutationAIError("STALE");
    });
    return {
      binding,
      preview,
      context,
      disclosureHash: this.digest(input.question, preview, context),
    };
  }
  async prepare(scope: MutationScope, raw: unknown, signal?: AbortSignal) {
    const input = mutationAIPrepareSchema.parse(raw);
    this.prune();
    if (
      this.tickets.size >= 32 ||
      [...this.tickets.values()].filter((ticket) => ticket.binding.ownerId === scope.ownerId)
        .length >= 4
    )
      throw new MutationAIError("CAPACITY");
    const prepared = await this.current(scope, input);
    if (signal?.aborted) throw new MutationAIError("STALE");
    const expiresAt = Math.min(this.now() + 45000, input.submittedAt + 55000);
    if (expiresAt <= this.now()) throw new MutationAIError("STALE");
    // Recheck capacity after asynchronous metadata requests.
    this.prune();
    if (
      this.tickets.size >= 32 ||
      [...this.tickets.values()].filter((ticket) => ticket.binding.ownerId === scope.ownerId)
        .length >= 4
    )
      throw new MutationAIError("CAPACITY");
    const id = randomUUID();
    this.tickets.set(id, {
      id,
      binding: prepared.binding,
      input,
      readPreview: prepared.preview,
      context: prepared.context,
      disclosureHash: prepared.disclosureHash,
      expiresAt,
      sending: false,
    });
    return {
      ticketId: id,
      disclosureHash: prepared.disclosureHash,
      question: input.question,
      destination: prepared.preview.destination,
      schema: prepared.context.schema,
      ...(prepared.context.semantics === undefined
        ? {}
        : { semantics: prepared.context.semantics }),
      writeScope: prepared.context.writes,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  async generate(
    scope: MutationScope,
    raw: unknown,
    signal: AbortSignal,
    progress: (stage: PlanStage) => void = () => {},
  ) {
    const input = mutationAISendSchema.parse(raw);
    this.prune();
    const ticket = this.tickets.get(input.ticketId);
    if (
      !ticket ||
      ticket.sending ||
      ticket.expiresAt <= this.now() ||
      ticket.disclosureHash !== input.disclosureHash ||
      ticket.binding.ownerId !== scope.ownerId ||
      ticket.binding.workspaceId !== scope.workspaceId ||
      ticket.binding.sourceId !== scope.sourceId ||
      signal.aborted
    )
      throw new MutationAIError("STALE");
    ticket.sending = true;
    try {
      const prepared = await this.current(scope, ticket.input);
      if (
        !sameScope(prepared.binding, ticket.binding) ||
        prepared.disclosureHash !== ticket.disclosureHash ||
        signal.aborted
      )
        throw new MutationAIError("STALE");
      const request: PlanRequest = {
        instanceId: ticket.input.instanceId,
        scopeToken: ticket.input.scopeToken,
        submittedAt: ticket.input.submittedAt,
        question: ticket.input.question,
        schemaHash: ticket.readPreview.schemaHash,
        ...ticket.readPreview.destination,
      };
      return await this.base.generateAuthorized(
        scope.ownerId,
        scope.workspaceId,
        scope.sourceId,
        ticket.input.taskId,
        request,
        signal,
        async (config, question, schema, outgoing, options) => {
          if (!outgoing || outgoing.aborted) throw new MutationAIError("STALE");
          const current = await this.current(scope, ticket.input);
          const context = mutationAIContext(
            schema,
            current.context.attestation,
            options?.semantics,
          );
          if (
            !sameScope(current.binding, ticket.binding) ||
            current.disclosureHash !== ticket.disclosureHash ||
            this.digest(question, ticket.readPreview, context) !== ticket.disclosureHash ||
            outgoing.aborted
          )
            throw new MutationAIError("STALE");
          const answer = await this.invoke(
            config,
            question,
            context.schema,
            context.writes,
            outgoing,
            { ...options, semantics: context.semantics },
          );
          // A legitimately sent request may outlive the metadata task's short
          // retention. Revalidate authority, not the old task's natural TTL.
          const after = await this.access.withScope(scope, async (binding) => binding);
          const afterCapability = await this.capability(scope);
          const afterContext = mutationAIContext(schema, afterCapability, options?.semantics);
          await this.access.withScope(scope, async (binding) => {
            if (!sameScope(binding, ticket.binding)) throw new MutationAIError("STALE");
          });
          if (
            this.digest(question, ticket.readPreview, afterContext) !== ticket.disclosureHash ||
            !sameScope(after, ticket.binding) ||
            outgoing.aborted
          )
            throw new MutationAIError("STALE");
          return answer;
        },
        (answer) => {
          const candidate = decodeMutationCandidate(answer);
          if (candidate.kind === "mutation") assertMutationAIPlan(candidate.plan, ticket.context);
          return candidate;
        },
        progress,
      );
    } finally {
      this.tickets.delete(ticket.id);
    }
  }
  close(): void {
    this.tickets.clear();
  }
}
