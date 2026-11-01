import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Entry } from "@napi-rs/keyring";
import { registrySecret } from "../src/connectors/system-vault.js";

test("system vault persists registry key without exposing it", {
  skip: process.env.CONNECTOR_TEST_KEYRING !== "1",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-vault-"));
  const path = join(dir, "state.json");
  const service = `aw-test-${randomUUID()}`;
  const name = createHash("sha256").update(resolve(path)).digest("hex");
  const entry = new Entry(service, name, { linux: { store: "secret-service" } });
  try {
    const first = registrySecret(path, service);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(registrySecret(path, service), first);
  } finally {
    try {
      entry.deletePassword();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
