import { OperationalError } from "./operational-error.js";
export interface ApiConfig {
  host: string;
  port: number;
}

/** G3 implementation is reviewable; production execution awaits the G4 gate. */
export function readStage8Enabled(env: NodeJS.ProcessEnv): false {
  if ((env.ENABLE_STAGE8_WRITES ?? "0") !== "0") throw new OperationalError("WRITES_NOT_ACCEPTED");
  return false;
}

export function readStage3Enabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ENABLE_STAGE3_DATASOURCES ?? "0";
  if (value !== "0" && value !== "1") throw new OperationalError("STAGE3_FLAG_INVALID");
  return value === "1";
}

export function readStage4Enabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ENABLE_STAGE4_READS ?? "0";
  if (value !== "0" && value !== "1") throw new OperationalError("STAGE4_FLAG_INVALID");
  if (value === "1" && !readStage3Enabled(env)) throw new OperationalError("STAGE4_DEPENDENCY");
  return value === "1";
}

export function readStage6Enabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ENABLE_STAGE6_SEMANTICS ?? "0";
  if (value !== "0" && value !== "1") throw new OperationalError("STAGE6_FLAG_INVALID");
  if (value === "1" && !readStage4Enabled(env)) throw new OperationalError("STAGE6_DEPENDENCY");
  return value === "1";
}

export function readStage7Enabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ENABLE_STAGE7_HISTORY ?? "0";
  if (value !== "0" && value !== "1") throw new OperationalError("STAGE7_FLAG_INVALID");
  if (value === "1" && !readStage6Enabled(env)) throw new OperationalError("STAGE7_DEPENDENCY");
  return value === "1";
}

/** Resolve configuration before opening a listener; never guess an invalid port. */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const host = env.API_HOST?.trim() || "127.0.0.1";
  const portText = env.API_PORT ?? "3000";
  // Until trusted proxy and shared rate limiting are validated, bind locally only.
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new OperationalError("API_HOST_INVALID");
  }

  if (!/^[0-9]+$/.test(portText)) {
    throw new OperationalError("API_PORT_INVALID");
  }

  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new OperationalError("API_PORT_INVALID");
  }

  return { host, port };
}
