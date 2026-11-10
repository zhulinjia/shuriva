import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { ServiceError } from "../../server/errors.js"
import { testAiConnection } from "../../server/ai/provider.js"
import { createFixture, documentFor, WRITE_HEADERS } from "./fixture.js"

type ModelRequest = {
    path: string | undefined
    authorization: string | undefined
    body: { model: string; messages: { role: string; content: string }[]; response_format: unknown }
}

async function modelFixture(t: TestContext, respond: (request: ModelRequest, response: ServerResponse) => void) {
    const calls: ModelRequest[] = []
    const server = createServer((request, response) => {
        let body = ""
        request.setEncoding("utf8")
        request.on("data", (chunk: string) => {
            body += chunk
        })
        request.on("end", () => {
            const call = { path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) as ModelRequest["body"] }
            calls.push(call)
            respond(call, response)
        })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    t.after(
        () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve())
                server.closeAllConnections()
            }),
    )
    const address = server.address()
    assert.ok(address && typeof address === "object")
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls }
}

function jsonReply(response: ServerResponse, content: unknown = { ok: true }): void {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
}

test("connection testing is authenticated, contains no business context, and never saves draft settings", async (t) => {
    const { app, storage, login, createSqliteFile, createSource } = await createFixture(t)
    const cookie = await login()
    await createSource(cookie, "private-source-not-for-test", createSqliteFile("private", ["private-record-not-for-test"]))
    const model = await modelFixture(t, (_, response) => jsonReply(response))
    const original = { baseUrl: model.baseUrl, model: "saved-model", apiKey: "saved-secret" }
    const saved = await app.inject({ method: "PUT", url: "/api/settings/ai", headers: { ...WRITE_HEADERS, cookie }, payload: original })
    assert.equal(saved.statusCode, 200)
    const before = storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get()
    const draft = { ...original, model: "draft-model", apiKey: "draft-secret" }

    const anonymous = await app.inject({ method: "POST", url: "/api/settings/ai/test", headers: WRITE_HEADERS, payload: draft })
    assert.equal(anonymous.statusCode, 401)
    const crossOrigin = await app.inject({
        method: "POST",
        url: "/api/settings/ai/test",
        headers: { ...WRITE_HEADERS, cookie, origin: "https://untrusted.example" },
        payload: draft,
    })
    assert.equal(crossOrigin.statusCode, 403)
    assert.equal(model.calls.length, 0)

    const tested = await app.inject({ method: "POST", url: "/api/settings/ai/test", headers: { ...WRITE_HEADERS, cookie }, payload: draft })
    assert.equal(tested.statusCode, 200, tested.body)
    assert.equal(tested.json().ok, true)
    assert.equal(tested.json().model, "draft-model")
    assert.ok(Number.isInteger(tested.json().elapsedMs) && tested.json().elapsedMs >= 0)
    assert.ok(!tested.body.includes("secret"))
    assert.equal(model.calls.length, 1)
    const call = model.calls[0]!
    assert.equal(call.path, "/v1/chat/completions")
    assert.equal(call.authorization, "Bearer draft-secret")
    assert.deepEqual(call.body.response_format, { type: "json_object" })
    const system = call.body.messages.find((message) => message.role === "system")
    const user = call.body.messages.find((message) => message.role === "user")
    const prompt = await readFile(new URL("../../server/ai/connection-test-prompt.md", import.meta.url), "utf8")
    assert.equal(system?.content, prompt.trim())
    assert.deepEqual(JSON.parse(user?.content ?? "null"), { purpose: "connection_test" })
    assert.ok(!JSON.stringify(call.body).includes("private-source-not-for-test"))
    assert.ok(!JSON.stringify(call.body).includes("private-record-not-for-test"))
    assert.deepEqual(storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get(), before)

    const current = await app.inject({ method: "GET", url: "/api/settings/ai", headers: { cookie } })
    assert.deepEqual(current.json(), { configured: true, provider: "custom", baseUrl: model.baseUrl, model: "saved-model" })
})

