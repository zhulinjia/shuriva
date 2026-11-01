import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// G2 currently validates Windows/x64. The installed Go compiler's own host
// architecture is 386, so select the target explicitly rather than inheriting it.
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("G2_BRIDGE_TARGET_NOT_VALIDATED");
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const cache = path.join(workspace, ".cache");
if ((await realpath(cache)) !== path.resolve(cache)) throw new Error("G2_CACHE_LINK_REJECTED");
await promisify(execFile)(
  "go",
  [
    "build",
    "-C",
    fileURLToPath(new URL("../bridge", import.meta.url)),
    "-o",
    path.join(cache, "stage9-g2-bridge.exe"),
    ".",
  ],
  {
    windowsHide: true,
    env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
  },
);
console.log("G2 bridge target: windows/amd64");
