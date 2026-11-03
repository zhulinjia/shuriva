import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

// Test-only transparent relay. Only fixed method names, protocol versions,
// child PID, and boolean outcomes are retained; payloads are never logged.
const [entry, reference, trace] = process.argv.slice(2);
if (!entry || !reference || !trace) throw Error("synthetic relay arguments required");
const child = spawn(process.execPath, [entry, reference], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { SystemRoot: process.env.SystemRoot ?? "" },
});
const buffers = ["", ""],
  pending = new Map();
const methods = new Set(["server/discover", "subscriptions/listen", "tools/list", "tools/call"]);
let written = 0,
  overflow = false;
function overflowed() {
  if (overflow) return;
  overflow = true;
  appendFileSync(trace, `${JSON.stringify({ event: "trace_overflow" })}\n`);
}
function record(value) {
  if (written++ < 100) appendFileSync(trace, `${JSON.stringify(value)}\n`);
  else overflowed();
}
function versions(message) {
  return (JSON.stringify(message).match(/[0-9]{4}-[0-9]{2}-[0-9]{2}/g) ?? []).slice(0, 4);
}
record({ event: "child_started", pid: child.pid, relayPid: process.pid });
function inspect(index, chunk) {
  buffers[index] += chunk.toString("utf8");
  if (buffers[index].length > 1048576) {
    overflowed();
    buffers[index] = "";
    return;
  }
  const lines = buffers[index].split("\n");
  buffers[index] = lines.pop();
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (index === 0) {
      record({
        event: "client_method",
        method: methods.has(message.method) ? message.method : "other",
      });
      if (message.method === "server/discover") {
        pending.set(message.id, "discover");
        record({ event: "discover", versions: versions(message) });
      } else if (message.method === "tools/call") {
        pending.set(message.id, "call");
        record({
          event: "call",
          tool: message.params?.name === "workspaces_list" ? "workspaces_list" : "other",
        });
      }
    } else if (pending.has(message.id)) {
      const kind = pending.get(message.id);
      pending.delete(message.id);
      if (kind === "discover") record({ event: "discover_result", versions: versions(message) });
      else record({ event: "call_result", ok: !message.error && !message.result?.isError });
    }
  }
}
process.stdin.on("data", (chunk) => inspect(0, chunk));
child.stdout.on("data", (chunk) => inspect(1, chunk));
child.stdin.on("error", () => {});
process.stdout.on("error", () => child.kill());
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.on("SIGTERM", () => child.kill());
child.once("error", () => {
  process.exitCode = 1;
  process.stdin.destroy();
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
  process.stdin.destroy();
});
