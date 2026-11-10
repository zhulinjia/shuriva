export type ServiceErrorCode =
    | "invalid_input"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "rate_limited"
    | "unavailable"
    | "upstream_failure"

/** A safe, actionable error intended for an API caller. Never embed driver errors or secrets. */
export class ServiceError extends Error {
    readonly code: ServiceErrorCode
    readonly reason?: string

    constructor(code: ServiceErrorCode, message: string, reason?: string) {
        super(message)
        this.name = "ServiceError"
        this.code = code
        this.reason = reason
    }
}
