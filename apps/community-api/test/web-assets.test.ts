import assert from "node:assert/strict";
import {
  appendFile,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import express from "express";
import { validateWebOrigin } from "../src/config.js";
import { mountWebAssets } from "../src/web-assets.js";

const directories: string[] = [],
  servers: Server[] = [];
test("built web requires the explicit listener address and origin to agree", () => {
  validateWebOrigin("http://127.0.0.1:3000", { host: "127.0.0.1", port: 3000 });
  validateWebOrigin("http://[::1]:3000", { host: "::1", port: 3000 });
  for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3001"])
    assert.throws(() => validateWebOrigin(origin, { host: "::1", port: 3000 }), {
      code: "WEB_ORIGIN_INVALID",
    });
});
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "shuriva-web-assets-"));
  directories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><script src="/assets/app-ab12.js"></script>',
  );
  await writeFile(join(directory, "assets/app-ab12.js"), 'document.title="Shuriva";');
  await writeFile(join(directory, ".env"), "SYNTHETIC_MUST_NOT_BE_SERVED");
  return directory;
}
test("built web serves a bounded same-origin allowlist without intercepting API or reading runtime files", async () => {
  const directory = await fixture(),
    app = express(),
    server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  await mountWebAssets(app, directory, origin);
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  const index = await fetch(origin);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(index.headers.get("cache-control"), "no-store");
  assert.match(await index.text(), /app-ab12.js/);
  await writeFile(join(directory, "assets/app-ab12.js"), "CHANGED_AFTER_STARTUP");
  assert.match(await (await fetch(`${origin}/assets/app-ab12.js`)).text(), /Shuriva/);
  for (const path of [
    "/.env",
    "/assets/.env",
    "/assets/app-ab12.js.map",
    "/src/main.ts",
    "/missing-page",
  ]) {
    const result = await fetch(origin + path);
    assert.equal(result.status, 404);
    assert.equal((await result.text()).includes("SYNTHETIC_MUST_NOT_BE_SERVED"), false);
  }
  const unapprovedHost = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(origin, { headers: { host: "unapproved.invalid" } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
  assert.equal(unapprovedHost, 403);
  assert.equal((await fetch(origin, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});
test("web build rejects source maps, nested directories and incomplete index at startup", async () => {
  for (const invalid of ["app.js.map", "nested", "asset.constructor", "asset.__proto__"]) {
    const directory = await fixture();
    if (invalid === "nested") await mkdir(join(directory, "assets", invalid));
    else await writeFile(join(directory, "assets", invalid), "synthetic");
    await assert.rejects(mountWebAssets(express(), directory, "http://127.0.0.1:3000"), {
      code: "WEB_ASSETS_INVALID",
    });
  }
  await assert.rejects(mountWebAssets(express(), "relative", "http://127.0.0.1:3000"), {
    code: "WEB_ASSETS_INVALID",
  });
  const incomplete = await fixture();
  await rm(join(incomplete, "index.html"));
  await assert.rejects(mountWebAssets(express(), incomplete, "http://127.0.0.1:3000"), {
    code: "WEB_ASSETS_INVALID",
  });
});

test("index requires its actual parsed local script, stylesheet and modulepreload resources", async () => {
  for (const html of [
    '<script src="/assets/missing.js"></script>',
    '<script src="/assets/app-ab12.js"></script><link rel="stylesheet" href="/assets/missing.css">',
    '<script src="/assets/app-ab12.js"></script><link rel="modulepreload" href="/assets/missing.js">',
    '<script src="https://other.invalid/app.js"></script>',
    '<!-- <script src="/assets/app-ab12.js"></script> -->',
  ]) {
    const directory = await fixture();
    await writeFile(join(directory, "index.html"), html);
    await assert.rejects(mountWebAssets(express(), directory, "http://127.0.0.1:3000"), {
      code: "WEB_ASSETS_INVALID",
    });
  }
  const directory = await fixture();
  await writeFile(
    join(directory, "index.html"),
    '<script src="/assets/app-ab12&#x2e;js"></script>',
  );
  await mountWebAssets(express(), directory, "http://127.0.0.1:3000");
});

test("file growth during the actual handle read is bounded and rejected", async (t) => {
  const directory = await fixture(),
    asset = join(directory, "assets/app-ab12.js");
  const expected = await lstat(asset, { bigint: true });
  const sample = await open(asset, "r"),
    prototype = Object.getPrototypeOf(sample),
    original = prototype.read;
  await sample.close();
  let changed = false,
    largestRead = 0;
  t.mock.method(
    prototype,
    "read",
    async function (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      if ((await this.stat({ bigint: true })).ino === expected.ino) {
        largestRead = Math.max(largestRead, length);
        if (!changed) {
          changed = true;
          await appendFile(asset, Buffer.alloc(2 * 1048576));
        }
      }
      return original.call(this, buffer, offset, length, position);
    },
  );
  await assert.rejects(mountWebAssets(express(), directory, "http://127.0.0.1:3000"), {
    code: "WEB_ASSETS_INVALID",
  });
  assert.equal(changed, true);
  assert.ok(largestRead <= Number(expected.size) + 1);
});

test("replacing a checked file with an escaping link before reading does not disclose its target", async (t) => {
  const directory = await fixture(),
    asset = join(directory, "assets/app-ab12.js");
  const outside = await mkdtemp(join(tmpdir(), "shuriva-web-outside-"));
  directories.push(outside);
  const target = join(outside, "synthetic.js");
  await writeFile(target, "SYNTHETIC_OUTSIDE_MUST_NOT_BE_READ");
  const expected = await lstat(asset, { bigint: true });
  const sample = await open(asset, "r"),
    prototype = Object.getPrototypeOf(sample),
    original = prototype.stat;
  await sample.close();
  let replaced = false;
  t.mock.method(prototype, "stat", async function (this: FileHandle, options: { bigint: true }) {
    const result = await original.call(this, options);
    if (!replaced && result.ino === expected.ino) {
      replaced = true;
      await rm(asset);
      await symlink(target, asset, "file");
    }
    return result;
  });
  await assert.rejects(mountWebAssets(express(), directory, "http://127.0.0.1:3000"), {
    code: "WEB_ASSETS_INVALID",
  });
  assert.equal(replaced, true);
});
test("web build refuses a directory junction rather than following it", async () => {
  const directory = await fixture(),
    parent = await mkdtemp(join(tmpdir(), "shuriva-web-link-"));
  directories.push(parent);
  const link = join(parent, "build");
  await symlink(directory, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(mountWebAssets(express(), link, "http://127.0.0.1:3000"), {
    code: "WEB_ASSETS_INVALID",
  });
});
