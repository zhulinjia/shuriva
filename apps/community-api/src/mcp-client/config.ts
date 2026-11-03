import { resolve } from "node:path";
import { apiPackageRoot } from "../package-path.js";
export interface ExternalConfig {
  origin: string;
  controlPorts: number[];
  programRoot: string;
  hostExecutable: string;
  runRoot: string;
}
export function readExternalConfig(
  env: NodeJS.ProcessEnv,
  origin: string,
  apiPort: number,
  mcpPort?: number,
): ExternalConfig | undefined {
  const flag = env.ENABLE_STAGE9_MCP_CLIENT ?? "0";
  if (flag === "0") return;
  if (flag !== "1" || env.ENABLE_STAGE7_HISTORY !== "1") throw Error("EXTERNAL_MCP_CONFIG_INVALID");
  const u = new URL(origin);
  return {
    origin,
    controlPorts: [
      apiPort,
      Number(u.port || (u.protocol === "https:" ? 443 : 80)),
      ...(mcpPort ? [mcpPort] : []),
    ],
    programRoot: resolve(apiPackageRoot(), ".runtime/mcp-programs"),
    hostExecutable: resolve(apiPackageRoot(), "bin/mcp-host.exe"),
    runRoot: resolve(apiPackageRoot(), ".runtime/mcp-runs"),
  };
}
