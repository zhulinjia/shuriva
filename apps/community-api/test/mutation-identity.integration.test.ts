import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import {
  type MutationMessage,
  mutationMessageFields,
  mutationPayload,
} from "../src/connectors/mutation-protocol.js";
import {
  ConnectorRegistry,
  canonicalPair,
  canonicalPairProof,
  canonicalSigned,
  type PairInput,
  type RotateInput,
} from "../src/connectors/registry.js";
import { executionBindingSchema, MutationError } from "../src/mutations/model.js";
import type { MutationAccess, MutationTransport } from "../src/mutations/ports.js";
import { MutationService } from "../src/mutations/service.js";
import { ReadService } from "../src/queries/service.js";
import { mutationFixture } from "./mutation-fixture.js";

const integration = { skip: process.env.STAGE8_G3_TEST !== "1", timeout: 30_000 };
function identity() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return { privateKey: pair.privateKey, publicKey: der.subarray(-32).toString("base64url") };
}
function signed(fields: string[], key: ReturnType<typeof identity>): string {
  return sign(null, Buffer.from(fields.join("\n")), key.privateKey).toString("base64url");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function removeIdentityDirectory(directory: string) {
  const owned = resolve(directory);
  assert.ok(
    (await realpath(owned)) === owned &&
      dirname(owned) === (await realpath(tmpdir())) &&
      basename(owned).startsWith("g3-mutation-identity-"),
    "identity fixture cleanup ownership mismatch",
  );
  await rm(owned, { recursive: true, force: true });
}

async function identityFixture() {
  const f = await mutationFixture();
  const directory = await mkdtemp(join(tmpdir(), "g3-mutation-identity-"));
  let registry: ConnectorRegistry | undefined;
  try {
    registry = await ConnectorRegistry.open(
      join(directory, "registry.json"),
      randomBytes(32).toString("hex"),
    );
    const active = identity();
    const offer = await registry.createPairing(f.binding.ownerId);
    const pair: PairInput = {
      pairingId: offer.pairingId,
      proof: "",
      connectorId: f.binding.connectorId,
      name: "isolated identity boundary",
      publicKey: active.publicKey,
      agentVersion: "test",
      protocol: 2,
      signature: "",
    };
    pair.proof = createHmac("sha256", createHash("sha256").update(offer.secret).digest())
      .update(canonicalPairProof(pair).join("\n"))
      .digest("base64url");
    pair.signature = signed(canonicalPair(pair), active);
    await registry.pair(pair);
    const currentRegistry = registry;
    const reads = new ReadService(f.sources, registry);
    let accessBarrier:
      | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
      | undefined;
    const access: MutationAccess = {
      async authenticate() {
        return undefined;
      },
      async withScope(scope, action) {
        const pause = accessBarrier;
        accessBarrier = undefined;
        if (pause) {
          pause.entered.resolve();
          await pause.release.promise;
        }
        // Exercise the same workspace -> current Connector identity lock order
        // as production. A bare isActiveOwner snapshot would make this fake.
        return reads.withCurrentReadScope(scope, async () => {
          const source = await f.sources.boundSource(
            scope.ownerId,
            scope.workspaceId,
            scope.sourceId,
          );
          if (!source) throw new MutationError("NOT_FOUND");
          return action({ ...scope, connectorId: source.connectorId });
        });
      },
    };
    const transport: MutationTransport = {
      async capability() {
        throw Error("no transport in identity authorization test");
      },
      async preview() {
        throw Error("no transport in identity authorization test");
      },
      async execute() {
        throw Error("no transport in identity authorization test");
      },
      async status() {
        throw Error("no transport in identity authorization test");
      },
      async cancel() {
        throw Error("no transport in identity authorization test");
      },
    };
    const service = new MutationService(
      f.store,
      access,
      transport,
      { sign: async (payload) => currentRegistry.signMutationPermit(payload) },
      { enabled: true, executionEnabled: true },
    );
    const registration = async () => {
      const preview = f.preview();
      await f.store.savePreview(f.binding, preview);
      const found = await f.store.confirm(f.binding, f.sessionId, {
        confirmationId: randomUUID(),
        previewId: preview.previewId,
        commitment: preview.commitment,
        revision: preview.revision,
      });
      const e = found.execution;
      return executionBindingSchema.parse({
        ...f.binding,
        executionId: e.executionId,
        previewId: e.previewId,
        commitment: e.commitment,
        revision: e.revision,
        apiBoot: e.apiBoot,
        connectorBoot: e.connectorBoot,
        targetIdentity: e.targetIdentity,
        targetEpoch: e.targetEpoch,
        policyGeneration: e.policyGeneration,
        installationGeneration: e.installationGeneration,
      });
    };
    const message = (kind: "claim" | "permit", payload: unknown, key = active): MutationMessage => {
      const now = Math.floor(Date.now() / 1000);
      const value: MutationMessage = {
        ...f.binding,
        id: randomUUID(),
        kind,
        operation: "execute",
        payload: mutationPayload(payload),
        issuedAt: now,
        expiresAt: now + 30,
        nonce: randomBytes(32).toString("base64url"),
        replyTo: "",
        protocol: 1,
        signature: "",
      };
      value.signature = signed(mutationMessageFields(value), key);
      return value;
    };
    const rotate = async (old = active, next = identity()) => {
      const value: RotateInput = {
        connectorId: f.binding.connectorId,
        newPublicKey: next.publicKey,
        agentVersion: "test",
        protocol: 1,
        timestamp: Math.floor(Date.now() / 1000),
        nonce: randomBytes(32).toString("base64url"),
        signature: "",
      };
      value.signature = signed(canonicalSigned("rotate", value), old);
      await currentRegistry.rotate(value);
      return next;
    };
    return {
      f,
      registry: currentRegistry,
      service,
      registration,
      message,
      rotate,
      pauseAccess() {
        const pause = { entered: deferred(), release: deferred() };
        accessBarrier = pause;
        return pause;
      },
      async close() {
        reads.close();
        await currentRegistry.close();
        await removeIdentityDirectory(directory);
        await f.close();
      },
    };
  } catch (error) {
    await registry?.close();
    await removeIdentityDirectory(directory);
    await f.close();
    throw error;
  }
}

test(
  "mutation claim and permit recheck the current identity after preauthentication and rotation",
  integration,
  async () => {
    for (const phase of ["claim", "permit"] as const) {
      const lab = await identityFixture();
      try {
        const execution = await lab.registration();
        if (phase === "permit") {
          const claim = lab.message("claim", execution);
          await lab.registry.authenticateMutationMessage(claim);
          await lab.service.claim(lab.f.binding, execution, () =>
            lab.registry.assertCurrentMutationMessage(claim),
          );
        }
        const request = { ...execution, challenge: randomBytes(32).toString("base64url") };
        const message = lab.message(phase, phase === "claim" ? execution : request);
        await lab.registry.authenticateMutationMessage(message);
        const pause = lab.pauseAccess();
        const attempt =
          phase === "claim"
            ? lab.service.claim(lab.f.binding, execution, () =>
                lab.registry.assertCurrentMutationMessage(message),
              )
            : lab.service.permit(lab.f.binding, request, () =>
                lab.registry.assertCurrentMutationMessage(message),
              );
        // Attach the observer before releasing the controlled scheduling point.
        const rejected = assert.rejects(attempt, /DENIED/);
        await pause.entered.promise;
        try {
          await lab.rotate();
        } finally {
          pause.release.resolve();
        }
        await rejected;
        const record = await lab.f.store.get(lab.f.binding, execution.executionId);
        assert.equal(record.state, phase === "claim" ? "registered" : "running");
        assert.equal(record.permitIssued, false);
        const [rows] = await lab.f.pool.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS count FROM mutation_permit WHERE executionId=?",
          [execution.executionId],
        );
        assert.equal(Number(rows[0]?.count), 0);
      } finally {
        await lab.close();
      }
    }
  },
);

