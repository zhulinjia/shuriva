import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mutationPlanSchema } from "../mutations/public.js";
import { McpError } from "./model.js";

/** In-memory provenance exists only while the administrator holds the draft.
 * Eviction or restart fails closed; no guess or browser-provided claim is used. */
export class ChangeOrigins {
  private readonly key = randomBytes(32);
  private readonly entries = new Map<
    string,
    {
      ownerId: string;
      sessionId: string;
      workspaceId: string;
      sourceId: string;
      connectorId: string;
      bindingGeneration: string;
      plan: Buffer;
    }
  >();
  commitment(plan: unknown) {
    const parsed = mutationPlanSchema.parse(plan);
    return createHmac("sha256", this.key).update(JSON.stringify(parsed)).digest();
  }
  add(
    id: string,
    input: {
      ownerId: string;
      sessionId: string;
      workspaceId: string;
      sourceId: string;
      connectorId: string;
      bindingGeneration: string;
      plan: Buffer;
    },
  ) {
    if (this.entries.size >= 128) {
      const oldest = this.entries.keys().next().value;
      if (oldest) {
        this.entries.get(oldest)?.plan.fill(0);
        this.entries.delete(oldest);
      }
    }
    this.entries.set(id, input);
  }
  verify(input: {
    id: string;
    ownerId: string;
    sessionId: string;
    workspaceId: string;
    sourceId: string;
    plan: unknown;
  }) {
    const entry = this.entries.get(input.id);
    if (
      !entry ||
      entry.ownerId !== input.ownerId ||
      entry.sessionId !== input.sessionId ||
      entry.workspaceId !== input.workspaceId ||
      entry.sourceId !== input.sourceId
    )
      throw new McpError("MCP_CHANGE_ORIGIN_UNAVAILABLE", 409);
    const current = this.commitment(input.plan);
    try {
      return {
        invocationId: input.id,
        planChanged: !timingSafeEqual(entry.plan, current),
        connectorId: entry.connectorId,
        bindingGeneration: entry.bindingGeneration,
      };
    } finally {
      current.fill(0);
    }
  }
  close() {
    for (const entry of this.entries.values()) entry.plan.fill(0);
    this.entries.clear();
    this.key.fill(0);
  }
}
