import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./stdio-server.mjs", import.meta.url))],
  env: { SystemRoot: process.env.SystemRoot ?? "", G2_START_DESCENDANT: "1" },
  stderr: "pipe",
  maxBufferSize: 65536,
});
const client = new Client(
  { name: "g2-job-client", version: "0.0.0" },
  {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  },
);
let phase = "connect";
process.on("exit", (code) =>
  writeFileSync(
    `${process.env.G2_JOB_METADATA}.diagnostic.json`,
    JSON.stringify({ phase, code, client: process.pid, server: transport.pid }),
  ),
);
await client.connect(transport);
phase = "call";
const result = await client.callTool({ name: "process_info", arguments: {} });
const info = JSON.parse(result.content[0].text);
await writeFile(
  process.env.G2_JOB_METADATA,
  JSON.stringify({
    worker: process.ppid,
    client: process.pid,
    server: info.pid,
    descendant: info.descendant,
  }),
  { flag: "wx" },
);
phase = "ready";
if (process.env.G2_JOB_MODE === "graceful") await client.close();
else setInterval(() => {}, 1000);
