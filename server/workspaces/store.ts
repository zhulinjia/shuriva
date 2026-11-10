import { randomUUID } from "node:crypto"
import { workspaceDocumentSchema } from "../../src/shared/workspace-schema.js"
import type { WorkspaceDocument } from "../../src/shared/workspace-schema.js"
import { ServiceError } from "../errors.js"
import type { Storage } from "../storage.js"

type WorkspaceRow = {
  id: string
  document: string
  revision: number
  updatedAt: string
}

export type StoredWorkspace = Omit<WorkspaceRow, "document"> & {
  document: WorkspaceDocument
}

function decodeWorkspace(row: WorkspaceRow): StoredWorkspace {
  return { ...row, document: workspaceDocumentSchema.parse(JSON.parse(row.document)) }
}

function ensureSourcesExist(storage: Storage, document: WorkspaceDocument): void {
  const find = storage.db.prepare("SELECT 1 FROM datasources WHERE id = ?")
  const ids = new Set(document.queries.map((query) => query.datasourceId))
  for (const id of ids) {
    if (!find.get(id)) throw new ServiceError("invalid_input", "A datasource does not exist")
  }
}

/** Called inside the datasource deletion transaction. Corrupt documents fail closed. */
export function workspaceUsesDatasource(storage: Storage, datasourceId: string): boolean {
  const rows = storage.db.prepare("SELECT document FROM workspaces").all() as { document: string }[]
  return rows.some((row) => {
    const document = workspaceDocumentSchema.parse(JSON.parse(row.document))
    return document.queries.some((query) => query.datasourceId === datasourceId)
  })
}

export function createWorkspaceStore(storage: Storage) {
  const list = (): StoredWorkspace[] => {
    const rows = storage.db.prepare(
      "SELECT id, document, revision, updated_at AS updatedAt FROM workspaces ORDER BY updated_at DESC",
    ).all() as WorkspaceRow[]
    return rows.map(decodeWorkspace)
  }

  const get = (id: string): StoredWorkspace | null => {
    const row = storage.db.prepare(
      "SELECT id, document, revision, updated_at AS updatedAt FROM workspaces WHERE id = ?",
    ).get(id) as WorkspaceRow | undefined
    return row ? decodeWorkspace(row) : null
  }

  const create = (document: WorkspaceDocument): StoredWorkspace => {
    const id = randomUUID()
    const updatedAt = new Date().toISOString()
    storage.db.transaction(() => {
      ensureSourcesExist(storage, document)
      storage.db.prepare(
        "INSERT INTO workspaces(id, document, revision, updated_at) VALUES (?, ?, 1, ?)",
      ).run(id, JSON.stringify(document), updatedAt)
    }).immediate()
    return { id, document, revision: 1, updatedAt }
  }

  const update = (id: string, revision: number, document: WorkspaceDocument): StoredWorkspace => {
    const updatedAt = new Date().toISOString()
    storage.db.transaction(() => {
      ensureSourcesExist(storage, document)
      const result = storage.db.prepare(
        "UPDATE workspaces SET document = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      ).run(JSON.stringify(document), updatedAt, id, revision)
      if (!result.changes) throw new ServiceError("conflict", "Workspace changed or no longer exists")
    }).immediate()
    return { id, document, revision: revision + 1, updatedAt }
  }

  const remove = (id: string): void => {
    const result = storage.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id)
    if (!result.changes) throw new ServiceError("not_found", "Workspace not found")
  }

  return { list, get, create, update, remove }
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>
