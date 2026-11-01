import type { Router } from "express";
import { DataSourceError } from "./errors.js";
import type { DataSourceRouteContext } from "./route-context.js";

/** Scans and snapshots expose only the authenticated workspace/source binding. */
export function mountDataSourceScanRoutes(
  router: Router,
  { store, registry }: Pick<DataSourceRouteContext, "store" | "registry">,
): void {
  router.get("/workspaces/:workspaceId/:sourceId/snapshot", async (req, res) => {
    const snapshot = await store.latest(
      res.locals.ownerId as string,
      req.params.workspaceId,
      req.params.sourceId,
    );
    if (!snapshot) throw new DataSourceError("NOT_FOUND");
    res.json({ snapshot });
  });
  router.get("/workspaces/:workspaceId/:sourceId/snapshots", async (req, res) => {
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    if (req.query.before !== undefined && before === undefined)
      throw new DataSourceError("INVALID");
    res.json(
      await store.history(
        res.locals.ownerId as string,
        req.params.workspaceId,
        req.params.sourceId,
        before,
      ),
    );
  });
  router.get("/workspaces/:workspaceId/:sourceId/snapshots/:snapshotId", async (req, res) => {
    const snapshot = await store.snapshot(
      res.locals.ownerId as string,
      req.params.workspaceId,
      req.params.sourceId,
      req.params.snapshotId,
    );
    if (!snapshot) throw new DataSourceError("NOT_FOUND");
    res.json({ snapshot });
  });
  router.post("/workspaces/:workspaceId/:sourceId/scan", async (req, res) => {
    const actor = res.locals.ownerId as string;
    const source = await store.boundSource(actor, req.params.workspaceId, req.params.sourceId);
    if (!source || !(await registry.isActiveOwner(actor, source.connectorId)))
      throw new DataSourceError("NOT_FOUND");
    res.status(202).json(await store.beginScan(actor, req.params.workspaceId, req.params.sourceId));
  });
  router.get("/workspaces/:workspaceId/:sourceId/scan", async (req, res) => {
    res.json({
      scan: await store.scanStatus(
        res.locals.ownerId as string,
        req.params.workspaceId,
        req.params.sourceId,
      ),
    });
  });
}