test(
  "identity rotation waits until an admitted mutation permit transaction has finished",
  integration,
  async () => {
    const lab = await identityFixture();
    try {
      const execution = await lab.registration();
      const claim = lab.message("claim", execution);
      await lab.registry.authenticateMutationMessage(claim);
      await lab.service.claim(lab.f.binding, execution, () =>
        lab.registry.assertCurrentMutationMessage(claim),
      );
      const request = { ...execution, challenge: randomBytes(32).toString("base64url") };
      const message = lab.message("permit", request);
      await lab.registry.authenticateMutationMessage(message);
      const entered = deferred(),
        release = deferred();
      const original = lab.f.store.permit.bind(lab.f.store);
      lab.f.store.permit = async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      };
      const permit = lab.service.permit(lab.f.binding, request, () =>
        lab.registry.assertCurrentMutationMessage(message),
      );
      await entered.promise;
      let rotated = false;
      const rotation = lab.rotate().then(() => {
        rotated = true;
      });
      try {
        await new Promise<void>((yes) => setImmediate(yes));
        assert.equal(rotated, false);
      } finally {
        release.resolve();
      }
      const result = await permit;
      await rotation;
      assert.equal(result.challenge, request.challenge);
      assert.equal(
        (await lab.f.store.get(lab.f.binding, execution.executionId)).permitIssued,
        true,
      );
      assert.throws(() => lab.registry.assertCurrentMutationMessage(message), /DENIED/);
      assert.equal(rotated, true);
    } finally {
      await lab.close();
    }
  },
);
