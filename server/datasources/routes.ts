import type { FastifyInstance } from "fastify"
import { datasourcePreferencesSchema } from "../../src/shared/datasource-metadata.js"
import { idParamsSchema, parseInput } from "../http.js"
import { datasourceInputSchema } from "./contracts.js"
import type { DatasourceService } from "./service.js"

export function registerDatasourceRoutes(app: FastifyInstance, sources: DatasourceService): void {
    app.get("/api/datasources", async () => sources.list())

    app.post("/api/datasources", async (request, reply) => {
        const input = parseInput(datasourceInputSchema, request.body, "Invalid datasource configuration")
        return reply.code(201).send(await sources.create(input))
    })

    app.get("/api/datasources/:id/schema", async (request) => {
        const { id } = parseInput(idParamsSchema, request.params, "Invalid datasource")
        return sources.describe(id)
    })

    app.put("/api/datasources/:id/metadata", async (request) => {
        const { id } = parseInput(idParamsSchema, request.params, "Invalid datasource")
        const preferences = parseInput(datasourcePreferencesSchema, request.body, "数据源说明格式不正确。")
        return sources.updateMetadata(id, preferences)
    })

    app.delete("/api/datasources/:id", async (request) => {
        const { id } = parseInput(idParamsSchema, request.params, "Invalid datasource")
        sources.remove(id)
        return { ok: true }
    })
}
