import { BoundedStdioInput } from "../../dist/stdio-boundary.js";

const mode = process.argv[2];
if (mode === "crash") process.exit(2);
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "oversized") process.stdout.write(`${"x".repeat(65537)}\n`);
else {
  const input = new BoundedStdioInput(1000);
  input.on("error", () => {
    process.exitCode = 2;
    process.stdin.destroy();
  });
  input.on("data", (frame) => {
    if (!frame.toString().trim()) return;
    const value = JSON.parse(frame.toString());
    if (
      value.operation !== "ping" ||
      typeof value.nonce !== "string" ||
      value.nonce.length !== 64
    ) {
      process.exitCode = 2;
      process.stdin.destroy();
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        nonce: value.nonce,
        pid: process.pid,
        parent: process.ppid,
        leaked: Boolean(process.env.DATABASE_URL || process.env.BETTER_AUTH_SECRET),
      })}\n`,
    );
  });
  process.stdin.pipe(input);
}
