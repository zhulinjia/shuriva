import {
  canonicalPairFields,
  canonicalPairProofFields,
  canonicalIdentityFields,
  canonicalPairAcknowledgement,
  canonicalIdentityAcknowledgement,
  type HeartbeatInput,
  type PairInput,
  type RotateInput,
} from "@shuriva/core-contracts";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { SignedMessage } from "./identity-protocol.js";
import type { SchemaTask, SchemaResult } from "./schema-protocol.js";
import { RegistryFile } from "./registry-file.js";
import { RegistrySigner } from "./registry-signer.js";
import { IdentityQueue } from "./identity-queue.js";
import { ConnectorError } from "./errors.js";
import {
  UUID,
  decode,
  safeText,
  validateAgentVersion,
  verifySignature,
} from "./protocol-validation.js";
import { MutationRegistryProtocol } from "./registry-mutation.js";
import { ReadRegistryProtocol } from "./registry-read.js";
import { SchemaRegistryProtocol } from "./registry-schema.js";
import type { RegistryProtocolContext } from "./registry-protocol-context.js";
import type { ReadCancel, ReadResult, ReadTask } from "../protocol/read-task.js";
import type { MutationMessage, UnsignedMutationMessage } from "./mutation-protocol.js";

interface Pairing {
  id: string;
  owner: string;
  encryptedKey?: string;
  expiresAt: number;
}
interface Connector {
  id: string;
  owner: string;
  name: string;
  publicKey: string;
  agentVersion: string;
  protocolVersion: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}
interface Replay {
  id: string;
  expiresAt: number;
}
export interface DiagnosticTask {
  id: string;
  connectorId: string;
  actorId: string;
  operation: "diagnostic";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  protocol: 1;
  signature: string;
}
interface StoredTask extends DiagnosticTask {
  completedAt: number | null;
}
export interface ResultInput extends SignedMessage {
  taskId: string;
  outcome: "ok";
}
interface State {
  version: 1;
  pairings: Pairing[];
  connectors: Connector[];
  replays: Replay[];
  tasks: StoredTask[];
}
export type { HeartbeatInput, PairInput, RotateInput } from "@shuriva/core-contracts";
const LIMIT = 5000;
export const canonicalPair = canonicalPairFields;
export const canonicalPairProof = canonicalPairProofFields;
export const canonicalSigned = canonicalIdentityFields;
export function taskFields(task: DiagnosticTask): string[] {
  return [
    "connector-v1",
    "task",
    task.id,
    task.connectorId,
    task.actorId,
    task.operation,
    String(task.issuedAt),
    String(task.expiresAt),
    task.nonce,
    "1",
  ];
}

