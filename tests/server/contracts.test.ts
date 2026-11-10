import { strict as assert } from "node:assert"
import { join } from "node:path"
import { test } from "node:test"
import { datasourceInputSchema } from "../../server/datasources/contracts.js"
import { compileQuery } from "../../server/datasources/query.js"
import { querySchema } from "../../src/shared/workspace-schema.js"
import type { WorkspaceQuery } from "../../src/shared/workspace-schema.js"
import { createFixture, documentFor, TEST_PASSWORD, TEST_USERNAME, WRITE_HEADERS } from "./fixture.js"

test("sessions are independent and protected writes require an origin header", async (t) => {
  const { app, login } = await createFixture(t)
  const missingHeader = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  })
  assert.equal(missingHeader.statusCode, 403)

  const firstLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: WRITE_HEADERS,
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  })
  assert.equal(firstLogin.statusCode, 200)
  const header = firstLogin.headers["set-cookie"]
  assert.equal(typeof header, "string")
  assert.match(header as string, /HttpOnly/i)
  assert.match(header as string, /SameSite=Strict/i)
  const firstCookie = (header as string).split(";")[0]!
  const secondCookie = await login()

  const logout = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { ...WRITE_HEADERS, cookie: firstCookie },
  })
  assert.equal(logout.statusCode, 200)
  assert.equal((await app.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: firstCookie } })).statusCode, 401)
  assert.equal((await app.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: secondCookie } })).statusCode, 200)
})

test("SQLite credentials remain encrypted and query filters are parameterized", async (t) => {
  const { app, storage, login, createSqliteFile, createSource } = await createFixture(t)
  const cookie = await login()
  const sourceFile = createSqliteFile("test", ["Alpha", "Beta", "100%"])
  const sourceId = await createSource(cookie, "records", sourceFile)
  const stored = storage.db.prepare("SELECT encrypted_config FROM datasources WHERE id = ?").get(sourceId) as
    | { encrypted_config: string }
    | undefined
  assert.ok(stored)
  assert.ok(!stored.encrypted_config.includes(sourceFile))

  const schema = await app.inject({ method: "GET", url: `/api/datasources/${sourceId}/schema`, headers: { cookie } })
  assert.equal(schema.statusCode, 200)
  assert.deepEqual(schema.json().tables[0].columns.map((column: { name: string }) => column.name), ["id", "name", "status"])
  const blocked = await app.inject({
    method: "POST",
    url: "/api/datasources",
    headers: { ...WRITE_HEADERS, cookie },
    payload: { name: "secrets", engine: "sqlite", config: { path: join(storage.dataDir, "shuriva.sqlite") } },
  })
  assert.equal(blocked.statusCode, 400)

  const query = { ...documentFor(sourceId).queries[0], filters: [{ field: "name", operator: "contains", value: "%" }] }
  const filtered = await app.inject({ method: "POST", url: "/api/workspaces/preview", headers: { ...WRITE_HEADERS, cookie }, payload: query })
  assert.equal(filtered.statusCode, 200)
  assert.deepEqual(filtered.json().rows.map((row: { name: string }) => row.name), ["100%"])

  const injectedValue = { ...query, filters: [{ field: "name", operator: "eq", value: "' OR 1=1 --" }] }
  const result = await app.inject({ method: "POST", url: "/api/workspaces/preview", headers: { ...WRITE_HEADERS, cookie }, payload: injectedValue })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json().rows, [])
})

test("workspace revisions prevent lost updates and preserve supported placeholders", async (t) => {
  const { app, login, createSqliteFile, createSource } = await createFixture(t)
  const cookie = await login()
  const sourceId = await createSource(cookie, "records", createSqliteFile("test", ["Alpha"]))
  const document = documentFor(sourceId)
  const created = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { ...WRITE_HEADERS, cookie },
    payload: { ...document, components: [...document.components, { id: "chart", type: "placeholder", title: "Chart", description: "Not yet available" }] },
  })
  assert.equal(created.statusCode, 201)
  assert.equal(created.json().document.components[1].type, "placeholder")
  const workspace = created.json() as { id: string; revision: number; document: typeof document }
  const savedQuery = await app.inject({
    method: "GET",
    url: `/api/workspaces/${workspace.id}/queries/records`,
    headers: { cookie },
  })
  assert.equal(savedQuery.statusCode, 200)
  assert.equal(savedQuery.json().rows[0].name, "Alpha")

  const update = (title: string) => app.inject({
    method: "PUT",
    url: `/api/workspaces/${workspace.id}`,
    headers: { ...WRITE_HEADERS, cookie },
    payload: { revision: workspace.revision, document: { ...workspace.document, title } },
  })
  const updates = await Promise.all([update("First"), update("Second")])
  assert.deepEqual(updates.map((response) => response.statusCode).sort(), [200, 409])

  const invalid = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { ...WRITE_HEADERS, cookie },
    payload: { ...document, components: [{ id: "bad", type: "html", title: "Bad", queryId: "records", html: "<script>" }] },
  })
  assert.equal(invalid.statusCode, 400)
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/workspaces/${workspace.id}`,
    headers: { ...WRITE_HEADERS, cookie },
  })
  assert.equal(removed.statusCode, 200)
})

test("query compilation quotes schema-derived identifiers and parameterizes values for each engine", () => {
  const id = "c3d3e27e-1865-402c-a5e4-e1f05db922e3"
  const value = "' OR 1=1 --"
  for (const engine of ["sqlite", "postgresql", "mysql"] as const) {
    const input = engine === "sqlite"
      ? { name: "test", engine, config: { path: "/unused" } }
      : engine === "postgresql"
        ? { name: "test", engine, config: { host: "localhost", port: 5432, database: "db", user: "user", password: "", schema: "public", ssl: false } }
        : { name: "test", engine, config: { host: "localhost", port: 3306, database: "db", user: "user", password: "", ssl: false } }
    const source = { ...datasourceInputSchema.parse(input), id }
    const tableName = engine === "mysql" ? "a`b" : 'a"b'
    const fieldName = engine === "mysql" ? "c`d" : 'c"d'
    const query = querySchema.parse({
      id: "q", datasourceId: id, table: tableName, fields: [fieldName],
      filters: [{ field: fieldName, operator: "eq", value }],
    })
    const compiled = compileQuery(source, query, [{ name: tableName, columns: [{ name: fieldName, type: "text" }] }])
    assert.deepEqual(compiled.parameters, [value])
    assert.ok(!compiled.sql.includes(value))
    assert.ok(compiled.sql.includes(engine === "postgresql" ? "$1" : "?"))
    assert.ok(compiled.sql.includes(engine === "mysql" ? "`a``b`" : '"a""b"'))
    const invalidLimit = { ...query, limit: "1; DROP TABLE records;--" } as unknown as WorkspaceQuery
    assert.throws(() => compileQuery(source, invalidLimit, [{ name: tableName, columns: [{ name: fieldName, type: "text" }] }]))
  }
})
