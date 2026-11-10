// Run with playwright-cli against the isolated tests/browser-fixture.ts service.
// oxlint-disable-next-line no-unused-vars -- playwright-cli evaluates this function directly.
async function aiModelsRegression(page) {
    const context = await page
        .context()
        .browser()
        .newContext({ viewport: { width: 1440, height: 1000 } })
    const view = await context.newPage()
    const origin = "http://127.0.0.1:4318"
    const headers = { "x-shuriva-request": "1", origin }
    const assert = (condition, message) => {
        if (!condition) throw new Error(message)
    }
    const assertFeedbackAtButton = async (button) => {
        const feedbackId = await button.getAttribute("aria-describedby")
        assert(feedbackId, "The action must be associated with its local feedback")
        await view.waitForFunction(
            (id) => {
                const rect = document.getElementById(id)?.getBoundingClientRect()
                return rect && rect.top >= 0 && rect.bottom <= innerHeight + 1
            },
            feedbackId,
            { timeout: 3000 },
        )
        const placement = await button.evaluate((element, id) => {
            const action = element.getBoundingClientRect()
            const feedback = document.getElementById(id).getBoundingClientRect()
            return { gap: feedback.top - action.bottom, overlaps: feedback.left < action.right && feedback.right > action.left }
        }, feedbackId)
        assert(placement.gap >= 0 && placement.gap <= 32 && placement.overlaps, "Feedback must sit directly below the clicked button")
        assert((await view.locator("[data-sonner-toast]").count()) === 0, "Connection tests must not create a detached global notification")
    }
    const errors = []
    view.on("pageerror", (error) => errors.push(error.message))
    let original
    let activeProvider
    let workspaceId
    try {
        await view.goto(origin)
        await view.getByLabel("管理员账号").fill("admin")
        await view.getByLabel("密码", { exact: true }).fill("shuriva")
        await view.getByRole("button", { name: "登录", exact: true }).click()
        await view.getByRole("heading", { name: "我的工作台", exact: true }).waitFor()
        const snapshot = await (await view.request.get(origin + "/api/settings/ai/providers")).json()
        activeProvider = snapshot.activeProvider
        original = snapshot.providers.find((profile) => profile.provider === "custom")
        await view.getByRole("button", { name: "设置", exact: true }).first().click()
        const custom = () => view.getByRole("button", { name: "编辑 自定义（OpenAI 兼容） 配置", exact: true }).click()
        await custom()
        const ids = view.getByLabel("API 模型 ID", { exact: true })
        const labels = view.getByLabel("显示名称", { exact: true })
        await ids.first().waitFor()
        const key = view.getByLabel("API 密钥", { exact: true })
        await view.getByText("密钥已保存", { exact: true }).waitFor()
        assert((await key.inputValue()) === "", "Saved credentials must never be returned to the input")
        assert((await key.getAttribute("placeholder")).includes("已保存"), "A saved credential must look saved")
        await key.fill("test-only-key")
        await view.getByText("新密钥待保存", { exact: true }).waitFor()
        await view.getByRole("button", { name: "保存配置", exact: true }).click()
        await view.getByText("配置已保存。", { exact: true }).waitFor()
        await view.getByText("密钥已保存", { exact: true }).waitFor()
        await view.reload()
        await view.getByRole("heading", { name: "我的工作台", exact: true }).waitFor()
        await view.getByRole("button", { name: "设置", exact: true }).first().click()
        await view.getByText("密钥已保存", { exact: true }).waitFor()
        assert((await key.inputValue()) === "", "Refreshing must show saved state without exposing a key")
        await view.getByRole("button", { name: "添加模型", exact: true }).click()
        await labels.nth(1).fill("备用本地模型")
        await ids.nth(1).fill(" test-alt-model ")
        const alternate = view.getByRole("group", { name: "模型 备用本地模型", exact: true })
        let testCalls = 0
        await view.route("**/api/settings/ai/test", async (route) => {
            testCalls += 1
            await new Promise((resolve) => setTimeout(resolve, 700))
            await route.continue()
        })
        const testButton = alternate.getByRole("button", { name: "测试模型 test-alt-model", exact: true })
        await view.setViewportSize({ width: 1440, height: 800 })
        await testButton.scrollIntoViewIfNeeded()
        await testButton.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            window.scrollBy(0, rect.bottom - innerHeight + 4)
        })
        await testButton.click()
        await alternate.getByText("正在测试连接…", { exact: true }).waitFor()
        assert(
            await alternate.getByRole("button", { name: "测试模型 test-alt-model", exact: true }).isDisabled(),
            "A running test must block repeat clicks",
        )
        await assertFeedbackAtButton(testButton)
        await alternate.getByText("连接成功", { exact: true }).waitFor()
        assert(testCalls === 1, "The connection test must make exactly one request")
        assert(
            await alternate.getByRole("button", { name: "重新测试模型 test-alt-model", exact: true }).isEnabled(),
            "Successful tests must offer a clear retest action",
        )
        await assertFeedbackAtButton(alternate.getByRole("button", { name: "重新测试模型 test-alt-model", exact: true }))
        assert(
            await alternate.getByText("连接成功", { exact: true }).isVisible(),
            "The result must remain beside the action after completion",
        )
        await view.unroute("**/api/settings/ai/test")
        await key.fill("wrong-test-key")
        assert((await alternate.getByText("连接成功", { exact: true }).count()) === 0, "Editing a credential must clear stale success")
        await alternate.getByRole("button", { name: "测试模型 test-alt-model", exact: true }).click()
        await alternate.getByText("连接测试失败", { exact: true }).waitFor()
        await assertFeedbackAtButton(alternate.getByRole("button", { name: "重新测试模型 test-alt-model", exact: true }))
        await alternate.getByText("模型服务拒绝了 API 密钥，请检查密钥是否正确或已过期。", { exact: true }).waitFor()
        assert((await key.inputValue()) === "wrong-test-key", "A failed test must keep the unsaved credential")
        await key.fill("test-only-key")
        await alternate.getByRole("button", { name: "测试模型 test-alt-model", exact: true }).click()
        await alternate.getByText("连接成功", { exact: true }).waitFor()
        await view.setViewportSize({ width: 1440, height: 1000 })
        await view.screenshot({ path: ".playwright-cli/ai-test-feedback-desktop.png", fullPage: true })
        await view.getByRole("button", { name: "保存配置", exact: true }).click()
        await view.getByText("配置已保存。", { exact: true }).waitFor()
        assert(
            await alternate.getByText("连接成功", { exact: true }).isVisible(),
            "Local test results must survive saving the configuration",
        )
        assert((await view.getByLabel("API 密钥", { exact: true }).inputValue()) === "", "Saving must not expose the stored key")
        await view.reload()
        await view.getByRole("heading", { name: "我的工作台", exact: true }).waitFor()
        await view.getByRole("button", { name: "设置", exact: true }).first().click()
        await ids.nth(1).waitFor()
        assert(
            (await ids.evaluateAll((elements) => elements.map((element) => element.value))).includes("test-alt-model"),
            "Multiple model IDs must survive a reload",
        )
        assert(
            (await labels.evaluateAll((elements) => elements.map((element) => element.value))).includes("备用本地模型"),
            "Display names must survive a reload",
        )
        await view.getByRole("button", { name: "将 备用本地模型 设为默认", exact: true }).click()
        await view.getByRole("button", { name: "保存配置", exact: true }).click()
        await view.getByText("配置已保存。", { exact: true }).waitFor()
        assert(
            (await (await view.request.get(origin + "/api/settings/ai")).json()).model === "test-alt-model",
            "The default model must be persisted",
        )
        await view.screenshot({ path: ".playwright-cli/ai-models-desktop.png", fullPage: true })
        for (const width of [720, 390]) {
            await view.setViewportSize({ width, height: 1000 })
            const size = await view.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }))
            assert(size.content <= size.width + 1, "Model editor overflows at " + width)
        }
        await view.screenshot({ path: ".playwright-cli/ai-models-mobile.png", fullPage: true })
        await alternate.getByRole("button", { name: "测试模型 test-alt-model", exact: true }).click()
        await alternate.getByText("连接成功", { exact: true }).waitFor()
        await assertFeedbackAtButton(alternate.getByRole("button", { name: "重新测试模型 test-alt-model", exact: true }))
        assert(
            (await view.getByRole("group", { name: "配置操作", exact: true }).getByText("连接成功", { exact: true }).count()) === 0,
            "A row test must not also show its result at the footer",
        )
        await view.screenshot({ path: ".playwright-cli/ai-test-feedback-mobile.png", fullPage: true })
        await view.setViewportSize({ width: 1440, height: 1000 })
        const generated = []
        await view.route("**/api/ai/generate", async (route) => {
            generated.push(route.request().postDataJSON())
            await route.continue()
        })
        await view.getByRole("button", { name: "创建工作台", exact: true }).first().click()
        await view.getByRole("textbox", { name: "描述你想完成的业务任务", exact: true }).fill("查看记录")
        const chooser = view.getByLabel("生成模型", { exact: true })
        await chooser.selectOption(JSON.stringify({ provider: "custom", modelId: "test-model" }))
        await view.getByRole("button", { name: "选择数据源", exact: true }).click()
        await view.getByLabel("选择 验收测试库", { exact: true }).check()
        await view.getByRole("button", { name: "确认选择", exact: true }).click()
        await view.screenshot({ path: ".playwright-cli/ai-models-create.png", fullPage: true })
        await view.getByRole("button", { name: "开始构建工作台", exact: true }).click()
        await view.getByRole("heading", { name: "记录工作台", exact: true }).waitFor()
        assert(
            generated[0].aiModel.provider === "custom" && generated[0].aiModel.modelId === "test-model",
            "Creation must send the selected provider and exact model ID",
        )
        assert(JSON.parse(await chooser.inputValue()).modelId === "test-model", "The chosen model must carry into the editor")
        assert(
            (await (await view.request.get(origin + "/api/settings/ai")).json()).model === "test-alt-model",
            "Per-request selection must not change the global default",
        )
        await chooser.selectOption(JSON.stringify({ provider: "custom", modelId: "test-alt-model" }))
        await view.getByLabel("描述工作台需求", { exact: true }).fill("增加图表")
        await view.getByRole("button", { name: "生成修改", exact: true }).click()
        await view.getByText("图表功能待接入", { exact: true }).waitFor()
        assert(
            generated[1].aiModel.modelId === "test-alt-model" && generated[1].current,
            "Editing must use the selected model and preserve the current document",
        )
        const savedResponse = view.waitForResponse(
            (response) => response.url() === origin + "/api/workspaces" && response.request().method() === "POST",
        )
        await view.getByRole("button", { name: "保存工作台", exact: true }).click()
        workspaceId = (await (await savedResponse).json()).id
        await view.getByRole("button", { name: "设置", exact: true }).first().click()
        await custom()
        await view.getByRole("switch", { name: "启用 备用本地模型", exact: true }).uncheck()
        await view.getByRole("button", { name: "保存配置", exact: true }).click()
        await view.getByText("配置已保存。", { exact: true }).waitFor()
        const changed = await (await view.request.get(origin + "/api/settings/ai")).json()
        assert(changed.model === "test-model", "Disabling the default must choose another enabled model")
        await view.getByRole("button", { name: "创建工作台", exact: true }).first().click()
        await chooser.waitFor()
        assert(
            !(await chooser.locator("option").allTextContents()).some((text) => text.includes("test-alt-model")),
            "Disabled models must not appear as choices",
        )
        await view.getByRole("button", { name: "设置", exact: true }).first().click()
        await custom()
        await view.getByRole("button", { name: "添加模型", exact: true }).click()
        await labels.nth(2).fill("重复模型")
        await ids.nth(2).fill("constructor")
        assert(
            (await view.getByRole("group", { name: "模型 重复模型", exact: true }).getByText("连接成功", { exact: true }).count()) === 0,
            "Untested custom IDs must not inherit a successful test state",
        )
        await ids.nth(2).fill("test-model")
        await view.getByRole("button", { name: "保存配置", exact: true }).click()
        await view.getByText("同一家提供商不能配置重复的模型 ID。", { exact: true }).waitFor()
        assert((await ids.nth(2).getAttribute("aria-invalid")) === "true", "Duplicate IDs must have a field error")
        await view.getByRole("button", { name: "移除模型 重复模型", exact: true }).click()
        await view.getByRole("button", { name: "移除模型 备用本地模型", exact: true }).click()
        const firstLabel = await labels.first().inputValue()
        await view.getByRole("switch", { name: "启用 " + firstLabel, exact: true }).uncheck()
        await view.getByRole("button", { name: "保存配置", exact: true }).click()
        await view.getByText("请启用至少一个模型，并将已启用的模型设为默认。", { exact: true }).waitFor()
        await view.getByRole("switch", { name: "启用 " + firstLabel, exact: true }).check()
        await view.getByRole("button", { name: "保存配置", exact: true }).click()
        await view.getByText("配置已保存。", { exact: true }).waitFor()
        await view.getByRole("button", { name: "编辑 DeepSeek 配置", exact: true }).click()
        assert(
            (await ids.evaluateAll((elements) => elements.map((element) => element.value))).join(",") === "deepseek-flash",
            "DeepSeek must preset only deepseek-flash",
        )
        assert(errors.length === 0, "Browser errors: " + errors.join("; "))
        return {
            modelCrud: true,
            perModelTest: true,
            visibleTestFeedback: true,
            savedKeyStatus: true,
            defaultModel: true,
            disabledModelFiltering: true,
            duplicateValidation: true,
            generationSelection: true,
            editorSelection: true,
            deepseekFlashOnly: true,
            mobile: true,
            aiProvider: "local test stub",
            pageErrors: errors.length,
        }
    } finally {
        if (workspaceId) await view.request.delete(origin + "/api/workspaces/" + workspaceId, { headers })
        if (original?.configured)
            await view.request.put(origin + "/api/settings/ai/providers", {
                headers,
                data: {
                    provider: "custom",
                    baseUrl: original.baseUrl,
                    models: original.models,
                    defaultModel: original.defaultModel,
                    apiKey: "test-only-key",
                },
            })
        if (activeProvider) await view.request.post(origin + "/api/settings/ai/active", { headers, data: { provider: activeProvider } })
        await context.close()
    }
}