/** Single-process registry. All reads and writes are serialized; success is returned after rename. */
export class ConnectorRegistry {
  private state: State = { version: 1, pairings: [], connectors: [], replays: [], tasks: [] };
  private queue: Promise<void> = Promise.resolve();
  private readonly identities = new IdentityQueue();
  private failed = false;
  private readonly signer: RegistrySigner;
  private readonly mutationProtocol: MutationRegistryProtocol;
  private readonly readProtocol: ReadRegistryProtocol;
  private readonly schemaProtocol: SchemaRegistryProtocol;
  /** Internal metadata lookup; caller authenticates the signed operation first. */
  async auditOwner(connectorId: string): Promise<string | undefined> {
    await this.queue;
    return this.state.connectors.find((item) => item.id === connectorId)?.owner;
  }
  private constructor(
    private readonly file: RegistryFile,
    private readonly key: Buffer,
  ) {
    this.signer = new RegistrySigner(key);
    const registry = this;
    const context: RegistryProtocolContext = {
      get failed() {
        return registry.failed;
      },
      signer: this.signer,
      activeIdentity: (id) =>
        this.state.connectors.find((item) => item.id === id && item.revokedAt === null),
      exclusive: (fn) => this.exclusive(fn),
      forConnector: (id, fn, limit) => this.forConnector(id, fn, limit),
      consumeReplay: (id, now) => this.consumeReplay(id, now),
    };
    this.mutationProtocol = new MutationRegistryProtocol(context);
    this.readProtocol = new ReadRegistryProtocol(context);
    this.schemaProtocol = new SchemaRegistryProtocol(context);
  }
  static async open(path: string, secret: string | (() => string)): Promise<ConnectorRegistry> {
    const file = await RegistryFile.open(path);
    let registry: ConnectorRegistry | undefined;
    try {
      const activeSecret = typeof secret === "function" ? secret() : secret;
      registry = new ConnectorRegistry(
        file,
        createHmac("sha256", activeSecret).update("connector-registry-v1").digest(),
      );
      const raw = await file.read();
      if (raw !== undefined) {
        const saved: unknown = JSON.parse(raw);
        if (
          !saved ||
          typeof saved !== "object" ||
          !("state" in saved) ||
          !("mac" in saved) ||
          typeof saved.mac !== "string"
        )
          throw new Error("Invalid connector registry");
        const actual = Buffer.from(saved.mac, "hex");
        const expected = registry.mac(saved.state);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw new Error("Connector registry integrity check failed");
        const state = saved.state as State;
        if (
          state.version !== 1 ||
          !Array.isArray(state.pairings) ||
          !Array.isArray(state.connectors) ||
          !Array.isArray(state.replays) ||
          Object.keys(state).some(
            (key) => !["version", "pairings", "connectors", "replays", "tasks"].includes(key),
          )
        )
          throw new Error("Invalid connector registry format");
        // Preserve the current local development registry, which may be empty
        // and have been created before diagnostic tasks were first added.
        if (state.tasks === undefined) state.tasks = [];
        else if (!Array.isArray(state.tasks)) throw new Error("Invalid connector registry format");
        registry.state = state;
        for (const pairing of state.pairings) {
          if (
            typeof pairing.encryptedKey !== "string" ||
            Object.keys(pairing).some(
              (key) => !["id", "owner", "encryptedKey", "expiresAt"].includes(key),
            )
          )
            throw new Error("Invalid encrypted pairing state");
          registry.decryptPairingKey(pairing);
        }
      } else await registry.persist();
      return registry;
    } catch (e) {
      if (registry) await registry.close();
      else await file.close();
      throw e;
    }
  }
  platformPublicKey(): string {
    return this.signer.publicKey();
  }
  pairAcknowledgement(input: PairInput): string {
    return this.signer.signFields(canonicalPairAcknowledgement(input));
  }
  acknowledgement(
    operation: "heartbeat" | "rotate" | "probe",
    input: HeartbeatInput | RotateInput,
  ): string {
    return this.signer.signFields(canonicalIdentityAcknowledgement(operation, input));
  }

