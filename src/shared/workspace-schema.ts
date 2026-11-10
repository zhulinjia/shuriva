import { z } from "zod"

// These are descriptions interpreted by the application, never executable code.
const identifier = z.string().min(1).max(255)
const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()])

export const filterSchema = z
    .object({
        field: identifier,
        operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains"]),
        value: scalar,
    })
    .strict()

export const querySchema = z
    .object({
        id: identifier,
        datasourceId: z.uuid(),
        table: identifier,
        fields: z.array(identifier).min(1).max(100),
        filters: z.array(filterSchema).max(20).default([]),
        orderBy: z
            .object({ field: identifier, direction: z.enum(["asc", "desc"]) })
            .strict()
            .optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).max(1_000_000).default(0),
    })
    .strict()

export const workspaceComponentSchema = z.discriminatedUnion("type", [
    z.object({ id: identifier, type: z.literal("table"), title: z.string().min(1).max(120), queryId: identifier }).strict(),
    z
        .object({ id: identifier, type: z.literal("metric"), title: z.string().min(1).max(120), queryId: identifier, field: identifier })
        .strict(),
    z.object({ id: identifier, type: z.literal("detail"), title: z.string().min(1).max(120), queryId: identifier }).strict(),
    z
        .object({
            id: identifier,
            type: z.literal("placeholder"),
            title: z.string().min(1).max(120),
            description: z.string().min(1).max(400),
        })
        .strict(),
])

export const workspaceDocumentSchema = z
    .object({
        version: z.literal(1),
        title: z.string().trim().min(1).max(120),
        description: z.string().max(1000).default(""),
        queries: z.array(querySchema).min(1).max(20),
        components: z.array(workspaceComponentSchema).min(1).max(40),
    })
    .strict()
    .superRefine((document, context) => {
        const queries = new Map(document.queries.map((query) => [query.id, query]))
        if (queries.size !== document.queries.length) context.addIssue({ code: "custom", message: "Duplicate query IDs" })
        if (new Set(document.components.map((component) => component.id)).size !== document.components.length)
            context.addIssue({ code: "custom", message: "Duplicate component IDs" })
        for (const component of document.components) {
            if (component.type === "placeholder") continue
            const query = queries.get(component.queryId)
            if (!query) context.addIssue({ code: "custom", message: `Unknown query: ${component.queryId}` })
            else if (component.type === "metric" && !query.fields.includes(component.field))
                context.addIssue({ code: "custom", message: `Metric field is not in its query: ${component.field}` })
        }
    })

export type WorkspaceDocument = z.infer<typeof workspaceDocumentSchema>
export type WorkspaceQuery = z.infer<typeof querySchema>
