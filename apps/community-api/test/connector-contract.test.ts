import assert from "node:assert/strict";
import { createHash, createHmac, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  canonicalPair,
  canonicalPairProof,
  canonicalSigned,
  type HeartbeatInput,
  type PairInput,
  type RotateInput,
} from "../src/connectors/registry.js";
import {
  type ReadCancel,
  type ReadResult,
  type ReadTask,
  readCancelFields,
  readResultFields,
  readTaskFields,
} from "../src/protocol/read-task.js";

test("shared Go/TypeScript connector v1 signatures match", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../../connector/testdata/protocol-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { pair: PairInput; heartbeat: HeartbeatInput; rotate: RotateInput };
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(fixture.pair.publicKey, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  for (const [message, signature] of [
    [canonicalSigned("heartbeat", fixture.heartbeat), fixture.heartbeat.signature],
    [canonicalSigned("rotate", fixture.rotate), fixture.rotate.signature],
  ] as Array<[string[], string]>) {
    assert.equal(
      verify(null, Buffer.from(message.join("\n")), key, Buffer.from(signature, "base64url")),
      true,
    );
  }
});

test("shared Go/TypeScript v2 pairing proof and signature match", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../../connector/testdata/pair-v2.json", import.meta.url), "utf8"),
  ) as { secret: string; pair: PairInput };
  const key = createHash("sha256").update(fixture.secret).digest();
  const proof = createHmac("sha256", key)
    .update(canonicalPairProof(fixture.pair).join("\n"))
    .digest("base64url");
  assert.equal(proof, fixture.pair.proof);
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(fixture.pair.publicKey, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalPair(fixture.pair).join("\n")),
      publicKey,
      Buffer.from(fixture.pair.signature, "base64url"),
    ),
    true,
  );
});

test("shared delegated schema vector preserves the exact signed field scope", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../../connector/testdata/delegated-schema-task.json", import.meta.url),
      "utf8",
    ),
  ) as { publicKey: string; task: ReadTask };
  assert.equal(fixture.task.operation, "model_schema");
  assert.deepEqual(JSON.parse(Buffer.from(fixture.task.payload, "base64url").toString("utf8")), {
    delegatedScope: { customers: ["id"] },
  });
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(fixture.publicKey, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(
      null,
      Buffer.from(readTaskFields(fixture.task).join("\n")),
      key,
      Buffer.from(fixture.task.signature, "base64url"),
    ),
    true,
  );
});

test("shared Go/TypeScript read task signature binds routing and payload", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../../connector/testdata/read-task.json", import.meta.url),
      "utf8",
    ),
  ) as { publicKey: string; task: ReadTask; cancel: ReadCancel; result: ReadResult };
  const payload = JSON.parse(Buffer.from(fixture.task.payload, "base64url").toString("utf8"));
  assert.deepEqual(payload.delegatedScope, { customers: ["id"] });
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(fixture.publicKey, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(
      null,
      Buffer.from(readTaskFields(fixture.task).join("\n")),
      key,
      Buffer.from(fixture.task.signature, "base64url"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(readTaskFields({ ...fixture.task, payload: "e30" }).join("\n")),
      key,
      Buffer.from(fixture.task.signature, "base64url"),
    ),
    false,
  );
  const widened = Buffer.from(
    JSON.stringify({ ...payload, delegatedScope: { customers: ["id", "secret"] } }),
  ).toString("base64url");
  assert.equal(
    verify(
      null,
      Buffer.from(readTaskFields({ ...fixture.task, payload: widened }).join("\n")),
      key,
      Buffer.from(fixture.task.signature, "base64url"),
    ),
    false,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(readCancelFields(fixture.cancel).join("\n")),
      key,
      Buffer.from(fixture.cancel.signature, "base64url"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(
        readCancelFields({
          ...fixture.cancel,
          sourceId: "55555555-5555-4555-8555-555555555555",
        }).join("\n"),
      ),
      key,
      Buffer.from(fixture.cancel.signature, "base64url"),
    ),
    false,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(readResultFields(fixture.result).join("\n")),
      key,
      Buffer.from(fixture.result.signature, "base64url"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(readResultFields({ ...fixture.result, payload: "error" }).join("\n")),
      key,
      Buffer.from(fixture.result.signature, "base64url"),
    ),
    false,
  );
});
