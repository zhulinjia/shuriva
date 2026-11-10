import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { AI_PROVIDER_PRESETS, initialAiModels } from "../../src/shared/ai-settings.js"
import { workspaceDocumentSchema } from "../../src/shared/workspace-schema.js"
import { createFixture, documentFor, WRITE_HEADERS } from "./fixture.js"

type MessageContent = string | { type: string; text?: string }[]
type ModelBody = {
    model: string
    system?: MessageContent
    messages: { role: string; content: MessageContent }[]
    response_format?: { type: string }
    output_config?: { format?: { type: string; schema: unknown } }
    max_tokens?: number
    max_completion_tokens?: number
}
type ModelCall = { path?: string; bearer?: string; key?: string; version?: string; body: ModelBody }

function textContent(content: MessageContent | undefined): string {
    return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("")
}

function reply(response: ServerResponse, call: ModelCall, output: unknown): void {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
        JSON.stringify(
            call.path?.endsWith("/messages")
                ? {
                      id: "msg_test",
                      type: "message",
                      role: "assistant",
                      model: call.body.model,
                      content: [{ type: "text", text: JSON.stringify(output) }],
                      stop_reason: "end_turn",
                      stop_sequence: null,
                      usage: { input_tokens: 1, output_tokens: 1 },
                  }
                : {
                      id: "chatcmpl_test",
                      object: "chat.completion",
                      created: 1,
                      model: call.body.model,
                      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
                      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                  },
        ),
    )
}

