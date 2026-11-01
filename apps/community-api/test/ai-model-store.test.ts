import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelStore, systemModelStore } from "../src/ai/model-store.js";

function fixture() {
  const values = new Map<string, string>();
  const store = new ModelStore((owner) => ({
    getPassword: () => values.get(owner) ?? null,
    setPassword: (value) => {
      values.set(owner, value);
    },
    deletePassword: () => values.delete(owner),
  }));
  return { store, values };
}

test("model credential storage isolates owners and never returns secrets in display state", () => {
  const { store } = fixture();
  const config = { baseUrl: "https://example.com/v1", model: "model-name", apiKey: "fake-key" };
  assert.deepEqual(store.display("alice"), { configured: false });
  store.set("alice", config);
  assert.deepEqual(store.display("alice"), {
    configured: true,
    baseUrl: config.baseUrl,
    model: config.model,
    configVersion: store.versioned("alice")?.configVersion,
  });
  assert.deepEqual(store.display("bob"), { configured: false });
  assert.deepEqual(store.get("alice"), config);
  store.clear("alice");
  assert.equal(store.get("alice"), null);
});

test("invalid or corrupted credential records fail closed", () => {
  const { store, values } = fixture();
  assert.throws(() =>
    store.set("alice", { baseUrl: "http://example.com", model: "model", apiKey: "fake" }),
  );
  assert.throws(() =>
    store.set("alice", { baseUrl: "https://example.com", model: "model", apiKey: "with\nnewline" }),
  );
  assert.throws(() =>
    store.set("bad owner", { baseUrl: "https://example.com", model: "model", apiKey: "fake" }),
  );
  values.set("alice", "malformed");
  assert.throws(() => store.get("alice"), /MODEL_STORE_UNAVAILABLE/);
});

test("each configuration update invalidates older previews and in-flight requests", () => {
  const { store, values } = fixture();
  const first = { baseUrl: "https://example.com/v1", model: "model", apiKey: "synthetic-A" };
  store.set("alice", first);
  const a = store.versioned("alice");
  assert.ok(a);
  const watcher = store.watch("alice", a.configVersion);
  store.set("alice", { ...first, apiKey: "synthetic-B" });
  assert.equal(watcher.signal.aborted, true);
  assert.notEqual(store.versioned("alice")?.configVersion, a.configVersion);
  assert.throws(() => store.watch("alice", a.configVersion), /STALE/);
  const b = store.versioned("alice");
  assert.ok(b);
  const deletion = store.watch("alice", b.configVersion);
  store.clear("alice");
  assert.equal(deletion.signal.aborted, true);
  assert.equal(store.versioned("alice"), null);
  // Out-of-band credential changes also invalidate a later version check.
  store.set("alice", first);
  const previous = store.versioned("alice");
  values.set("alice", JSON.stringify({ ...first, apiKey: "synthetic-C" }));
  assert.notEqual(store.versioned("alice")?.configVersion, previous?.configVersion);
});

test("synthetic model credential round-trips through the real system vault", {
  skip: process.env.STAGE5_KEYRING_TEST !== "1",
}, () => {
  const owner = randomUUID();
  const store = systemModelStore(join(tmpdir(), `stage5-model-${randomUUID()}`));
  try {
    const config = {
      baseUrl: "https://example.com/v1",
      model: "fixture",
      apiKey: "synthetic-test-key",
    };
    store.set(owner, config);
    assert.deepEqual(store.get(owner), config);
    assert.deepEqual(store.display(owner), {
      configured: true,
      baseUrl: config.baseUrl,
      model: config.model,
      configVersion: store.versioned(owner)?.configVersion,
    });
  } finally {
    store.clear(owner);
  }
});
