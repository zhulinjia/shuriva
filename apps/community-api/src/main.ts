import { resolve } from "node:path";
import { createApp } from "./app.js";
import { readAuthConfig } from "./auth.js";
import {
  readApiConfig,
  readStage3Enabled,
  readStage4Enabled,
  readStage6Enabled,
  readStage7Enabled,
  readStage8Enabled,
  validateWebOrigin,
} from "./config.js";
import { apiPackageRoot } from "./package-path.js";
import { readMcpConfig } from "./mcp/runtime.js";
import { readExternalConfig } from "./mcp-client/config.js";
import type { Express } from "express";
import { mountWebAssets } from "./web-assets.js";
import {
  createDiagnosticRuntime,
  createDiagnosticLogger,
  diagnostics,
  readLoggingConfig,
  withDiagnostics,
} from "./logging/public.js";

async function bootstrap(): Promise<void> {
  const runtime = await createDiagnosticRuntime(
    readLoggingConfig(process.env, resolve(apiPackageRoot(), ".runtime", "logs")),
  );
  try {
    await withDiagnostics(runtime.logger, {}, async () => {
      const { host, port } = readApiConfig(process.env);
      const auth = readAuthConfig(process.env);
      const webDirectory = process.env.WEB_ASSETS_DIR?.trim();
      if (webDirectory) {
        validateWebOrigin(auth?.origin, { host, port });
      }
      const connectorStatePath =
        process.env.CONNECTOR_STATE_PATH?.trim() ||
        resolve(apiPackageRoot(), ".runtime", "connectors.json");
      const app = await createApp({
        diagnostics: runtime.logger,
        diagnosticHealth: runtime.health,
        shutdownHooks: false,
        auth,
        connectorStatePath,
        stage3Enabled: readStage3Enabled(process.env),
        stage4Enabled: readStage4Enabled(process.env),
        stage6Enabled: readStage6Enabled(process.env),
        stage7Enabled: readStage7Enabled(process.env),
        stage8Enabled: readStage8Enabled(process.env),
        mcpConfig: readMcpConfig(process.env),
        externalMcpConfig: readExternalConfig(
          process.env,
          auth?.origin ?? "",
          port,
          readMcpConfig(process.env)?.port,
        ),
      });
      let stopping: Promise<void> | undefined;
      const shutdown = () => {
        if (stopping) return;
        stopping = (async () => {
          try {
            runtime.logger.info("platform.stopping");
            await app.close();
          } catch (error) {
            runtime.logger.error("platform.stop_failed", {}, error);
            process.exitCode = 1;
          } finally {
            await runtime.close();
          }
        })().catch((error: unknown) => {
          createDiagnosticLogger(process.stderr).error("platform.stop_failed", {}, error);
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      try {
        if (webDirectory && auth)
          await mountWebAssets(
            app.getHttpAdapter().getInstance() as Express,
            webDirectory,
            auth.origin,
          );
        await app.listen(port, host);
      } catch (error) {
        await app.close();
        throw error;
      }
      diagnostics.info("platform.started");
    });
  } catch (error) {
    runtime.logger.error("platform.start_failed", {}, error);
    await runtime.close();
    throw error;
  }
}
bootstrap().catch((error: unknown) => {
  diagnostics.error("platform.bootstrap_failed", {}, error);
  process.exitCode = 1;
});