async function providerFixture(t: TestContext, respond: (call: ModelCall, response: ServerResponse) => void) {
    const calls: ModelCall[] = []
    const server = createServer((request, response) => {
        let body = ""
        request.setEncoding("utf8")
        request.on("data", (chunk: string) => {
            body += chunk
        })
        request.on("end", () => {
            const call: ModelCall = {
                path: request.url,
                bearer: request.headers.authorization,
                key: typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined,
                version: typeof request.headers["anthropic-version"] === "string" ? request.headers["anthropic-version"] : undefined,
                body: JSON.parse(body) as ModelBody,
            }
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

test("each preset uses its own protocol for connection tests and controlled workspace generation", async (t) => {
    for (const provider of ["deepseek", "openai", "anthropic", "custom"] as const) {
        await t.test(provider, async (t) => {
            const { app, login, createSource, createSqliteFile } = await createFixture(t)
            const cookie = await login()
            const rowName = `private-${provider}-record`
            const sourceId = await createSource(cookie, "private-source", createSqliteFile(provider, [rowName]))
            const document = documentFor(sourceId)
            let mode: "normal" | "invalid-workspace" | "unauthorized" | "redirect" = "normal"
            const model = await providerFixture(t, (call, response) => {
                if (mode === "unauthorized") {
                    response.writeHead(401, { "content-type": "application/json" }).end(
                        JSON.stringify({
                            type: "error",
                            error: { type: "authentication_error", message: "raw-secret-model-error" },
                        }),
                    )
                    return
                }
                if (mode === "redirect") {
                    response.writeHead(302, { location: "https://do-not-follow.invalid/" }).end()
                    return
                }
                const user = call.body.messages.find((message) => message.role === "user")
                const context = JSON.parse(textContent(user?.content)) as { purpose?: string }
                reply(
                    response,
                    call,
                    context.purpose === "connection_test"
                        ? { ok: true }
                        : mode === "invalid-workspace"
                          ? { ...document, components: [{ id: "bad", type: "html", html: "injected-script" }] }
                          : document,
                )
            })
            const settings = {
                provider,
                baseUrl: model.baseUrl,
                model: AI_PROVIDER_PRESETS[provider].defaultModel || "test-model",
                apiKey: `${provider}-private-key`,
            }
            const saved = await app.inject({
                method: "PUT",
                url: "/api/settings/ai",
                headers: { ...WRITE_HEADERS, cookie },
                payload: settings,
            })
            assert.equal(saved.statusCode, 200)
            assert.equal(saved.json().provider, provider)
            const tested = await app.inject({
                method: "POST",
                url: "/api/settings/ai/test",
                headers: { ...WRITE_HEADERS, cookie },
                payload: { provider, baseUrl: model.baseUrl, model: settings.model },
            })
            assert.equal(tested.statusCode, 200, tested.body)
            assert.equal(tested.json().provider, provider)
            assert.equal(model.calls.length, 1)
            const first = model.calls[0]!
            assert.equal(first.body.model, settings.model)
            if (provider === "anthropic") {
                assert.equal(first.path, "/v1/messages")
                assert.equal(first.bearer, undefined)
                assert.equal(first.key, settings.apiKey)
                assert.equal(first.version, "2023-06-01")
                assert.equal(first.body.output_config?.format?.type, "json_schema")
                assert.equal(first.body.max_tokens, 2_048)
                assert.ok(textContent(first.body.system).includes("模型连接测试"))
            } else {
                assert.equal(first.path, "/v1/chat/completions")
                assert.equal(first.bearer, `Bearer ${settings.apiKey}`)
                assert.equal(first.key, undefined)
                assert.equal(first.body.response_format?.type, "json_object")
                if (provider === "openai") {
                    assert.equal(first.body.max_completion_tokens, 2_048)
                    assert.equal(first.body.max_tokens, undefined)
                }
            }
            assert.ok(!JSON.stringify(first.body).includes(rowName))
            assert.ok(!JSON.stringify(first.body).includes("private-source"))
            const generate = () =>
                app.inject({
                    method: "POST",
                    url: "/api/ai/generate",
                    headers: { ...WRITE_HEADERS, cookie },
                    payload: { instruction: "Show records", datasourceIds: [sourceId] },
                })
            const generated = await generate()
            assert.equal(generated.statusCode, 200, generated.body)
            assert.deepEqual(generated.json().document, workspaceDocumentSchema.parse(document))
            assert.ok(!JSON.stringify(model.calls[1]?.body).includes(rowName))
            const preview = await app.inject({
                method: "POST",
                url: "/api/workspaces/preview",
                headers: { ...WRITE_HEADERS, cookie },
                payload: generated.json().document.queries[0],
            })
            assert.equal(preview.statusCode, 200)
            assert.equal(preview.json().rows[0].name, rowName)
            mode = "invalid-workspace"
            const invalid = await generate()
            assert.equal(invalid.statusCode, 502)
            assert.ok(!invalid.body.includes("injected-script"))
            mode = "unauthorized"
            const before = model.calls.length
            const rejected = await app.inject({
                method: "POST",
                url: "/api/settings/ai/test",
                headers: { ...WRITE_HEADERS, cookie },
                payload: settings,
            })
            assert.equal(rejected.statusCode, 502)
            assert.equal(rejected.json().code, "ai_authentication_failed")
            assert.ok(!rejected.body.includes("raw-secret-model-error"))
            assert.ok(!rejected.body.includes(settings.apiKey))
            assert.equal(model.calls.length, before + 1)
            mode = "redirect"
            const redirect = await app.inject({
                method: "POST",
                url: "/api/settings/ai/test",
                headers: { ...WRITE_HEADERS, cookie },
                payload: settings,
            })
            assert.equal(redirect.json().code, "ai_endpoint_redirect")
            assert.equal(model.calls.length, before + 2)
        })
    }
})

test("legacy configurations stay custom and switching protocol cannot reuse a saved key", async (t) => {
    const { app, storage, login } = await createFixture(t)
    const cookie = await login()
    const model = await providerFixture(t, (call, response) => reply(response, call, { ok: true }))
    const legacy = storage.seal({ baseUrl: model.baseUrl, model: "legacy-model", apiKey: "legacy-secret" })
    storage.db.prepare("INSERT INTO settings(key, value) VALUES ('ai', ?)").run(legacy)
    const settings = await app.inject({ method: "GET", url: "/api/settings/ai", headers: { cookie } })
    assert.deepEqual(settings.json(), { configured: true, provider: "custom", baseUrl: model.baseUrl, model: "legacy-model" })
    assert.deepEqual(storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get(), { value: legacy })
    for (const [url, method] of [
        ["/api/settings/ai/test", "POST"],
        ["/api/settings/ai", "PUT"],
    ] as const) {
        const rejected = await app.inject({
            method,
            url,
            headers: { ...WRITE_HEADERS, cookie },
            payload: { provider: "anthropic", baseUrl: model.baseUrl, model: "claude-sonnet-5-5" },
        })
        assert.equal(rejected.statusCode, 400)
        assert.equal(rejected.json().code, "ai_key_provider_changed")
        assert.ok(!rejected.body.includes("legacy-secret"))
    }
    assert.equal(model.calls.length, 0)
    const legacyTest = await app.inject({
        method: "POST",
        url: "/api/settings/ai/test",
        headers: { ...WRITE_HEADERS, cookie },
        payload: { baseUrl: model.baseUrl, model: "legacy-model" },
    })
    assert.equal(legacyTest.statusCode, 200)
    assert.equal(model.calls[0]?.bearer, "Bearer legacy-secret")
    const newTest = await app.inject({
        method: "POST",
        url: "/api/settings/ai/test",
        headers: { ...WRITE_HEADERS, cookie },
        payload: { provider: "anthropic", baseUrl: model.baseUrl, model: "claude-sonnet-5-5", apiKey: "new-provider-secret" },
    })
    assert.equal(newTest.statusCode, 200, newTest.body)
    assert.equal(model.calls[1]?.key, "new-provider-secret")
    assert.equal(model.calls[1]?.bearer, undefined)
    const unchanged = await app.inject({ method: "GET", url: "/api/settings/ai", headers: { cookie } })
    assert.equal(unchanged.json().provider, "custom")
    const unknown = await app.inject({
        method: "POST",
        url: "/api/settings/ai/test",
        headers: { ...WRITE_HEADERS, cookie },
        payload: { provider: "unregistered", baseUrl: model.baseUrl, model: "model", apiKey: "secret" },
    })
    assert.equal(unknown.statusCode, 400)
    assert.equal(model.calls.length, 2)
    const upgraded = await app.inject({
        method: "PUT",
        url: "/api/settings/ai",
        headers: { ...WRITE_HEADERS, cookie },
        payload: { provider: "anthropic", baseUrl: model.baseUrl, model: "claude-sonnet-5-5", apiKey: "new-provider-secret" },
    })
    assert.equal(upgraded.statusCode, 200)
    const profiles = await app.inject({ method: "GET", url: "/api/settings/ai/providers", headers: { cookie } })
    assert.equal(profiles.json().activeProvider, "custom")
    assert.equal(profiles.json().providers.filter((profile: { configured: boolean }) => profile.configured).length, 2)
    const legacyAgain = await app.inject({
        method: "POST",
        url: "/api/settings/ai/test",
        headers: { ...WRITE_HEADERS, cookie },
        payload: { baseUrl: model.baseUrl, model: "legacy-model" },
    })
    assert.equal(legacyAgain.statusCode, 200)
    assert.equal(model.calls[2]?.bearer, "Bearer legacy-secret", "Upgrading must preserve the previous provider's credential")
})

test("provider profiles persist independently and generation changes only after explicit activation", async (t) => {
    const { app, storage, login, createSource, createSqliteFile } = await createFixture(t)
    const cookie = await login()
    const sourceId = await createSource(cookie, "records", createSqliteFile("records", ["row"]))
    const document = documentFor(sourceId)
    const model = await providerFixture(t, (call, response) => {
        const user = call.body.messages.find((message) => message.role === "user")
        const context = JSON.parse(textContent(user?.content)) as { purpose?: string }
        reply(response, call, context.purpose === "connection_test" ? { ok: true } : document)
    })
    const read = (url = "/api/settings/ai/providers") => app.inject({ method: "GET", url, headers: { cookie } })
    const write = (url: string, payload: object, method: "POST" | "PUT" = "POST") =>
        app.inject({ method, url, headers: { ...WRITE_HEADERS, cookie }, payload })
    const empty = await read()
    assert.equal(empty.json().activeProvider, null)
    assert.equal(empty.json().providers.length, 4)
    const first = await write(
        "/api/settings/ai",
        { provider: "deepseek", baseUrl: model.baseUrl, model: "ds-model", apiKey: "ds-secret" },
        "PUT",
    )
    assert.equal(first.statusCode, 200)
    assert.equal((await read()).json().activeProvider, "deepseek", "The first saved configuration becomes active")
    const saves = await Promise.all(
        ["openai", "anthropic"].map((provider) =>
            write(
                "/api/settings/ai",
                {
                    provider,
                    baseUrl: model.baseUrl,
                    model: `${provider}-model`,
                    apiKey: `${provider}-secret`,
                },
                "PUT",
            ),
        ),
    )
    assert.ok(saves.every((result) => result.statusCode === 200))
    const profiles = await read()
    assert.equal(profiles.json().activeProvider, "deepseek", "Saving another provider must not change the active one")
    assert.equal(profiles.json().providers.filter((profile: { configured: boolean }) => profile.configured).length, 3)
    assert.ok(!profiles.body.includes("secret"))
    assert.ok(!profiles.body.includes("apiKey"))
    const stored = storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string }
    assert.ok(!stored.value.includes("secret"))
    assert.equal((storage.open(stored.value) as { version: number }).version, 3)

    const tested = await write("/api/settings/ai/test", { provider: "anthropic", baseUrl: model.baseUrl, model: "draft-model" })
    assert.equal(tested.statusCode, 200, tested.body)
    assert.equal(model.calls.at(-1)?.key, "anthropic-secret", "Inactive providers reuse only their own stored credential")
    assert.equal((await read()).json().activeProvider, "deepseek")
    assert.equal(
        (await read()).json().providers.find((profile: { provider: string }) => profile.provider === "anthropic").model,
        "anthropic-model",
    )
    const generate = () => write("/api/ai/generate", { instruction: "Show records", datasourceIds: [sourceId] })
    assert.equal((await generate()).statusCode, 200)
    assert.equal(model.calls.at(-1)?.bearer, "Bearer ds-secret")
    for (const provider of ["openai", "anthropic", "deepseek"] as const) {
        const activated = await write("/api/settings/ai/active", { provider })
        assert.equal(activated.statusCode, 200)
        assert.equal(activated.json().activeProvider, provider)
        assert.ok(!activated.body.includes("secret"))
        assert.equal((await read("/api/settings/ai")).json().provider, provider)
        assert.equal((await generate()).statusCode, 200)
        const call = model.calls.at(-1)!
        assert.equal(
            provider === "anthropic" ? call.key : call.bearer,
            provider === "anthropic" ? "anthropic-secret" : `Bearer ${provider === "deepseek" ? "ds" : "openai"}-secret`,
        )
    }
    const missing = await write("/api/settings/ai/active", { provider: "custom" })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().code, "ai_provider_not_configured")
    assert.equal((await read()).json().activeProvider, "deepseek")
    assert.equal((await write("/api/settings/ai/active", { provider: "unregistered" })).statusCode, 400)
    assert.equal((await app.inject({ method: "GET", url: "/api/settings/ai/providers" })).statusCode, 401)
    assert.equal(
        (await app.inject({ method: "POST", url: "/api/settings/ai/active", headers: WRITE_HEADERS, payload: { provider: "openai" } }))
            .statusCode,
        401,
    )
    assert.equal(
        (
            await app.inject({
                method: "POST",
                url: "/api/settings/ai/active",
                headers: { ...WRITE_HEADERS, cookie, origin: "https://untrusted.example" },
                payload: { provider: "openai" },
            })
        ).statusCode,
        403,
    )
    assert.equal((await read()).json().activeProvider, "deepseek")
})

test("all registered model IDs reach their native SDK unchanged and per-request selection preserves global defaults", async (t) => {
    const { app, login, createSource, createSqliteFile } = await createFixture(t)
    const cookie = await login()
    const sourceId = await createSource(cookie, "records", createSqliteFile("records", ["row"]))
    const document = documentFor(sourceId)
    const model = await providerFixture(t, (call, response) => {
        const user = call.body.messages.find((message) => message.role === "user")
        const context = JSON.parse(textContent(user?.content)) as { purpose?: string }
        reply(response, call, context.purpose === "connection_test" ? { ok: true } : document)
    })
    const write = (url: string, payload: object, method: "POST" | "PUT" = "POST") =>
        app.inject({ method, url, headers: { ...WRITE_HEADERS, cookie }, payload })
    const read = () => app.inject({ method: "GET", url: "/api/settings/ai/providers", headers: { cookie } })
    for (const provider of ["deepseek", "openai", "anthropic"] as const) {
        const result = await write(
            "/api/settings/ai/providers",
            {
                provider,
                baseUrl: model.baseUrl,
                apiKey: `${provider}-key`,
                defaultModel: AI_PROVIDER_PRESETS[provider].defaultModel,
                models: initialAiModels(provider),
            },
            "PUT",
        )
        assert.equal(result.statusCode, 200, result.body)
        assert.ok(!result.body.includes("apiKey"))
    }
    assert.deepEqual(AI_PROVIDER_PRESETS.deepseek.models, ["deepseek-flash"])
    await write("/api/settings/ai/active", { provider: "openai" })
    const beforeSelections = (await read()).json()
    for (const provider of ["deepseek", "openai", "anthropic"] as const) {
        for (const modelId of AI_PROVIDER_PRESETS[provider].models) {
            const generated = await write("/api/ai/generate", {
                instruction: "Show records",
                datasourceIds: [sourceId],
                aiModel: { provider, modelId },
            })
            assert.equal(generated.statusCode, 200, generated.body)
            assert.equal(model.calls.at(-1)?.body.model, modelId)
            assert.equal(model.calls.at(-1)?.path, provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions")
            assert.equal(
                provider === "anthropic" ? model.calls.at(-1)?.key : model.calls.at(-1)?.bearer,
                provider === "anthropic" ? `${provider}-key` : `Bearer ${provider}-key`,
            )
            const tested = await write("/api/settings/ai/test", { provider, baseUrl: model.baseUrl, model: modelId })
            assert.equal(tested.statusCode, 200, tested.body)
            assert.equal(model.calls.at(-1)?.body.model, modelId)
        }
    }
    assert.deepEqual((await read()).json(), beforeSelections)
    const generateDefault = () => write("/api/ai/generate", { instruction: "Show records", datasourceIds: [sourceId] })
    assert.equal((await generateDefault()).statusCode, 200)
    assert.equal(model.calls.at(-1)?.body.model, "gpt-5.4-mini")
    const profile = { provider: "openai", baseUrl: model.baseUrl, defaultModel: "gpt-5.4", models: initialAiModels("openai") }
    const saved = await write("/api/settings/ai/providers", profile, "PUT")
    assert.equal(saved.statusCode, 200)
    assert.equal((await generateDefault()).statusCode, 200)
    assert.equal(model.calls.at(-1)?.body.model, "gpt-5.4")
    const disabled = { ...profile, models: profile.models.map((item) => ({ ...item, enabled: item.id !== "gpt-5.4-mini" })) }
    assert.equal((await write("/api/settings/ai/providers", disabled, "PUT")).statusCode, 200)
    const count = model.calls.length
    for (const aiModel of [
        { provider: "openai", modelId: "gpt-5.4-mini" },
        { provider: "openai", modelId: "unregistered-model" },
        { provider: "custom", modelId: "test-model" },
        { provider: "openai", modelId: "gpt-5.4", baseUrl: "http://do-not-contact.invalid" },
    ]) {
        const rejected = await write("/api/ai/generate", { instruction: "Show records", datasourceIds: [sourceId], aiModel })
        assert.equal(rejected.statusCode, 400)
    }
    assert.equal(model.calls.length, count, "Rejected selections must not contact any model service")
    assert.equal((await read()).json().activeProvider, "openai")
    assert.equal((await generateDefault()).statusCode, 200)
    assert.equal(model.calls.at(-1)?.body.model, "gpt-5.4")
})

test("model lists enforce unique IDs, enabled defaults, endpoint key boundaries and authenticated writes", async (t) => {
    const { app, storage, login } = await createFixture(t)
    const cookie = await login()
    const payload = {
        provider: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        defaultModel: "gpt-5.4-mini",
        models: initialAiModels("openai"),
        apiKey: "profile-secret",
    }
    const write = (input: object, headers: Record<string, string> = { ...WRITE_HEADERS, cookie }) =>
        app.inject({ method: "PUT", url: "/api/settings/ai/providers", headers, payload: input })
    assert.equal((await write(payload)).statusCode, 200)
    const before = storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get()
    for (const invalid of [
        { ...payload, models: [] },
        { ...payload, models: [payload.models[0], payload.models[0]] },
        { ...payload, defaultModel: "unregistered" },
        { ...payload, models: payload.models.map((item) => ({ ...item, enabled: false })) },
        { ...payload, models: [{ id: "", label: "", enabled: true }] },
        { ...payload, models: [{ ...payload.models[0], apiKey: "nested-key" }] },
    ])
        assert.equal((await write(invalid)).statusCode, 400)
    const changedEndpoint = await write({ ...payload, apiKey: undefined, baseUrl: "http://127.0.0.1:2/v1" })
    assert.equal(changedEndpoint.json().code, "ai_key_endpoint_changed")
    const changedProvider = await write({ ...payload, apiKey: undefined, provider: "anthropic" })
    assert.equal(changedProvider.json().code, "ai_key_provider_changed")
    assert.equal((await write(payload, WRITE_HEADERS)).statusCode, 401)
    assert.equal((await write(payload, { ...WRITE_HEADERS, cookie, origin: "https://untrusted.example" })).statusCode, 403)
    assert.deepEqual(storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get(), before)
})

test("v2 provider configurations upgrade on write without losing keys, defaults or existing models", async (t) => {
    const { app, storage, login } = await createFixture(t)
    const cookie = await login()
    const previous = storage.seal({
        version: 2,
        activeProvider: "openai",
        profiles: {
            openai: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "account-model", apiKey: "openai-secret" },
            deepseek: { provider: "deepseek", baseUrl: "http://127.0.0.1:2/v1", model: "deepseek-flash", apiKey: "deepseek-secret" },
        },
    })
    storage.db.prepare("INSERT INTO settings(key, value) VALUES ('ai', ?)").run(previous)
    const read = await app.inject({ method: "GET", url: "/api/settings/ai/providers", headers: { cookie } })
    const openai = read.json().providers.find((item: { provider: string }) => item.provider === "openai")
    assert.equal(openai.defaultModel, "account-model")
    assert.deepEqual(
        openai.models.filter((item: { enabled: boolean }) => item.enabled),
        [{ id: "account-model", label: "account-model", enabled: true }],
    )
    assert.deepEqual(storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get(), { value: previous })
    const saved = await app.inject({
        method: "PUT",
        url: "/api/settings/ai/providers",
        headers: { ...WRITE_HEADERS, cookie },
        payload: {
            provider: "openai",
            baseUrl: openai.baseUrl,
            models: openai.models,
            defaultModel: openai.defaultModel,
        },
    })
    assert.equal(saved.statusCode, 200)
    const row = storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string }
    const upgraded = storage.open(row.value) as { version: number; profiles: Record<string, { apiKey: string; defaultModel: string }> }
    assert.equal(upgraded.version, 3)
    assert.equal(upgraded.profiles.openai?.apiKey, "openai-secret")
    assert.equal(upgraded.profiles.deepseek?.apiKey, "deepseek-secret")
    assert.equal(upgraded.profiles.openai?.defaultModel, "account-model")
})

test("custom model IDs never inherit built-in object labels", () => {
    for (const id of ["constructor", "toString", "__proto__"]) {
        assert.deepEqual(initialAiModels("custom", id), [{ id, label: id, enabled: true }])
    }
})
