import { OperationalError } from "../operational-error.js";
import { isAbsolute, resolve } from "node:path";
import type { DiagnosticLevel } from "./fields.js";

export interface LoggingConfig {
  level: DiagnosticLevel;
  directory?: string;
  maxBytes: number;
  maxFiles: number;
}
export function readLoggingConfig(env: NodeJS.ProcessEnv, defaultDirectory: string): LoggingConfig {
  const level = env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level))
    throw new OperationalError("LOG_LEVEL_INVALID");
  const stdoutOnly = env.LOG_STDOUT_ONLY ?? "0";
  if (stdoutOnly !== "0" && stdoutOnly !== "1")
    throw new OperationalError("LOG_STDOUT_ONLY_INVALID");
  const size = env.LOG_MAX_BYTES ?? "10485760",
    count = env.LOG_MAX_FILES ?? "7";
  if (!/^[0-9]+$/.test(size) || !/^[0-9]+$/.test(count))
    throw new OperationalError("LOG_LIMITS_INVALID");
  const maxBytes = Number(size),
    maxFiles = Number(count);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 100 * 1024 * 1024 ||
    !Number.isInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 30
  )
    throw new OperationalError("LOG_LIMITS_INVALID");
  const directory = env.LOG_DIR?.trim() || resolve(defaultDirectory);
  if (!isAbsolute(directory)) throw new OperationalError("LOG_DIR_INVALID");
  return {
    level: level as DiagnosticLevel,
    ...(stdoutOnly === "1" ? {} : { directory }),
    maxBytes,
    maxFiles,
  };
}
