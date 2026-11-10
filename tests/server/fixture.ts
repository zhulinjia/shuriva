import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import type { TestContext } from "node:test"
import Database from "better-sqlite3"
import { hash } from "argon2"
import { createApp } from "../../server/app.js"
import { createStorage } from "../../server/storage.js"

export const TEST_USERNAME = "admin"
export const TEST_PASSWORD = "a test password long enough"
export const WRITE_HEADERS = { "x-shuriva-request": "1", origin: "http://localhost", host: "localhost" }

export function documentFor(datasourceId: string) {
  return {
    version: 1,
    title: "Records",
    description: "",
    queries: [{
      id: "records",
      datasourceId,
      table: "records",
      fields: ["id", "name", "status"],
      filters: [] as { field: string; operator: "eq"; value: string }[],
      limit: 2,
    }],
    components: [{ id: "table", type: "table", title: "Records", queryId: "records" }],
  }
}

export async function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "shuriva-security-test-"))
  const storage = createStorage(join(directory, "app"))
  storage.db.prepare("INSERT INTO admin(id, username, password_hash) VALUES (1, ?, ?)")
    .run(TEST_USERNAME, await hash(TEST_PASSWORD))
  const app = await createApp(storage)
  await app.ready()

  t.after(async () => {
    await app.close()
    storage.db.close()
    const target = realpathSync(directory)
    const parent = realpathSync(tmpdir())
    if (!target.startsWith(parent + sep) || !resolve(target).includes("shuriva-security-test-")) {
      throw new Error("Refusing to remove unexpected test directory")
    }
    rmSync(target, { recursive: true, force: true })
  })

  async function login(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: WRITE_HEADERS,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    if (response.statusCode !== 200) throw new Error("Test login failed")
    const header = response.headers["set-cookie"]
    if (typeof header !== "string") throw new Error("Test session cookie missing")
    return header.split(";")[0]!
  }

  function createSqliteFile(name: string, records: readonly string[]): string {
    const path = join(directory, `${randomUUID()}.sqlite`)
    const database = new Database(path)
    try {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT, status TEXT)")
      const insert = database.prepare("INSERT INTO records(name, status) VALUES (?, ?)")
      for (const record of records) insert.run(record, name)
    } finally {
      database.close()
    }
    return path
  }

  async function createSource(cookie: string, name: string, path: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/datasources",
      headers: { ...WRITE_HEADERS, cookie },
      payload: { name, engine: "sqlite", config: { path } },
    })
    if (response.statusCode !== 201) throw new Error(`Test datasource creation failed: ${response.statusCode}`)
    return (response.json() as { id: string }).id
  }

  return { app, storage, directory, login, createSqliteFile, createSource }
}
