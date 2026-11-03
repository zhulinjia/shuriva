import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ExternalDriver, ResolverBudget } from "../src/mcp-client/driver.js";
import type { ExternalConfig } from "../src/mcp-client/config.js";
import type { ExternalLease } from "../src/mcp-client/lease.js";
import type { Connection } from "../src/mcp-client/model.js";
import type { ClientVault } from "../src/mcp-client/vault.js";
import { digest } from "../src/mcp-client/tool-policy.js";
import { packageFixture } from "./external-program-fixture.js";

const enabled = process.env.STAGE9_G4_TEST === "1" && process.platform === "win32";
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function observe(predicate: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await pause(10);
  }
  assert.fail("owned stdio event was not observed");
}

async function stdioFixture(listChanged = true, acknowledge = true) {
  const f = await packageFixture(String.raw`
import {existsSync,readFileSync,unlinkSync,appendFileSync} from 'node:fs';
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
const control=process.env.MCP_TEST_KEY;
const transport=new StdioServerTransport();
const originalSend=transport.send.bind(transport);
transport.send=(message,options)=>{
  if(!${acknowledge}&&message.method==='notifications/subscriptions/acknowledged')return Promise.resolve();
  return originalSend(message,options);
};
let server;
const handle=serveStdio(()=>{
  server=new McpServer({name:'stdio-subscription-fixture',version:'1'},
    {capabilities:{tools:{listChanged:${listChanged}}}});
  server.registerTool('echo',{inputSchema:z.strictObject({})},async()=>{
    appendFileSync(control+'.called','called\n');
    await new Promise(done=>setTimeout(done,5000));
    return {content:[{type:'text',text:'synthetic'}]};
  });
  return server;
},{legacy:'reject',transport});
setInterval(()=>{
  if(!server||!existsSync(control))return;
  const command=readFileSync(control,'utf8');unlinkSync(control);
  if(command==='change')void server.sendToolListChanged();
  if(command==='close')void handle.close();
},10);
`);
  const control = join(f.root, "synthetic-control");
  const program = await f.catalog.inspect(f.id);
  const connection = {
    id: randomUUID(),
    credentialRef: randomUUID(),
    installationHash: program.installationHash,
    config: {
      kind: "stdio",
      programId: f.id,
      connectTimeoutMs: acknowledge ? 10000 : 1000,
      callTimeoutMs: 10000,
    },
  } as Connection;
  const lease = {
    async run(
      _c: unknown,
      _who: unknown,
      work: (check: () => void, signal: AbortSignal, remaining: () => number) => Promise<unknown>,
    ) {
      return work(
        () => {},
        new AbortController().signal,
        () => 5000,
      );
    },
  } as unknown as ExternalLease;
  const driver = new ExternalDriver(
    connection,
    { runRoot: join(f.root, "runs") } as ExternalConfig,
    {
      has: () => true,
      get: () => ({ environment: { MCP_TEST_KEY: control } }),
    } as unknown as ClientVault,
    lease,
    new ResolverBudget(),
    f.catalog,
  );
  const who = { ownerId: randomUUID(), sessionId: randomUUID() };
  const run = <T>(work: () => Promise<T>) =>
    driver.within({ who, signal: AbortSignal.timeout(15000), check() {} }, work, async () => {});
  return {
    driver,
    control,
    run,
    async close() {
      await driver.close();
      await f.close();
    },
  };
}

test("real owned stdio rejects an unhonored subscription before any tool discovery", {
  skip: !enabled,
  timeout: 30000,
}, async () => {
  const f = await stdioFixture(false);
  try {
    await assert.rejects(
      f.run(() => f.driver.discover()),
      /SUBSCRIPTION_UNAVAILABLE/,
    );
    assert.equal(existsSync(`${f.control}.called`), false);
  } finally {
    await f.close();
  }
});

test("real owned stdio subscription acknowledgment wait is bounded", {
  skip: !enabled,
  timeout: 30000,
}, async () => {
  const f = await stdioFixture(true, false);
  try {
    const started = performance.now();
    await assert.rejects(
      f.run(() => f.driver.discover()),
      /NETWORK_FAILED/,
    );
    assert.ok(performance.now() - started < 7000);
    assert.equal(existsSync(`${f.control}.called`), false);
  } finally {
    await f.close();
  }
});

test("real owned stdio changes and connection loss before local handoff cannot invoke", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  for (const command of ["change", "close"] as const) {
    await t.test(command, async () => {
      const f = await stdioFixture();
      try {
        const tools = await f.run(() => f.driver.discover());
        const [tool] = tools;
        assert.ok(tool && tool.status === "available");
        const hash = digest(tools);
        f.driver.verifySnapshot(hash);
        let handoffs = 0;
        await writeFile(f.control, command);
        await observe(() => {
          try {
            f.driver.verifySnapshot(hash);
          } catch {
            return true;
          }
          return false;
        });
        // The observed driver fact, rather than the control-file write, denies the call.
        await assert.rejects(
          f.run(() =>
            f.driver.call(tool, {}, undefined, () => {
              handoffs++;
            }),
          ),
          /SNAPSHOT_CHANGED|NETWORK_FAILED|NOT_CONNECTED|CLOSED/,
        );
        assert.equal(handoffs, 0);
        assert.equal(existsSync(`${f.control}.called`), false);
      } finally {
        await f.close();
      }
    });
  }
});

test("real owned stdio tool change after local handoff aborts once without replay", {
  skip: !enabled,
  timeout: 30000,
}, async () => {
  const f = await stdioFixture();
  try {
    const tools = await f.run(() => f.driver.discover());
    const [tool] = tools;
    assert.ok(tool && tool.status === "available");
    let handoffs = 0;
    const call = f.run(() =>
      f.driver.call(tool, {}, undefined, () => {
        handoffs++;
      }),
    );
    const rejected = assert.rejects(call, /SNAPSHOT_CHANGED|NETWORK_FAILED|CLOSED/);
    void rejected.catch(() => {});
    await observe(() => existsSync(`${f.control}.called`));
    await writeFile(f.control, "change");
    await observe(() => {
      try {
        f.driver.verifySnapshot(digest(tools));
        return false;
      } catch {
        return true;
      }
    });
    await rejected;
    assert.equal(handoffs, 1);
    await pause(1100);
    assert.equal(await readFile(`${f.control}.called`, "utf8"), "called\n");
  } finally {
    await f.close();
  }
});
