import { parentPort, workerData } from "node:worker_threads"
import { workspaceDocumentSchema } from "../../src/shared/workspace-schema.js"
import { createDatasourceService } from "../../server/datasources/service.js"
import { ServiceError } from "../../server/errors.js"
import { createStorage } from "../../server/storage.js"
import { createWorkspaceStore } from "../../server/workspaces/store.js"

type RaceJob = {
  directory: string
  sourceId: string
  operation: "create" | "remove"
  document: unknown
  signal: SharedArrayBuffer
}

const job = workerData as RaceJob
const storage = createStorage(job.directory)
const signal = new Int32Array(job.signal)
parentPort?.postMessage({ ready: true })
while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0)

try {
  if (job.operation === "create") {
    createWorkspaceStore(storage).create(workspaceDocumentSchema.parse(job.document))
  } else {
    createDatasourceService(storage).remove(job.sourceId)
  }
  parentPort?.postMessage({ outcome: "ok" })
} catch (error) {
  parentPort?.postMessage({ outcome: error instanceof ServiceError ? error.code : "unexpected" })
} finally {
  storage.db.close()
}
