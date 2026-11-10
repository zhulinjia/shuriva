import Fastify, { LogController } from "fastify"
import cookie from "@fastify/cookie"
import fastifyStatic from "@fastify/static"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { registerAiRoutes } from "./ai/routes.js"
import { registerAuthRoutes } from "./auth/routes.js"
import { createSessionService } from "./auth/session.js"
import { registerDatasourceRoutes } from "./datasources/routes.js"
import { createDatasourceService } from "./datasources/service.js"
import { registerErrorHandler } from "./http.js"
import type { Storage } from "./storage.js"
import { registerWorkspaceRoutes } from "./workspaces/routes.js"
import { createWorkspaceStore } from "./workspaces/store.js"

type AppOptions = {
  serveStatic?: boolean
  enableLogging?: boolean
}

/** Compose the application; storage is owned and closed by the caller. */
export async function createApp(storage: Storage, options: AppOptions = {}) {
  const app = Fastify({
    logger: options.enableLogging ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
  })
  registerErrorHandler(app)
  await app.register(cookie)

  const sessions = createSessionService(storage)
  const sources = createDatasourceService(storage)
  const workspaces = createWorkspaceStore(storage)
  registerAuthRoutes(app, sessions, {
    allowedOrigin: process.env.SHURIVA_ORIGIN,
    secureCookie: process.env.SHURIVA_SECURE_COOKIE === "true",
  })
  registerDatasourceRoutes(app, sources)
  registerWorkspaceRoutes(app, workspaces, sources)
  registerAiRoutes(app, storage, sources)

  const assets = resolve("dist")
  if (options.serveStatic && existsSync(resolve(assets, "index.html"))) {
    await app.register(fastifyStatic, { root: assets, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" })
      return reply.sendFile("index.html")
    })
  }
  return app
}
