import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { ServiceError } from "../errors.js"
import { parseInput } from "../http.js"
import { SESSION_COOKIE, SESSION_DURATION_MS } from "./session.js"
import type { SessionService } from "./session.js"

const loginSchema = z.object({
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(1024),
}).strict()

type AuthOptions = { allowedOrigin?: string; secureCookie: boolean }

function isAllowedOrigin(request: FastifyRequest, configuredOrigin: string | undefined): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  if (configuredOrigin) return origin === configuredOrigin
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

export function registerAuthRoutes(app: FastifyInstance, sessions: SessionService, options: AuthOptions): void {
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers["x-shuriva-request"] !== "1" || !isAllowedOrigin(request, options.allowedOrigin)) {
        throw new ServiceError("forbidden", "Request origin rejected")
      }
    }
    if (request.url.split("?")[0] === "/api/auth/login") return
    if (!sessions.isAuthenticated(request.cookies[SESSION_COOKIE])) {
      throw new ServiceError("unauthorized", "Authentication required")
    }
  })

  app.post("/api/auth/login", async (request, reply) => {
    const input = parseInput(loginSchema, request.body, "Invalid credentials")
    const session = await sessions.login(request.ip, input.username, input.password)
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: options.secureCookie,
      path: "/",
      maxAge: SESSION_DURATION_MS / 1000,
    })
    return { username: session.username }
  })

  app.get("/api/auth/session", async () => {
    const username = sessions.username()
    if (!username) throw new ServiceError("unauthorized", "Authentication required")
    return { username }
  })

  app.post("/api/auth/logout", async (request, reply) => {
    sessions.logout(request.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: "/" })
    return { ok: true }
  })
}
