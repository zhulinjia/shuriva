// Disposable, loopback-only fixture for browser integration tests; never use in deployment.
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import { hash } from "argon2"
import { createApp } from "../server/app.js"
import { createStorage } from "../server/storage.js"
import { readAiConfig, saveAiConfig } from "../server/ai/config-store.js"

const dir = process.env.SHURIVA_BROWSER_FIXTURE_DIR
    ? resolve(process.env.SHURIVA_BROWSER_FIXTURE_DIR)
    : mkdtempSync(join(tmpdir(), "shuriva-browser-test-"))
const path = join(dir, "records.sqlite")
if (!existsSync(path)) {
    const db = new Database(path)
    db.exec(
        "CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT, status TEXT); INSERT INTO records(name,status) VALUES ('Alpha','new'),('Beta','done'),('Gamma','new')",
    )
    db.close()
}
const metadataPath = join(dir, "metadata-sample.sqlite")
if (!existsSync(metadataPath)) {
    const db = new Database(metadataPath)
    db.exec(`
        CREATE TABLE customers (tenant_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY (tenant_id, customer_id));
        CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, amount REAL NOT NULL,
            FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, customer_id));
        CREATE VIEW order_summary AS SELECT id, amount FROM orders;
        INSERT INTO customers VALUES (1, 101, '示例客户');
        INSERT INTO orders VALUES (1, 1, 101, 88.5);
    `)
    db.close()
}
const storage = createStorage(join(dir, "app"))
if (!storage.db.prepare("SELECT id FROM admin WHERE id = 1").get())
    storage.db.prepare("INSERT INTO admin VALUES (1, ?, ?)").run("admin", await hash("shuriva"))
const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
        body += chunk.toString()
    })
    request.on("end", () => {
        const input = JSON.parse(body) as { model: string; messages: { content: string }[] }
        if (request.headers.authorization !== "Bearer test-only-key") {
            response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Test key rejected" } }))
            return
        }
        if (request.url !== "/v1/chat/completions" || !["test-model", "test-alt-model"].includes(input.model)) {
            response
                .writeHead(404, { "content-type": "application/json" })
                .end(JSON.stringify({ error: { message: "Test model not found" } }))
            return
        }
        const context = JSON.parse(input.messages[1]!.content) as { purpose?: string; instruction: string; sources: { id: string }[] }
        if (context.purpose === "connection_test") {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }))
            return
        }
        const components: (
            | { id: string; type: "table"; title: string; queryId: string }
            | { id: string; type: "placeholder"; title: string; description: string }
        )[] = [{ id: "table", type: "table", title: "记录列表", queryId: "records" }]
        if (context.instruction.includes("图表"))
            components.push({ id: "chart", type: "placeholder", title: "趋势图", description: "图表功能待接入" })
        const document = {
            version: 1,
            title: context.instruction.includes("修改") ? "已修改的记录" : "记录工作台",
            description: "测试数据",
            queries: [
                {
                    id: "records",
                    datasourceId: context.sources[0]!.id,
                    table: "records",
                    fields: ["id", "name", "status"],
                    filters: [],
                    limit: 2,
                },
            ],
            components,
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(document) } }] }))
    })
})
await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen))
const address = provider.address()
if (!address || typeof address === "string") throw new Error("Provider failed to listen")
if (!storage.db.prepare("SELECT id FROM datasources WHERE name = ?").get("验收测试库"))
    storage.db
        .prepare("INSERT INTO datasources(id, name, engine, encrypted_config, created_at) VALUES (?, ?, 'sqlite', ?, ?)")
        .run(randomUUID(), "验收测试库", storage.seal({ path }), new Date().toISOString())
const configuredAi = readAiConfig(storage, "custom")
if (
    !configuredAi ||
    (configuredAi.provider === "custom" && configuredAi.model === "test-model" && configuredAi.apiKey === "test-only-key")
) {
    saveAiConfig(storage, {
        provider: "custom",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        apiKey: "test-only-key",
    })
}
const app = await createApp(storage, { serveStatic: true })
app.get("/test-info", async () => ({ path, metadataPath, provider: `http://127.0.0.1:${address.port}/v1` }))
const port = Number(process.env.SHURIVA_BROWSER_FIXTURE_PORT || 4318)
await app.listen({ host: "127.0.0.1", port })
console.log(`Browser fixture listening on 127.0.0.1:${port}`)
const close = async () => {
    await app.close()
    storage.db.close()
    provider.close()
}
process.once("SIGINT", () => void close().then(() => process.exit(0)))
process.once("SIGTERM", () => void close().then(() => process.exit(0)))
