import { fromNodeHeaders } from "better-auth/node";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import type { SessionIdentity } from "../auth/public.js";
import type { ScopeCoordinator } from "../datasources/public.js";
import { declareRequestAudit } from "../history/public.js";
import { installHttpResponseLease } from "../http-response-lease.js";
import { diagnostics } from "../logging/public.js";
import { AuthorizationWork } from "./authorization-work.js";
import { BoundaryError } from "./input-limits.js";
import type { McpInvocations } from "./invocations.js";
import { clientInput, grantInput, McpError, safeCallback } from "./model.js";
import type { McpOAuthFlow } from "./oauth-flow.js";
import type { McpStore } from "./store.js";

export interface McpManagement {
  store: McpStore;
  oauth: McpOAuthFlow;
  invocations: McpInvocations;
  coordinator: ScopeCoordinator;
  authenticate(headers: Request["headers"]): Promise<SessionIdentity | undefined>;
  health?(): unknown;
  changeDraftsEnabled?: boolean;
}
const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  diagnostics.error("mcp.request_failed", {}, error);
  const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
  const status =
    error instanceof McpError || error instanceof BoundaryError
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : type === "entity.too.large"
          ? 413
          : type === "entity.parse.failed"
            ? 400
            : 503;
  res
    .status(status)
    .json({ error: error instanceof McpError ? error.code : "MCP_REQUEST_REJECTED" });
};
function receiveBudget(router: express.Router) {
  let active = 0;
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (active >= 16) {
      res.status(429).json({ error: "MCP_REQUEST_CAPACITY" });
      return;
    }
    active++;
    let finished = false;
    const release = () => {
      if (!finished) {
        finished = true;
        active--;
        clearTimeout(timer);
      }
    };
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(408).json({ error: "MCP_BODY_TIMEOUT" });
      res.once("finish", () => res.destroy());
    }, 5000);
    // This deadline bounds receiving the body, not the business operation.
    // Sending a timeout while a committed mutation continues corrupts its audit outcome.
    if (req.readableEnded) clearTimeout(timer);
    else req.once("end", () => clearTimeout(timer));
    res.once("finish", release);
    res.once("close", release);
    next();
  });
}
/** Hold both authorizations until Node finishes sending or the connection is
 * closed. Finishing only means the server sent bytes, not that a browser
 * received or processed them. */
