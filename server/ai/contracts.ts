import { z } from "zod"
import { aiModelSelectionSchema, aiProviderSettingsInputSchema, aiSettingsInputSchema } from "../../src/shared/ai-settings.js"
import { workspaceDocumentSchema } from "../../src/shared/workspace-schema.js"

export const aiConfigSchema = aiSettingsInputSchema.extend({ apiKey: aiSettingsInputSchema.shape.apiKey.unwrap() })
export const aiProviderConfigSchema = aiProviderSettingsInputSchema.safeExtend({ apiKey: aiSettingsInputSchema.shape.apiKey.unwrap() })

export const generationSchema = z
    .object({
        instruction: z.string().trim().min(1).max(8000),
        datasourceIds: z.array(z.uuid()).min(1).max(10),
        current: workspaceDocumentSchema.optional(),
        aiModel: aiModelSelectionSchema.optional(),
    })
    .strict()

export type AiConfig = z.infer<typeof aiConfigSchema>
export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>
export type GenerationInput = z.infer<typeof generationSchema>
