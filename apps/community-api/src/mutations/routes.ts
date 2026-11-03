import express, { type ErrorRequestHandler, type Express } from "express";
import { z } from "zod";
import { DataSourceError } from "../datasources/public.js";
import { diagnostics } from "../logging/public.js";
import {
  confirmationSchema,
  MutationError,
  type MutationIdentity,
  type MutationScope,
  mutationId,
} from "./model.js";
import type { MutationAccess } from "./ports.js";
import type { MutationService } from "./service.js";

const empty = z.strictObject({});
const pathId = (value: unknown) => mutationId.parse(value);
export function mountMutationRoutes(
  server: Express,
  origin: string,
  access: MutationAccess,
  service?: MutationService,
  provenance?: {
    verify(
      identity: MutationIdentity,
      scope: MutationScope,
      id: string,
      plan: unknown,
    ): {
      invocationId: string;
      planChanged: boolean;
      connectorId: string;
      bindingGeneration: string;
    };
    record(
      identity: MutationIdentity,
      scope: MutationScope,
      proof: {
        invocationId: string;
        planChanged: boolean;
        connectorId: string;
        bindingGeneration: string;
      },
      previewId: string,
    ): Promise<void>;
  },
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
  router.use(express.json({ limit: "1152kb" }));
  router.use(async (req, res, next) => {
    const identity = await access.authenticate(req.headers);
    if (!identity) {
      res.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }
    res.locals.mutationIdentity = identity;
    next();
  });
  router.use((_req, res, next) => {
    if (!service) {
      res.status(503).json({ error: "UNAVAILABLE" });
      return;
    }
    next();
  });
  const identity = (res: express.Response): MutationIdentity =>
    res.locals.mutationIdentity as MutationIdentity;
  const scope = (req: express.Request, res: express.Response): MutationScope => ({
    ownerId: identity(res).ownerId,
    workspaceId: pathId(req.params.workspace),
    sourceId: pathId(req.params.source),
  });
  const prefix = "/:workspace/:source";
  router.get(`${prefix}/capability`, async (req, res) =>
    res.json(await service?.capability(scope(req, res))),
  );
  router.post(`${prefix}/previews`, async (req, res) => {
    const body = z
      .strictObject({ plan: z.unknown(), originInvocationId: mutationId.optional() })
      .parse(req.body);
    const current = scope(req, res),
      who = identity(res);
    if (body.originInvocationId && !provenance) throw new MutationError("UNAVAILABLE");
    let proof:
      | {
          invocationId: string;
          planChanged: boolean;
          connectorId: string;
          bindingGeneration: string;
        }
      | undefined;
    if (body.originInvocationId) {
      try {
        proof = provenance?.verify(who, current, body.originInvocationId, body.plan);
      } catch {
        res.status(503).json({ error: "MCP_CHANGE_ORIGIN_UNAVAILABLE" });
        return;
      }
      if (!proof) {
        res.status(503).json({ error: "MCP_CHANGE_ORIGIN_UNAVAILABLE" });
        return;
      }
    }
    const preview = await service?.preview(current, body.plan, proof);
    if (!preview) throw new MutationError("UNAVAILABLE");
    if (proof) {
      const fresh = await access.authenticate(req.headers);
      if (!fresh || fresh.ownerId !== who.ownerId || fresh.sessionId !== who.sessionId)
        throw new MutationError("DENIED");
      await provenance?.record(who, current, proof, preview.previewId);
    }
    res.status(201).json({ ...preview, ...(proof ? { origin: proof } : {}) });
  });
  router.post(`${prefix}/previews/:preview/confirm`, async (req, res) => {
    const body = confirmationSchema.parse(req.body);
    if (body.previewId !== pathId(req.params.preview)) throw new MutationError("INVALID");
    res.status(202).json(await service?.confirm(scope(req, res), identity(res), body));
  });
  router.get(`${prefix}/confirmations/:id`, async (req, res) =>
    res.json(await service?.confirmation(scope(req, res), pathId(req.params.id))),
  );
  router.post(`${prefix}/confirmations/:id/close`, async (req, res) => {
    const body = confirmationSchema.parse(req.body);
    if (body.confirmationId !== pathId(req.params.id)) throw new MutationError("INVALID");
    res.json(await service?.closeConfirmation(scope(req, res), body));
  });
  router.get(`${prefix}/executions`, async (req, res) => {
    const query = z
      .strictObject({
        after: z
          .string()
          .regex(/^[1-9][0-9]{0,19}$/)
          .optional(),
      })
      .parse(req.query);
    res.json(await service?.list(scope(req, res), query.after));
  });
  router.get(`${prefix}/receipts`, async (req, res) => {
    const query = z.strictObject({ after: z.string().min(1).max(80).optional() }).parse(req.query);
    res.json(await service?.receipts(scope(req, res), query.after));
  });
  router.get(`${prefix}/executions/:id`, async (req, res) =>
    res.json(await service?.get(scope(req, res), pathId(req.params.id))),
  );
  router.post(`${prefix}/executions/:id/cancel`, async (req, res) => {
    empty.parse(req.body);
    res.json(await service?.cancel(scope(req, res), pathId(req.params.id)));
  });
  router.post(`${prefix}/recovery`, async (req, res) => {
    empty.parse(req.body);
    res.json(await service?.recovery(scope(req, res)));
  });
  const handler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "INVALID" });
      return;
    }
    if (error instanceof MutationError || error instanceof DataSourceError) {
      const code = error.code;
      const status =
        code === "NOT_FOUND"
          ? 404
          : code === "INVALID"
            ? 400
            : code === "DENIED"
              ? 403
              : code === "UNAVAILABLE" || code === "CAPACITY"
                ? 503
                : 409;
      res.status(status).json({ error: code });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      (error.type === "entity.parse.failed" || error.type === "entity.too.large")
    ) {
      res.status(400).json({ error: "INVALID" });
      return;
    }
    diagnostics.error("mutation.request_failed", {}, error);
    res.status(503).json({ error: "UNAVAILABLE" });
  };
  router.use(handler);
  server.use("/api/mutations", router);
}
