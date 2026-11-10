import { createHash, randomBytes } from "node:crypto"
import { verify } from "argon2"
import { ServiceError } from "../errors.js"
import type { Storage } from "../storage.js"

export const SESSION_COOKIE = "shuriva_session"
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000

const LOGIN_WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 8
const MAX_TRACKED_IPS = 10_000
// A fixed non-credential hash makes unknown-user attempts pay the same password
// verification cost as a normal login, even before an administrator is configured.
const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=4$eircBXQEQEZr3lbSqc1MRw$88cVkX1DHSX+gJP3O9K1cd8RVcRBvk3fB3/uU/DSqgw"

type AttemptWindow = { count: number; until: number }
type AdminRow = { username: string; password_hash: string }
type PasswordVerifier = (passwordHash: string, password: string) => Promise<boolean>

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function createSessionService(storage: Storage, verifyPassword: PasswordVerifier = verify) {
  const attempts = new Map<string, AttemptWindow>()

  function reserveAttempt(ip: string, now: number): void {
    let attempt = attempts.get(ip)
    if (!attempt || attempt.until <= now) {
      if (attempts.size >= MAX_TRACKED_IPS && !attempt) {
        for (const [key, window] of attempts) {
          if (window.until <= now) attempts.delete(key)
        }
        if (attempts.size >= MAX_TRACKED_IPS) {
          throw new ServiceError("rate_limited", "Too many attempts; try again later")
        }
      }
      attempt = { count: 0, until: now + LOGIN_WINDOW_MS }
      attempts.set(ip, attempt)
    }
    if (attempt.count >= MAX_ATTEMPTS) {
      throw new ServiceError("rate_limited", "Too many attempts; try again later")
    }
    // Reserve before the async hash verification so parallel requests cannot
    // all pass the limit while verification is in flight.
    attempt.count += 1
  }

  async function login(ip: string, username: string, password: string) {
    const now = Date.now()
    reserveAttempt(ip, now)
    const admin = storage.db.prepare(
      "SELECT username, password_hash FROM admin WHERE id = 1",
    ).get() as AdminRow | undefined
    const passwordMatches = await verifyPassword(admin?.password_hash ?? DUMMY_HASH, password)
    if (!admin || username !== admin.username || !passwordMatches) {
      throw new ServiceError("unauthorized", "Invalid credentials")
    }

    const token = randomBytes(32).toString("base64url")
    storage.db.transaction(() => {
      // A password reset can happen while Argon2 runs. Do not issue a session
      // based on credentials that were revoked during that verification.
      const current = storage.db.prepare(
        "SELECT username, password_hash FROM admin WHERE id = 1",
      ).get() as AdminRow | undefined
      if (!current || current.username !== admin.username || current.password_hash !== admin.password_hash) {
        throw new ServiceError("unauthorized", "Invalid credentials")
      }
      storage.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now)
      storage.db.prepare("INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)")
        .run(hashToken(token), now + SESSION_DURATION_MS)
    }).immediate()
    attempts.delete(ip)
    return { token, username: admin.username }
  }

  function isAuthenticated(token: string | undefined): boolean {
    if (!token || token.length > 128) return false
    const session = storage.db.prepare(
      "SELECT expires_at FROM sessions WHERE token_hash = ?",
    ).get(hashToken(token)) as { expires_at: number } | undefined
    return Boolean(session && session.expires_at > Date.now())
  }

  function username(): string | null {
    const admin = storage.db.prepare("SELECT username FROM admin WHERE id = 1").get() as
      | { username: string }
      | undefined
    return admin?.username ?? null
  }

  function logout(token: string | undefined): void {
    if (token) storage.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token))
  }

  return { login, isAuthenticated, username, logout }
}

export type SessionService = ReturnType<typeof createSessionService>
