import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { BoundedStdioInput } from "../../dist/stdio-boundary.js";

const input = new BoundedStdioInput(Number(process.env.G2_FRAME_TIMEOUT_MS ?? 5000));
input.on("error", () => {
  process.exitCode = 2;
  process.stdin.destroy();
});
process.stdin.pipe(input);
if (process.env.G2_READY_NOTICE === "1") process.stderr.write("G2_STDIO_READY\n");
const transport = new StdioServerTransport(input, process.stdout, { maxBufferSize: 65536 });
let child;
if (process.env.G2_START_DESCENDANT === "1") {
  child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    env: { SystemRoot: process.env.SystemRoot ?? "" },
    stdio: "ignore",
    windowsHide: true,
  });
}
await serveStdio(
  () => {
    const server = new McpServer({ name: "g2-owned-stdio-fixture", version: "0.0.0" });
    server.registerTool("process_info", { inputSchema: z.object({}) }, async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            pid: process.pid,
            descendant: child?.pid,
            leaked: ["DATABASE_URL", "BETTER_AUTH_SECRET", "G2_PARENT_CANARY"].some((key) =>
              Boolean(process.env[key]),
            ),
          }),
        },
      ],
    }));
    return server;
  },
  {
    legacy: process.env.G2_PROTOCOL_PROFILE === "2025-11-25" ? "serve" : "reject",
    transport,
    onerror: () => {
      process.exitCode = 2;
    },
  },
);
