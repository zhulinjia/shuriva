import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "win32") throw Error("MCP host currently requires Windows/amd64");
await mkdir(resolve(root, "apps/community-api/bin"), { recursive: true });
await promisify(execFile)(
  "go",
  [
    "build",
    "-trimpath",
    "-o",
    resolve(root, "apps/community-api/bin/mcp-host.exe"),
    "./cmd/mcp-host",
  ],
  {
    cwd: resolve(root, "connector/go"),
    env: { ...process.env, GOARCH: "amd64", GOOS: "windows", CGO_ENABLED: "0" },
    windowsHide: true,
  },
);
console.log("Built Windows/amd64 owned MCP host");
