import { resolve } from "node:path";
import { installProgram } from "./mcp-client/programs.js";
import { apiPackageRoot } from "./package-path.js";
import { diagnostics } from "./logging/public.js";
// Installation is an explicit local administrator action, never a model tool.
try {
  if (process.argv.length !== 4 || process.argv[3] !== "--trust-source")
    throw Error("Usage: mcp:program:install <self-contained package> --trust-source");
  const id = await installProgram(
    resolve(process.argv[2] ?? ""),
    resolve(apiPackageRoot(), ".runtime", "mcp-programs"),
    resolve(apiPackageRoot(), "bin/mcp-host.exe"),
  );
  console.log(`Installed program: ${id}`);
} catch {
  diagnostics.error("mcp.external_failed");
  process.exitCode = 1;
}
