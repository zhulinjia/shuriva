import express, { type Express, type ErrorRequestHandler } from "express";
import { diagnostics } from "../logging/public.js";
import type { AuthenticateOwner } from "../connectors/public.js";
import { DataSourceError } from "../datasources/public.js";
import type { HistoryRead } from "../queries/public.js";
import type { HistoryStore } from "./store.js";
import type { HistoryKind, HistoryScope } from "./model.js";
import { declareRequestAuditContext } from "./request-audit.js";

export function mountHistoryRoutes(
  server: Express,
  owner: AuthenticateOwner,
  origin: string,
  store: HistoryStore | undefined,
  read: HistoryRead | undefined,
) {
  const router = express.Router();
  router.use("/:workspace/:source", (req, res, next) => {
    declareRequestAuditContext(res, {
      workspaceId: req.params.workspace,
      sourceId: req.params.source,
      targetId: req.params.source,
    });
    next();
  });
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.headers.origin !== origin) {
      res.status(403).json({ error: "DENIED" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "272kb" }));
  router.use(async (req, res, next) => {
    const actor = await owner(req.headers);
    if (!actor) {
      res.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }
    res.locals.ownerId = actor;
    next();
  });
  router.get("/capability", (_req, res) => res.json({ enabled: !!store }));
  router.use((_req, res, next) => {
    if (!store) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    next();
  });
  router.get("/audit", async (req, res) =>
    res.json(await store?.listAudit(res.locals.ownerId as string, req.query.after)),
  );
  router.get("/executions", async (req, res) => {
    await read?.flushHistory();
    res.json(await store?.listExecutions(res.locals.ownerId as string, req.query.after));
  });
  const scope = (req: express.Request, res: express.Response): HistoryScope => ({
    ownerId: res.locals.ownerId as string,
    workspaceId: req.params.workspace as string,
    sourceId: req.params.source as string,
  });
  const kind = (value: string): HistoryKind => {
    if (!["conversation", "artifact", "execution"].includes(value))
      throw new DataSourceError("INVALID");
    return value as HistoryKind;
  };
  const changeKind = (value: string) => {
    if (value !== "conversation" && value !== "artifact") throw new DataSourceError("INVALID");
    return value;
  };
  router.post("/:workspace/:source/export", async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length !== 0
    )
      throw new DataSourceError("INVALID");
    const activeStore = store;
    if (!read || !activeStore) throw new DataSourceError("NOT_FOUND");
    const currentScope = scope(req, res);
    await read.withCurrentReadScope(currentScope, () => activeStore.recordExport(currentScope));
    res.json({ ok: true });
  });
  router.get("/:workspace/:source/:kind", async (req, res) => {
    if (
      req.query.deleted !== undefined &&
      req.query.deleted !== "true" &&
      req.query.deleted !== "false"
    )
      throw new DataSourceError("INVALID");
    await read?.flushHistory();
    res.json(
      await store?.list(
        scope(req, res),
        kind(req.params.kind),
        req.query.after,
        req.query.deleted === "true",
      ),
    );
  });
  router.get("/:workspace/:source/:kind/:id", async (req, res) =>
    res.json(
      await store?.get(
        scope(req, res),
        kind(req.params.kind),
        req.params.id,
        req.query.deleted === "true",
      ),
    ),
  );
  router.put("/:workspace/:source/:kind/:id", async (req, res) => {
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("revision" in body) ||
      !("content" in body)
    )
      throw new DataSourceError("INVALID");
    res.json(
      await store?.save(
        scope(req, res),
        changeKind(req.params.kind),
        req.params.id,
        body.revision,
        body.content,
      ),
    );
  });
  router.patch("/:workspace/:source/:kind/:id", async (req, res) => {
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("revision" in body) ||
      !("deleted" in body) ||
      typeof body.deleted !== "boolean"
    )
      throw new DataSourceError("INVALID");
    res.json(
      await store?.setDeleted(
        scope(req, res),
        changeKind(req.params.kind),
        req.params.id,
        body.revision,
        body.deleted,
      ),
    );
  });
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
    const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
    if (type === "entity.parse.failed" || type === "entity.too.large") {
      res.status(type === "entity.too.large" ? 413 : 400).json({ error: "INVALID" });
      return;
    }
    diagnostics.error("history.request_failed", {}, error);
    res.status(503).json({ error: "UNAVAILABLE" });
  };
  router.use(errors);
  server.use("/api/history", router);
}
