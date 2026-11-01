import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import { safeError, safeFields, type DiagnosticFields, type DiagnosticLevel } from "./fields.js";
import { diagnosticEvent } from "./events.js";
import { diagnosticOutputState } from "./output.js";

export interface DiagnosticSink {
  readonly writableLength?: number;
  on?(event: "error", listener: (error: unknown) => void): unknown;
  off?(event: "error", listener: (error: unknown) => void): unknown;
  once?(event: "close", listener: () => void): unknown;
  write(line: string, callback?: (error?: Error | null) => void): unknown;
}
export interface DiagnosticLogger {
  debug(event: string, fields?: DiagnosticFields, error?: unknown): void;
  info(event: string, fields?: DiagnosticFields, error?: unknown): void;
  warn(event: string, fields?: DiagnosticFields, error?: unknown): void;
  error(event: string, fields?: DiagnosticFields, error?: unknown): void;
}
export function createDiagnosticLogger(
  sink: DiagnosticSink,
  level: DiagnosticLevel = "info",
  onFailure: () => void = () => {},
): DiagnosticLogger {
  // The raw destination, including stdout/stderr fallback, must own one error
  // listener even when no file runtime has been composed around this logger.
  const output = diagnosticOutputState(sink);
  const failed = () => {
    try {
      onFailure();
    } catch {
      // An observer cannot turn diagnostic failure into a business failure.
    }
  };
  const logger = pino(
    {
      level,
      base: { service: "community-api", bootId: randomUUID() },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    {
      write(line: string) {
        if (output.failed || (sink.writableLength ?? 0) + Buffer.byteLength(line) > 1024 * 1024) {
          failed();
          return;
        }
        if (sink instanceof Writable)
          sink.write(line, (error) => {
            if (error) failed();
          });
        else sink.write(line);
      },
    },
  );
  const emit = (
    severity: DiagnosticLevel,
    event: string,
    fields: DiagnosticFields = {},
    error?: unknown,
  ) => {
    const safeEvent = diagnosticEvent(event);
    try {
      logger[severity]({
        event: safeEvent,
        ...safeFields({ ...contexts.getStore()?.fields, ...fields }),
        ...(error === undefined ? {} : safeError(error)),
      });
    } catch {
      failed();
    }
  };
  const method =
    (severity: DiagnosticLevel) => (event: string, fields?: DiagnosticFields, error?: unknown) =>
      emit(severity, event, fields, error);
  return Object.freeze({
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
  });
}
const contexts = new AsyncLocalStorage<{ logger: DiagnosticLogger; fields: DiagnosticFields }>();
const fallback = createDiagnosticLogger(process.stderr);
export const silentDiagnostics: DiagnosticLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});
export function withDiagnostics<T>(
  logger: DiagnosticLogger,
  fields: DiagnosticFields,
  action: () => T,
): T {
  return contexts.run({ logger, fields }, action);
}
// Context-local dependency: concurrent application instances and tests do not
// mutate a process-global logger or leak another request's correlation IDs.
const forward =
  (level: DiagnosticLevel) => (event: string, fields?: DiagnosticFields, error?: unknown) =>
    (contexts.getStore()?.logger ?? fallback)[level](event, fields, error);
export const diagnostics: DiagnosticLogger = Object.freeze({
  debug: forward("debug"),
  info: forward("info"),
  warn: forward("warn"),
  error: forward("error"),
});
