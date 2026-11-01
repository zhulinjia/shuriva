import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the product loads shared foundation, while demo-only styles stay in the demo entry", async () => {
  const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
  const [entry, styles, demo, foundation, demoStyles] = await Promise.all([
    read("main.tsx"),
    read("styles.css"),
    read("App.tsx"),
    read("foundation.css"),
    read("prototype.css"),
  ]);
  assert.match(entry, /\.\/Product/);
  assert.match(styles, /\.\/foundation\.css/);
  assert.doesNotMatch(styles, /\.\/prototype\.css/);
  assert.match(demo, /\.\/prototype\.css/);
  assert.match(foundation, /:root\s*\{/);
  assert.match(foundation, /button:focus-visible/);
  assert.ok(demoStyles.length > 1000);
});
