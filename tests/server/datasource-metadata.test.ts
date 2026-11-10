import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { test } from "node:test"
import Database from "better-sqlite3"
import { buildAiMetadata } from "../../server/datasources/ai-metadata.js"
import { applyKeys, groupColumns } from "../../server/datasources/metadata.js"
import { saveAiConfig } from "../../server/ai/config-store.js"
import { emptyDatasourcePreferences } from "../../src/shared/datasource-metadata.js"
import type { DatasourcePreferences, DatasourceSchema } from "../../src/shared/datasource-metadata.js"
import { createFixture, documentFor, WRITE_HEADERS } from "./fixture.js"

test("SQLite schema, notes, relationships and scope persist separately without modifying the source", async (t) => {
    const { app, storage, directory, login, createSource } = await createFixture(t)
    const cookie = await login()
    const path = join(directory, "business.sqlite")
    const db = new Database(path)
    db.exec(`CREATE TABLE customers (tenant_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, name TEXT, PRIMARY KEY (tenant_id, customer_id));
      CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant_id INTEGER, customer_id INTEGER, amount REAL NOT NULL,
        FOREIGN KEY (tenant_id, customer_id) REFERENCES customers);
      CREATE VIEW order_view AS SELECT id, amount FROM orders;
      CREATE TABLE "quoted""table" ("quoted""field" TEXT);
      CREATE TABLE sqliteA (value INTEGER, doubled INTEGER GENERATED ALWAYS AS (value * 2));`)
    const original = db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all()
    db.close()
    const id = await createSource(cookie, "business", path)
    const other = await createSource(cookie, "other", path)
    const getSchema = (sourceId = id) => app.inject({ method: "GET", url: `/api/datasources/${sourceId}/schema`, headers: { cookie } })
    const save = (value: object, sourceId = id) =>
        app.inject({ method: "PUT", url: `/api/datasources/${sourceId}/metadata`, headers: { ...WRITE_HEADERS, cookie }, payload: value })
    assert.equal((await app.inject({ method: "GET", url: `/api/datasources/${id}/schema` })).statusCode, 401)
    assert.equal(
        (
            await app.inject({
                method: "PUT",
                url: `/api/datasources/${id}/metadata`,
                headers: { cookie },
                payload: emptyDatasourcePreferences(),
            })
        ).statusCode,
        403,
    )
    const response = await getSchema()
    assert.equal(response.statusCode, 200, response.body)
    const schema = response.json() as DatasourceSchema
    assert.deepEqual(schema.warnings, [])
    const customers = schema.tables.find((table) => table.name === "customers")!
    const orders = schema.tables.find((table) => table.name === "orders")!
    assert.equal(customers.columns.find((column) => column.name === "tenant_id")?.primaryKeyPosition, 1)
    assert.equal(customers.columns.find((column) => column.name === "customer_id")?.primaryKeyPosition, 2)
    assert.equal(orders.columns.find((column) => column.name === "amount")?.nullable, false)
    assert.equal(schema.tables.find((table) => table.name === "order_view")?.kind, "view")
    assert.equal(schema.tables.find((table) => table.name === 'quoted"table')?.columns[0]?.name, 'quoted"field')
    assert.deepEqual(
        schema.tables.find((table) => table.name === "sqliteA")?.columns.map((column) => column.name),
        ["value", "doubled"],
    )
    assert.deepEqual(orders.relations?.[0]?.mappings, [
        { from: "tenant_id", to: "tenant_id" },
        { from: "customer_id", to: "customer_id" },
    ])
    const preferences: DatasourcePreferences = {
        revision: 0,
        tables: [{ name: "orders", description: "订单业务说明", columns: [{ name: "amount", description: "订单金额说明" }] }],
        relations: [
            {
                id: randomUUID(),
                fromTable: "orders",
                toTable: "customers",
                mappings: [{ from: "customer_id", to: "customer_id" }],
                description: "业务确认",
            },
        ],
        aiScope: { mode: "selected", tables: [{ name: "orders", columns: ["id", "amount"] }] },
    }
    const saved = await save(preferences)
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal(saved.json().revision, 1)
    assert.deepEqual((await getSchema()).json().preferences, { ...preferences, revision: 1 })
    assert.deepEqual((await getSchema(other)).json().preferences, emptyDatasourcePreferences())
    const stored = storage.db.prepare("SELECT encrypted_payload FROM datasource_metadata WHERE datasource_id = ?").get(id) as {
        encrypted_payload: string
    }
    assert.ok(!stored.encrypted_payload.includes("订单业务说明"))
    assert.equal((await save(preferences)).statusCode, 409)
    const invalid = { ...preferences, revision: 1, relations: [{ ...preferences.relations[0], id: randomUUID(), toTable: "missing" }] }
    assert.equal((await save(invalid)).statusCode, 400)
    const after = new Database(path, { readonly: true })
    assert.deepEqual(after.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all(), original)
    after.close()
    const changed = new Database(path)
    changed.exec("DROP TABLE customers")
    changed.close()
    assert.deepEqual((await getSchema()).json().preferences, { ...preferences, revision: 1 })
    assert.equal((await save({ ...preferences, revision: 1 })).statusCode, 200)
    assert.equal(
        (await app.inject({ method: "DELETE", url: `/api/datasources/${id}`, headers: { ...WRITE_HEADERS, cookie } })).statusCode,
        200,
    )
    assert.equal(storage.db.prepare("SELECT 1 FROM datasource_metadata WHERE datasource_id = ?").get(id), undefined)
})

