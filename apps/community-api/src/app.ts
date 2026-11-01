import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Express } from "express";
import { systemModelStore } from "./ai/model-store.js";
import { mountModelRoutes } from "./ai/routes.js";
import { ModelPlanner } from "./ai/public.js";
import { AppModule } from "./app.module.js";
import {
  type AuthConfig,
  createAuth,
  createDatabase,
  authMutationIdentity,
  authSessionReferenceActive,
  authSessionAccess,
} from "./auth.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import { authOwner, mountConnectorRoutes } from "./connectors/routes.js";
import { registrySecret } from "./connectors/system-vault.js";
import { mountDataSourceRoutes } from "./datasources/routes.js";
import { scanHooks } from "./datasources/scan.js";
import { DataSourceStore } from "./datasources/store.js";
import { ScopeCoordinator } from "./datasources/public.js";
import { AuditTrail } from "./history/audit.js";
import { mountHistoryRoutes } from "./history/routes.js";
import { HistoryStore } from "./history/store.js";
import { verifyDatabaseCurrent } from "./migrations.js";
import { mountProductRoutes } from "./product-routes.js";
import { ReadService } from "./queries/service.js";
import { mountSemanticRoutes } from "./semantic/routes.js";
import { SemanticStore } from "./semantic/store.js";
import { WorkspaceStore } from "./workspaces.js";
import {
  ConnectorMutationTransport,
  mountMutationAgentRoutes,
} from "./mutations/connector-transport.js";
import {
  createDiagnosticLogger,
  diagnostics,
  frameworkDiagnostics,
  installRequestDiagnostics,
  silentDiagnostics,
  withDiagnostics,
  type DiagnosticLogger,
} from "./logging/public.js";
import type { MutationAccess } from "./mutations/ports.js";
import { mountMutationRoutes } from "./mutations/routes.js";
import { MutationService } from "./mutations/service.js";
import { MutationStore } from "./mutations/store.js";
import { MutationAIPlanner } from "./mutations/ai/planner.js";
import { mountMutationAIRoutes } from "./mutations/ai/routes.js";

