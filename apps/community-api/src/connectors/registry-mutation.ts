import type { RegistryProtocolContext } from "./registry-protocol-context.js";
import { ConnectorError } from "./errors.js";
import { createHash } from "node:crypto";
import { verifySignature } from "./protocol-validation.js";
import {
  type MutationMessage,
  type UnsignedMutationMessage,
  validateMutationMessage,
  mutationMessageFields,
} from "./mutation-protocol.js";

export class MutationRegistryProtocol {
  constructor(private readonly context: RegistryProtocolContext) {}
  /** A result may only be created or read while the connector remains active. */
  async signMutationMessage(input: UnsignedMutationMessage): Promise<MutationMessage> {
    const message = validateMutationMessage({ ...input, signature: "A".repeat(86) });
    if (
      !["task", "poll_reply", "result_reply", "claim_reply", "permit_reply"].includes(message.kind)
    )
      throw new ConnectorError("INVALID");
    return this.context.forConnector(message.connectorId, () =>
      this.context.exclusive(async () => {
        const connector = this.context.activeIdentity(message.connectorId);
        if (!connector || (message.ownerId && connector.owner !== message.ownerId))
          throw new ConnectorError("DENIED");
        return {
          ...message,
          signature: this.context.signer.signFields(mutationMessageFields(message)),
        };
      }),
    );
  }

  /** Recheck a preauthenticated message while the caller holds this Connector's
   * withActiveOwner lock. No nonce is consumed and no lock is acquired here:
   * the caller must retain that lock through its durable authorization write.
   */
  assertCurrentMutationMessage(input: MutationMessage): void {
    const message = validateMutationMessage(input);
    if (this.context.failed || !["poll", "result", "claim", "permit"].includes(message.kind))
      throw new ConnectorError("DENIED");
    const connector = this.context.activeIdentity(message.connectorId);
    if (
      !connector ||
      (message.ownerId && connector.owner !== message.ownerId) ||
      !verifySignature(connector.publicKey, message.signature, mutationMessageFields(message))
    )
      throw new ConnectorError("DENIED");
  }

  /** Consume only a nonce hash, never the sensitive task or result payload. */
  async authenticateMutationMessage(input: unknown): Promise<MutationMessage> {
    const message = validateMutationMessage(input);
    if (!["poll", "result", "claim", "permit"].includes(message.kind))
      throw new ConnectorError("INVALID");
    await this.context.forConnector(message.connectorId, () =>
      this.context.exclusive(async () => {
        this.assertCurrentMutationMessage(message);
        const now = Date.now();
        const id = createHash("sha256")
          .update(`mutation:${message.connectorId}:${message.nonce}`)
          .digest("hex");
        await this.context.consumeReplay(id, now);
      }),
    );
    return message;
  }

  signMutationPermit(payload: unknown): string {
    return this.context.signer.signBytes(
      Buffer.from(`mutation-permit-v1\0${JSON.stringify(payload)}`),
    );
  }
}
