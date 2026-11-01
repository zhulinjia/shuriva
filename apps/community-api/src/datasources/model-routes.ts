import type { Router } from "express";
import { diagnostics } from "../logging/public.js";
import {
  ModelPlanner,
  modelPlanFailure,
  streamModelPlan,
  type ModelStore,
  type PlanStage,
} from "../ai/public.js";
import type { AuditRecorder } from "../history/public.js";
import type { SemanticReader } from "../semantic/public.js";
import { DataSourceError } from "./errors.js";
import type { DataSourceRouteContext } from "./route-context.js";

/** Model disclosure and generation use existing scoped read authority. */
export function mountDataSourceModelRoutes(
  router: Router,
  {
    read,
    inWorkspace,
    withReadScope,
  }: Pick<DataSourceRouteContext, "read" | "inWorkspace" | "withReadScope">,
  models?: ModelStore,
  semantics?: SemanticReader,
  audit?: AuditRecorder,
): void {
  const planner =
    read && models
      ? new ModelPlanner(
          read,
          models,
          (actor, workspace, source, operation) =>
            inWorkspace(workspace, () => withReadScope(actor, workspace, source, operation)),
          { semantics },
        )
      : undefined;
  router.get("/workspaces/:workspaceId/:sourceId/queries/:id/model-preview", async (req, res) => {
    if (!planner) {
      res.sendStatus(404);
      return;
    }
    let preview: Awaited<ReturnType<ModelPlanner["preview"]>>;
    try {
      preview = await planner.preview(
        res.locals.ownerId as string,
        req.params.workspaceId,
        req.params.sourceId,
        req.params.id,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        ["STALE", "NO_MODEL_FIELDS", "SEMANTICS_TOO_LARGE"].includes(error.message)
      ) {
        res
          .status(409)
          .json({ error: error.message === "STALE" ? "SEMANTIC_STALE" : error.message });
        return;
      }
      throw error;
    }
    if (!preview) {
      res.status(409).json({ error: "PREVIEW_UNAVAILABLE" });
      return;
    }
    res.json(preview);
  });
  router.post("/workspaces/:workspaceId/:sourceId/queries/:id/model-plan", async (req, res) => {
    if (!planner) {
      res.sendStatus(404);
      return;
    }
    const body: unknown = req.body;
    const fields = [
      "instanceId",
      "scopeToken",
      "submittedAt",
      "question",
      "schemaHash",
      "baseUrl",
      "model",
      "configVersion",
    ];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== fields.length ||
      !fields.every((key) => Object.hasOwn(body, key))
    )
      throw new DataSourceError("INVALID");
    const data = body as Record<string, unknown>;
    if (
      typeof data.question !== "string" ||
      !data.question.trim() ||
      Buffer.byteLength(data.question) > 8192 ||
      typeof data.schemaHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(data.schemaHash) ||
      typeof data.baseUrl !== "string" ||
      typeof data.model !== "string" ||
      typeof data.configVersion !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.configVersion)
    )
      throw new DataSourceError("INVALID");
    const connection = new AbortController();
    res.once("close", () => connection.abort());
    const input = {
      instanceId: data.instanceId,
      scopeToken: data.scopeToken,
      submittedAt: data.submittedAt,
      question: data.question,
      schemaHash: data.schemaHash,
      baseUrl: data.baseUrl,
      model: data.model,
      configVersion: data.configVersion,
    };
    const generate = async (progress?: (stage: PlanStage) => void) => {
      const actor = res.locals.ownerId as string;
      const historyScope = { workspaceId: req.params.workspaceId, sourceId: req.params.sourceId };
      const recordOutcome = (
        event: "model.completed" | "model.failed",
        outcome: "success" | "failure",
      ) => {
        try {
          audit?.record(actor, { event, outcome }, historyScope);
        } catch (error) {
          if (!res.headersSent) res.setHeader("X-Audit-Status", "unavailable");
          diagnostics.error("model.audit_unavailable", {}, error);
        }
      };
      audit?.record(
        actor,
        {
          event: "model.requested",
          outcome: "success",
        },
        historyScope,
      );
      diagnostics.info("model.plan_requested", {
        taskId: req.params.id,
        workspaceId: req.params.workspaceId,
        sourceId: req.params.sourceId,
      });
      let result: Awaited<ReturnType<ModelPlanner["generate"]>>;
      try {
        result = await planner.generate(
          res.locals.ownerId as string,
          req.params.workspaceId,
          req.params.sourceId,
          req.params.id,
          input,
          connection.signal,
          progress,
        );
      } catch (error) {
        recordOutcome("model.failed", "failure");
        diagnostics.warn(
          "model.plan_failed",
          {
            taskId: req.params.id,
            workspaceId: req.params.workspaceId,
            sourceId: req.params.sourceId,
            code: modelPlanFailure(error).error,
          },
          error,
        );
        throw error;
      }
      recordOutcome("model.completed", "success");
      diagnostics.info("model.plan_completed", {
        taskId: req.params.id,
        workspaceId: req.params.workspaceId,
        sourceId: req.params.sourceId,
      });
      return result;
    };
    if (req.accepts(["json", "text/event-stream"]) === "text/event-stream") {
      await streamModelPlan(res, connection.signal, generate);
      return;
    }
    try {
      const candidate = await generate();
      if (!res.destroyed) res.json({ plan: candidate });
    } catch (error) {
      if (res.destroyed) return;
      const failure = modelPlanFailure(error);
      res.status(failure.status).json({ error: failure.error });
    }
  });
}
