import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { act, cleanup, renderHook } from "@testing-library/react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const loader = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [], include: [] }, appType: "custom" });
const { useConversationHistory } = await loader.ssrLoadModule("/src/chat/use-conversation-history.ts");
const workspace = crypto.randomUUID(), source = crypto.randomUUID();
const messages = [{ id: crypto.randomUUID(), role: "user", text: "本页业务问题" }];
const fetchOriginal = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = fetchOriginal; });
after(async () => { await loader.close(); dom.window.close(); });

function beforeUnloadBlocked() {
  const event = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test("memory-only conversations are dirty before saving and keep unload protection when history is disabled", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error("must not contact history"); };
  const hook = renderHook(({ messages, enabled }) => useConversationHistory(workspace, source, messages, enabled, () => {}), {
    initialProps: { messages: [], enabled: false },
  });
  assert.equal(hook.result.current.hasUnsaved, false);
  hook.rerender({ messages, enabled: false });
  assert.equal(hook.result.current.hasUnsaved, true);
  assert.equal(beforeUnloadBlocked(), true);
  await act(() => hook.result.current.save(messages));
  assert.equal(requests, 0);
  assert.equal(hook.result.current.status, "unsaved");
  assert.equal(hook.result.current.hasUnsaved, true);
  hook.rerender({ messages, enabled: true });
  assert.equal(hook.result.current.hasUnsaved, true);
  await act(async () => { hook.result.current.reset(); });
  hook.rerender({ messages: [], enabled: true });
  assert.equal(hook.result.current.hasUnsaved, false);
  assert.equal(beforeUnloadBlocked(), false);
});

test("only the saved snapshot becomes clean; later replies and title edits stay dirty", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: crypto.randomUUID(), revision: 1 }), { headers: { "content-type": "application/json" } });
  const hook = renderHook(({ messages }) => useConversationHistory(workspace, source, messages, true, () => {}), { initialProps: { messages } });
  await act(() => hook.result.current.save(messages));
  assert.equal(hook.result.current.hasUnsaved, false);
  assert.equal(beforeUnloadBlocked(), false);
  await act(async () => { hook.result.current.setTitle("新标题"); });
  assert.equal(hook.result.current.hasUnsaved, true);
  const next = [...messages, { id: crypto.randomUUID(), role: "assistant", text: "新回复" }];
  hook.rerender({ messages: next });
  assert.equal(hook.result.current.hasUnsaved, true);
  assert.equal(beforeUnloadBlocked(), true);
});
