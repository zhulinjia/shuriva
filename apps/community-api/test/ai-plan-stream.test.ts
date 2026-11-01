import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { streamModelPlan } from "../src/ai/plan-stream.js";

test("real HTTP exposes progress before a model completes, sanitizes failure and aborts on disconnect", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  let cancelObserved!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancelObserved = resolve;
  });
  const app = express();
  app.post("/plan", async (_req, res) => {
    const cancel = new AbortController();
    res.once("close", () => cancel.abort());
    await streamModelPlan(res, cancel.signal, async (progress) => {
      progress("awaiting_model");
      await gate;
      completed = true;
      return { kind: "clarification", question: "请补充问题" };
    });
  });
  app.post("/fail", async (_req, res) => {
    await streamModelPlan(res, new AbortController().signal, async (progress) => {
      progress("checking_context");
      throw Error("private-key-and-provider-details");
    });
  });
  app.post("/cancel", async (_req, res) => {
    const cancel = new AbortController();
    res.once("close", () => cancel.abort());
    await streamModelPlan(res, cancel.signal, async (progress) => {
      progress("waiting_connector");
      await new Promise<void>((resolve) =>
        cancel.signal.addEventListener(
          "abort",
          () => {
            cancelObserved();
            resolve();
          },
          { once: true },
        ),
      );
      return null;
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/plan`, { method: "POST" });
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /data-progress|"start"/);
    assert.equal(completed, false);
    release();
    let remaining = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining += new TextDecoder().decode(chunk.value);
    }
    assert.match(remaining, /data-plan/);
    assert.match(remaining, /\[DONE\]/);
    const failed = await (await fetch(`${base}/fail`, { method: "POST" })).text();
    assert.match(failed, /data-failure/);
    assert.match(failed, /MODEL_UNAVAILABLE/);
    assert.doesNotMatch(failed, /private-key|provider-details|data-plan/);
    const controller = new AbortController();
    const pending = await fetch(`${base}/cancel`, { method: "POST", signal: controller.signal });
    await pending.body?.getReader().read();
    controller.abort();
    await Promise.race([
      cancelled,
      new Promise((_, reject) => setTimeout(() => reject(Error("disconnect not observed")), 1500)),
    ]);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