  private mac(data: unknown): Buffer {
    return createHmac("sha256", this.key).update(JSON.stringify(data)).digest();
  }
  private pairingCipherKey(): Buffer {
    return createHmac("sha256", this.key).update("connector-pairing-encryption-v1").digest();
  }
  private pairingAAD(pairing: Pairing): Buffer {
    return Buffer.from(
      JSON.stringify(["connector-pairing-v1", pairing.id, pairing.owner, pairing.expiresAt]),
    );
  }
  private encryptPairingKey(pairing: Pairing, value: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.pairingCipherKey(), iv);
    cipher.setAAD(this.pairingAAD(pairing));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }
  private decryptPairingKey(pairing: Pairing): Buffer {
    const data = pairing.encryptedKey && decode(pairing.encryptedKey, 60);
    if (!data) throw new Error("Invalid encrypted pairing state");
    try {
      const cipher = createDecipheriv("aes-256-gcm", this.pairingCipherKey(), data.subarray(0, 12));
      cipher.setAAD(this.pairingAAD(pairing));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
    } catch {
      throw new Error("Encrypted pairing state integrity check failed");
    }
  }
  private async persist(): Promise<void> {
    const content = JSON.stringify({
      state: this.state,
      mac: this.mac(this.state).toString("hex"),
    });
    try {
      await this.file.write(content);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  private async consumeReplay(id: string, now: number): Promise<void> {
    this.state.replays = this.state.replays.filter((item) => item.expiresAt > now);
    if (this.state.replays.some((item) => item.id === id)) throw new ConnectorError("DENIED");
    if (this.state.replays.length >= LIMIT) throw new ConnectorError("CAPACITY");
    this.state.replays.push({ id, expiresAt: now + 121_000 });
    await this.persist();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.failed)
        throw new Error("Connector registry requires restart after a storage failure");
      // Roll back in-memory mutations; an ambiguous storage failure also disables the registry.
      const before = structuredClone(this.state);
      try {
        return await fn();
      } catch (e) {
        this.state = before;
        throw e;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  // Operations that publish or revoke a particular identity must remain ordered,
  // but waiting for its database transaction must not stall unrelated identities.
  private forConnector<T>(id: string, fn: () => Promise<T>, limit = true): Promise<T> {
    return this.identities.run(id, fn, limit);
  }
  async close(): Promise<void> {
    await this.identities.drain();
    await this.queue;
    await this.file.close();
  }

  async createPairing(
    owner: string,
  ): Promise<{ pairingId: string; secret: string; platformPublicKey: string; expiresAt: number }> {
    return this.exclusive(async () => {
      const now = Date.now();
      this.state.pairings = this.state.pairings.filter((p) => p.expiresAt > now);
      if (this.state.pairings.length >= 100) throw new ConnectorError("CAPACITY");
      const pairingId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const expiresAt = now + 300_000;
      const pairing: Pairing = {
        id: pairingId,
        owner,
        expiresAt,
      };
      pairing.encryptedKey = this.encryptPairingKey(
        pairing,
        createHash("sha256").update(secret).digest(),
      );
      this.state.pairings.push(pairing);
      await this.persist();
      return { pairingId, secret, platformPublicKey: this.platformPublicKey(), expiresAt };
    });
  }
  async pair(input: PairInput): Promise<void> {
    return this.exclusive(async () => {
      if (input.protocol !== 2) throw new ConnectorError("INCOMPATIBLE");
      if (
        !UUID.test(input.pairingId) ||
        !UUID.test(input.connectorId) ||
        !decode(input.proof, 32) ||
        !decode(input.publicKey, 32) ||
        !safeText(input.name, 120) ||
        !validateAgentVersion(input.agentVersion)
      )
        throw new ConnectorError("INVALID");
      const pairing = this.state.pairings.find((p) => p.id === input.pairingId);
      const key = pairing ? this.decryptPairingKey(pairing) : Buffer.alloc(32);
      const expected = createHmac("sha256", key)
        .update(canonicalPairProof(input).join("\n"))
        .digest();
      const proof = decode(input.proof, 32);
      if (
        !pairing ||
        pairing.expiresAt <= Date.now() ||
        key.length !== 32 ||
        !proof ||
        !timingSafeEqual(proof, expected) ||
        !verifySignature(input.publicKey, input.signature, canonicalPair(input))
      )
        throw new ConnectorError("DENIED");
      if (
        this.state.connectors.length >= 1000 ||
        this.state.connectors.filter((c) => c.revokedAt === null).length >= 100 ||
        this.state.connectors.some(
          (c) => c.id === input.connectorId || c.publicKey === input.publicKey,
        )
      )
        throw new ConnectorError("DENIED");
      this.state.pairings = this.state.pairings.filter((p) => p.id !== pairing.id);
      this.state.connectors.push({
        id: input.connectorId,
        owner: pairing.owner,
        name: input.name,
        publicKey: input.publicKey,
        agentVersion: input.agentVersion,
        protocolVersion: 1,
        lastSeenAt: null,
        revokedAt: null,
      });
      await this.persist();
    });
  }
  async heartbeat(input: HeartbeatInput): Promise<DiagnosticTask | null> {
    if (!(await this.signed("heartbeat", input))) throw new ConnectorError("INCOMPATIBLE");
    return this.pendingDiagnostic(input.connectorId);
  }
  private async pendingDiagnostic(connectorId: string): Promise<DiagnosticTask | null> {
    return this.exclusive(async () => {
      const connector = this.state.connectors.find(
        (c) => c.id === connectorId && c.revokedAt === null,
      );
      if (!connector) return null;
      const task = this.state.tasks.find(
        (t) =>
          t.connectorId === connector.id &&
          t.completedAt === null &&
          t.expiresAt > Math.floor(Date.now() / 1000),
      );
      if (!task) return null;
      const { completedAt: _completedAt, ...message } = task;
      return message;
    });
  }
  async rotate(input: RotateInput): Promise<void> {
    if (!UUID.test(input.connectorId)) throw new ConnectorError("INVALID");
    // Do not allow unauthenticated requests to wait behind a long transaction.
    await this.exclusive(async () => {
      const connector = this.state.connectors.find(
        (item) => item.id === input.connectorId && item.revokedAt === null,
      );
      if (
        !connector ||
        !Number.isSafeInteger(input.timestamp) ||
        Math.abs(Math.floor(Date.now() / 1000) - input.timestamp) > 60 ||
        !verifySignature(connector.publicKey, input.signature, canonicalSigned("rotate", input))
      )
        throw new ConnectorError("DENIED");
    });
    return this.forConnector(input.connectorId, async () => {
      if (!(await this.signed("rotate", input))) throw new ConnectorError("INCOMPATIBLE");
    });
  }
  async probe(input: HeartbeatInput): Promise<void> {
    if (!(await this.signed("probe", input))) throw new ConnectorError("INCOMPATIBLE");
  }
  private async signed(
    op: "heartbeat" | "rotate" | "probe",
    input: HeartbeatInput | RotateInput,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      if (
        !UUID.test(input.connectorId) ||
        !validateAgentVersion(input.agentVersion) ||
        !Number.isSafeInteger(input.protocol) ||
        input.protocol < 1 ||
        input.protocol > 255 ||
        !Number.isSafeInteger(input.timestamp) ||
        !decode(input.nonce, 32) ||
        !decode(input.signature, 64)
      )
        throw new ConnectorError("INVALID");
      if (op === "rotate" && !decode((input as RotateInput).newPublicKey, 32))
        throw new ConnectorError("INVALID");
      const now = Date.now();
      const connector = this.state.connectors.find((c) => c.id === input.connectorId);
      if (
        !connector ||
        connector.revokedAt !== null ||
        Math.abs(Math.floor(now / 1000) - input.timestamp) > 60 ||
        !verifySignature(connector.publicKey, input.signature, canonicalSigned(op, input))
      )
        throw new ConnectorError("DENIED");
      this.state.replays = this.state.replays.filter((r) => r.expiresAt > now);
      const replayId = createHash("sha256")
        .update(`${input.connectorId}:${input.nonce}`)
        .digest("hex");
      if (this.state.replays.some((r) => r.id === replayId)) throw new ConnectorError("DENIED");
      if (this.state.replays.length >= LIMIT) throw new ConnectorError("CAPACITY");
      const compatible = input.protocol === 1;
      if (compatible && op === "rotate") {
        const next = (input as RotateInput).newPublicKey;
        if (this.state.connectors.some((c) => c.publicKey === next))
          throw new ConnectorError("DENIED");
        connector.publicKey = next;
      }
      if (op === "heartbeat") {
        connector.agentVersion = input.agentVersion;
        connector.protocolVersion = input.protocol;
        connector.lastSeenAt = now;
      }
      this.state.replays.push({ id: replayId, expiresAt: now + 121_000 });
      await this.persist();
      return compatible;
    });
  }
  async createDiagnostic(owner: string, id: string): Promise<void> {
    return this.exclusive(async () => {
      const connector = this.state.connectors.find(
        (c) => c.id === id && c.owner === owner && c.revokedAt === null,
      );
      if (!connector) throw new ConnectorError("NOT_FOUND");
      if (!safeText(owner, 128)) throw new ConnectorError("INVALID");
      const now = Math.floor(Date.now() / 1000);
      this.state.tasks = this.state.tasks.filter((t) => t.expiresAt > now - 3600);
      if (
        this.state.tasks.length >= 1000 ||
        this.state.tasks.some(
          (t) => t.connectorId === id && t.completedAt === null && t.expiresAt > now,
        )
      )
        throw new ConnectorError("CAPACITY");
      const task: DiagnosticTask = {
        id: randomUUID(),
        connectorId: id,
        actorId: owner,
        operation: "diagnostic",
        issuedAt: now,
        expiresAt: now + 60,
        nonce: randomBytes(32).toString("base64url"),
        protocol: 1,
        signature: "",
      };
      task.signature = this.signer.signFields(taskFields(task));
      this.state.tasks.push({ ...task, completedAt: null });
      await this.persist();
    });
  }
  async completeDiagnostic(input: ResultInput): Promise<void> {
    return this.exclusive(async () => {
      if (
        input.protocol !== 1 ||
        !UUID.test(input.connectorId) ||
        !UUID.test(input.taskId) ||
        input.outcome !== "ok" ||
        !validateAgentVersion(input.agentVersion) ||
        !Number.isSafeInteger(input.timestamp) ||
        !decode(input.nonce, 32) ||
        !decode(input.signature, 64)
      )
        throw new ConnectorError("INVALID");
      const now = Date.now();
      const connector = this.state.connectors.find(
        (c) => c.id === input.connectorId && c.revokedAt === null,
      );
      const task = this.state.tasks.find(
        (t) => t.id === input.taskId && t.connectorId === input.connectorId,
      );
      const fields = [
        "connector-v1",
        "result",
        input.connectorId,
        input.taskId,
        input.outcome,
        input.agentVersion,
        "1",
        String(input.timestamp),
        input.nonce,
      ];
      if (
        !connector ||
        !task ||
        task.expiresAt <= Math.floor(now / 1000) ||
        Math.abs(Math.floor(now / 1000) - input.timestamp) > 60 ||
        !verifySignature(connector.publicKey, input.signature, fields)
      )
        throw new ConnectorError("DENIED");
      this.state.replays = this.state.replays.filter((r) => r.expiresAt > now);
      const replayId = createHash("sha256")
        .update(`${input.connectorId}:${input.nonce}`)
        .digest("hex");
      if (this.state.replays.some((r) => r.id === replayId)) throw new ConnectorError("DENIED");
      if (this.state.replays.length >= LIMIT) throw new ConnectorError("CAPACITY");
      this.state.replays.push({ id: replayId, expiresAt: now + 121_000 });
      task.completedAt ??= now;
      await this.persist();
    });
  }
  resultAcknowledgement(input: ResultInput): string {
    return this.signer.signFields([
      "connector-v1",
      "result-ack",
      input.connectorId,
      input.taskId,
      input.nonce,
      "1",
    ]);
  }

  async list(owner: string): Promise<
    Array<{
      id: string;
      name: string;
      agentVersion: string;
      lastSeenAt: number | null;
      status: "online" | "offline" | "incompatible" | "revoked";
      diagnosticStatus: "pending" | "completed" | "expired" | null;
    }>
  > {
    return this.exclusive(async () =>
      this.state.connectors
        .filter((c) => c.owner === owner)
        .map((c) => ({
          id: c.id,
          name: c.name,
          agentVersion: c.agentVersion,
          lastSeenAt: c.lastSeenAt,
          diagnosticStatus: (() => {
            const task = [...this.state.tasks].reverse().find((t) => t.connectorId === c.id);
            return !task
              ? null
              : task.completedAt !== null
                ? "completed"
                : task.expiresAt <= Math.floor(Date.now() / 1000)
                  ? "expired"
                  : "pending";
          })(),
          status:
            c.revokedAt !== null
              ? "revoked"
              : c.lastSeenAt !== null && Date.now() - c.lastSeenAt < 45_000
                ? (c.protocolVersion ?? 1) === 1
                  ? "online"
                  : "incompatible"
                : "offline",
        })),
    );
  }
  async revoke(owner: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw new ConnectorError("NOT_FOUND");
    return this.forConnector(
      id,
      () =>
        this.exclusive(async () => {
          const connector = this.state.connectors.find((c) => c.id === id && c.owner === owner);
          if (!connector || connector.revokedAt !== null) throw new ConnectorError("NOT_FOUND");
          connector.revokedAt = Date.now();
          await this.persist();
        }),
      false,
    );
  }

  async isActiveOwner(owner: string, id: string): Promise<boolean> {
    return this.exclusive(async () =>
      this.state.connectors.some(
        (connector) =>
          connector.id === id && connector.owner === owner && connector.revokedAt === null,
      ),
    );
  }

  async withActiveOwner<T>(owner: string, id: string, action: () => T): Promise<T | undefined> {
    if (!UUID.test(id)) return undefined;
    return this.forConnector(id, async () => {
      if (!(await this.isActiveOwner(owner, id))) return undefined;
      return action();
    });
  }

  schemaTask(input: Omit<SchemaTask, "signature" | "operation" | "protocol">): SchemaTask {
    return this.schemaProtocol.schemaTask(input);
  }
  verifySchemaResult(input: SchemaResult, commit: () => Promise<void>): Promise<void> {
    return this.schemaProtocol.verifySchemaResult(input, commit);
  }
  schemaResultAcknowledgement(input: SchemaResult): string {
    return this.schemaProtocol.schemaResultAcknowledgement(input);
  }
  issueSchemaTask(
    connectorId: string,
    get: () => Promise<Omit<SchemaTask, "signature" | "operation" | "protocol"> | null>,
  ): Promise<SchemaTask | null> {
    return this.schemaProtocol.issueSchemaTask(connectorId, get);
  }
  signMutationMessage(input: UnsignedMutationMessage): Promise<MutationMessage> {
    return this.mutationProtocol.signMutationMessage(input);
  }
  assertCurrentMutationMessage(input: MutationMessage): void {
    this.mutationProtocol.assertCurrentMutationMessage(input);
  }
  authenticateMutationMessage(input: unknown): Promise<MutationMessage> {
    return this.mutationProtocol.authenticateMutationMessage(input);
  }
  signMutationPermit(payload: unknown): string {
    return this.mutationProtocol.signMutationPermit(payload);
  }
  issueReadTask(task: Omit<ReadTask, "signature">): Promise<ReadTask> {
    return this.readProtocol.issueReadTask(task);
  }
  issueReadCancel(cancel: Omit<ReadCancel, "signature">): Promise<ReadCancel> {
    return this.readProtocol.issueReadCancel(cancel);
  }
  preflightReadResult(input: ReadResult): Promise<void> {
    return this.readProtocol.preflightReadResult(input);
  }
  verifyReadResult(input: ReadResult, commit: () => Promise<void>): Promise<void> {
    return this.readProtocol.verifyReadResult(input, commit);
  }
  readResultAcknowledgement(input: ReadResult): string {
    return this.readProtocol.readResultAcknowledgement(input);
  }
}
