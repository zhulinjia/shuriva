import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { installProgram, ProgramCatalog } from "../src/mcp-client/programs.js";
import { apiPackageRoot } from "../src/package-path.js";
export async function packageFixture(override?: string) {
  const root = resolve(apiPackageRoot(), "../../.cache", `mcp-owned-${randomUUID()}`),
    source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ type: "module" }));
  const fromWeb = createRequire(join(apiPackageRoot(), "../community-web/package.json"));
  const vite = fromWeb.resolve("vite");
  const fromVite = createRequire(await realpath(vite));
  const { build } = fromVite("esbuild") as { build(options: unknown): Promise<unknown> };
  await build({
    stdin: {
      contents:
        override ??
        `import {spawn} from 'node:child_process';import {McpServer} from '@modelcontextprotocol/server';import {StdioServerTransport,serveStdio} from '@modelcontextprotocol/server/stdio';import {z} from 'zod';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});await serveStdio(()=>{const s=new McpServer({name:'owned-fixture',version:'1'});s.registerTool('process_info',{inputSchema:z.strictObject({})},async()=>({content:[{type:'text',text:JSON.stringify({pid:process.pid,hostParent:process.ppid,child:child.pid,leaked:['DATABASE_URL','BETTER_AUTH_SECRET','NODE_OPTIONS','SHURIVA_MCP_ENV'].some(k=>Boolean(process.env[k])),configured:process.env.MCP_TEST_KEY==='synthetic'})}]}));s.registerTool('pause_input',{inputSchema:z.strictObject({})},async()=>{process.stdin.pause();return{content:[{type:'text',text:'paused'}]};});return s;},{legacy:'reject',transport:new StdioServerTransport(process.stdin,process.stdout)});`,
      resolveDir: apiPackageRoot(),
      sourcefile: "synthetic-mcp.mjs",
    },
    outfile: join(source, "entry.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: "import {createRequire as __fixtureRequire} from 'node:module';const require=__fixtureRequire(import.meta.url);",
    },
  });
  await writeFile(
    join(source, "mcp-package.json"),
    JSON.stringify({
      name: "Synthetic owned fixture",
      entry: "entry.mjs",
      secretEnvironment: ["MCP_TEST_KEY"],
    }),
  );
  const catalogRoot = join(root, "programs"),
    id = await installProgram(source, catalogRoot, resolve(apiPackageRoot(), "bin/mcp-host.exe")),
    catalog = new ProgramCatalog(catalogRoot, resolve(apiPackageRoot(), "bin/mcp-host.exe"));
  return {
    root,
    source,
    id,
    catalog,
    close: async () => {
      if (
        dirname(await realpath(root)).toLowerCase() !==
        resolve(apiPackageRoot(), "../../.cache").toLowerCase()
      )
        throw Error("fixture cleanup path rejected");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
