import { realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { Worker } from "node:worker_threads"
import type { Storage } from "../storage.js"
import type { SchemaRead } from "../../src/shared/datasource-metadata.js"
import type { CompiledQuery, QueryRow } from "./contracts.js"

export type SqliteJob =
    | { path: string; operation: "schema"; detailed: boolean }
    | { path: string; operation: "query"; sql: string; parameters: (string | number | null)[] }

type WorkerReply<T> = { result: T } | { error: true }

/** Refuse aliases, including hard links, to the application's own metadata. */
function resolveDatasourcePath(path: string, storage: Storage): string {
    const file = realpathSync(resolve(path))
    const fileStat = statSync(file)
    const protectedNames = ["shuriva.sqlite", "shuriva.sqlite-wal", "shuriva.sqlite-shm", "master.key"]

    for (const name of protectedNames) {
        const protectedPath = resolve(storage.dataDir, name)
        try {
            const protectedFile = realpathSync(protectedPath)
            const protectedStat = statSync(protectedFile)
            const samePath = file.toLowerCase() === protectedFile.toLowerCase()
            const sameFile = fileStat.ino !== 0 && fileStat.dev === protectedStat.dev && fileStat.ino === protectedStat.ino
            if (samePath || sameFile) throw new Error("Application metadata cannot be used as a datasource")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
            throw error
        }
    }
    return file
}

function runWorker<T>(job: SqliteJob): Promise<T> {
    const workerFile = import.meta.url.endsWith(".ts") ? "../sqlite-worker.ts" : "../sqlite-worker.js"
    return new Promise((resolveJob, reject) => {
        const worker = new Worker(new URL(workerFile, import.meta.url), { workerData: job })
        let settled = false
        const finish = (reply: WorkerReply<T> | null) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (reply && "result" in reply) resolveJob(reply.result)
            else reject(new Error("SQLite operation failed"))
        }
        const timeout = setTimeout(() => {
            void worker.terminate()
            finish(null)
        }, 7000)

        worker.once("message", (reply: WorkerReply<T>) => finish(reply))
        worker.once("error", () => finish(null))
        worker.once("exit", () => finish(null))
    })
}

export function describeSqlite(path: string, storage: Storage, detailed = true): Promise<SchemaRead> {
    return runWorker({ operation: "schema", path: resolveDatasourcePath(path, storage), detailed })
}

export function executeSqlite(path: string, query: CompiledQuery, storage: Storage): Promise<QueryRow[]> {
    return runWorker({
        operation: "query",
        path: resolveDatasourcePath(path, storage),
        sql: query.sql,
        parameters: query.parameters.map((value) => (typeof value === "boolean" ? Number(value) : value)),
    })
}
