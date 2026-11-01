import type { Router } from "express";
import { diagnostics } from "../logging/public.js";
import { DataSourceError } from "./errors.js";
import type { DataSourceRouteContext } from "./route-context.js";

/** Query task HTTP surface; registration and authorization remain on ReadService. */
export function mountDataSourceQueryRoutes(
  router: Router,
  {
    read,
    inWorkspace,
    withReadScope,
  }: Pick<DataSourceRouteContext, "read" | "inWorkspace" | "withReadScope">,
): void {
  router.get("/query-capability", (_req, res) => {
    res.json({ enabled: read !== undefined });
  });
  router.get("/workspaces/:workspaceId/:sourceId/queries/scope", async (req, res) => {
    if (!read) {
      res.sendStatus(404);
      return;
    }
    const token = await inWorkspace(req.params.workspaceId, () =>
      withReadScope(
        res.locals.ownerId as string,
        req.params.workspaceId,
        req.params.sourceId,
        (scope) => read.issueScope(scope),
      ),
    );
    res.json(token);
  });
  router.post("/workspaces/:workspaceId/:sourceId/queries", async (req, res) => {
    if (!read) {
      res.sendStatus(404);
      return;
    }
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 8 ||
      !Object.hasOwn(body, "requestId") ||
      !Object.hasOwn(body, "instanceId") ||
      !Object.hasOwn(body, "scopeToken") ||
      !Object.hasOwn(body, "submittedAt") ||
      !Object.hasOwn(body, "sql") ||
      !Object.hasOwn(body, "parameters") ||
      !Object.hasOwn(body, "maxRows") ||
      !Object.hasOwn(body, "schemaVersion")
    )
      throw new DataSourceError("INVALID");
    const data = body as Record<string, unknown>;
    try {
      const id = await inWorkspace(req.params.workspaceId, async () => {
        return withReadScope(
          res.locals.ownerId as string,
          req.params.workspaceId,
          req.params.sourceId,
          (scope) => {
            if (!read.validScope(scope, data.instanceId, data.scopeToken, data.submittedAt))
              throw new Error("STALE");
            const id = read.jobs.create(
              scope,
              data.requestId,
              data.sql,
              data.parameters,
              data.maxRows,
              data.schemaVersion,
            );
            return read.trackExecution(scope, id).then(() => id);
          },
        );
      });
      res.status(202).json({ id });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID")
        throw new DataSourceError("INVALID");
      if (error instanceof Error && (error.message === "CONFLICT" || error.message === "STALE")) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (
        error instanceof Error &&
        (error.message === "CAPACITY" || error.message === "RESULT_CAPACITY")
      ) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post("/workspaces/:workspaceId/:sourceId/queries/model-schema", async (req, res) => {
    if (!read) {
      res.sendStatus(404);
      return;
    }
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 4 ||
      !["requestId", "instanceId", "scopeToken", "submittedAt"].every((key) =>
        Object.hasOwn(body, key),
      )
    )
      throw new DataSourceError("INVALID");
    const data = body as Record<string, unknown>;
    try {
      const id = await inWorkspace(req.params.workspaceId, () =>
        withReadScope(
          res.locals.ownerId as string,
          req.params.workspaceId,
          req.params.sourceId,
          (scope) => {
            if (!read.validScope(scope, data.instanceId, data.scopeToken, data.submittedAt))
              throw new Error("STALE");
            return read.jobs.createModelSchema(scope, data.requestId);
          },
        ),
      );
      diagnostics.info("model.prepare_registered", {
        taskId: id,
        workspaceId: req.params.workspaceId,
        sourceId: req.params.sourceId,
      });
      res.status(202).json({ id });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID")
        throw new DataSourceError("INVALID");
      if (error instanceof Error && ["CONFLICT", "STALE"].includes(error.message)) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof Error && ["CAPACITY", "RESULT_CAPACITY"].includes(error.message)) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.get("/workspaces/:workspaceId/:sourceId/queries/:id", async (req, res) => {
    if (!read) {
      res.sendStatus(404);
      return;
    }
    await inWorkspace(req.params.workspaceId, async () => {
      const status = await withReadScope(
        res.locals.ownerId as string,
        req.params.workspaceId,
        req.params.sourceId,
        (scope) => read.jobs.status(scope, req.params.id),
      );
      if (!status) throw new DataSourceError("NOT_FOUND");
      res.json(status);
    });
  });
  router.delete("/workspaces/:workspaceId/:sourceId/queries/:id", async (req, res) => {
    if (!read) {
      res.sendStatus(404);
      return;
    }
    await inWorkspace(req.params.workspaceId, async () => {
      const cancelled = await withReadScope(
        res.locals.ownerId as string,
        req.params.workspaceId,
        req.params.sourceId,
        (scope) => {
          try {
            return read.jobs.cancel(scope, req.params.id);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "CAPACITY") throw error;
            // If a cancellation tombstone cannot be retained, invalidate the
            // issued binding token under the same authorization locks. A late
            // POST carrying that token can no longer create the unknown task.
            read.invalidateBinding(scope.ownerId, scope.workspaceId, scope.sourceId);
            return true;
          }
        },
      );
      if (!cancelled) throw new DataSourceError("NOT_FOUND");
      diagnostics.info("query.cancel_requested", {
        taskId: req.params.id,
        workspaceId: req.params.workspaceId,
        sourceId: req.params.sourceId,
      });
      res.json({ ok: true });
    });
  });
}
