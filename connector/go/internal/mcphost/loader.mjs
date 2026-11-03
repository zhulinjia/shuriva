// The host embeds and pins this file before resuming Node. This catches
// undeclared module resolution; it is not isolation from trusted OS-user code.

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function guardPackage(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "installation.json"), "utf8"));
  const allowed = new Set(manifest.files.map((file) => resolve(root, file.path).toLowerCase()));
  registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (result.url.startsWith("node:")) return result;
      if (
        !result.url.startsWith("file:") ||
        !allowed.has(resolve(fileURLToPath(result.url)).toLowerCase())
      )
        throw new Error("MCP_PACKAGE_MODULE_REJECTED");
      return result;
    },
  });
}