test("saved keys can be reused only at the same normalized endpoint, including during save", async (t) => {
    const { app, storage, login } = await createFixture(t)
    const cookie = await login()
    const first = await modelFixture(t, (_, response) => jsonReply(response))
    const second = await modelFixture(t, (_, response) => jsonReply(response))
    const write = (url: string, payload: object, method: "POST" | "PUT" = "POST") =>
        app.inject({ method, url, headers: { ...WRITE_HEADERS, cookie }, payload })
    const missing = await write("/api/settings/ai/test", { baseUrl: first.baseUrl, model: "model" })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().code, "ai_key_required")
    await write("/api/settings/ai", { baseUrl: first.baseUrl, model: "model", apiKey: "first-secret" }, "PUT")

    const same = await write("/api/settings/ai/test", { baseUrl: first.baseUrl + "/", model: "another-model" })
    assert.equal(same.statusCode, 200)
    assert.equal(first.calls[0]?.authorization, "Bearer first-secret")
    for (const [url, method] of [
        ["/api/settings/ai/test", "POST"],
        ["/api/settings/ai", "PUT"],
    ] as const) {
        const changed = await write(url, { baseUrl: second.baseUrl, model: "model" }, method)
        assert.equal(changed.statusCode, 400)
        assert.equal(changed.json().code, "ai_key_endpoint_changed")
        assert.ok(!changed.body.includes("first-secret"))
    }
    assert.equal(second.calls.length, 0)
    const tested = await write("/api/settings/ai/test", { baseUrl: second.baseUrl, model: "model", apiKey: "second-secret" })
    assert.equal(tested.statusCode, 200)
    assert.equal(second.calls[0]?.authorization, "Bearer second-secret")
    const afterTest = await app.inject({ method: "GET", url: "/api/settings/ai", headers: { cookie } })
    assert.equal(afterTest.json().baseUrl, first.baseUrl)

    await write("/api/settings/ai", { baseUrl: second.baseUrl, model: "model", apiKey: "second-secret" }, "PUT")
    const updated = await write("/api/settings/ai", { baseUrl: second.baseUrl, model: "updated-model" }, "PUT")
    assert.equal(updated.statusCode, 200)
    assert.deepEqual(updated.json(), { configured: true, provider: "custom", baseUrl: second.baseUrl, model: "updated-model" })
    const encrypted = storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string }
    assert.ok(!encrypted.value.includes("second-secret"))
    assert.equal((storage.open(encrypted.value) as { profiles: { custom: { apiKey: string } } }).profiles.custom.apiKey, "second-secret")
})

test("model failures have safe actionable codes and do not invalidate the local session", async (t) => {
    const { app, login } = await createFixture(t)
    const cookie = await login()
    let mode: number | "invalid-json" | "invalid-shape" | "invalid-envelope" | "oversized" | "redirect" = 401
    const model = await modelFixture(t, (_, response) => {
        if (typeof mode === "number") {
            response.writeHead(mode, { "content-type": "application/json" })
            response.end(JSON.stringify({ error: { message: "raw-provider-secret" } }))
        } else if (mode === "invalid-json") {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify({ choices: [{ message: { content: "raw-provider-secret" } }] }))
        } else if (mode === "invalid-shape") jsonReply(response, { ok: false })
        else if (mode === "invalid-envelope") {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify({ unexpected: "raw-provider-secret" }))
        } else if (mode === "oversized") response.writeHead(200).end(Buffer.alloc(2_000_001, "x"))
        else response.writeHead(302, { location: "https://should-not-follow.invalid/" }).end()
    })
    const cases = [
        [401, "ai_authentication_failed"],
        [403, "ai_access_denied"],
        [404, "ai_model_unavailable"],
        [429, "ai_rate_limited"],
        [408, "ai_timeout"],
        [504, "ai_timeout"],
        [500, "ai_provider_unavailable"],
        [400, "ai_request_rejected"],
        [422, "ai_request_rejected"],
        ["invalid-json", "ai_invalid_response"],
        ["invalid-shape", "ai_invalid_response"],
        ["invalid-envelope", "ai_invalid_response"],
        ["oversized", "ai_response_too_large"],
        ["redirect", "ai_endpoint_redirect"],
    ] as const
    for (const [nextMode, code] of cases) {
        mode = nextMode
        const before = model.calls.length
        const result = await app.inject({
            method: "POST",
            url: "/api/settings/ai/test",
            headers: { ...WRITE_HEADERS, cookie },
            payload: { baseUrl: model.baseUrl, model: "model", apiKey: "request-secret" },
        })
        assert.equal(result.statusCode, 502, String(nextMode))
        assert.equal(result.json().code, code, String(nextMode))
        assert.match(result.json().error, /[\u4e00-\u9fff]/)
        assert.ok(!result.body.includes("raw-provider-secret"))
        assert.ok(!result.body.includes("request-secret"))
        assert.equal(model.calls.length, before + 1, "Failed model requests must not be retried")
    }
    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })
    assert.equal(session.statusCode, 200)
    const settings = await app.inject({ method: "GET", url: "/api/settings/ai", headers: { cookie } })
    assert.deepEqual(settings.json(), { configured: false })
})

