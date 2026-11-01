import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareContext } from "../src/chat/chat-context.ts";

const message = (role, text, id) => ({ role, text, id });

test("preserves a complete recent conversation within the UTF-8 budget", () => {
  const history = [message("user", "查询客户", "1"), message("assistant", "哪个城市？", "2")];
  const context = prepareContext(history, "上海");
  assert.equal(context?.omitted, false);
  assert.equal(context?.text, "用户: 查询客户\n助手: 哪个城市？\n用户: 上海");
});

test("a very long earlier turn is omitted transparently so a short answer can proceed", () => {
  const history = [
    message("user", "客".repeat(2700), "1"),
    message("assistant", "哪个城市？".repeat(20), "2"),
  ];
  const context = prepareContext(history, "上海");
  assert.equal(context?.omitted, true);
  assert.equal(context?.text, "用户: 上海");
  assert.ok(new TextEncoder().encode(context.text).length <= 8192);
});

test("retains only contiguous complete recent turns and reports earlier omissions", () => {
  const history = [];
  for (let i = 0; i < 4; i++)
    history.push(message("user", `q${i}`, `u${i}`), message("assistant", `a${i}`, `a${i}`));
  const context = prepareContext(history, "下一步");
  assert.equal(context?.omitted, true);
  assert.equal(context?.text.includes("q0"), false);
  assert.equal(context?.text.includes("q1"), true);
  assert.equal(context?.text.includes("a3"), true);
});

test("rejects a current question that cannot fit rather than cutting it", () => {
  assert.equal(prepareContext([], "客".repeat(3000)), null);
  assert.equal(prepareContext([], "  "), null);
});
