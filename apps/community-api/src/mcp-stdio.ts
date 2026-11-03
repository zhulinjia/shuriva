import { loadLocalCredential } from "./mcp/local-vault.js";
import { startLocalStdio } from "./mcp/local-stdio.js";

try {
  if (process.argv.length !== 3) throw Error("MCP_LOCAL_REFERENCE_REQUIRED");
  const runtime = await startLocalStdio(
    loadLocalCredential(process.argv[2] ?? ""),
    process.stdin,
    process.stdout,
  );
  process.once("SIGINT", () => {
    void runtime.close();
  });
  process.once("SIGTERM", () => {
    void runtime.close();
  });
} catch {
  process.stderr.write(
    "MCP_LOCAL_UNAVAILABLE: check the approved local credential reference and its expiry.\n",
  );
  process.exitCode = 1;
}
