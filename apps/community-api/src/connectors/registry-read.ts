import type { RegistryProtocolContext } from "./registry-protocol-context.js";
import { canonicalReadResultAcknowledgement } from "@shuriva/core-contracts";
import { ConnectorError } from "./errors.js";
import { createHash } from "node:crypto";
import { UUID, B64, decode, verifySignature } from "./protocol-validation.js";
import {
  type ReadTask,
  type ReadCancel,
  type ReadResult,
  readTaskFields,
  readCancelFields,
  readResultFields,
} from "../protocol/read-task.js";

export class ReadRegistryProtocol {
  constructor(private readonly context: RegistryProtocolContext) {}
  /** Sign only after the caller checks the current workspace/source binding. */
  async issueReadTask(task: Omit<ReadTask, "signature">): Promise<ReadTask> {
    if (!UUID.test(task.connectorId)) throw new ConnectorError("INVALID");
    return this.context.forConnector(task.connectorId, () =>
      this.context.exclusive(async () => {
        const connector = this.context.activeIdentity(task.connectorId);
        if (!connector || connector.owner !== task.actorId) throw new ConnectorError("DENIED");
        const now = Math.floor(Date.now() / 1000);
        if (
          !UUID.test(task.id) ||
          !UUID.test(task.workspaceId) ||
          !UUID.test(task.sourceId) ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(task.actorId) ||
          !["read_query", "model_schema", "model_authorize"].includes(task.operation) ||
          task.protocol !== 1 ||
          !Number.isSafeInteger(task.issuedAt) ||
          !Number.isSafeInteger(task.expiresAt) ||
          task.issuedAt > now + 60 ||
          task.expiresAt <= now ||
          task.expiresAt <= task.issuedAt ||
          task.expiresAt - task.issuedAt > 60 ||
          !decode(task.nonce, 32) ||
          typeof task.payload !== "string" ||
          !B64.test(task.payload) ||
          task.payload.length > 32768 ||
          Buffer.from(task.payload, "base64url").toString("base64url") !== task.payload
        )
          throw new ConnectorError("INVALID");
        const unsigned: ReadTask = { ...task, signature: "" };
        return {
          ...task,
          signature: this.context.signer.signFields(readTaskFields(unsigned)),
        };
      }),
    );
  }

  /** A cancellation is issued for the same actor, source and task as the read. */
  async issueReadCancel(cancel: Omit<ReadCancel, "signature">): Promise<ReadCancel> {
    if (!UUID.test(cancel.connectorId)) throw new ConnectorError("INVALID");
    return this.context.forConnector(cancel.connectorId, () =>
      this.context.exclusive(async () => {
        const connector = this.context.activeIdentity(cancel.connectorId);
        if (!connector || connector.owner !== cancel.actorId) throw new ConnectorError("DENIED");
        const now = Math.floor(Date.now() / 1000);
        if (
          !UUID.test(cancel.taskId) ||
          !UUID.test(cancel.workspaceId) ||
          !UUID.test(cancel.sourceId) ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(cancel.actorId) ||
          !Number.isSafeInteger(cancel.issuedAt) ||
          !Number.isSafeInteger(cancel.expiresAt) ||
          cancel.issuedAt > now + 60 ||
          cancel.expiresAt <= now ||
          cancel.expiresAt <= cancel.issuedAt ||
          cancel.expiresAt - cancel.issuedAt > 60 ||
          !decode(cancel.nonce, 32)
        )
          throw new ConnectorError("INVALID");
        const unsigned: ReadCancel = { ...cancel, signature: "" };
        return {
          ...cancel,
          signature: this.context.signer.signFields(readCancelFields(unsigned)),
        };
      }),
    );
  }

  /** Verify identity before and after queueing; publish only inside commit. */
  async preflightReadResult(input: ReadResult): Promise<void> {
    if (!UUID.test(input.connectorId)) throw new ConnectorError("INVALID");
    await this.context.exclusive(async () => this.checkReadResult(input));
  }

  async verifyReadResult(input: ReadResult, commit: () => Promise<void>): Promise<void> {
    await this.preflightReadResult(input);
    return this.context.forConnector(input.connectorId, async () => {
      await this.context.exclusive(async () => {
        this.checkReadResult(input);
        const now = Date.now();
        const id = createHash("sha256").update(`${input.connectorId}:${input.nonce}`).digest("hex");
        await this.context.consumeReplay(id, now);
      });
      await commit();
    });
  }

  readResultAcknowledgement(input: ReadResult): string {
    return this.context.signer.signFields(canonicalReadResultAcknowledgement(input));
  }

  private checkReadResult(input: ReadResult): void {
    if (
      !UUID.test(input.connectorId) ||
      !UUID.test(input.taskId) ||
      !UUID.test(input.workspaceId) ||
      !UUID.test(input.sourceId) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.actorId) ||
      !["ok", "failed"].includes(input.outcome) ||
      typeof input.payload !== "string" ||
      input.payload.length < 1 ||
      input.payload.length > 1_398_102 ||
      !Number.isSafeInteger(input.timestamp) ||
      !decode(input.taskNonce, 32) ||
      !decode(input.nonce, 32) ||
      !decode(input.signature, 64)
    )
      throw new ConnectorError("INVALID");
    const connector = this.context.activeIdentity(input.connectorId);
    if (
      !connector ||
      connector.owner !== input.actorId ||
      Math.abs(Math.floor(Date.now() / 1000) - input.timestamp) > 60 ||
      !verifySignature(connector.publicKey, input.signature, readResultFields(input))
    )
      throw new ConnectorError("DENIED");
  }
}
