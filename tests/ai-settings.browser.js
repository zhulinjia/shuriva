// Run with playwright-cli against the isolated tests/browser-fixture.ts service.
// oxlint-disable-next-line no-unused-vars -- playwright-cli evaluates this function directly.
async function aiSettingsRegression(page) {
    const context = await page
        .context()
        .browser()
        .newContext({ viewport: { width: 1440, height: 900 } })
    const testPage = await context.newPage()
    const origin = "http://127.0.0.1:4318"
    const headers = { "x-shuriva-request": "1", origin }
    const errors = []
    testPage.on("pageerror", (error) => errors.push(error.message))
    const assert = (condition, message) => {
        if (!condition) throw new Error(message)
    }
    let provider
    let workspaceId
    const restoreSettings = async () => {
        await testPage.request.put(origin + "/api/settings/ai", {
            headers,
            data: { baseUrl: provider, model: "test-model", apiKey: "test-only-key" },
        })
        await testPage.request.post(origin + "/api/settings/ai/active", { headers, data: { provider: "custom" } })
    }
    try {
        await testPage.goto(origin)
        await testPage.getByLabel("管理员账号").fill("admin")
        await testPage.getByLabel("密码", { exact: true }).fill("shuriva")
        await testPage.getByRole("button", { name: "登录", exact: true }).click()
        await testPage.getByRole("heading", { name: "我的工作台", exact: true }).waitFor()
        provider = (await (await testPage.request.get(origin + "/test-info")).json()).provider
        const initial = await (await testPage.request.get(origin + "/api/settings/ai")).json()
        await testPage.getByRole("button", { name: "设置", exact: true }).first().click()
        const address = testPage.getByLabel("服务地址", { exact: true })
        const model = testPage.getByLabel("API 模型 ID", { exact: true }).first()
        const key = testPage.getByLabel("API 密钥", { exact: true })
        const selectProvider = (name) => testPage.getByRole("button", { name: "编辑 " + name + " 配置", exact: true }).click()
        const providerState = async () => (await testPage.request.get(origin + "/api/settings/ai/providers")).json()
        await address.waitFor()
        assert((await address.inputValue()) === provider, "The saved address must populate the form")
        assert((await model.inputValue()) === "test-model", "The saved model must populate the form")
        assert((await key.inputValue()) === "", "Stored credentials must never populate the form")
        assert((await providerState()).activeProvider === "custom", "Legacy settings must remain active")
        for (const [name, id, baseUrl, exampleModel] of [
            ["DeepSeek", "deepseek", "https://api.deepseek.com", "deepseek-flash"],
            ["OpenAI", "openai", "https://api.openai.com/v1", "gpt-5.4-mini"],
            ["Claude", "anthropic", "https://api.anthropic.com/v1", "claude-sonnet-5-5"],
        ]) {
            await key.fill("unsaved-provider-key")
            await selectProvider(name)
            assert((await address.inputValue()) === baseUrl, "The provider address must be prefilled: " + id)
            assert((await model.inputValue()) === exampleModel, "The provider model must be prefilled: " + id)
            assert((await key.inputValue()) === "", "Switching providers must clear the unsaved credential")
            await testPage.getByRole("button", { name: "设为当前使用", exact: true }).click()
            await testPage.getByText("请先保存该提供商的配置，再设为当前使用。", { exact: true }).waitFor()
            await model.fill("another-account-model")
            assert((await model.inputValue()) === "another-account-model", "Preset models must remain editable")
            await model.fill(exampleModel)
            await key.fill("browser-profile-" + id)
            await testPage.getByRole("button", { name: "保存配置", exact: true }).click()
            await testPage.getByText("配置已保存。", { exact: true }).waitFor()
            assert((await key.inputValue()) === "", "Saving must clear the credential")
            const snapshot = await providerState()
            assert(snapshot.activeProvider === "custom", "Saving an inactive provider must not switch generation")
            assert(snapshot.providers.find((item) => item.provider === id).model === exampleModel, "The provider must save independently")
        }
        await selectProvider("DeepSeek")
        assert((await model.inputValue()) === "deepseek-flash", "Returning to a provider must restore its own saved model")
        await selectProvider("OpenAI")
        assert((await model.inputValue()) === "gpt-5.4-mini", "Saving Claude must not overwrite OpenAI")
        await model.fill("unsaved-model")
        await testPage.getByRole("button", { name: "设为当前使用", exact: true }).click()
        await testPage.getByText("有未保存的修改，请先保存后再设为当前使用。", { exact: true }).waitFor()
        await model.fill("gpt-5.4-mini")
        await testPage.getByRole("button", { name: "设为当前使用", exact: true }).click()
        await testPage.getByText("已切换当前使用的提供商。", { exact: true }).waitFor()
        assert((await providerState()).activeProvider === "openai", "Activation must change the selected runtime provider")
        await testPage.screenshot({ path: ".playwright-cli/ai-providers-desktop.png" })
        await testPage.reload()
        await testPage.getByRole("heading", { name: "我的工作台", exact: true }).waitFor()
        await testPage.getByRole("button", { name: "设置", exact: true }).first().click()
        await testPage.getByRole("heading", { name: "OpenAI", exact: true }).waitFor()
        assert((await key.inputValue()) === "", "Reloading must never reveal a profile key")
        await selectProvider("自定义（OpenAI 兼容）")
        assert(
            (await address.inputValue()) === provider && (await model.inputValue()) === "test-model",
            "Returning to the saved provider must restore its configuration",
        )
        assert((await providerState()).activeProvider === "openai", "Selecting an editor must not switch the active provider")
        await testPage.getByRole("button", { name: "设为当前使用", exact: true }).click()
        await testPage.getByText("已切换当前使用的提供商。", { exact: true }).waitFor()

        let testCalls = 0
        await testPage.route("**/api/settings/ai/test", async (route) => {
            testCalls += 1
            await new Promise((resolve) => setTimeout(resolve, 450))
            await route.continue()
        })
        await testPage.getByRole("button", { name: /^(测试连接|重新测试连接)$/ }).click()
        assert(await testPage.getByRole("button", { name: "正在测试…", exact: true }).isDisabled(), "Testing must prevent repeat requests")
        assert(await testPage.getByRole("button", { name: "保存配置", exact: true }).isDisabled(), "Saving and testing must not race")
        assert(await key.isDisabled(), "The credential must not change during a test")
        await testPage.getByRole("group", { name: "配置操作", exact: true }).getByText("连接成功", { exact: true }).waitFor()
        const defaultTest = testPage.getByRole("button", { name: "重新测试连接", exact: true })
        const feedbackId = await defaultTest.getAttribute("aria-describedby")
        assert(feedbackId, "Default model tests must be associated with their local feedback")
        const placement = await defaultTest.evaluate((button, id) => {
            const action = button.getBoundingClientRect()
            const feedback = document.getElementById(id).getBoundingClientRect()
            return { gap: feedback.top - action.bottom, visible: feedback.top >= 0 && feedback.bottom <= innerHeight + 1 }
        }, feedbackId)
        assert(
            placement.gap >= 0 && placement.gap <= 32 && placement.visible,
            "Default test feedback must be visible immediately below its button",
        )
        assert((await testPage.locator("[data-sonner-toast]").count()) === 0, "Default tests must not create a global notification")
        assert(
            (await testPage.getByRole("group", { name: "模型 test-model", exact: true }).getByText("连接成功", { exact: true }).count()) ===
                0,
            "A footer test must not also show its result in a model row",
        )
        assert(testCalls === 1, "A connection test must make one request")
        await testPage.unroute("**/api/settings/ai/test")
        const afterTest = await (await testPage.request.get(origin + "/api/settings/ai")).json()
        assert(JSON.stringify(afterTest) === JSON.stringify(initial), "Testing must not save the draft")

        await address.fill("")
        await testPage.getByRole("button", { name: /^(测试连接|重新测试连接)$/ }).click()
        await testPage.getByText("请填写服务地址。", { exact: true }).waitFor()
        assert((await address.getAttribute("aria-invalid")) === "true", "Missing input must have an accessible field error")
        assert(await address.evaluate((element) => element === document.activeElement), "Validation must focus the missing field")
        await address.fill("http://127.0.0.1:1/v1")
        await testPage.getByRole("button", { name: /^(测试连接|重新测试连接)$/ }).click()
        await testPage.getByText("服务地址已变更，请重新输入该服务的 API 密钥。", { exact: true }).waitFor()
        assert((await key.getAttribute("aria-invalid")) === "true", "Changing the endpoint must require a fresh key")

        await address.fill(provider)
        await key.fill("wrong-test-key")
        await testPage.getByRole("button", { name: /^(测试连接|重新测试连接)$/ }).click()
        await testPage.getByText("模型服务拒绝了 API 密钥，请检查密钥是否正确或已过期。", { exact: true }).waitFor()
        assert((await key.inputValue()) === "wrong-test-key", "A failed test must preserve the current input")
        const session = await testPage.request.get(origin + "/api/auth/session")
        assert(session.status() === 200, "Provider authentication errors must not log the user out")
        await key.fill("test-only-key")
        await model.fill("missing-model")
        await testPage.getByRole("button", { name: /^(测试连接|重新测试连接)$/ }).click()
        await testPage.getByText("找不到模型或接口，请检查服务地址和模型名称。", { exact: true }).waitFor()
        assert((await model.inputValue()) === "missing-model", "The model draft must survive a failed test")
        const afterFailure = await (await testPage.request.get(origin + "/api/settings/ai")).json()
        assert(JSON.stringify(afterFailure) === JSON.stringify(initial), "A failed test must not alter saved settings")

        await model.fill("test-model")
        await testPage.getByRole("button", { name: "保存配置", exact: true }).click()
        await testPage.getByText("配置已保存。", { exact: true }).waitFor()
        assert((await key.inputValue()) === "", "Saving must clear the entered credential")
        await testPage.reload()
        await testPage.getByRole("heading", { name: "我的工作台", exact: true }).waitFor()
        await testPage.getByRole("button", { name: "设置", exact: true }).first().click()
        await address.waitFor()
        assert(
            (await address.inputValue()) === provider && (await model.inputValue()) === "test-model",
            "Saved public fields must survive a reload",
        )
        assert((await key.inputValue()) === "", "Reloading must not reveal the stored credential")
        await testPage.getByRole("button", { name: /^(测试连接|重新测试连接)$/ }).click()
        await testPage.getByRole("group", { name: "配置操作", exact: true }).getByText("连接成功", { exact: true }).waitFor()
        for (const width of [720, 390]) {
            await testPage.setViewportSize({ width, height: 900 })
            const size = await testPage.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }))
            assert(size.content <= size.viewport + 1, "AI settings overflow at " + width)
            assert(await key.isVisible(), "The credential input must be usable on narrow screens")
        }
        await testPage.screenshot({ path: ".playwright-cli/ai-providers-mobile.png", fullPage: true })
        await testPage.setViewportSize({ width: 1440, height: 900 })

        const sources = await (await testPage.request.get(origin + "/api/datasources")).json()
        const workspaceDocument = {
            version: 1,
            title: "连接测试工作台",
            queries: [
                { id: "records", datasourceId: sources[0].id, table: "records", fields: ["id", "name", "status"], filters: [], limit: 2 },
            ],
            components: [{ id: "records", type: "table", title: "记录", queryId: "records" }],
        }
        const created = await testPage.request.post(origin + "/api/workspaces", { headers, data: workspaceDocument })
        assert(created.status() === 201, "Workspace test setup failed")
        const saved = await created.json()
        workspaceId = saved.id
        await testPage.request.put(origin + "/api/settings/ai", {
            headers,
            data: { baseUrl: provider, model: "test-model", apiKey: "wrong-test-key" },
        })
        await testPage.reload()
        await testPage.getByRole("heading", { name: "我的工作台", exact: true }).waitFor()
        await testPage.locator("#main-content").getByRole("button", { name: "连接测试工作台", exact: true }).click()
        const instruction = testPage.getByLabel("描述工作台需求", { exact: true })
        await instruction.fill("修改标题")
        await testPage.getByRole("button", { name: "生成修改", exact: true }).click()
        await testPage.getByText("模型服务拒绝了 API 密钥，请检查密钥是否正确或已过期。", { exact: true }).waitFor()
        assert((await instruction.inputValue()) === "修改标题", "Failed edits must preserve the instruction")
        assert(
            await testPage.getByRole("heading", { name: "连接测试工作台", exact: true }).isVisible(),
            "A failed generation must preserve the preview",
        )
        const reopened = await (await testPage.request.get(origin + "/api/workspaces/" + saved.id)).json()
        assert(JSON.stringify(reopened) === JSON.stringify(saved), "A failed generation must preserve the saved document")

        await testPage.getByRole("button", { name: "创建工作台", exact: true }).first().click()
        const prompt = testPage.getByRole("textbox", { name: "描述你想完成的业务任务", exact: true })
        await prompt.fill("查看记录")
        await testPage.getByRole("button", { name: "选择数据源", exact: true }).click()
        await testPage.getByLabel("选择 验收测试库", { exact: true }).check()
        await testPage.getByRole("button", { name: "确认选择", exact: true }).click()
        await testPage.getByRole("button", { name: "开始构建工作台", exact: true }).click()
        await testPage.getByText("当前输入已保留。", { exact: false }).waitFor()
        assert((await prompt.inputValue()) === "查看记录", "A failed creation must preserve the requirement")
        await restoreSettings()
        await testPage.getByRole("button", { name: "开始构建工作台", exact: true }).click()
        await testPage.getByRole("heading", { name: "记录工作台", exact: true }).waitFor()
        await testPage.getByText("Alpha", { exact: true }).waitFor()
        const freshPage = await context.newPage()
        await freshPage.route("**/api/settings/ai/providers", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    activeProvider: null,
                    providers: ["deepseek", "openai", "anthropic", "custom"].map((provider) => ({ provider, configured: false })),
                }),
            }),
        )
        await freshPage.goto(origin)
        await freshPage.getByRole("heading", { name: "我的工作台", exact: true }).waitFor()
        await freshPage.getByRole("button", { name: "设置", exact: true }).first().click()
        await freshPage.getByRole("heading", { name: "DeepSeek", exact: true }).waitFor()
        assert(
            (await freshPage.getByLabel("服务地址", { exact: true }).inputValue()) === "https://api.deepseek.com",
            "New forms must prefill the official address",
        )
        await freshPage.getByRole("button", { name: "测试连接", exact: true }).click()
        await freshPage.getByText("请填写 API 密钥。", { exact: true }).waitFor()
        await freshPage.close()
        assert(errors.length === 0, "Browser errors: " + errors.join("; "))
        return {
            providerPresets: ["deepseek", "openai", "anthropic"],
            independentProfiles: true,
            explicitActivation: true,
            profileReload: true,
            draftTestDoesNotSave: true,
            storedKeyReuse: true,
            endpointGuard: true,
            clearErrors: true,
            generationFailurePreservesState: true,
            mobile: true,
            aiProvider: "local test stub",
            pageErrors: errors.length,
        }
    } finally {
        if (workspaceId) await testPage.request.delete(origin + "/api/workspaces/" + workspaceId, { headers })
        if (provider) await restoreSettings()
        await context.close()
    }
}
