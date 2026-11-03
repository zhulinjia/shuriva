import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { NativeStdioTransport } from "../src/mcp-client/native-stdio.js";
import { fileHash } from "../src/mcp-client/program-files.js";
import { ownedStdio } from "../src/mcp-client/stdio.js";
import { apiPackageRoot } from "../src/package-path.js";
import { packageFixture } from "./external-program-fixture.js";

test("G4 natural process exit delivers all buffered stdout before transport close", {
  timeout: 10000,
}, async (t) => {
  const transport = new NativeStdioTransport({
    command: process.execPath,
    args: [
      "-e",
      "const lines=Array.from({length:10},(_,id)=>JSON.stringify({jsonrpc:'2.0',id,result:{data:'x'.repeat(32000)}})).join(String.fromCharCode(10))+String.fromCharCode(10);process.stdout.write(lines,()=>process.exit(0));",
    ],
    cwd: apiPackageRoot(),
    env: { SYSTEMROOT: process.env.SystemRoot ?? "" },
  });
  t.after(() => transport.close());
  let messages = 0;
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => {
      assert.equal(messages, 10);
      resolve();
    };
  });
  transport.onmessage = () => {
    messages++;
  };
  transport.onerror = () => {};
  await transport.start();
  await closed;
  assert.equal(messages, 10);
});

