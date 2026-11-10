import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import { linkSync, renameSync } from "node:fs"
import { join } from "node:path"
import { createCipheriv, randomBytes } from "node:crypto"
import { test } from "node:test"
import { Worker } from "node:worker_threads"
import Database from "better-sqlite3"
import { createSecretCodec } from "../../server/secrets.js"
import { createStorage } from "../../server/storage.js"
import { createSessionService } from "../../server/auth/session.js"
import { createFixture, documentFor, TEST_PASSWORD, TEST_USERNAME, WRITE_HEADERS } from "./fixture.js"

test("parallel failed logins are rate-limited without exposing protected routes", async (t) => {
  const { app } = await createFixture(t)
  const unauthorized = await app.inject({ method: "GET", url: "/api/workspaces" })
  assert.equal(unauthorized.statusCode, 401)

  const rejectedOrigin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { ...WRITE_HEADERS, origin: "https://attacker.example" },
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  })
  assert.equal(rejectedOrigin.statusCode, 403)

  const attempts = await Promise.all(Array.from({ length: 8 }, () => app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: WRITE_HEADERS,
    payload: { username: TEST_USERNAME, password: "incorrect" },
  })))
  assert.deepEqual(attempts.map((response) => response.statusCode), Array(8).fill(401))
  const limited = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: WRITE_HEADERS,
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  })
  assert.equal(limited.statusCode, 429)
})

test("a password reset during verification cannot issue a stale session", async (t) => {
  const { storage } = await createFixture(t)
  let verificationStarted!: () => void
  let resumeVerification!: () => void
  const started = new Promise<void>((resolve) => { verificationStarted = resolve })
  const resume = new Promise<void>((resolve) => { resumeVerification = resolve })
  const sessions = createSessionService(storage, async () => {
    verificationStarted()
    await resume
    return true
  })

  const login = sessions.login("127.0.0.1", TEST_USERNAME, TEST_PASSWORD)
  await started
  storage.db.transaction(() => {
    storage.db.prepare("UPDATE admin SET password_hash = ? WHERE id = 1").run("replacement-hash")
    storage.db.prepare("DELETE FROM sessions").run()
  })()
  resumeVerification()
  await assert.rejects(login, /Invalid credentials/)
  assert.equal((storage.db.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count, 0)
})

test("multiple SQLite sources stay isolated and workspace references prevent deletion", async (t) => {
  const { app, login, createSqliteFile, createSource } = await createFixture(t)
  const cookie = await login()
  const firstId = await createSource(cookie, "first", createSqliteFile("first", ["first-only"]))
  const secondId = await createSource(cookie, "second", createSqliteFile("second", ["second-only"]))
  const first = documentFor(firstId).queries[0]!
  const second = documentFor(secondId).queries[0]!

  const query = async (input: object) => app.inject({
    method: "POST",
    url: "/api/workspaces/preview",
    headers: { ...WRITE_HEADERS, cookie },
    payload: input,
  })
  const [firstResult, secondResult] = await Promise.all([query(first), query(second)])
  assert.equal(firstResult.statusCode, 200)
  assert.equal(secondResult.statusCode, 200)
  assert.deepEqual(firstResult.json().rows.map((row: { name: string }) => row.name), ["first-only"])
  assert.deepEqual(secondResult.json().rows.map((row: { name: string }) => row.name), ["second-only"])

  const invalidField = await query({ ...first, fields: ["name\"; DROP TABLE records;--"] })
  assert.notEqual(invalidField.statusCode, 200)
  const invalidTable = await query({ ...first, table: 'records"; DROP TABLE records;--' })
  assert.notEqual(invalidTable.statusCode, 200)
  const unchanged = await query(first)
  assert.equal(unchanged.json().rows[0].name, "first-only")

  const create = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { ...WRITE_HEADERS, cookie },
    payload: documentFor(firstId),
  })
  assert.equal(create.statusCode, 201)
  const blocked = await app.inject({
    method: "DELETE",
    url: `/api/datasources/${firstId}`,
    headers: { ...WRITE_HEADERS, cookie },
  })
  assert.equal(blocked.statusCode, 409)
  assert.equal((await query(second)).json().rows[0].name, "second-only")
})

