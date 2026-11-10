import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { ServiceError } from "./errors.js"

const STATUS_BY_CODE = {
    invalid_input: 400,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    rate_limited: 429,
    unavailable: 503,
    upstream_failure: 502,
} as const

export const idParamsSchema = z.object({ id: z.uuid() })

export function parseInput<T extends z.ZodType>(schema: T, value: unknown, message: string): z.output<T> {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new ServiceError("invalid_input", message)
    return parsed.data
}

export function registerErrorHandler(app: FastifyInstance): void {
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ServiceError) {
            if (error.code === "unavailable" || error.code === "upstream_failure") {
                request.log.warn({ code: error.code, reason: error.reason, route: request.routeOptions.url }, "Dependency request failed")
            }
            void reply.code(STATUS_BY_CODE[error.code]).send({ error: error.message, code: error.reason ?? error.code })
            return
        }
        const code = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined
        const status = typeof code === "number" && code >= 400 && code < 500 ? code : 500
        if (status === 500) {
            // Do not log error objects: database and provider errors may contain credentials.
            request.log.error({ route: request.routeOptions.url }, "Unhandled request failure")
        }
        const message = status === 500 ? "The operation failed. Check the server configuration and try again." : "Invalid request"
        void reply.code(status).send({ error: message })
    })
}
