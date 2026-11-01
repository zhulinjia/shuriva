import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthorizationWork } from "../src/mcp/authorization-work.js";

test("timed-out SDK work retains its bounded capacity until it actually settles", async () => {
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const work = new AuthorizationWork(10, 1);
  await assert.rejects(
    () =>
      work.run(async () => {
        await gate;
        return true;
      }),
    /MCP_AUTH_DEADLINE_EXCEEDED/,
  );
  await assert.rejects(() => work.run(async () => true), /MCP_AUTH_CAPACITY/);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await work.run(async () => true), true);
});

test("SDK result arriving after the monotonic deadline is rejected", async () => {
  const work = new AuthorizationWork(10, 1);
  await assert.rejects(
    () =>
      work.run(async () => {
        const end = performance.now() + 25;
        while (performance.now() < end) {
          /* simulate delayed event loop */
        }
        return true;
      }),
    /MCP_AUTH_DEADLINE_EXCEEDED/,
  );
});
