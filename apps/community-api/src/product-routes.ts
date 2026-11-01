import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { diagnostics } from "./logging/public.js";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";
import type { Pool } from "mysql2/promise";
import type { Auth } from "./auth.js";
import { WorkspaceStore, workspaceName } from "./workspaces.js";

const workspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function mountProductRoutes(
  server: Express,
  auth: Auth,
  pool: Pool,
  origin: string,
  workspaceStore?: WorkspaceStore,
  archiveWorkspace?: (
    ownerId: string,
    workspaceId: string,
    operation: () => Promise<boolean>,
  ) => Promise<boolean>,
): void {
  const authHandler = toNodeHandler(auth);
  server.use(
    "/api/auth",
    (req, res, next) => {
      const allowed =
        (req.method === "POST" &&
          ["/sign-in/username", "/sign-out", "/change-password"].includes(req.path)) ||
        (req.method === "GET" && req.path === "/get-session");
      if (!allowed) {
        res.sendStatus(404);
        return;
      }
      next();
    },
    authHandler,
  );
  const store = workspaceStore ?? new WorkspaceStore(pool);
  const router = express.Router();
  router.use((req, res, next) => {
    if (!req.path.startsWith("/workspaces") && !req.path.startsWith("/security")) {
      next("router");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.headers.origin !== origin) {
      res.status(403).json({ error: "请求来源无效" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "8kb" }));
  async function currentSession(req: Request, res: Response) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    return session;
  }
  router.get("/workspaces", async (req, res) => {
    const current = await currentSession(req, res);
    if (!current) return;
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    if (after && !/^[0-9a-f-]{36}$/i.test(after)) {
      res.status(400).json({ error: "分页参数无效" });
      return;
    }
    if (
      req.query.archived !== undefined &&
      req.query.archived !== "true" &&
      req.query.archived !== "false"
    ) {
      res.status(400).json({ error: "归档参数无效" });
      return;
    }
    res.json(await store.list(current.user.id, req.query.archived === "true", after));
  });
  router.post("/workspaces", async (req, res) => {
    const current = await currentSession(req, res);
    if (!current) return;
    const name = workspaceName(req.body);
    if (!name) {
      res.status(400).json({ error: "工作区名称须为 1 至 120 个字符" });
      return;
    }
    res.status(201).json(await store.create(current.user.id, name));
  });
  router.patch("/workspaces/:id", async (req, res) => {
    const current = await currentSession(req, res);
    if (!current) return;
    const name = workspaceName(req.body);
    if (!name) {
      res.status(400).json({ error: "工作区名称须为 1 至 120 个字符" });
      return;
    }
    if (!(await store.rename(current.user.id, req.params.id, name))) {
      res.status(404).json({ error: "工作区不存在或已归档" });
      return;
    }
    res.json({ id: req.params.id, name });
  });
  router.post("/workspaces/:id/archive", async (req, res) => {
    const current = await currentSession(req, res);
    if (!current) return;
    if (!workspaceId.test(req.params.id)) {
      res.status(404).json({ error: "工作区不存在或已归档" });
      return;
    }
    const archive = () => store.setArchived(current.user.id, req.params.id, true);
    const archived = archiveWorkspace
      ? await archiveWorkspace(current.user.id, req.params.id, archive)
      : await archive();
    if (!archived) {
      res.status(404).json({ error: "工作区不存在或已归档" });
      return;
    }
    res.json({ ok: true });
  });
  router.post("/workspaces/:id/restore", async (req, res) => {
    const current = await currentSession(req, res);
    if (!current) return;
    if (!(await store.setArchived(current.user.id, req.params.id, false))) {
      res.status(404).json({ error: "工作区不存在或未归档" });
      return;
    }
    res.json({ ok: true });
  });
  router.get("/security/sessions", async (req, res) => {
    const current = await currentSession(req, res);
    if (!current) return;
    const sessions = await auth.api.listSessions({ headers: fromNodeHeaders(req.headers) });
    res.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        userAgent: session.userAgent,
        current: session.id === current.session.id,
      })),
    });
  });
  router.post("/security/sessions/:id/revoke", async (req, res) => {
    const current = await currentSession(req, res);
    if (!current) return;
    const headers = fromNodeHeaders(req.headers);
    const sessions = await auth.api.listSessions({ headers });
    const target = sessions.find((session) => session.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    await auth.api.revokeSession({ headers, body: { token: target.token } });
    res.json({ ok: true, current: target.id === current.session.id });
  });
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const kind = error && typeof error === "object" && "type" in error ? error.type : undefined;
    if (kind === "entity.parse.failed") {
      res.status(400).json({ error: "请求格式无效" });
      return;
    }
    if (kind === "entity.too.large") {
      res.status(413).json({ error: "请求内容过大" });
      return;
    }
    diagnostics.error("product.request_failed", {}, error);
    res.status(500).json({ error: "服务暂不可用，请稍后重试" });
  };
  router.use(handleError);
  server.use("/api", router);
}