test("application metadata cannot be connected through a hard link", async (t) => {
  const { app, storage, directory, login } = await createFixture(t)
  const cookie = await login()
  const alias = join(directory, "metadata-alias.sqlite")
  try {
    linkSync(join(storage.dataDir, "shuriva.sqlite"), alias)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM" || code === "ENOTSUP" || code === "EACCES") {
      t.skip("The test filesystem does not permit hard links")
      return
    }
    throw error
  }
  const response = await app.inject({
    method: "POST",
    url: "/api/datasources",
    headers: { ...WRITE_HEADERS, cookie },
    payload: { name: "metadata", engine: "sqlite", config: { path: alias } },
  })
  assert.equal(response.statusCode, 400)
})

test("encrypted settings reject tampering, malformed values and the wrong key", () => {
  const codec = createSecretCodec(randomBytes(32))
  const encrypted = codec.seal({ password: "private-test-value" })
  assert.ok(!encrypted.includes("private-test-value"))
  assert.deepEqual(codec.open(encrypted), { password: "private-test-value" })
  assert.throws(() => createSecretCodec(randomBytes(32)).open(encrypted))
  assert.throws(() => codec.open(encrypted + ":extra"))
  const parts = encrypted.split(":")
  const bytes = Buffer.from(parts[3]!, "base64")
  bytes[0] = bytes[0]! ^ 1
  parts[3] = bytes.toString("base64")
  assert.throws(() => codec.open(parts.join(":")))
})

test("existing v1 encrypted settings remain readable", () => {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const plaintext = JSON.stringify({ apiKey: "legacy-test-key" })
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const legacy = ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":")
  assert.deepEqual(createSecretCodec(key).open(legacy), { apiKey: "legacy-test-key" })
})

test("an existing data directory is not silently re-keyed when its master key is missing", async (t) => {
  const { storage } = await createFixture(t)
  const keyPath = join(storage.dataDir, "master.key")
  const backupPath = join(storage.dataDir, "master.key.test-backup")
  renameSync(keyPath, backupPath)
  try {
    assert.throws(() => createStorage(storage.dataDir), /Master key is missing/)
  } finally {
    renameSync(backupPath, keyPath)
  }
})

test("datasource deletion and workspace creation never leave an orphan reference", async (t) => {
  const { app, login, createSqliteFile, createSource } = await createFixture(t)
  const cookie = await login()
  const id = await createSource(cookie, "race", createSqliteFile("race", ["row"]))
  const [created, removed] = await Promise.all([
    app.inject({ method: "POST", url: "/api/workspaces", headers: { ...WRITE_HEADERS, cookie }, payload: documentFor(id) }),
    app.inject({ method: "DELETE", url: `/api/datasources/${id}`, headers: { ...WRITE_HEADERS, cookie } }),
  ])

  const results = [created.statusCode, removed.statusCode]
  assert.ok(
    (results[0] === 201 && results[1] === 409) || (results[0] === 400 && results[1] === 200),
    `Unexpected outcomes: ${results.join(", ")}`,
  )
  const sources = await app.inject({ method: "GET", url: "/api/datasources", headers: { cookie } })
  const workspaces = await app.inject({ method: "GET", url: "/api/workspaces", headers: { cookie } })
  if (workspaces.json().length) {
    assert.ok(sources.json().some((source: { id: string }) => source.id === id))
  }
})

