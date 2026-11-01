import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { LoggerService } from "@nestjs/common";
import { withDiagnostics, type DiagnosticLogger } from "./logger.js";

export function installRequestDiagnostics(server: Express, logger: DiagnosticLogger): void {
  server.use((req, res, next) => {
    const requestId = randomUUID(),
      start = performance.now();
    res.setHeader("X-Request-Id", requestId);
    withDiagnostics(logger, { requestId }, () => {
      let completed = false;
      const finish = (aborted: boolean) => {
        if (completed) return;
        completed = true;
        const path: unknown = req.route?.path;
        const fields = {
          requestId,
          method: req.method,
          route: typeof path === "string" ? path : "unmatched",
          status: aborted ? 499 : res.statusCode,
          durationMs: performance.now() - start,
        };
        if (aborted || res.statusCode >= 500) logger.error("http.completed", fields);
        else if (res.statusCode >= 400) logger.warn("http.completed", fields);
        else logger.info("http.completed", fields);
      };
      res.once("finish", () => finish(false));
      res.once("close", () => finish(!res.writableFinished));
      next();
    });
  });
}
/** Framework messages may contain URLs or exception text; only fixed events cross the boundary. */
export function frameworkDiagnostics(logger: DiagnosticLogger): LoggerService {
  return {
    log() {
      logger.info("framework.lifecycle");
    },
    warn() {
      logger.warn("framework.warning");
    },
    error(error: unknown) {
      logger.error("framework.failure", {}, error instanceof Error ? error : undefined);
    },
    debug() {
      logger.debug("framework.debug");
    },
    verbose() {
      logger.debug("framework.verbose");
    },
    fatal(error: unknown) {
      logger.error("framework.fatal", {}, error instanceof Error ? error : undefined);
    },
  };
}