async function leasedJson(res: Response, value: unknown, check: () => void, signal: AbortSignal) {
  const dispose = installHttpResponseLease(res, check, signal);
  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => res.destroy(), 5000);
      const done = () => {
        clearTimeout(timer);
        if (finished) resolve();
        else reject(new McpError("MCP_RESPONSE_CLOSED", 408));
      };
      res.once("finish", () => {
        finished = true;
        done();
      });
      res.once("close", done);
      try {
        signal.throwIfAborted();
        check();
        res.json(value);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  } finally {
    dispose();
  }
}
export function mountMcpManagement(
  server: Express,
  origin: string,
  runtime: () => McpManagement | undefined,
) {
  const router = express.Router(),
    work = new AuthorizationWork();
  receiveBudget(router);
  router.use((req, res, next) => {
    if (
      (req.method !== "GET" && req.headers.origin !== origin) ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["content-encoding"]
    ) {
      res.status(403).json({ error: "MCP_ORIGIN_REJECTED" });
      return;
    }
    next();
  });
  router.get("/capability", (_req, res) =>
    res.json({
      enabled: !!runtime(),
      writesEnabled: false,
      changeDraftsEnabled: runtime()?.changeDraftsEnabled === true,
      changeOriginPreviewAvailable: runtime()?.changeDraftsEnabled === true,
      independentLocalIsolation: false,
    }),
  );
  router.use(express.json({ limit: "32kb" }));
  const run =
    (
      operation: (
        req: Request,
        res: Response,
        value: McpManagement,
        identity: SessionIdentity,
      ) => Promise<void>,
    ) =>
    async (req: Request, res: Response) => {
      const value = runtime();
      if (!value) throw new McpError("MCP_NOT_ENABLED", 503);
      const identity = await work.run(() => value.authenticate(req.headers));
      if (!identity) throw new McpError("MCP_UNAUTHENTICATED", 401);
      if (res.destroyed || res.headersSent) throw new McpError("MCP_REQUEST_EXPIRED", 408);
      await operation(req, res, value, identity);
    };
  router.get(
    "/clients",
    run(async (_q, res, r, who) => {
      res.json({ clients: await r.store.clients(who.ownerId), resource: r.oauth.resource });
    }),
  );
  router.get(
    "/login/:id",
    run(async (req, res, r) => {
      res.json({ authorizationUrl: r.oauth.resumeLogin(z.string().uuid().parse(req.params.id)) });
    }),
  );
  router.get(
    "/health",
    run(async (_req, res, r) => {
      res.json({
        authorization: r.health?.() ?? null,
        recovery:
          "If authorization capacity remains unavailable, inspect diagnostics and restart the platform. Timed-out work is never silently reused.",
      });
    }),
  );
  router.post(
    "/clients",
    run(async (req, res, r, who) => {
      declareRequestAudit(res, "mcp.client_registered");
      const input = clientInput.parse(req.body);
      if (
        !safeCallback(input.redirectUri) ||
        (input.mode === "local_domain" &&
          !/^http:\/\/127\.0\.0\.1:[0-9]+\/callback$/.test(input.redirectUri))
      )
        throw new McpError("MCP_CALLBACK_INVALID");
      res.status(201).json(await r.oauth.register(who, fromNodeHeaders(req.headers), input));
    }),
  );
  router.get(
    "/grants",
    run(async (_q, res, r, who) => {
      res.json({ grants: await r.store.grants(who.ownerId) });
    }),
  );
  router.post(
    "/clients/:id/disable",
    run(async (req, res, r, who) => {
      declareRequestAudit(res, "mcp.client_disabled");
      await r.store.disableClient(who.ownerId, z.string().min(1).max(255).parse(req.params.id));
      res.json({ ok: true });
    }),
  );
  router.post(
    "/grants",
    run(async (req, res, r, who) => {
      declareRequestAudit(res, "mcp.grant_created");
      const input = grantInput.parse(req.body);
      if (input.scopes.includes("change:propose") && r.changeDraftsEnabled !== true)
        throw new McpError("MCP_WRITES_DISABLED", 403);
      const client = await r.store.client(who.ownerId, input.clientId);
      if (client?.mode === "local_domain" && !input.scopes.includes("metadata:read"))
        throw new McpError("MCP_LOCAL_METADATA_REQUIRED", 400);
      const id = await r.coordinator.withBoundIdentity(
        { ownerId: who.ownerId, ...input },
        (binding, _signal, connection) =>
          r.store.createGrant(
            connection,
            who.ownerId,
            who.sessionId,
            input,
            binding.connectorId,
            binding.bindingGeneration,
            r.oauth.resource,
          ),
      );
      res.status(201).json({ id });
    }),
  );
  router.post(
    "/grants/:id/revoke",
    run(async (req, res, r, who) => {
      declareRequestAudit(res, "mcp.grant_revoked", { targetId: String(req.params.id) });
      const id = z.string().uuid().parse(req.params.id);
      await r.store.revoke(who.ownerId, id);
      res.json({ ok: true });
    }),
  );
  router.get(
    "/consents/:id",
    run(async (req, res, r, who) => {
      res.json(await r.oauth.review(who, z.string().uuid().parse(req.params.id)));
    }),
  );
  router.post(
    "/consents/:id",
    run(async (req, res, r, who) => {
      declareRequestAudit(res, "mcp.consent_decided", { targetId: String(req.params.id) });
      const body = z.strictObject({ accept: z.boolean() }).parse(req.body);
      res.json(
        await r.oauth.consent(
          who,
          fromNodeHeaders(req.headers),
          z.string().uuid().parse(req.params.id),
          body.accept,
        ),
      );
    }),
  );
  router.get(
    "/invocations",
    run(async (_q, res, r, who) => {
      res.json({ invocations: await r.invocations.list(who.ownerId) });
    }),
  );
  router.get(
    "/invocations/:id",
    run(async (req, res, r, who) => {
      res.json(await r.invocations.review(who, z.string().uuid().parse(req.params.id)));
    }),
  );
  router.post(
    "/invocations/:id/decision",
    run(async (req, res, r, who) => {
      declareRequestAudit(res, "mcp.query_decided", { targetId: String(req.params.id) });
      const body = z
        .strictObject({ accept: z.boolean(), commitment: z.string().regex(/^[0-9a-f]{64}$/) })
        .parse(req.body);
      await r.invocations.approve(
        who,
        z.string().uuid().parse(req.params.id),
        body.commitment,
        body.accept,
      );
      res.json({ ok: true });
    }),
  );
  router.get(
    "/change-drafts/:id",
    run(async (req, res, r, who) => {
      await r.invocations.reviewChange(
        who,
        z.string().uuid().parse(req.params.id),
        (value, check, signal) => leasedJson(res, value, check, signal),
      );
    }),
  );
  router.post(
    "/change-drafts/:id/claim",
    run(async (req, res, r, who) => {
      declareRequestAudit(res, "mcp.change_claim_requested", { targetId: String(req.params.id) });
      const body = z
        .strictObject({ commitment: z.string().regex(/^[0-9a-f]{64}$/) })
        .parse(req.body);
      await r.invocations.claimChange(
        who,
        z.string().uuid().parse(req.params.id),
        body.commitment,
        (value, check, signal) => leasedJson(res, value, check, signal),
      );
    }),
  );
  router.post(
    "/change-drafts/:id/acknowledge",
    run(async (req, res, r, who) => {
      declareRequestAudit(res, "mcp.change_receipt_requested", { targetId: String(req.params.id) });
      const body = z.strictObject({ receipt: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.body);
      await r.invocations.acknowledgeChange(
        who,
        z.string().uuid().parse(req.params.id),
        body.receipt,
      );
      res.json({ ok: true });
    }),
  );
  router.use(errorHandler);
  server.use("/api/mcp", router);
}
/** Mount before the ordinary auth allowlist; all other SDK routes remain 404. */
export function mountMcpOAuth(
  server: Express,
  origin: string,
  runtime: () => McpManagement | undefined,
) {
  const router = express.Router();
  const work = new AuthorizationWork();
  receiveBudget(router);
  router.use((req, _res, next) => {
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers["content-encoding"])
      throw new McpError("MCP_ORIGIN_REJECTED", 403);
    next();
  });
  router.get("/authorize", async (req, res) => {
    await work.run(async () => {
      const r = runtime();
      if (!r) throw new McpError("MCP_NOT_ENABLED", 503);
      const who = await r.authenticate(req.headers);
      const query = req.originalUrl.split("?")[1] ?? "";
      if (!who) {
        if (res.destroyed || res.headersSent) return;
        res.redirect(await r.oauth.login(query));
        return;
      }
      res.redirect(await r.oauth.authorize(who, fromNodeHeaders(req.headers), query));
    });
  });
  router.post(
    "/token",
    express.text({ type: "application/x-www-form-urlencoded", limit: "8kb" }),
    async (req, res) => {
      await work.settle(async () => {
        const r = runtime();
        if (!r) throw new McpError("MCP_NOT_ENABLED", 503);
        if (typeof req.body !== "string") throw new McpError("MCP_OAUTH_REQUEST_INVALID");
        const response = await r.oauth.token(req.body);
        res
          .status(response.status)
          .set(Object.fromEntries(response.headers))
          .send(await response.text());
      });
    },
  );
  router.use(errorHandler);
  server.use("/api/auth/oauth2", router);
  server.get(
    [
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/openid-configuration/api/auth",
    ],
    async (req, res) => {
      const r = runtime();
      if (!r) {
        res.sendStatus(404);
        return;
      }
      try {
        const response = await work.run(() =>
          r.oauth.provider.handler(new Request(`${origin}${req.path}`)),
        );
        res
          .status(response.status)
          .set(Object.fromEntries(response.headers))
          .send(await response.text());
      } catch (error) {
        errorHandler(error, req, res, () => {});
      }
    },
  );
}
