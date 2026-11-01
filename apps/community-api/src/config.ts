export interface ApiConfig {
  host: string;
  port: number;
}

/** G3 implementation is reviewable; production execution awaits the G4 gate. */
export function readStage8Enabled(env: NodeJS.ProcessEnv): false {
  if ((env.ENABLE_STAGE8_WRITES ?? "0") !== "0")
    throw new Error("Controlled writes remain closed until stage 8 security acceptance");
  return false;
}

export function readStage3Enabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ENABLE_STAGE3_DATASOURCES ?? "0";
  if (value !== "0" && value !== "1") throw new Error("ENABLE_STAGE3_DATASOURCES must be 0 or 1");
  return value === "1";
}

export function readStage4Enabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ENABLE_STAGE4_READS ?? "0";
  if (value !== "0" && value !== "1") throw new Error("ENABLE_STAGE4_READS must be 0 or 1");
  if (value === "1" && !readStage3Enabled(env))
    throw new Error("ENABLE_STAGE4_READS requires ENABLE_STAGE3_DATASOURCES=1");
  return value === "1";
}

export function readStage6Enabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ENABLE_STAGE6_SEMANTICS ?? "0";
  if (value !== "0" && value !== "1") throw new Error("ENABLE_STAGE6_SEMANTICS must be 0 or 1");
  if (value === "1" && !readStage4Enabled(env))
    throw new Error("ENABLE_STAGE6_SEMANTICS requires ENABLE_STAGE4_READS=1");
  return value === "1";
}

export function readStage7Enabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ENABLE_STAGE7_HISTORY ?? "0";
  if (value !== "0" && value !== "1") throw new Error("ENABLE_STAGE7_HISTORY must be 0 or 1");
  if (value === "1" && !readStage6Enabled(env))
    throw new Error("ENABLE_STAGE7_HISTORY requires ENABLE_STAGE6_SEMANTICS=1");
  return value === "1";
}

/** Resolve configuration before opening a listener; never guess an invalid port. */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const host = env.API_HOST?.trim() || "127.0.0.1";
  const portText = env.API_PORT ?? "3000";
  // Until trusted proxy and shared rate limiting are validated, bind locally only.
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("API_HOST must be a loopback address until external deployment is hardened");
  }

  if (!/^[0-9]+$/.test(portText)) {
    throw new Error("API_PORT must be an integer between 1 and 65535");
  }

  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be an integer between 1 and 65535");
  }

  return { host, port };
}