test("connection tests reject malformed endpoints before contacting a provider", async (t) => {
    const { app, login } = await createFixture(t)
    const cookie = await login()
    for (const baseUrl of [
        "not-a-url",
        "file:///secret",
        "https://user:password@example.com/v1",
        "https://example.com/v1?",
        "https://example.com/v1#",
    ]) {
        const result = await app.inject({
            method: "POST",
            url: "/api/settings/ai/test",
            headers: { ...WRITE_HEADERS, cookie },
            payload: { baseUrl, model: "model", apiKey: "secret" },
        })
        assert.equal(result.statusCode, 400)
        assert.ok(!result.body.includes("password"))
    }
})

test("a slow provider is aborted without retrying", async (t) => {
    const model = await modelFixture(t, () => {
        /* Keep the response open until the request is aborted. */
    })
    const started = performance.now()
    await assert.rejects(
        testAiConnection({ provider: "custom", baseUrl: model.baseUrl, model: "model", apiKey: "secret" }, AbortSignal.timeout(500)),
        (error: unknown) => error instanceof ServiceError && error.reason === "ai_timeout",
    )
    assert.ok(performance.now() - started < 3_000)
    assert.equal(model.calls.length, 1)
})

test("a provider network failure is safe and is not retried", async (t) => {
    const model = await modelFixture(t, (_, response) => response.destroy())
    await assert.rejects(
        testAiConnection({ provider: "custom", baseUrl: model.baseUrl, model: "model", apiKey: "network-secret" }),
        (error: unknown) =>
            error instanceof ServiceError && error.reason === "ai_connection_failed" && !error.message.includes("network-secret"),
    )
    assert.equal(model.calls.length, 1)
})

test("a generation failure preserves the saved workspace and returns the same safe model error", async (t) => {
    const { app, login, createSource, createSqliteFile } = await createFixture(t)
    const cookie = await login()
    const sourceId = await createSource(cookie, "records", createSqliteFile("records", ["row"]))
    const current = documentFor(sourceId)
    const saved = await app.inject({ method: "POST", url: "/api/workspaces", headers: { ...WRITE_HEADERS, cookie }, payload: current })
    const model = await modelFixture(t, (_, response) => {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "provider-private" } }))
    })
    await app.inject({
        method: "PUT",
        url: "/api/settings/ai",
        headers: { ...WRITE_HEADERS, cookie },
        payload: { baseUrl: model.baseUrl, model: "model", apiKey: "secret" },
    })
    const failed = await app.inject({
        method: "POST",
        url: "/api/ai/generate",
        headers: { ...WRITE_HEADERS, cookie },
        payload: { instruction: "Change the title", datasourceIds: [sourceId], current },
    })
    assert.equal(failed.statusCode, 502)
    assert.equal(failed.json().code, "ai_authentication_failed")
    assert.ok(!failed.body.includes("provider-private"))
    const reopened = await app.inject({ method: "GET", url: `/api/workspaces/${saved.json().id}`, headers: { cookie } })
    assert.deepEqual(reopened.json(), saved.json())
})
