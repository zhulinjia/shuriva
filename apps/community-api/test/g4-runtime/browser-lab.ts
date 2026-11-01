/** Explicit manual-browser fixture; no public test-control HTTP endpoints. */
import { createInterface } from "node:readline";
import { g4Runtime, origin } from "./runtime.js";
const runtime = await g4Runtime();
const input = createInterface({ input: process.stdin });
process.stdout.write(
  `${JSON.stringify({ ready: true, origin, username: runtime.username, password: runtime.password })}\n`,
);
try {
  for await (const line of input) {
    const command = JSON.parse(line) as { action: string; data?: string };
    if (command.action === "stop") break;
    const result =
      command.action === "observe"
        ? await runtime.observe()
        : command.action === "restart"
          ? await runtime.restart()
          : await runtime.command(command.action, command.data);
    process.stdout.write(`${JSON.stringify({ action: command.action, result: result ?? "ok" })}\n`);
  }
} finally {
  input.close();
  await runtime.close();
}
