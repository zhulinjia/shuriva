import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { DatasourceService } from "../datasources/service.js"
import { aiProviderSchema, aiProviderSettingsInputSchema, aiSettingsInputSchema } from "../../src/shared/ai-settings.js"
import { parseInput } from "../http.js"
import type { Storage } from "../storage.js"
import {
    activateAiProvider,
    publicAiConfig,
    readAiConfig,
    readAiProviders,
    resolveAiConfig,
    saveAiConfig,
    saveAiProviderSettings,
} from "./config-store.js"
import { generationSchema } from "./contracts.js"
import { testAiConnection } from "./provider.js"
import { generateWorkspace } from "./service.js"

export function registerAiRoutes(app: FastifyInstance, storage: Storage, sources: DatasourceService): void {
    app.get("/api/settings/ai", async () => publicAiConfig(readAiConfig(storage)))
    app.get("/api/settings/ai/providers", async () => readAiProviders(storage))
    app.put("/api/settings/ai/providers", async (request) => {
        const input = parseInput(aiProviderSettingsInputSchema, request.body, "AI 配置无效，请检查连接信息、模型 ID 和默认模型。")
        return saveAiProviderSettings(storage, input)
    })
    app.post("/api/settings/ai/active", async (request) => {
        const input = parseInput(z.object({ provider: aiProviderSchema }).strict(), request.body, "请选择已配置的 AI 提供商。")
        return activateAiProvider(storage, input.provider)
    })

    app.put("/api/settings/ai", async (request) => {
        const input = parseInput(aiSettingsInputSchema, request.body, "AI 配置无效，请检查服务地址、模型名称和密钥。")
        const config = resolveAiConfig(storage, input)
        saveAiConfig(storage, config)
        return publicAiConfig(config)
    })

    app.post("/api/settings/ai/test", async (request) => {
        const input = parseInput(aiSettingsInputSchema, request.body, "AI 配置无效，请检查服务地址、模型名称和密钥。")
        return testAiConnection(resolveAiConfig(storage, input))
    })

    app.post("/api/ai/generate", async (request) => {
        const input = parseInput(generationSchema, request.body, "Invalid generation request")
        return { document: await generateWorkspace(storage, sources, input) }
    })
}
