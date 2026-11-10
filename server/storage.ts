import Database from "better-sqlite3"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createSecretCodec } from "./secrets.js"

export type Storage = {
    db: Database.Database
    dataDir: string
    seal: (value: unknown) => string
    open: (value: string) => unknown
}

export function createStorage(directory = process.env.SHURIVA_DATA_DIR || ".shuriva"): Storage {
    const dataDir = resolve(directory)
    const dbPath = resolve(dataDir, "shuriva.sqlite")
    const keyPath = resolve(dataDir, "master.key")
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    if (!existsSync(keyPath)) {
        if (existsSync(dbPath)) throw new Error("Master key is missing; refusing to open existing data")
        try {
            writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 })
        } catch (error) {
            // Another process may have initialized the same key concurrently.
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
    }
    const codec = createSecretCodec(readFileSync(keyPath))
    const db = new Database(dbPath)
    try {
        db.pragma("journal_mode = WAL")
        db.pragma("foreign_keys = ON")
        db.exec(`
      CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS datasources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        encrypted_config TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS datasource_metadata (
        datasource_id TEXT PRIMARY KEY REFERENCES datasources(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        encrypted_payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        document TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        target TEXT,
        created_at TEXT NOT NULL
      );
    `)
    } catch (error) {
        db.close()
        throw error
    }
    return { db, dataDir, ...codec }
}
