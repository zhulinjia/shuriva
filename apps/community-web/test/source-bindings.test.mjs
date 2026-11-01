import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindingIsLoading,
  bindingScope,
  loadBindingStatus,
  loadBoundPage,
} from "../src/datasources/source-bindings.ts";

test("refresh only checks the visible page and pinned selections in bounded batches", async () => {
  const visible = Array.from({ length: 100 }, (_, index) => `visible-${index}`);
  const scope = bindingScope(visible, "outside-selection", "outside-snapshot");
  const requests = [];
  const result = await loadBindingStatus("workspace", scope, async (path, options) => {
    const ids = JSON.parse(options.body).sourceIds;
    requests.push({ path, ids });
    return { sources: ids.filter((id) => id !== "visible-99").map((id) => ({ id })) };
  });
  assert.deepEqual(
    requests.map((item) => item.ids.length),
    [100, 2],
  );
  assert.equal(
    requests.every((item) => item.path === "/api/data-sources/workspaces/workspace/status"),
    true,
  );
  assert.equal(
    result.some((item) => item.id === "outside-selection"),
    true,
  );
  assert.equal(
    result.some((item) => item.id === "outside-snapshot"),
    true,
  );
  assert.equal(
    result.some((item) => item.id === "visible-99"),
    false,
  );
  assert.equal(bindingScope(["same"], "same", "same").length, 1);
  assert.throws(() => bindingScope([...visible, "overflow"], "", ""));
});

test("failed binding refresh exposes its error instead of loading forever", () => {
  assert.equal(bindingIsLoading("workspace", true, false, "old", "new"), true);
  assert.equal(bindingIsLoading("workspace", false, true, "old", "new"), false);
  assert.equal(bindingIsLoading("workspace", false, false, "same", "same"), false);
  assert.equal(bindingIsLoading("", true, false, "old", "new"), false);
});

test("page lookup is a single request and unrequested or duplicate status is rejected", async () => {
  let calls = 0;
  const page = await loadBoundPage("workspace", "cursor", async (path) => {
    calls++;
    assert.equal(path, "/api/data-sources/workspaces/workspace?after=cursor");
    return { sources: [{ id: "one" }], nextCursor: "next" };
  });
  assert.equal(calls, 1);
  assert.equal(page.nextCursor, "next");
  await assert.rejects(
    loadBindingStatus("workspace", ["a"], async () => ({ sources: [{ id: "other" }] })),
  );
  await assert.rejects(
    loadBindingStatus("workspace", ["a", "b"], async () => ({
      sources: [{ id: "a" }, { id: "a" }],
    })),
  );
  await assert.rejects(loadBindingStatus("workspace", ["a", "a"], async () => ({ sources: [] })));
});
