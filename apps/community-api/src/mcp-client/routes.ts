import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import type { SessionIdentity } from "../auth/public.js";
import { installHttpResponseLease } from "../http-response-lease.js";
import { diagnostics } from "../logging/public.js";
import { AuthorizationWork } from "../mcp/public.js";
import { decodeJson } from "./limits.js";
import { ExternalMcpError, uuid } from "./model.js";
import type { ExternalMcpService } from "./service.js";
export interface ExternalManagement {
  service: ExternalMcpService;
  authenticate(headers: Request["headers"]): Promise<SessionIdentity | undefined>;
}
async function sendHeld(res: Response, body: unknown, check: () => void, signal: AbortSignal) {
  const remove = installHttpResponseLease(res, check, signal);
  try {
    await new Promise<void>((yes, no) => {
      const cleanup = () => {
        res.off("finish", finished);
        res.off("close", closed);
      };
      const finished = () => {
        cleanup();
        yes();
      };
      const closed = () => {
        cleanup();
        no(new ExternalMcpError("EXTERNAL_MCP_DELIVERY_CLOSED"));
      };
      res.once("finish", finished);
      res.once("close", closed);
      try {
        check();
        res.json(body);
      } catch (e) {
        cleanup();
        no(e);
      }
    });
  } finally {
    remove();
  }
}
export function mountExternalMcp(
  server: Express,
  origin: string,
  runtime: () => ExternalManagement | undefined,
) {
  const router = express.Router();
  const authorization = new AuthorizationWork();
  let receiving = 0,
    working = 0;
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (
      (req.method !== "GET" && req.headers.origin !== origin) ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["content-encoding"]
    ) {
      res.status(403).json({ error: "EXTERNAL_MCP_ORIGIN_REJECTED" });
      return;
    }
    if (receiving >= 16) {
      res.status(429).end();
      return;
    }
    receiving++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        receiving--;
        clearTimeout(timer);
      }
    };
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(408).json({ error: "EXTERNAL_MCP_BODY_TIMEOUT" });
      req.destroy();
    }, 5000);
    res.once("close", release);
    res.once("finish", release);
    if (req.readableEnded) release();
    else req.once("end", release);
    next();
  });
  router.get("/capability", (_q, res) =>
    res.json({
      enabled: !!runtime(),
      executionHost: "platform",
      stdioProfile: "windows-amd64-trusted-node",
      writesEnabled: false,
    }),
  );
  // Raw parser, followed by pre-parse depth/member/byte validation; never allow
  // the generic JSON parser to allocate an unbounded nested structure first.
  router.use(express.raw({ type: "application/json", limit: "32kb" }));
  router.use((req, _res, next) => {
    if (Buffer.isBuffer(req.body)) req.body = decodeJson(req.body, 32768);
    next();
  });
  const run =
    (
      action: (
        req: Request,
        res: Response,
        r: ExternalManagement,
        who: SessionIdentity,
      ) => Promise<void>,
    ) =>
    async (req: Request, res: Response) => {
      if (working >= 16) throw new ExternalMcpError("EXTERNAL_MCP_REQUEST_CAPACITY", 429);
      working++;
      try {
        const r = runtime();
        if (!r) throw new ExternalMcpError("EXTERNAL_MCP_NOT_ENABLED", 503);
        const headers = { ...req.headers };
        const who = await authorization.run(() => r.authenticate(headers));
        if (!who) throw new ExternalMcpError("EXTERNAL_MCP_UNAUTHENTICATED", 401);
        if (res.destroyed || res.headersSent)
          throw new ExternalMcpError("EXTERNAL_MCP_REQUEST_EXPIRED", 408);
        await action(req, res, r, who);
      } finally {
        working--;
      }
    };
  const connection = async (req: Request, r: ExternalManagement, who: SessionIdentity) =>
    r.service.connection(who, uuid.parse(req.params.workspace), uuid.parse(req.params.id));
  const base = "/workspaces/:workspace/connections";
  router.get(
    "/health",
    run(async (_q, res, r) => {
      res.json(r.service.health());
    }),
  );
  router.get(
    "/programs",
    run(async (_q, res, r) => {
      res.json({
        programs: (await r.service.catalog.list()).map((p) => ({
          ...p,
          workingDirectoryRoot: r.service.config.runRoot,
        })),
      });
    }),
  );
  router.get(
    base,
    run(async (q, res, r, w) => {
      res.json({ connections: await r.service.list(w, uuid.parse(q.params.workspace)) });
    }),
  );
  router.post(
    base,
    run(async (q, res, r, w) => {
      const body = z.strictObject({ name: z.string(), config: z.unknown() }).parse(q.body);
      res
        .status(201)
        .json(await r.service.create(w, { ...body, workspaceId: uuid.parse(q.params.workspace) }));
    }),
  );
  router.post(
    `${base}/:id/credentials`,
    run(async (q, res, r, w) => {
      await r.service.credentials(await connection(q, r, w), w, q.body);
      res.json({ saved: true });
    }),
  );
  router.post(
    `${base}/:id/disable`,
    run(async (q, res, r, w) => {
      await r.service.disable(
        await r.service.managementConnection(
          w,
          uuid.parse(q.params.workspace),
          uuid.parse(q.params.id),
        ),
        w,
      );
      res.json({ disabled: true });
    }),
  );
  router.post(
    `${base}/:id/program-approval`,
    run(async (q, res, r, w) => {
      const b = z
        .strictObject({ installationHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(q.body);
      await r.service.approveProgram(await connection(q, r, w), w, b.installationHash);
      res.json({ approved: true });
    }),
  );
  router.post(
    `${base}/:id/discover`,
    run(async (q, res, r, w) => {
      res.json({ tools: await r.service.discover(await connection(q, r, w), w) });
    }),
  );
  router.post(
    `${base}/:id/disconnect`,
    run(async (q, res, r, w) => {
      const c = await connection(q, r, w);
      await r.service.disconnectForUser(c.id);
      res.json({ disconnected: true });
    }),
  );
  router.post(
    `${base}/:id/tools-approval`,
    run(async (q, res, r, w) => {
      const b = z
        .strictObject({
          snapshotHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          tools: z.array(z.string().min(1).max(128)).max(100),
        })
        .parse(q.body);
      await r.service.approve(await connection(q, r, w), w, b.snapshotHash ?? "", b.tools);
      res.json({ approved: b.tools.length > 0 });
    }),
  );
  router.post(
    `${base}/:id/oauth/start`,
    run(async (q, res, r, w) => {
      res.json(await r.service.startOAuth(await connection(q, r, w), w));
    }),
  );
  router.get(
    "/oauth/attempts/:attempt",
    run(async (q, res, r, w) => {
      res.json(r.service.oauth.view(w, uuid.parse(q.params.attempt)));
    }),
  );
  router.post(
    "/oauth/attempts/:attempt/finish",
    run(async (q, res, r, w) => {
      res.json(await r.service.finishOAuth(w, uuid.parse(q.params.attempt)));
    }),
  );
  router.get("/oauth/callback", async (q, res) => {
    const r = runtime();
    if (!r) throw new ExternalMcpError("EXTERNAL_MCP_NOT_ENABLED", 503);
    const b = z.record(z.string(), z.string().max(4096)).parse(q.query);
    if (Object.keys(b).length > 6)
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_CALLBACK_REJECTED");
    const id = await r.service.oauth.callback(b);
    res.redirect(303, `${origin}/?externalMcpOAuth=${encodeURIComponent(id)}`);
  });
  router.get(
    `${base}/:id/calls`,
    run(async (q, res, r, w) => {
      res.json({ calls: await r.service.invocations.history(await connection(q, r, w), w) });
    }),
  );
  router.post(
    `${base}/:id/calls`,
    run(async (q, res, r, w) => {
      const b = z
        .strictObject({ tool: z.string().min(1).max(128), arguments: z.unknown() })
        .parse(q.body);
      q.body = undefined;
      const c = await connection(q, r, w),
        pending = r.service.invocations.prepare(c, w, b.tool, b.arguments);
      b.arguments = undefined;
      res.status(201).json(await pending);
    }),
  );
  router.get(
    `${base}/:id/calls/:call/review`,
    run(async (q, res, r, w) => {
      await r.service.invocations.review(
        await connection(q, r, w),
        w,
        uuid.parse(q.params.call),
        (b, c, s) => sendHeld(res, b, c, s),
      );
    }),
  );
  router.post(
    `${base}/:id/calls/:call/confirm`,
    run(async (q, res, r, w) => {
      res
        .status(202)
        .json(
          await r.service.invocations.confirm(
            await connection(q, r, w),
            w,
            uuid.parse(q.params.call),
          ),
        );
    }),
  );
  router.post(
    `${base}/:id/calls/:call/cancel`,
    run(async (q, res, r, w) => {
      res.json(
        await r.service.invocations.cancel(await connection(q, r, w), w, uuid.parse(q.params.call)),
      );
    }),
  );
  router.post(
    `${base}/:id/calls/:call/acknowledge-unknown`,
    run(async (q, res, r, w) => {
      await r.service.invocations.acknowledge(
        await connection(q, r, w),
        w,
        uuid.parse(q.params.call),
      );
      res.json({ acknowledged: true });
    }),
  );
  router.get(
    `${base}/:id/calls/:call/result`,
    run(async (q, res, r, w) => {
      await r.service.invocations.result(
        await connection(q, r, w),
        w,
        uuid.parse(q.params.call),
        (b, c, s) => sendHeld(res, b, c, s),
      );
    }),
  );
  const error: ErrorRequestHandler = (e: unknown, _q, res, _next) => {
    diagnostics.error("mcp.external_failed", {}, e);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res
      .status(e instanceof ExternalMcpError ? e.status : e instanceof z.ZodError ? 400 : 503)
      .json({ error: e instanceof ExternalMcpError ? e.code : "EXTERNAL_MCP_REQUEST_REJECTED" });
  };
  router.use(error);
  server.use("/api/external-mcp", router);
}
