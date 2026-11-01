import express, { type Express, type ErrorRequestHandler } from "express";
import { z } from "zod";
import { streamModelPlan, type PlanStage } from "../../ai/public.js";
import { DataSourceError } from "../../datasources/public.js";
import { diagnostics } from "../../logging/public.js";
import { mutationId, type MutationIdentity, type MutationScope } from "../model.js";
import type { MutationAccess } from "../ports.js";
import {
  MutationAIError,
  type MutationAIPlanner,
  mutationAIPrepareSchema,
  mutationAISendSchema,
} from "./planner.js";

/** Dedicated draft endpoint: no chat history, SQL execution or automatic preview. */
export function mountMutationAIRoutes(
  server: Express,
  origin: string,
  access: MutationAccess,
  planner?: MutationAIPlanner,
): void {
  const router = express.Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST" || req.headers.origin !== origin) {
      res.status(403).json({ error: "DENIED" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "16kb" }));
  router.use(async (req, res, next) => {
    const identity = await access.authenticate(req.headers);
    if (!identity) {
      res.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }
    res.locals.mutationIdentity = identity;
    if (!planner) {
      res.status(503).json({ error: "UNAVAILABLE" });
      return;
    }
    next();
  });
  const scope = (
    req: express.Request,
    res: express.Response,
  ): MutationScope & { sessionId: string } => ({
    ownerId: (res.locals.mutationIdentity as MutationIdentity).ownerId,
    sessionId: (res.locals.mutationIdentity as MutationIdentity).sessionId,
    workspaceId: mutationId.parse(req.params.workspace),
    sourceId: mutationId.parse(req.params.source),
  });
  router.post("/prepare", async (req, res) => {
    const input = mutationAIPrepareSchema.parse(req.body);
    const cancel = new AbortController();
    res.once("close", () => cancel.abort());
    const current = scope(req, res);
    const prepared = await planner?.prepare(current, input, cancel.signal);
    diagnostics.info("mutation_ai.prepare_completed", {
      taskId: input.taskId,
      sourceId: current.sourceId,
      workspaceId: current.workspaceId,
    });
    if (!res.destroyed) res.json(prepared);
  });
  router.post("/generate", async (req, res) => {
    const input = mutationAISendSchema.parse(req.body);
    const current = scope(req, res);
    const activePlanner = planner;
    if (!activePlanner) throw new MutationAIError("UNAVAILABLE");
    const cancel = new AbortController();
    res.once("close", () => cancel.abort());
    const generate = async (progress?: (stage: PlanStage) => void) => {
      diagnostics.info("mutation_ai.plan_requested", {
        sourceId: current.sourceId,
        workspaceId: current.workspaceId,
      });
      try {
        const result = await activePlanner.generate(current, input, cancel.signal, progress);
        diagnostics.info("mutation_ai.plan_completed", {
          sourceId: current.sourceId,
          workspaceId: current.workspaceId,
        });
        return result;
      } catch (error) {
        diagnostics.warn(
          "mutation_ai.plan_failed",
          {
            sourceId: current.sourceId,
            workspaceId: current.workspaceId,
            code:
              error instanceof MutationAIError || error instanceof DataSourceError
                ? error.code
                : "MODEL_UNAVAILABLE",
          },
          error,
        );
        throw error;
      }
    };
    if (req.accepts(["json", "text/event-stream"]) === "text/event-stream")
      await streamModelPlan(res, cancel.signal, generate);
    else {
      const plan = await generate();
      if (!res.destroyed) res.json({ plan });
    }
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      (error.type === "entity.too.large" || error.type === "entity.parse.failed")
    ) {
      res.status(error.type === "entity.too.large" ? 413 : 400).json({ error: "INVALID" });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "INVALID" });
      return;
    }
    if (error instanceof DataSourceError) {
      res.status(error.code === "NOT_FOUND" ? 404 : 409).json({ error: error.code });
      return;
    }
    const code = error instanceof Error ? error.message : "";
    if (code === "STALE") {
      res.status(409).json({ error: "STALE" });
      return;
    }
    if (code === "CAPACITY") {
      res.status(429).json({ error: "CAPACITY" });
      return;
    }
    if (code === "NO_MODEL_FIELDS" || code === "SEMANTICS_TOO_LARGE") {
      res.status(409).json({ error: code });
      return;
    }
    if (code === "INVALID_PLAN") {
      res.status(422).json({ error: "INVALID_PLAN" });
      return;
    }
    diagnostics.error("mutation_ai.request_failed", {}, error);
    res.status(503).json({ error: "MODEL_UNAVAILABLE" });
  };
  router.use(errors);
  server.use("/api/mutations/:workspace/:source/ai", router);
}
