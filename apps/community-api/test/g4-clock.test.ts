import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateMutationMessage } from "../src/connectors/mutation-protocol.js";

test("G4 API clock-offset boundaries reject stale/future signed envelopes without changing host time", async () => {
  const { message } = JSON.parse(
    await readFile(
      new URL("../../../../connector/go/testdata/mutation-vector.json", import.meta.url),
      "utf8",
    ),
  );
  for (const offset of [-86400, -3, -2, 0, 29, 30, 86400]) {
    const now = message.issuedAt + offset;
    if (offset >= -2 && now < message.expiresAt)
      assert.doesNotThrow(() => validateMutationMessage(message, now));
    else assert.throws(() => validateMutationMessage(message, now));
  }
});
