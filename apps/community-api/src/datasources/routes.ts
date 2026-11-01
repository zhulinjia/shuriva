import express, { type ErrorRequestHandler, type Express } from "express";
import { diagnostics } from "../logging/public.js";
import type { ModelStore } from "../ai/public.js";
import type { ConnectorAuthorization, AuthenticateOwner } from "../connectors/public.js";
import type { AuditRecorder } from "../history/public.js";
import type { WorkspaceRead } from "../queries/public.js";
import type { SemanticReader } from "../semantic/public.js";
import { DataSourceError, type DataSourceStore } from "./store.js";
import { createDataSourceRouteContext } from "./route-context.js";
import { mountDataSourceManagementRoutes } from "./management-routes.js";
import { mountDataSourceQueryRoutes } from "./query-routes.js";
import { mountDataSourceModelRoutes } from "./model-routes.js";
import { mountDataSourceScanRoutes } from "./scan-routes.js";
import type { ScopeCoordinator } from "./scope-coordinator.js";

export function mountDataSourceRoutes(
  server: Express,
  store: DataSourceStore,
  registry: ConnectorAuthorization,
  origin: string,
  owner: AuthenticateOwner,
  scope: Pick<ScopeCoordinator, "inWorkspace">,
  read?: WorkspaceRead,
  models?: ModelStore,
  semantics?: SemanticReader,
  audit?: AuditRecorder,
): void {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.headers.origin !== origin) {
      res.status(403).json({ error: "请求来源无效" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: read ? "32kb" : "8kb" }));
  router.use(async (req, res, next) => {
    const id = await owner(req.headers);
    if (!id) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    res.locals.ownerId = id;
    next();
  });
  const context = createDataSourceRouteContext(store, registry, scope, read);
  mountDataSourceManagementRoutes(router, context);
  mountDataSourceQueryRoutes(router, context);
  mountDataSourceModelRoutes(router, context, models, semantics, audit);
  mountDataSourceScanRoutes(router, context);
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof DataSourceError) {
      res
        .status(error.code === "INVALID" ? 400 : error.code === "NOT_FOUND" ? 404 : 409)
        .json({ error: error.code });
      return;
    }
    const kind = error && typeof error === "object" && "type" in error ? error.type : undefined;
    if (kind === "entity.parse.failed" || kind === "entity.too.large") {
      res.status(kind === "entity.too.large" ? 413 : 400).json({ error: "INVALID" });
      return;
    }
    diagnostics.error("datasource.request_failed", {}, error);
    res.status(503).json({ error: "数据源服务尚未就绪" });
  };
  router.use(errors);
  server.use("/api/data-sources", router);
}
