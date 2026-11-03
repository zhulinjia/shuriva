import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, realpath, access, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { installProgram } from "../src/mcp-client/programs.js";
import { apiPackageRoot } from "../src/package-path.js";
import { externalFixture } from "./external-mcp-fixture.js";

// Explicit operator opt-in; never downloads packages or uses a user's MCP configuration.
test("G5 selected Memory Server package is approved and called through the owned process boundary", {
  skip: process.env.STAGE9_G5_MEMORY_TEST !== "1" || process.platform !== "win32",
}, async () => {
  const packagePath = process.env.G5_MEMORY_PACKAGE_DIR;
  if (!packagePath || !isAbsolute(packagePath))
    throw Error("G5_MEMORY_PACKAGE_DIR must be absolute");
  const official = await realpath(packagePath);
  const metadataPath = join(official, "package.json");
  const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("name" in metadata) ||
    metadata.name !== "@modelcontextprotocol/server-memory" ||
    !("version" in metadata) ||
    metadata.version !== "2.0.1" ||
    !("license" in metadata) ||
    metadata.license !== "SEE LICENSE IN LICENSE"
  )
    throw Error("expected official Memory Server 2.0.1 package metadata");
  const readme = await readFile(join(official, "README.md"), "utf8");
  if (!readme.includes("This MCP server is licensed under the MIT License"))
    throw Error("expected upstream MIT license statement");
  const workspace = resolve(apiPackageRoot(), "../..");
  if ((await realpath(process.cwd())).toLowerCase() !== workspace.toLowerCase())
    throw Error("run this isolated test from the workspace root");

  const f = await externalFixture();
  try {
    const source = join(f.root, "official-memory-source");
    const graphPath = join(f.root, "synthetic-empty-graph.jsonl");
    await mkdir(source);
    // A bundle is required by the existing execution host. The operator must
    // select a trusted package: metadata alone does not authenticate its origin.
    const fromWeb = createRequire(resolve(apiPackageRoot(), "../community-web/package.json"));
    const fromVite = createRequire(await realpath(fromWeb.resolve("vite")));
    const { build } = fromVite("esbuild") as { build(options: unknown): Promise<unknown> };
    await build({
      entryPoints: [join(official, "dist/index.js")],
      outfile: join(source, "entry.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: {
        js: "import {createRequire as __fixtureRequire} from 'node:module';const require=__fixtureRequire(import.meta.url);",
      },
    });
    // The upstream server reads its own package version at startup.
    await copyFile(metadataPath, join(source, "package.json"));
    await writeFile(
      join(source, "mcp-package.json"),
      JSON.stringify({
        name: "Official MCP Memory 2.0.1",
        entry: "entry.mjs",
        secretEnvironment: ["MEMORY_FILE_PATH"],
      }),
    );
    const programId = await installProgram(
      source,
      f.service.config.programRoot,
      f.service.config.hostExecutable,
    );
    const { id } = await f.service.create(f.identity, {
      workspaceId: f.binding.workspaceId,
      name: "Official synthetic memory",
      config: { kind: "stdio", programId },
    });
    let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
    const installed = await f.service.catalog.inspect(programId);
    await f.service.approveProgram(c, f.identity, installed.installationHash);
    c = await f.service.connection(f.identity, f.binding.workspaceId, id);
    await f.service.credentials(c, f.identity, { environment: { MEMORY_FILE_PATH: graphPath } });
    c = await f.service.connection(f.identity, f.binding.workspaceId, id);
    await f.service.approveProgram(c, f.identity, installed.installationHash);
    c = await f.service.connection(f.identity, f.binding.workspaceId, id);
    await f.service.discover(c, f.identity);
    c = await f.service.connection(f.identity, f.binding.workspaceId, id);
    assert.equal(c.snapshot.length, 9);
    assert.ok(c.snapshot.some((tool) => tool.name === "read_graph"));
    await assert.rejects(
      f.service.invocations.prepare(c, f.identity, "read_graph", {}),
      /TOOL_NOT_APPROVED/,
    );
    await f.service.approve(c, f.identity, c.snapshotHash ?? assert.fail("missing snapshot"), [
      "read_graph",
    ]);
    c = await f.service.connection(f.identity, f.binding.workspaceId, id);
    const q = await f.service.invocations.prepare(c, f.identity, "read_graph", {});
    const confirmations = await Promise.allSettled([
      f.service.invocations.confirm(c, f.identity, q.id),
      f.service.invocations.confirm(c, f.identity, q.id),
    ]);
    assert.equal(confirmations.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(confirmations.filter((item) => item.status === "rejected").length, 1);
    let state = "";
    for (let i = 0; i < 160; i++) {
      state =
        (await f.service.invocations.history(c, f.identity)).find((row) => row.id === q.id)
          ?.state ?? "";
      if (state && !["pending_approval", "running", "cancel_requested"].includes(state)) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(state, "succeeded");
    const response = await f.request(`${f.base}/${id}/calls/${q.id}/result`);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(JSON.parse(value.result.content[0].text), { entities: [], relations: [] });
    await assert.rejects(access(graphPath), { code: "ENOENT" });
    await f.service.disconnect(id);
    assert.equal(f.service.health().physical, 0);
  } finally {
    await f.close();
  }
});
