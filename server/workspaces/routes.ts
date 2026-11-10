import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { querySchema, workspaceDocumentSchema } from "../../src/shared/workspace-schema.js"
import type { DatasourceService } from "../datasources/service.js"
import { ServiceError } from "../errors.js"
import { idParamsSchema, parseInput } from "../http.js"
import type { WorkspaceStore } from "./store.js"

const queryParamsSchema = idParamsSchema.extend({ queryId: z.string().min(1).max(255) })
const updateSchema = z.object({
  revision: z.number().int().positive(),
  document: workspaceDocumentSchema,
}).strict()

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  workspaces: WorkspaceStore,
  sources: DatasourceService,
): void {
  app.get("/api/workspaces", async () => workspaces.list())

  app.get("/api/workspaces/:id", async (request) => {
    const { id } = parseInput(idParamsSchema, request.params, "Invalid workspace")
    const workspace = workspaces.get(id)
    if (!workspace) throw new ServiceError("not_found", "Workspace not found")
    return workspace
  })

  app.post("/api/workspaces", async (request, reply) => {
    const parsed = workspaceDocumentSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid workspace description",
        issues: parsed.error.issues.map((issue) => issue.message),
      })
    }
    return reply.code(201).send(workspaces.create(parsed.data))
  })

  app.post("/api/workspaces/preview", async (request) => {
    const query = parseInput(querySchema, request.body, "Invalid query")
    return { rows: await sources.execute(query) }
  })

  app.put("/api/workspaces/:id", async (request) => {
    const { id } = parseInput(idParamsSchema, request.params, "Invalid workspace description")
    const input = parseInput(updateSchema, request.body, "Invalid workspace description")
    return workspaces.update(id, input.revision, input.document)
  })

  app.delete("/api/workspaces/:id", async (request) => {
    const { id } = parseInput(idParamsSchema, request.params, "Invalid workspace")
    workspaces.remove(id)
    return { ok: true }
  })

  app.get("/api/workspaces/:id/queries/:queryId", async (request) => {
    const { id, queryId } = parseInput(queryParamsSchema, request.params, "Invalid query")
    const workspace = workspaces.get(id)
    if (!workspace) throw new ServiceError("not_found", "Workspace not found")
    const query = workspace.document.queries.find((item) => item.id === queryId)
    if (!query) throw new ServiceError("not_found", "Query not found")
    return { rows: await sources.execute(query) }
  })
}
