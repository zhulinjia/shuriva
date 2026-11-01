import type { Router } from "express";
import { DataSourceError, validId, validSourceName } from "./store.js";
import type { DataSourceRouteContext } from "./route-context.js";

function createBody(value: unknown): value is { id: string; connectorId: string; name: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 3 &&
    typeof body.id === "string" &&
    validId(body.id) &&
    typeof body.connectorId === "string" &&
    validId(body.connectorId) &&
    validSourceName(body.name)
  );
}

export function mountDataSourceManagementRoutes(
  router: Router,
  {
    store,
    registry,
    inWorkspace,
    read,
  }: Pick<DataSourceRouteContext, "store" | "registry" | "inWorkspace" | "read">,
): void {
  router.get("/", async (req, res) => {
    const after = req.query.after;
    const archived = req.query.archived;
    if (
      (after !== undefined && typeof after !== "string") ||
      (archived !== undefined && archived !== "true" && archived !== "false")
    )
      throw new DataSourceError("INVALID");
    res.json(await store.list(res.locals.ownerId as string, archived === "true", after));
  });
  router.patch("/:id", async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Object.keys(req.body).length !== 1 ||
      !validSourceName(req.body.name)
    )
      throw new DataSourceError("INVALID");
    await store.rename(res.locals.ownerId as string, req.params.id, req.body.name);
    res.json({ ok: true });
  });
  router.delete("/:id", async (req, res) => {
    await store.archive(res.locals.ownerId as string, req.params.id);
    res.json({ ok: true });
  });
  router.post("/:id/restore", async (req, res) => {
    await store.restore(res.locals.ownerId as string, req.params.id);
    res.json({ ok: true });
  });
  router.put("/:id/connector", async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Object.keys(req.body).length !== 1 ||
      typeof req.body.connectorId !== "string" ||
      !validId(req.body.connectorId)
    )
      throw new DataSourceError("INVALID");
    const actor = res.locals.ownerId as string;
    if (!(await registry.isActiveOwner(actor, req.body.connectorId)))
      throw new DataSourceError("NOT_FOUND");
    await store.reassign(actor, req.params.id, req.body.connectorId);
    res.json({ ok: true });
  });
  router.post("/", async (req, res) => {
    if (!createBody(req.body)) throw new DataSourceError("INVALID");
    const actor = res.locals.ownerId as string;
    if (!(await registry.isActiveOwner(actor, req.body.connectorId)))
      throw new DataSourceError("NOT_FOUND");
    await store.create(actor, req.body.id, req.body.connectorId, req.body.name);
    res.status(201).json({ id: req.body.id });
  });
  router.get("/workspaces/:workspaceId", async (req, res) => {
    const after = req.query.after;
    if (after !== undefined && typeof after !== "string") throw new DataSourceError("INVALID");
    const rows = await store.bindings(res.locals.ownerId as string, req.params.workspaceId, after);
    const sources = rows.slice(0, 100);
    res.json({ sources, nextCursor: rows.length > 100 ? (sources.at(-1)?.id ?? null) : null });
  });
  router.post("/workspaces/:workspaceId/status", async (req, res) => {
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("sourceIds" in body) ||
      !Array.isArray(body.sourceIds) ||
      body.sourceIds.length > 100 ||
      body.sourceIds.some((id: unknown) => typeof id !== "string" || !validId(id)) ||
      new Set(body.sourceIds).size !== body.sourceIds.length
    )
      throw new DataSourceError("INVALID");
    res.json({
      sources: await store.bindingStatuses(
        res.locals.ownerId as string,
        req.params.workspaceId,
        body.sourceIds,
      ),
    });
  });
  router.put("/workspaces/:workspaceId/:sourceId", async (req, res) => {
    await inWorkspace(req.params.workspaceId, () =>
      store.bind(res.locals.ownerId as string, req.params.workspaceId, req.params.sourceId),
    );
    res.status(201).json({ ok: true });
  });
  router.delete("/workspaces/:workspaceId/:sourceId", async (req, res) => {
    await inWorkspace(req.params.workspaceId, async () => {
      await store.unbind(res.locals.ownerId as string, req.params.workspaceId, req.params.sourceId);
      read?.invalidateBinding(
        res.locals.ownerId as string,
        req.params.workspaceId,
        req.params.sourceId,
      );
      read?.jobs.cancelMatching(
        res.locals.ownerId as string,
        req.params.workspaceId,
        req.params.sourceId,
      );
    });
    res.json({ ok: true });
  });
  router.put("/workspaces/:workspaceId/:sourceId/default", async (req, res) => {
    await store.setDefault(
      res.locals.ownerId as string,
      req.params.workspaceId,
      req.params.sourceId,
    );
    res.json({ ok: true });
  });
}
