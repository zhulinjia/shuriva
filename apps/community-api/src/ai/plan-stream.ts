import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import type { Response } from "express";
import { DataSourceError } from "../datasources/public.js";
import type { PlanStage } from "./progress.js";

/** Only fixed public errors cross the stream boundary; provider errors are private. */
export function modelPlanFailure(error: unknown) {
  if (error instanceof DataSourceError)
    return {
      status: error.code === "INVALID" ? 400 : error.code === "NOT_FOUND" ? 404 : 409,
      error: error.code,
    };
  const message = error instanceof Error ? error.message : "";
  if (message === "STALE") return { status: 409, error: "STALE" };
  if (message === "CAPACITY") return { status: 429, error: "CAPACITY" };
  if (message === "INVALID_PLAN") return { status: 422, error: "INVALID_PLAN" };
  return { status: 503, error: "MODEL_UNAVAILABLE" };
}

/** SDK SSE framing carries observed application stages, never unvalidated model output. */
export async function streamModelPlan(
  response: Response,
  signal: AbortSignal,
  operation: (progress: (stage: PlanStage) => void) => Promise<unknown>,
): Promise<void> {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const progress = (stage: PlanStage) => {
        if (!signal.aborted)
          writer.write({ type: "data-progress", data: { stage }, transient: true });
      };
      writer.write({ type: "start" });
      try {
        const plan = await operation(progress);
        if (!signal.aborted) writer.write({ type: "data-plan", data: { plan }, transient: true });
      } catch (error) {
        if (!signal.aborted)
          writer.write({ type: "data-failure", data: modelPlanFailure(error), transient: true });
      }
      if (!signal.aborted) writer.write({ type: "finish" });
    },
    onError: () => "MODEL_UNAVAILABLE",
  });
  await pipeUIMessageStreamToResponse({
    response,
    stream,
    keepAliveMs: 5000,
    headers: { "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
