import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseFiles } from "../release-files.mjs";
import { collectLicenses } from "../release-inventory.mjs";
import { cleanReleaseOutputs, createReleaseDirectory } from "../release-workspace.mjs";

test("dependency inventory merges real installed versions, includes notices and omits local paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "shuriva-notices-"));
  try {
    const dependency = join(root, "dep"),
      output = join(root, "output");
    await mkdir(dependency);
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: "synthetic-dependency", version: "1.0.0" }),
    );
    await writeFile(join(dependency, "LICENSE"), "SYNTHETIC LICENSE TEXT");
    const report = join(root, "npm.json"),
      go = join(root, "go.txt");
    await writeFile(report, JSON.stringify({ MIT: [{ paths: [dependency], license: "MIT" }] }));
    await writeFile(
      go,
      `example.invalid/main||${root}\nexample.invalid/module|v1.0.0|${dependency}\n`,
    );
    const summary = await collectLicenses({ npmReports: [report, report], goReport: go, output });
    assert.equal(summary.count, 2);
    assert.deepEqual(summary.missingNotices, []);
    const raw = await readFile(join(output, "licenses.json"), "utf8");
    assert.equal(raw.includes(root), false);
    const inventory = JSON.parse(raw);
    for (const component of inventory.components)
      assert.equal(
        await readFile(join(output, component.notices[0]), "utf8"),
        "SYNTHETIC LICENSE TEXT",
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("artifact inventory rejects private state and escaping links and detects changed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "shuriva-release-")),
    outside = await mkdtemp(join(tmpdir(), "shuriva-outside-"));
  try {
    await writeFile(join(root, "app.js"), "synthetic");
    const first = await releaseFiles(root);
    await writeFile(join(root, "app.js"), "changed");
    assert.notDeepEqual((await releaseFiles(root)).files, first.files);
    for (const name of [
      ".env",
      ".ENV",
      ".Env.local",
      ".Runtime",
      ".Private",
      "client.P12",
      "client.pem",
      "identity.key",
      "identity.keystore",
      "credentials.json",
      "service-account-local.json",
      "backup.sqlite",
      ".envrc",
    ]) {
      await writeFile(join(root, name), "SYNTHETIC_SECRET");
      await assert.rejects(releaseFiles(root), /private content/);
      await rm(join(root, name));
    }
    await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(releaseFiles(root), /links are not portable/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("manifest is validated before exclusion and no internal junction is accepted as portable", async () => {
  const root = await mkdtemp(join(tmpdir(), "shuriva-manifest-")),
    outside = await mkdtemp(join(tmpdir(), "shuriva-manifest-outside-"));
  try {
    await symlink(
      outside,
      join(root, "manifest.json"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(releaseFiles(root), /links are not portable/);
    await rm(join(root, "manifest.json"));
    await mkdir(join(root, "internal"));
    await symlink(
      join(root, "internal"),
      join(root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(releaseFiles(root), /links are not portable/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("release output rejects ancestor junctions before writing and fresh builds cannot retain emitted orphans", async () => {
  const root = await mkdtemp(join(tmpdir(), "shuriva-release-workspace-")),
    outside = await mkdtemp(join(tmpdir(), "shuriva-release-cache-"));
  try {
    await symlink(outside, join(root, ".cache"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(createReleaseDirectory(root), /ancestors/);
    await assert.rejects(readFile(join(outside, "releases")), { code: "ENOENT" });
    await rm(join(root, ".cache"));
    const output = await createReleaseDirectory(root);
    assert.ok(output.startsWith(join(root, ".cache", "releases")));
    await mkdir(join(root, "apps/community-api/dist/src"), { recursive: true });
    await writeFile(join(root, "apps/community-api/dist/src/deleted-module.js"), "stale");
    await cleanReleaseOutputs(root);
    await assert.rejects(readFile(join(root, "apps/community-api/dist/src/deleted-module.js")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("compound notices and exact version/hash/declaration supplements are preserved without guessing", async () => {
  const root = await mkdtemp(join(tmpdir(), "shuriva-license-binding-"));
  try {
    const dep = join(root, "dep");
    await mkdir(dep);
    await writeFile(
      join(dep, "package.json"),
      JSON.stringify({ name: "synthetic-native", version: "1.0.0", license: "MIT" }),
    );
    await writeFile(join(dep, "LICENSE.third-party.md"), "SYNTHETIC COMPOUND NOTICE");
    const report = join(root, "npm.json"),
      go = join(root, "go.txt");
    await writeFile(report, JSON.stringify({ MIT: [{ paths: [dep], license: "MIT" }] }));
    await writeFile(go, "");
    assert.deepEqual(
      (
        await collectLicenses({
          npmReports: [report],
          goReport: go,
          output: join(root, "compound"),
        })
      ).missingNotices,
      [],
    );
    await rm(join(dep, "LICENSE.third-party.md"));
    const text = "SYNTHETIC VERSION BOUND LICENSE",
      supplement = join(root, "supplements.json");
    await writeFile(join(root, "notice.txt"), text);
    const { createHash } = await import("node:crypto");
    const entry = {
      ecosystem: "npm",
      name: "synthetic-native",
      version: "1.0.0",
      license: "MIT",
      file: "notice.txt",
      sha256: createHash("sha256").update(text).digest("hex"),
      source: "https://example.invalid/commit/LICENSE",
    };
    await writeFile(
      supplement,
      JSON.stringify({ format: "shuriva-license-supplements-v1", components: [entry] }),
    );
    assert.deepEqual(
      (
        await collectLicenses({
          npmReports: [report],
          goReport: go,
          output: join(root, "supplemented"),
          supplementsFile: supplement,
        })
      ).missingNotices,
      [],
    );
    await writeFile(join(root, "notice.txt"), "TAMPERED");
    await assert.rejects(
      collectLicenses({
        npmReports: [report],
        goReport: go,
        output: join(root, "tampered"),
        supplementsFile: supplement,
      }),
      /checksum mismatch/,
    );
    await writeFile(join(root, "notice.txt"), text);
    await writeFile(
      join(dep, "package.json"),
      JSON.stringify({ name: "synthetic-native", version: "1.0.0", license: "Apache-2.0" }),
    );
    await assert.rejects(
      collectLicenses({
        npmReports: [report],
        goReport: go,
        output: join(root, "wrong-declaration"),
        supplementsFile: supplement,
      }),
      /declaration mismatch/,
    );
    await writeFile(
      join(dep, "package.json"),
      JSON.stringify({ name: "synthetic-native", version: "2.0.0", license: "MIT" }),
    );
    const differentVersion = await collectLicenses({
      npmReports: [report],
      goReport: go,
      output: join(root, "wrong-version"),
      supplementsFile: supplement,
    });
    assert.deepEqual(differentVersion.missingNotices, [
      { ecosystem: "npm", name: "synthetic-native", version: "2.0.0" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Go standard-library and actually compiled vendored module notices join the module inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "shuriva-go-notices-"));
  try {
    await writeFile(join(root, "LICENSE"), "SYNTHETIC GO LICENSE");
    const vendor = join(root, "src/vendor"),
      module = join(vendor, "example.invalid/lib");
    await mkdir(join(module, "pkg"), { recursive: true });
    await writeFile(join(module, "LICENSE"), "SYNTHETIC VENDORED LICENSE");
    await writeFile(join(module, "PATENTS"), "SYNTHETIC PATENT NOTICE");
    await writeFile(
      join(vendor, "modules.txt"),
      "# example.invalid/lib v1.2.3\n## explicit\nexample.invalid/lib/pkg\n",
    );
    const go = join(root, "go.txt"),
      toolchain = join(root, "toolchain.json"),
      output = join(root, "output");
    await writeFile(go, "");
    await writeFile(
      toolchain,
      JSON.stringify({
        root,
        version: "go1.26.0",
        standardPackages: `vendor/example.invalid/lib/pkg|${join(module, "pkg")}`,
      }),
    );
    const summary = await collectLicenses({
      npmReports: [],
      goReport: go,
      goToolchainReport: toolchain,
      output,
    });
    assert.equal(summary.count, 2);
    assert.deepEqual(summary.missingNotices, []);
    const raw = await readFile(join(output, "licenses.json"), "utf8"),
      saved = JSON.parse(raw);
    assert.equal(raw.includes(root), false);
    assert.equal(
      saved.components.find((x) => x.ecosystem === "go-toolchain-vendor").notices.length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual deployed packages include native optional and nested versions without virtual path assumptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "shuriva-deployed-licenses-"));
  try {
    const packages = [
      ["node_modules/native-optional", "native-optional", "1.0.0"],
      ["node_modules/@scope/library", "@scope/library", "2.0.0"],
      ["node_modules/@scope/library/node_modules/native-optional", "native-optional", "0.9.0"],
    ];
    for (const [path, name, version] of packages) {
      const directory = join(root, path);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name, version, license: "MIT" }),
      );
      await writeFile(
        join(directory, "LICENSE.third-party.md"),
        "SYNTHETIC ACTUAL PACKAGE LICENSE",
      );
    }
    const go = join(root, "go.txt");
    await writeFile(go, "");
    const result = await collectLicenses({
      npmReports: [],
      deployedNpmRoots: [root],
      goReport: go,
      output: join(root, "output"),
    });
    assert.equal(result.count, 3);
    assert.deepEqual(result.missingNotices, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