test("reference checks remain consistent across independent SQLite connections", { timeout: 15_000 }, async (t) => {
  const { storage, login, createSqliteFile, createSource } = await createFixture(t)
  const cookie = await login()
  const sourceId = await createSource(cookie, "race", createSqliteFile("race", ["row"]))
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const state = new Int32Array(signal)
  const workers = (["create", "remove"] as const).map((operation) => new Worker(
    new URL("./reference-race-worker.ts", import.meta.url),
    { workerData: { directory: storage.dataDir, sourceId, operation, document: documentFor(sourceId), signal } },
  ))
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())) })

  const ready = workers.map((worker) => new Promise<void>((resolveReady, reject) => {
    worker.once("message", (message: { ready?: boolean }) => {
      if (message.ready) resolveReady()
      else reject(new Error("Race worker failed to initialize"))
    })
    worker.once("error", reject)
  }))
  await Promise.all(ready)
  const outcomes = workers.map((worker) => new Promise<string>((resolveOutcome, reject) => {
    worker.once("message", (message: { outcome: string }) => resolveOutcome(message.outcome))
    worker.once("error", reject)
  }))
  Atomics.store(state, 0, 1)
  Atomics.notify(state, 0)
  const [created, removed] = await Promise.all(outcomes)
  assert.ok(
    (created === "ok" && removed === "conflict") || (created === "invalid_input" && removed === "ok"),
    `Unexpected concurrent outcomes: ${created}, ${removed}`,
  )
  const sources = storage.db.prepare("SELECT id FROM datasources WHERE id = ?").all(sourceId)
  const workspaces = storage.db.prepare("SELECT id FROM workspaces").all()
  assert.ok(workspaces.length === 0 || sources.length === 1)
})

test("AI requests protect filter values and reject invalid or unselected data sources", async (t) => {
  const { app, login, createSqliteFile, createSource } = await createFixture(t)
  const cookie = await login()
  const firstPath = createSqliteFile("first", ["record-not-for-model"])
  const firstDatabase = new Database(firstPath)
  firstDatabase.exec("CREATE TABLE other_records (id INTEGER PRIMARY KEY, name TEXT, status TEXT)")
  firstDatabase.close()
  const firstId = await createSource(cookie, "first", firstPath)
  const secondId = await createSource(cookie, "second", createSqliteFile("second", ["another-record"]))
  const received: string[] = []
  const paths: (string | undefined)[] = []
  const authorizations: (string | undefined)[] = []
  let mode: "echo" | "move-token" | "move-source" | "move-table" | "html" = "echo"
  const provider = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => { body += chunk })
    request.on("end", () => {
      received.push(body)
      paths.push(request.url)
      authorizations.push(request.headers.authorization)
      const payload = JSON.parse(body) as { messages: { role: string; content: string }[] }
      const userMessage = payload.messages.find((message) => message.role === "user")
      const context = JSON.parse(userMessage!.content) as { current: ReturnType<typeof documentFor> }
      if (mode === "move-token") context.current.queries[0]!.filters[0]!.field = "status"
      if (mode === "move-source") context.current.queries[0]!.datasourceId = secondId
      if (mode === "move-table") context.current.queries[0]!.table = "other_records"
      const result = mode === "html"
        ? { ...context.current, components: [{ id: "bad", type: "html", title: "Bad", html: "<script>" }] }
        : context.current
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
    })
  })
  await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen))
  t.after(() => new Promise<void>((resolveClose) => {
    provider.close(() => resolveClose())
    provider.closeAllConnections()
  }))
  const address = provider.address()
  assert.ok(address && typeof address === "object")

  const invalidUrl = await app.inject({
    method: "PUT",
    url: "/api/settings/ai",
    headers: { ...WRITE_HEADERS, cookie },
    payload: { baseUrl: "not-a-url", model: "test", apiKey: "private-key" },
  })
  assert.equal(invalidUrl.statusCode, 400)
  const settings = await app.inject({
    method: "PUT",
    url: "/api/settings/ai",
    headers: { ...WRITE_HEADERS, cookie },
    payload: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test", apiKey: "private-key" },
  })
  assert.equal(settings.statusCode, 200)
  assert.ok(!settings.body.includes("private-key"))

  const current = documentFor(firstId)
  current.queries[0]!.filters.push({ field: "name", operator: "eq", value: "sensitive-filter-value" })
  const generate = (body: object) => app.inject({
    method: "POST",
    url: "/api/ai/generate",
    headers: { ...WRITE_HEADERS, cookie },
    payload: body,
  })
  const valid = await generate({ instruction: "Adjust the view", datasourceIds: [firstId], current })
  assert.equal(valid.statusCode, 200, valid.body)
  assert.equal(valid.json().document.queries[0].filters[0].value, "sensitive-filter-value")
  assert.equal(received.length, 1)
  assert.equal(paths[0], "/v1/chat/completions")
  assert.equal(authorizations[0], "Bearer private-key")
  assert.deepEqual(JSON.parse(received[0]!).response_format, { type: "json_object" })
  assert.ok(!received[0]!.includes("sensitive-filter-value"))
  assert.ok(!received[0]!.includes("record-not-for-model"))
  assert.ok(!received[0]!.includes("private-key"))

  const unselected = await generate({ instruction: "Adjust", datasourceIds: [secondId], current })
  assert.equal(unselected.statusCode, 400)
  assert.equal(received.length, 1)

  mode = "move-token"
  const moved = await generate({ instruction: "Adjust", datasourceIds: [firstId], current })
  assert.equal(moved.statusCode, 502)
  assert.ok(!moved.body.includes("sensitive-filter-value"))
  mode = "move-source"
  const movedSource = await generate({ instruction: "Adjust", datasourceIds: [firstId, secondId], current })
  assert.equal(movedSource.statusCode, 502)
  mode = "move-table"
  const movedTable = await generate({ instruction: "Adjust", datasourceIds: [firstId], current })
  assert.equal(movedTable.statusCode, 502)
  mode = "html"
  const html = await generate({ instruction: "Adjust", datasourceIds: [firstId], current })
  assert.equal(html.statusCode, 502)
})

