import { z } from "zod"
import type { DatasourceTable } from "../../src/shared/datasource-metadata.js"

const connectionFields = {
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(255),
    user: z.string().min(1).max(255),
    password: z.string().max(4096),
}

export const datasourceInputSchema = z.discriminatedUnion("engine", [
    z
        .object({
            name: z.string().trim().min(1).max(120),
            engine: z.literal("sqlite"),
            config: z.object({ path: z.string().min(1).max(4096) }).strict(),
        })
        .strict(),
    z
        .object({
            name: z.string().trim().min(1).max(120),
            engine: z.literal("postgresql"),
            config: z
                .object({
                    ...connectionFields,
                    schema: z.string().min(1).max(255).default("public"),
                    ssl: z.boolean().default(false),
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            name: z.string().trim().min(1).max(120),
            engine: z.literal("mysql"),
            config: z.object({ ...connectionFields, ssl: z.boolean().default(false) }).strict(),
        })
        .strict(),
])

export type DatasourceInput = z.infer<typeof datasourceInputSchema>
export type Datasource = DatasourceInput & { id: string }
export type DatasourceEngine = Datasource["engine"]
export type TableInfo = DatasourceTable
export type QueryParameter = string | number | boolean | null
export type CompiledQuery = { sql: string; parameters: QueryParameter[] }
export type QueryRow = Record<string, unknown>