test("structure limits and incomplete composite relations are reported instead of fabricated", () => {
    const rows = Array.from({ length: 10001 }, (_, index) => ({ table_name: "large", column_name: `field_${index}`, data_type: "text" }))
    const limited = groupColumns(rows)
    assert.equal(limited.tables[0]?.columns.length, 10000)
    assert.ok(limited.warnings.some((warning) => warning.code === "columns_truncated"))
    applyKeys(limited, [], "public")
    assert.ok(limited.warnings.some((warning) => warning.code === "keys_unavailable"))
    const schema = groupColumns([
        { table_name: "orders", column_name: "a", data_type: "int" },
        { table_name: "orders", column_name: "b", data_type: "int" },
    ])
    applyKeys(
        schema,
        [
            {
                table_name: "orders",
                column_name: "a",
                constraint_name: "fk",
                constraint_type: "FOREIGN KEY",
                ordinal_position: 1,
                referenced_table_schema: "public",
                referenced_table_name: "target",
                referenced_column_name: "a",
            },
            {
                table_name: "orders",
                column_name: "b",
                constraint_name: "fk",
                constraint_type: "FOREIGN KEY",
                ordinal_position: 2,
                referenced_table_schema: null,
                referenced_table_name: null,
                referenced_column_name: null,
            },
        ],
        "public",
    )
    assert.deepEqual(schema.tables[0]?.relations, [])
    assert.ok(schema.warnings.some((warning) => warning.code === "relations_incomplete"))
    const restricted = groupColumns([
        { table_name: "orders", column_name: "a", data_type: "int" },
        { table_name: "target", column_name: "a", data_type: "int" },
    ])
    applyKeys(
        restricted,
        [
            {
                table_name: "orders",
                column_name: "a",
                constraint_name: "pk",
                constraint_type: "PRIMARY KEY",
                ordinal_position: 1,
                referenced_table_schema: null,
                referenced_table_name: null,
                referenced_column_name: null,
            },
            {
                table_name: "orders",
                column_name: null,
                constraint_name: "pk",
                constraint_type: "PRIMARY KEY",
                ordinal_position: 2,
                referenced_table_schema: null,
                referenced_table_name: null,
                referenced_column_name: null,
            },
            {
                table_name: "orders",
                column_name: "a",
                constraint_name: "external",
                constraint_type: "FOREIGN KEY",
                ordinal_position: 1,
                referenced_table_schema: "private_db",
                referenced_table_name: "private_table",
                referenced_column_name: "a",
            },
        ],
        "public",
    )
    assert.equal(restricted.tables[0]?.columns[0]?.primaryKeyPosition, undefined)
    assert.ok(restricted.warnings.some((warning) => warning.code === "keys_incomplete"))
    assert.ok(restricted.warnings.some((warning) => warning.code === "relations_outside_scope"))
    assert.ok(!JSON.stringify(restricted).includes("private_table"))
})

test("SQLite table limit is visible and prevents AI generation from a partial schema", async (t) => {
    const { app, storage, directory, login, createSource } = await createFixture(t)
    const cookie = await login()
    const path = join(directory, "many-tables.sqlite")
    const db = new Database(path)
    db.transaction(() => {
        for (let index = 0; index < 501; index++) db.exec(`CREATE TABLE table_${index} (id INTEGER PRIMARY KEY)`)
    })()
    db.close()
    const id = await createSource(cookie, "large", path)
    const schema = await app.inject({ method: "GET", url: `/api/datasources/${id}/schema`, headers: { cookie } })
    assert.equal(schema.statusCode, 200, schema.body)
    assert.equal(schema.json().tables.length, 500)
    assert.ok(schema.json().warnings.some((warning: { code: string }) => warning.code === "tables_truncated"))
    saveAiConfig(storage, { provider: "custom", baseUrl: "http://127.0.0.1:1/v1", model: "mock", apiKey: "mock" })
    const generate = await app.inject({
        method: "POST",
        url: "/api/ai/generate",
        headers: { ...WRITE_HEADERS, cookie },
        payload: { instruction: "查看记录", datasourceIds: [id] },
    })
    assert.equal(generate.statusCode, 400, generate.body)
})