export async function createApp(
  options: {
    logger?: false;
    auth?: AuthConfig;
    connectorStatePath?: string;
    stage3Enabled?: boolean;
    stage4Enabled?: boolean;
    stage6Enabled?: boolean;
    stage7Enabled?: boolean;
    stage8Enabled?: boolean;
    diagnostics?: DiagnosticLogger;
    diagnosticHealth?: () => {
      available: boolean;
      fileEnabled: boolean;
      dropped: number;
      closed: boolean;
    };
    shutdownHooks?: boolean;
  } = {},
): Promise<INestApplication> {
  const logger =
    options.diagnostics ??
    (options.logger === false ? silentDiagnostics : createDiagnosticLogger(process.stdout));
  return withDiagnostics(logger, {}, async () => {
    if (options.stage4Enabled && !options.stage3Enabled)
      throw new Error("stage 4 requires stage 3");
    if (options.stage6Enabled && !options.stage4Enabled)
      throw new Error("stage 6 requires stage 4");
    if (options.stage7Enabled && !options.stage6Enabled)
      throw new Error("stage 7 requires stage 6");
    if (options.stage8Enabled && !options.stage7Enabled)
      throw new Error("stage 8 requires stage 7");
    const app = await NestFactory.create(AppModule, {
      abortOnError: false,
      logger: options.logger === false ? false : frameworkDiagnostics(logger),
    });
    installRequestDiagnostics(app.getHttpAdapter().getInstance() as Express, logger);
    app.setGlobalPrefix("api");
    if (options.auth) {
      const pool = createDatabase(options.auth.databaseUrl);
      let database: Awaited<ReturnType<typeof verifyDatabaseCurrent>>;
      try {
        database = await verifyDatabaseCurrent(
          pool,
          options.stage3Enabled === true,
          options.stage6Enabled === true,
          options.stage7Enabled === true,
          options.stage8Enabled === true,
        );
      } catch (error) {
        await pool.end();
        await app.close();
        throw error;
      }
      const auth = createAuth(options.auth, pool);
      const server = app.getHttpAdapter().getInstance() as Express;
      if (options.diagnosticHealth)
        server.get("/api/diagnostics/logging", async (req, res) => {
          if (!(await authOwner(auth)(req.headers))) {
            res.status(401).json({ error: "UNAUTHENTICATED" });
            return;
          }
          res.setHeader("Cache-Control", "no-store");
          res.json(options.diagnosticHealth?.());
        });
      const dataSources = database.hasStage3 ? new DataSourceStore(pool) : undefined;
      const history =
        options.stage7Enabled && database.hasHistory && dataSources
          ? new HistoryStore(pool, dataSources)
          : undefined;
      let audit: AuditTrail | undefined;
      try {
        audit = history
          ? new AuditTrail(
              history,
              options.connectorStatePath
                ? join(dirname(options.connectorStatePath), "audit-outbox.json")
                : undefined,
              !!options.connectorStatePath,
            )
          : undefined;
      } catch (error) {
        await pool.end();
        await app.close();
        throw error;
      }
      audit?.install(app.getHttpAdapter().getInstance() as Express, authOwner(auth));
      let readService: ReadService | undefined;
      let scopeCoordinator: ScopeCoordinator | undefined;
      mountProductRoutes(
        app.getHttpAdapter().getInstance() as Express,
        auth,
        pool,
        options.auth.origin,
        new WorkspaceStore(
          pool,
          dataSources
            ? (connection, id) => dataSources.cancelWorkspaceScans(connection, id)
            : undefined,
        ),
        async (ownerId, workspaceId, operation) => {
          if (!scopeCoordinator) return operation();
          return scopeCoordinator.inWorkspace(workspaceId, async () => {
            const archived = await operation();
            if (archived) {
              readService?.invalidateWorkspace(ownerId, workspaceId);
              readService?.jobs.cancelMatching(ownerId, workspaceId);
            }
            return archived;
          });
        },
      );
      const statePath = options.connectorStatePath;
      if (statePath) {
        const modelStore = systemModelStore(statePath);
        mountModelRoutes(
          app.getHttpAdapter().getInstance() as Express,
          authOwner(auth),
          options.auth.origin,
          modelStore,
        );
        let activeRegistry: ConnectorRegistry | undefined;
        let initializingAudit = false;
        try {
          const registry = await ConnectorRegistry.open(statePath, () => registrySecret(statePath));
          activeRegistry = registry;
          initializingAudit = true;
          audit?.start();
          initializingAudit = false;
          const store = options.stage3Enabled ? dataSources : undefined;
          scopeCoordinator = store ? new ScopeCoordinator(store, registry) : undefined;
          if (store && options.stage4Enabled) {
            readService = new ReadService(
              store,
              registry,
              authSessionAccess(auth, pool),
              history
                ? {
                    begin: (scope, id, instance) =>
                      history.beginExecution(scope, id, scope.connectorId, instance),
                    update: (scope, id, state, summary) =>
                      history.setExecutionState(scope, id, state, summary),
                  }
                : undefined,
              scopeCoordinator,
            );
            if (history) await history.recoverExecutions(readService.instanceId);
          }
          const semantics =
            database.hasSemantics && dataSources ? new SemanticStore(dataSources) : undefined;
          if (store && scopeCoordinator) {
            const coordinator = scopeCoordinator;
            const access: MutationAccess = {
              authenticate: authMutationIdentity(auth),
              withScope: (scope, operation) => coordinator.withScope(scope, operation),
            };
            const mutations = new MutationStore(
              pool,
              store,
              randomBytes(32).toString("hex"),
              authSessionReferenceActive,
            );
            const channel = new ConnectorMutationTransport(registry, access);
            const enabled = options.stage8Enabled === true && database.hasMutations;
            // G3 ships implementation without granting the G4 production opening.
            const service = new MutationService(
              mutations,
              access,
              channel,
              { sign: async (payload) => registry.signMutationPermit(payload) },
              { enabled, executionEnabled: false },
            );
            channel.onExecutionResult(async (binding, expected, result) => {
              await service.result(binding, expected.executionId, result);
            });
            const modelPlanner = readService
              ? new ModelPlanner(
                  readService,
                  modelStore,
                  (ownerId, workspaceId, sourceId, operation) =>
                    access.withScope({ ownerId, workspaceId, sourceId }, async (binding) =>
                      operation(binding),
                    ),
                  { semantics },
                )
              : undefined;
            const mutationAI =
              enabled && modelPlanner
                ? new MutationAIPlanner(
                    modelPlanner,
                    access,
                    (scope) => service.capability(scope),
                    mutations.apiBoot,
                  )
                : undefined;
            mountMutationAIRoutes(
              app.getHttpAdapter().getInstance() as Express,
              options.auth.origin,
              access,
              mutationAI,
            );
            mountMutationRoutes(
              app.getHttpAdapter().getInstance() as Express,
              options.auth.origin,
              access,
              service,
            );
            if (enabled) {
              await mutations.recoverPreviousBoot();
              mountMutationAgentRoutes(
                app.getHttpAdapter().getInstance() as Express,
                registry,
                channel,
                service,
              );
            }
            let flushing = false;
            const flush =
              enabled && history
                ? setInterval(() => {
                    if (flushing) return;
                    flushing = true;
                    void mutations
                      .flushAudit({
                        append: (scope, eventId, event, executionId) =>
                          history.appendAudit(
                            scope.ownerId,
                            scope,
                            { event, executionId, outcome: "success" },
                            eventId,
                          ),
                      })
                      .catch((error: unknown) =>
                        diagnostics.error("mutation.audit_unavailable", {}, error),
                      )
                      .finally(() => {
                        flushing = false;
                      });
                  }, 1000)
                : undefined;
            flush?.unref();
            app.getHttpServer().once("close", () => {
              channel.close();
              if (flush) clearInterval(flush);
            });
          }
          mountHistoryRoutes(
            app.getHttpAdapter().getInstance() as Express,
            authOwner(auth),
            options.auth.origin,
            options.stage7Enabled ? history : undefined,
            readService,
          );
          // Once policy storage exists, disclosure enforcement cannot be disabled
          // by hiding the semantic configuration feature.
          if (options.stage6Enabled && semantics && readService)
            mountSemanticRoutes(
              app.getHttpAdapter().getInstance() as Express,
              authOwner(auth),
              options.auth.origin,
              semantics,
              readService,
            );
          mountConnectorRoutes(
            app.getHttpAdapter().getInstance() as Express,
            registry,
            options.auth.origin,
            authOwner(auth),
            store ? scanHooks(store, registry) : undefined,
            readService,
            audit
              ? (ownerId, event, connectorId) => {
                  audit?.record(ownerId, {
                    event,
                    outcome: "success",
                    connectorId,
                  });
                }
              : undefined,
          );
          if (store && scopeCoordinator)
            mountDataSourceRoutes(
              app.getHttpAdapter().getInstance() as Express,
              store,
              registry,
              options.auth.origin,
              authOwner(auth),
              scopeCoordinator,
              readService,
              modelStore,
              semantics,
              audit,
            );
          app.getHttpServer().once("close", () => {
            void registry.close();
            readService?.close();
          });
        } catch (error) {
          audit?.close();
          readService?.close();
          await activeRegistry?.close();
          if (initializingAudit) {
            await pool.end();
            await app.close();
            throw error;
          }
          diagnostics.error("connector.registry_unavailable", {}, error);
          const server = app.getHttpAdapter().getInstance() as Express;
          server.use(["/api/connectors", "/api/connector-agent"], (_req, res) => {
            res.setHeader("Cache-Control", "no-store");
            res.status(503).json({ error: "连接器服务不可用" });
          });
        }
      }
      app.getHttpServer().once("close", () => {
        audit?.close();
        void pool.end();
      });
    }
    if (options.shutdownHooks !== false) app.enableShutdownHooks();
    return app;
  });
}
