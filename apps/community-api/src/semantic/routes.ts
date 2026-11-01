import express, { type ErrorRequestHandler, type Express } from "express";
import { diagnostics } from "../logging/public.js";
import type { AuthenticateOwner } from "../connectors/public.js";
import { DataSourceError } from "../datasources/public.js";
import type { SemanticRead } from "../queries/public.js";
import type { SemanticStore } from "./store.js";

export function mountSemanticRoutes(
  server: Express,
  owner: AuthenticateOwner,
  origin: string,
  store: SemanticStore,
  read: SemanticRead,
): void {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.headers.origin !== origin) {
      res.status(403).json({ error: "DENIED" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "256kb" }));
  router.use(async (req, res, next) => {
    const id = await owner(req.headers);
    if (!id) {
      res.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }
    res.locals.ownerId = id;
    next();
  });
  router.get("/:workspace/:source", async (req, res) => {
    res.json(
      await read.inWorkspace(req.params.workspace, () =>
        store.get(res.locals.ownerId as string, req.params.workspace, req.params.source),
      ),
    );
  });
  router.put("/:workspace/:source", async (req, res) => {
    const value: unknown = req.body;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      !("revision" in value) ||
      !("snapshotId" in value) ||
      !("document" in value)
    )
      throw new DataSourceError("INVALID");
    res.json(
      await read.inWorkspace(req.params.workspace, async () => {
        const actor = res.locals.ownerId as string;
        const result = await store.save(
          actor,
          req.params.workspace,
          req.params.source,
          value.revision,
          value.snapshotId,
          value.document,
        );
        read.invalidateModelContext(actor, req.params.workspace, req.params.source);
        return result;
      }),
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
    const kind = error && typeof error === "object" && "type" in error ? error.type : undefined;
    if (kind === "entity.parse.failed" || kind === "entity.too.large") {
      res.status(kind === "entity.too.large" ? 413 : 400).json({ error: "INVALID" });
      return;
    }
    diagnostics.error("semantic.request_failed", {}, error);
    res.status(503).json({ error: "UNAVAILABLE" });
  };
  router.use(errors);
  server.use("/api/semantics", router);
}
