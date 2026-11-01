import type { RegistryProtocolContext } from "./registry-protocol-context.js";
import { ConnectorError } from "./errors.js";
import { createHash } from "node:crypto";
import { UUID, decode, validateAgentVersion, verifySignature } from "./protocol-validation.js";
import {
  type SchemaTask,
  type SchemaResult,
  schemaTaskFields,
  schemaResultFields,
} from "./schema-protocol.js";

export class SchemaRegistryProtocol {
  constructor(private readonly context: RegistryProtocolContext) {}
  schemaTask(input: Omit<SchemaTask, "signature" | "operation" | "protocol">): SchemaTask {
    if (
      !UUID.test(input.id) ||
      !UUID.test(input.connectorId) ||
      !UUID.test(input.workspaceId) ||
      !UUID.test(input.sourceId) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.actorId) ||
      !Number.isSafeInteger(input.issuedAt) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt - input.issuedAt !== 60 ||
      !decode(input.nonce, 32)
    )
      throw new ConnectorError("INVALID");
    return {
      ...input,
      operation: "schema_scan",
      protocol: 2,
      signature: this.context.signer.signFields(schemaTaskFields(input)),
    };
  }

  async verifySchemaResult(input: SchemaResult, commit: () => Promise<void>): Promise<void> {
    if (!UUID.test(input.connectorId)) throw new ConnectorError("INVALID");
    await this.context.exclusive(async () => this.checkSchemaResult(input));
    return this.context.forConnector(input.connectorId, async () => {
      await this.context.exclusive(async () => {
        this.checkSchemaResult(input);
        const now = Date.now();
        const replayId = createHash("sha256")
          .update(`${input.connectorId}:${input.nonce}`)
          .digest("hex");
        // Consume the nonce before entering the database. A failed or ambiguous
        // result is not replayed; the task expires and may be requested again.
        await this.context.consumeReplay(replayId, now);
      });
      await commit();
    });
  }

  private checkSchemaResult(input: SchemaResult): void {
    if (
      input.protocol !== 2 ||
      !UUID.test(input.connectorId) ||
      !UUID.test(input.taskId) ||
      !UUID.test(input.workspaceId) ||
      !UUID.test(input.sourceId) ||
      !["ok", "failed"].includes(input.outcome) ||
      typeof input.payload !== "string" ||
      input.payload.length > 1_398_102 ||
      !validateAgentVersion(input.agentVersion) ||
      !Number.isSafeInteger(input.timestamp) ||
      !decode(input.nonce, 32) ||
      !decode(input.signature, 64)
    )
      throw new ConnectorError("INVALID");
    const now = Date.now();
    const connector = this.context.activeIdentity(input.connectorId);
    if (
      !connector ||
      Math.abs(Math.floor(now / 1000) - input.timestamp) > 60 ||
      !verifySignature(connector.publicKey, input.signature, schemaResultFields(input))
    )
      throw new ConnectorError("DENIED");
  }

  schemaResultAcknowledgement(input: SchemaResult): string {
    return this.context.signer.signFields([
      "connector-v2",
      "scan-result-ack",
      input.connectorId,
      input.taskId,
      input.nonce,
      "2",
    ]);
  }
  async issueSchemaTask(
    connectorId: string,
    get: () => Promise<Omit<SchemaTask, "signature" | "operation" | "protocol"> | null>,
  ): Promise<SchemaTask | null> {
    if (!UUID.test(connectorId)) throw new ConnectorError("INVALID");
    return this.context.forConnector(connectorId, async () => {
      await this.context.exclusive(async () => {
        if (!this.context.activeIdentity(connectorId)) throw new ConnectorError("DENIED");
      });
      const task = await get();
      if (!task) return null;
      if (task.connectorId !== connectorId) throw new ConnectorError("DENIED");
      return this.schemaTask(task);
    });
  }
}
