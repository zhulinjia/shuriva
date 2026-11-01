import express, { type ErrorRequestHandler, type Express } from "express";
import type { AuthenticateOwner } from "../connectors/public.js";
import type { ModelStore } from "./model-store.js";
import { askModel } from "./provider.js";

/** Configuration is per owner; no model call includes real schema or data here. */
export function mountModelRoutes(
  server: Express,
  owner: AuthenticateOwner,
  origin: string,
  store: ModelStore,
): void {
  const router = express.Router();
  const checking = new Set<string>();
  const lastCheck = new Map<string, number>();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.headers.origin !== origin) {
      res.status(403).json({ error: "DENIED" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "8kb" }));
  router.use(async (req, res, next) => {
    const id = await owner(req.headers);
    if (!id) {
      res.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }
    res.locals.ownerId = id;
    next();
  });
  router.get("/config", (_req, res) => {
    res.json(store.display(res.locals.ownerId as string));
  });
  router.put("/config", (req, res) => {
    store.set(res.locals.ownerId as string, req.body);
    res.json(store.display(res.locals.ownerId as string));
  });
  router.delete("/config", (_req, res) => {
    store.clear(res.locals.ownerId as string);
    res.json({ configured: false });
  });
  router.post("/check", async (req, res) => {
    const id = res.locals.ownerId as string;
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("configVersion" in body) ||
      typeof body.configVersion !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.configVersion)
    ) {
      res.status(400).json({ error: "INVALID_MODEL_REQUEST" });
      return;
    }
    const selected = store.versioned(id);
    if (!selected || selected.configVersion !== body.configVersion) {
      res.status(409).json({ error: "STALE" });
      return;
    }
    const now = Date.now();
    if (checking.has(id) || now - (lastCheck.get(id) ?? 0) < 5000) {
      res.status(429).json({ error: "RATE_LIMIT" });
      return;
    }
    const configWatch = store.watch(id, selected.configVersion);
    checking.add(id);
    lastCheck.set(id, now);
    if (lastCheck.size > 2048) {
      for (const [key, value] of lastCheck) if (now - value >= 5000) lastCheck.delete(key);
    }
    const cancel = new AbortController();
    res.once("close", () => cancel.abort());
    try {
      // Synthetic metadata only: an availability test never discloses the user's database.
      try {
        await askModel(
          selected.config,
          "请确认服务可用并返回澄清问题。",
          {
            database: "example",
            tables: [{ name: "items", columns: [{ name: "id", type: "int" }] }],
          },
          AbortSignal.any([cancel.signal, configWatch.signal]),
        );
      } catch (error) {
        if (
          configWatch.signal.aborted ||
          store.versioned(id)?.configVersion !== selected.configVersion
        )
          throw new Error("STALE");
        throw error;
      }
      if (
        configWatch.signal.aborted ||
        store.versioned(id)?.configVersion !== selected.configVersion
      )
        throw new Error("STALE");
      if (!res.destroyed) res.json({ available: true });
    } finally {
      checking.delete(id);
      configWatch.dispose();
    }
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "STALE") {
      res.status(409).json({ error: "STALE" });
      return;
    }
    if (
      message === "INVALID_MODEL" ||
      message === "INVALID_ENDPOINT" ||
      message === "INVALID_MODEL_REQUEST"
    ) {
      res.status(400).json({ error: "INVALID_MODEL" });
      return;
    }
    res.status(503).json({ error: "MODEL_UNAVAILABLE" });
  };
  router.use(errors);
  server.use("/api/model", router);
}
