import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { readApiConfig, readStage3Enabled, readStage4Enabled } from "../src/config.js";

test("configuration defaults to a loopback listener and validates the port", () => {
  assert.equal(readStage3Enabled({}), false);
  assert.equal(readStage3Enabled({ ENABLE_STAGE3_DATASOURCES: "1" }), true);
  assert.throws(() => readStage3Enabled({ ENABLE_STAGE3_DATASOURCES: "yes" }));
  assert.equal(readStage4Enabled({}), false);
  assert.equal(
    readStage4Enabled({ ENABLE_STAGE3_DATASOURCES: "1", ENABLE_STAGE4_READS: "1" }),
    true,
  );
  assert.throws(() => readStage4Enabled({ ENABLE_STAGE4_READS: "1" }), /requires/);
  assert.throws(() => readStage4Enabled({ ENABLE_STAGE4_READS: "yes" }), /must be/);
  assert.deepEqual(readApiConfig({}), { host: "127.0.0.1", port: 3000 });
  assert.deepEqual(readApiConfig({ API_HOST: "localhost", API_PORT: "3200" }), {
    host: "localhost",
    port: 3200,
  });

  assert.throws(() => readApiConfig({ API_HOST: "0.0.0.0" }), /loopback/);
  for (const API_PORT of ["", "0", "65536", "-1", "3.5", "3000abc"]) {
    assert.throws(() => readApiConfig({ API_PORT }), /API_PORT/);
  }
});

test("health reports only API availability and an unimplemented action returns 404", async () => {
  const app = await createApp({ logger: false });
  try {
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok", service: "community-api" });

    const action = await fetch(`${baseUrl}/api/actions`, { method: "POST" });
    assert.equal(action.status, 404);
  } finally {
    await app.close();
  }
});