test("G4 official SDK stdio is pinned, minimal-env and descendant-owned; extra/modified package files are refused", {
  skip:
    process.env.STAGE9_G4_TEST !== "1" || process.platform !== "win32" || process.arch !== "x64",
  timeout: 30000,
}, async (t) => {
  const f = await packageFixture();
  t.after(() => f.close());
  const program = await f.catalog.inspect(f.id);
  const old = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "synthetic-parent-canary";
  t.after(() => {
    if (old === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = old;
  });
  const owned = await ownedStdio(
    program,
    { environment: { MCP_TEST_KEY: "synthetic" } },
    join(f.root, "runs"),
    async (send) => send(() => {}, AbortSignal.timeout(5000)),
  );
  t.after(() => owned.close().catch(() => {}));
  const client = new Client(
    { name: "owned-client", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(owned.transport, { timeout: 10000 });
  const tool = (await client.listTools()).tools[0];
  assert.equal(tool?.name, "process_info");
  const result = await client.callTool({ name: "process_info", arguments: {} });
  const item = result.content[0];
  assert.ok(item && item.type === "text");
  const info = JSON.parse(item.text);
  assert.equal(info.hostParent, owned.transport.pid);
  assert.equal(info.leaked, false);
  assert.equal(info.configured, true);
  process.kill(info.pid, 0);
  process.kill(info.child, 0);
  await assert.rejects(
    writeFile(join(f.catalog.root, f.id, "entry.mjs"), "// changed while active"),
  );
  await owned.close();
  assert.throws(() => process.kill(info.pid, 0));
  assert.throws(() => process.kill(info.child, 0));
  const folder = resolve(f.catalog.root, f.id);
  await writeFile(join(folder, "additional.mjs"), "export{}");
  await assert.rejects(f.catalog.inspect(f.id), /PROGRAM_CHANGED/);
  await rm(join(folder, "additional.mjs"));
  await writeFile(join(folder, "entry.mjs"), "// changed");
  await assert.rejects(f.catalog.inspect(f.id), /PROGRAM_CHANGED/);
});
test("G4 parent crash reclaims its target and descendant even when child input is backpressured", {
  skip: process.env.STAGE9_G4_TEST !== "1" || process.platform !== "win32",
  timeout: 30000,
}, async (t) => {
  const f = await packageFixture();
  t.after(() => f.close());
  const script = `import {Client} from ${JSON.stringify(pathToFileURL(resolve(apiPackageRoot(), "node_modules/@modelcontextprotocol/client/dist/index.mjs")).href)};import {ProgramCatalog} from ${JSON.stringify(pathToFileURL(resolve(apiPackageRoot(), "dist/src/mcp-client/programs.js")).href)};import {ownedStdio} from ${JSON.stringify(pathToFileURL(resolve(apiPackageRoot(), "dist/src/mcp-client/stdio.js")).href)};const[folder,id,host,runs]=process.argv.slice(1);const p=await new ProgramCatalog(folder,host).inspect(id);const owned=await ownedStdio(p,{},runs,send=>send(()=>{},AbortSignal.timeout(5000)));const c=new Client({name:'crash-fixture',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await c.connect(owned.transport);const r=await c.callTool({name:'process_info',arguments:{}});const info=JSON.parse(r.content[0].text);info.host=owned.transport.pid;await c.callTool({name:'pause_input',arguments:{}});void (async()=>{for(const i of [1,2,3])await owned.transport.send({jsonrpc:'2.0',method:'notifications/synthetic',params:{padding:'x'.repeat(60000)}});})().catch(()=>{});await new Promise(r=>setTimeout(r,200));process.stdout.write(JSON.stringify(info)+String.fromCharCode(10));setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      f.catalog.root,
      f.id,
      f.catalog.host,
      join(f.root, "runs"),
    ],
    {
      env: { SYSTEMROOT: process.env.SystemRoot ?? "" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill());
  let output = "",
    failure = "";
  child.stderr.on("data", (b) => {
    if (failure.length < 512) failure += String(b);
  });
  const info = await new Promise<{ pid: number; child: number; host: number }>((yes, no) => {
    const timer = setTimeout(() => no(Error(`crash fixture not ready ${failure}`)), 15000);
    child.stdout.on("data", (b) => {
      output += String(b);
      const line = output.split("\n")[0];
      if (line && output.includes("\n")) {
        clearTimeout(timer);
        try {
          yes(JSON.parse(line));
        } catch {
          no(Error("invalid fixture notice"));
        }
      }
    });
    child.once("error", no);
    child.once("exit", () => {
      if (!output) no(Error(`fixture exited before notice ${failure}`));
    });
  });
  child.kill();
  await new Promise<void>((r) => {
    if (child.exitCode !== null) r();
    else child.once("exit", () => r());
  });
  let alive = true;
  for (let i = 0; i < 80; i++) {
    alive = [info.pid, info.child, info.host].some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(alive, false);
});

test("G4 malformed program output still acknowledges proven descendant cleanup", {
  skip: process.env.STAGE9_G4_TEST !== "1" || process.platform !== "win32",
  timeout: 20000,
}, async (t) => {
  const f = await packageFixture(
    "setTimeout(()=>process.stdout.write('not-json'+String.fromCharCode(10)),200);setInterval(()=>{},1000);",
  );
  t.after(() => f.close());
  const program = await f.catalog.inspect(f.id),
    owned = await ownedStdio(program, {}, join(f.root, "runs"), (send) =>
      send(() => {}, AbortSignal.timeout(5000)),
    );
  owned.transport.onerror = () => {};
  t.after(() => owned.close().catch(() => {}));
  await owned.transport.start();
  await new Promise((r) => setTimeout(r, 500));
  await owned.close();
});

test("G4 an aborted physical lease terminates its own job while forwarding is blocked", {
  skip: process.env.STAGE9_G4_TEST !== "1" || process.platform !== "win32",
  timeout: 25000,
}, async (t) => {
  const f = await packageFixture(),
    lease = new AbortController();
  let owned: Awaited<ReturnType<typeof ownedStdio>> | undefined;
  let client: Client | undefined;
  t.after(async () => {
    await owned?.close().catch(() => {});
    await client?.close();
    await f.close();
  });
  const p = await f.catalog.inspect(f.id);
  owned = await ownedStdio(p, {}, join(f.root, "runs"), (send) =>
    send(() => lease.signal.throwIfAborted(), lease.signal),
  );
  client = new Client(
    { name: "lease-stop-fixture", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(owned.transport);
  const result = await client.callTool({ name: "process_info", arguments: {} });
  const item = result.content[0];
  assert.ok(item && item.type === "text");
  const info = JSON.parse(item.text);
  await client.callTool({ name: "pause_input", arguments: {} });
  const transport = owned.transport;
  const forwarding = (async () => {
    for (let i = 0; i < 3; i++)
      await transport.send({
        jsonrpc: "2.0",
        method: "notifications/synthetic",
        params: { padding: "x".repeat(60000) },
      });
  })();
  const rejected = assert.rejects(forwarding);
  await new Promise((r) => setTimeout(r, 100));
  lease.abort();
  await rejected;
  let live = true;
  for (let i = 0; i < 50; i++) {
    live = [info.pid, info.child].some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!live) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(live, false);
  await owned.close();
});

test("G4 a proven CreateProcess refusal does not leave unknown cleanup", {
  skip: process.env.STAGE9_G4_TEST !== "1" || process.platform !== "win32",
  timeout: 20000,
}, async (t) => {
  const f = await packageFixture();
  let owned: Awaited<ReturnType<typeof ownedStdio>> | undefined;
  t.after(async () => {
    await owned?.close().catch(() => {});
    await f.close();
  });
  const node = join(f.root, "not-an-image.exe");
  await writeFile(node, "synthetic invalid executable", { flag: "wx" });
  const p = await f.catalog.inspect(f.id);
  owned = await ownedStdio(
    { ...p, node, nodeHash: (await fileHash(node)).sha256 },
    {},
    join(f.root, "runs"),
    (send) => send(() => {}, AbortSignal.timeout(5000)),
  );
  owned.transport.onerror = () => {};
  await assert.rejects(owned.transport.start(), /START_FAILED|PROCESS_CREATE_FAILED/);
  await owned.close();
});

test("G4 cancellation after target creation but before resume still proves job cleanup", {
  skip: process.env.STAGE9_G4_TEST !== "1" || process.platform !== "win32",
  timeout: 20000,
}, async (t) => {
  const f = await packageFixture(
    "import {writeFileSync} from 'node:fs';writeFileSync('executed','unexpected');setInterval(()=>{},1000);",
  );
  let owned: Awaited<ReturnType<typeof ownedStdio>> | undefined;
  const lease = new AbortController();
  t.after(async () => {
    await owned?.close().catch(() => {});
    await f.close();
  });
  const p = await f.catalog.inspect(f.id);
  owned = await ownedStdio(p, {}, join(f.root, "runs"), (send) =>
    send(() => {
      if (owned && existsSync(join(owned.run, "ready"))) lease.abort();
      lease.signal.throwIfAborted();
    }, lease.signal),
  );
  owned.transport.onerror = () => {};
  await assert.rejects(owned.transport.start());
  assert.equal(existsSync(join(owned.run, "executed")), false);
  await owned.close();
});

test("G4 native rejected spawn has no published process identity or implicit shell", {
  skip: process.env.STAGE9_G4_TEST !== "1",
}, async (t) => {
  const f = await packageFixture();
  t.after(() => f.close());
  const transport = new NativeStdioTransport({
    command: join(f.root, "missing-host.exe"),
    env: { SYSTEMROOT: process.env.SystemRoot ?? "" },
    args: [],
    cwd: f.root,
  });
  transport.onerror = () => {};
  await assert.rejects(transport.start(), { code: "ENOENT" });
  assert.equal(transport.pid, null);
  await transport.close();
});
