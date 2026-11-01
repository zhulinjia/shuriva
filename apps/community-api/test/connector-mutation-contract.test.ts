import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  mutationMessageFields,
  validateMutationMessage,
  type MutationMessage,
} from "../src/connectors/mutation-protocol.js";

test("mutation protocol uses the same fixed signed bytes in TypeScript and Go", async () => {
  const vector = JSON.parse(
    await readFile(
      new URL("../../../../connector/go/testdata/mutation-vector.json", import.meta.url),
      "utf8",
    ),
  ) as { now: number; publicKey: string; fields: string[]; message: MutationMessage };
  const message = validateMutationMessage(vector.message, vector.now);
  assert.deepEqual(mutationMessageFields(message), vector.fields);
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(vector.publicKey, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(
      null,
      Buffer.from(vector.fields.join("\n")),
      key,
      Buffer.from(message.signature, "base64url"),
    ),
    true,
  );
  for (const field of [
    "kind",
    "operation",
    "ownerId",
    "workspaceId",
    "sourceId",
    "payload",
    "issuedAt",
    "expiresAt",
    "nonce",
    "replyTo",
  ] as const) {
    const changed = {
      ...message,
      [field]:
        typeof message[field] === "number" ? Number(message[field]) + 1 : `${message[field]}x`,
    };
    assert.equal(
      verify(
        null,
        Buffer.from(mutationMessageFields(changed as MutationMessage).join("\n")),
        key,
        Buffer.from(message.signature, "base64url"),
      ),
      false,
    );
  }
  assert.throws(() => validateMutationMessage(message, message.expiresAt));
  assert.throws(() => validateMutationMessage({ ...message, unexpected: true }, vector.now));
  assert.throws(() =>
    validateMutationMessage(
      { ...message, payload: Buffer.from([255]).toString("base64url") },
      vector.now,
    ),
  );
});