test("AI receives selected metadata and descriptions only; current and generated queries obey the same scope", async (t) => {
    const { app, storage, login, createSqliteFile, createSource } = await createFixture(t)
    const cookie = await login()
    const path = createSqliteFile("new", ["private-business-record"])
    const db = new Database(path)
    db.exec("ALTER TABLE records ADD COLUMN secret_field TEXT; CREATE TABLE secret_table (secret_column TEXT)")
    db.close()
    const id = await createSource(cookie, "business", path)
    const preferences: DatasourcePreferences = {
        revision: 0,
        tables: [
            { name: "records", description: "用户提供的表说明", columns: [{ name: "name", description: "用户提供的字段说明" }] },
            { name: "secret_table", description: "秘密表说明", columns: [] },
        ],
        relations: [],
        aiScope: { mode: "selected", tables: [{ name: "records", columns: ["id", "name"] }] },
    }
    assert.equal(
        (
            await app.inject({
                method: "PUT",
                url: `/api/datasources/${id}/metadata`,
                headers: { ...WRITE_HEADERS, cookie },
                payload: preferences,
            })
        ).statusCode,
        200,
    )
    let calls = 0
    let captured = ""
    let invalidResponse = false
    const document = documentFor(id)
    document.queries[0]!.fields = ["id", "name"]
    const provider = createServer((request, response) => {
        let body = ""
        request.on("data", (chunk: Buffer) => {
            body += chunk.toString()
        })
        request.on("end", () => {
            calls++
            const input = JSON.parse(body) as { messages: { role: string; content: string }[] }
            captured = input.messages.find((message) => message.role === "user")!.content
            const result = invalidResponse ? { ...document, queries: [{ ...document.queries[0], fields: ["secret_field"] }] } : document
            response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
        })
    })
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
    t.after(
        () =>
            new Promise<void>((resolve) => {
                provider.close(() => resolve())
                provider.closeAllConnections()
            }),
    )
    const address = provider.address()
    assert.ok(address && typeof address === "object")
    saveAiConfig(storage, { provider: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "mock", apiKey: "private-key" })
    const generate = (current?: typeof document) =>
        app.inject({
            method: "POST",
            url: "/api/ai/generate",
            headers: { ...WRITE_HEADERS, cookie },
            payload: { instruction: "查看记录", datasourceIds: [id], ...(current ? { current } : {}) },
        })
    assert.equal((await generate()).statusCode, 200)
    assert.ok(captured.includes("用户提供的表说明"))
    assert.ok(captured.includes("用户提供的字段说明"))
    for (const excluded of ["secret_field", "secret_table", "secret_column", "秘密表说明", "private-business-record", "private-key"])
        assert.ok(!captured.includes(excluded), excluded)
    const excludedCurrent = documentFor(id)
    assert.equal((await generate(excludedCurrent)).statusCode, 400)
    assert.equal(calls, 1)
    invalidResponse = true
    assert.equal((await generate()).statusCode, 502)
    assert.equal(calls, 2)
})

test("user descriptions override database comments in the model context", () => {
    const schema = {
        tables: [
            {
                name: "orders",
                comment: "database table comment",
                columns: [{ name: "amount", type: "numeric", comment: "database column comment" }],
            },
        ],
        warnings: [],
    }
    const preferences = {
        ...emptyDatasourcePreferences(),
        tables: [{ name: "orders", description: "表说明", columns: [{ name: "amount", description: "金额" }] }],
    }
    const context = JSON.stringify(buildAiMetadata(schema, preferences))
    assert.ok(context.includes("表说明") && context.includes("金额"))
    assert.ok(!context.includes("database table comment") && !context.includes("database column comment"))
})

test("model relations contain only selected endpoints and fields", () => {
    const schema = {
        tables: [
            {
                name: "orders",
                columns: [{ name: "customer_id", type: "int" }],
                relations: [
                    {
                        name: "fk",
                        fromTable: "orders",
                        toSchema: null,
                        toTable: "customers",
                        sameDatasource: true,
                        mappings: [{ from: "customer_id", to: "id" }],
                        source: "database" as const,
                    },
                ],
            },
            { name: "customers", columns: [{ name: "id", type: "int" }] },
        ],
        warnings: [],
    }
    const preferences: DatasourcePreferences = {
        ...emptyDatasourcePreferences(),
        relations: [
            {
                id: randomUUID(),
                fromTable: "orders",
                toTable: "customers",
                mappings: [{ from: "customer_id", to: "id" }],
                description: "订单属于客户",
            },
        ],
        aiScope: {
            mode: "selected",
            tables: [
                { name: "orders", columns: ["customer_id"] },
                { name: "customers", columns: ["id"] },
            ],
        },
    }
    const complete = buildAiMetadata(schema, preferences)
    assert.deepEqual(
        complete.relations.map((relation) => relation.source),
        ["database", "user"],
    )
    assert.equal(complete.relations[1]?.description, "订单属于客户")
    const limited = buildAiMetadata(schema, {
        ...preferences,
        aiScope: { mode: "selected", tables: [{ name: "orders", columns: ["customer_id"] }] },
    })
    assert.deepEqual(limited.relations, [])
    assert.ok(!JSON.stringify(limited).includes("customers"))
})