test("AI provider failures are bounded, never retried, and never expose provider secrets", async (t) => {
  const { app, login, createSqliteFile, createSource } = await createFixture(t)
  const cookie = await login()
  const sourceId = await createSource(cookie, "source", createSqliteFile("source", ["row"]))
  let mode: "failure" | "oversized" | "redirect" = "failure"
  let calls = 0
  let redirected = false
  const provider = createServer((request, response) => {
    if (request.url === "/redirect-target") {
      redirected = true
      response.writeHead(200).end()
      return
    }
    calls += 1
    request.resume()
    if (mode === "failure") {
      response.writeHead(503, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "provider-secret-details" } }))
    } else if (mode === "oversized") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(Buffer.alloc(2_000_001, "x"))
    } else {
      const address = provider.address()
      if (!address || typeof address === "string") throw new Error("Test provider unavailable")
      response.writeHead(302, { location: `http://127.0.0.1:${address.port}/redirect-target` })
      response.end()
    }
  })
  await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen))
  t.after(() => new Promise<void>((resolveClose) => {
    provider.close(() => resolveClose())
    provider.closeAllConnections()
  }))
  const address = provider.address()
  assert.ok(address && typeof address === "object")
  await app.inject({
    method: "PUT",
    url: "/api/settings/ai",
    headers: { ...WRITE_HEADERS, cookie },
    payload: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test", apiKey: "private-key" },
  })

  for (const nextMode of ["failure", "oversized", "redirect"] as const) {
    mode = nextMode
    const previousCalls = calls
    const result = await app.inject({
      method: "POST",
      url: "/api/ai/generate",
      headers: { ...WRITE_HEADERS, cookie },
      payload: { instruction: "Show records", datasourceIds: [sourceId] },
    })
    assert.equal(result.statusCode, 502, nextMode)
    assert.equal(calls, previousCalls + 1, `${nextMode} must not be retried`)
    assert.ok(!result.body.includes("private-key"))
    assert.ok(!result.body.includes("provider-secret-details"))
  }
  assert.equal(redirected, false)
})
