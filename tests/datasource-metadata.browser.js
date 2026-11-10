// Run against the isolated browser fixture; it uses a real SQLite database and a mock model.
// oxlint-disable-next-line no-unused-expressions
async (page) => {
    const context = await page
        .context()
        .browser()
        .newContext({ viewport: { width: 1440, height: 900 } })
    const testPage = await context.newPage()
    const errors = []
    testPage.on("pageerror", (error) => errors.push(error.message))
    const assert = (condition, message) => {
        if (!condition) throw new Error(message)
    }
    try {
        await testPage.goto("http://127.0.0.1:4318/")
        const info = await (await testPage.request.get("http://127.0.0.1:4318/test-info")).json()
        await testPage.getByLabel("管理员账号").fill("admin")
        await testPage.getByLabel("密码", { exact: true }).fill("shuriva")
        await testPage.getByRole("button", { name: "登录", exact: true }).click()
        await testPage.getByRole("button", { name: "数据源", exact: true }).click()
        await testPage.getByLabel("名称", { exact: true }).fill("结构验收示例库")
        await testPage.getByLabel("服务器上的数据库文件路径").fill(info.metadataPath)
        await testPage.getByRole("button", { name: "测试并添加" }).click()
        await testPage.getByText("连接已添加。", { exact: true }).waitFor()
        const source = testPage.locator("li").filter({ hasText: "结构验收示例库" })
        await source.getByRole("button", { name: "查看结构" }).click()
        await testPage
            .locator("main aside")
            .getByRole("button", { name: /^orders/ })
            .click()
        await testPage.getByText("数据库定义", { exact: true }).waitFor()
        assert(
            await testPage.getByText("tenant_id → tenant_id，customer_id → customer_id").isVisible(),
            "Composite foreign key must be visible",
        )
        await testPage.getByLabel("表的业务说明").fill("每条记录代表一笔订单")
        await testPage.getByLabel("字段 amount 的业务说明").fill("订单实付金额")
        await testPage.getByRole("radio", { name: "仅选择的表和字段" }).check()
        await testPage.getByLabel("允许 AI 使用字段 amount").uncheck()
        await testPage.getByRole("radio", { name: "全部读取到的表和字段（默认）" }).check()
        await testPage.getByRole("radio", { name: "仅选择的表和字段" }).check()
        assert(!(await testPage.getByLabel("允许 AI 使用字段 amount").isChecked()), "Switching scope must preserve the field selection")
        await testPage.getByRole("button", { name: "添加关系", exact: true }).click()
        await testPage.getByLabel("目标表", { exact: true }).selectOption("customers")
        await testPage.getByLabel("第 1 组本表字段").selectOption("customer_id")
        await testPage.getByLabel("第 1 组目标表字段").selectOption("customer_id")
        await testPage.getByLabel("关系说明（选填）").fill("订单对应客户")
        await testPage.getByRole("button", { name: "确认添加关系" }).click()
        assert(await testPage.getByText("用户确认", { exact: true }).isVisible(), "Confirmed relation must be visible")
        await testPage.getByRole("button", { name: "保存说明与范围" }).click()
        await testPage.getByText("已保存，刷新页面后仍会保留。").waitFor()
        await testPage.reload()
        await testPage.getByRole("button", { name: "数据源", exact: true }).click()
        await testPage.locator("li").filter({ hasText: "结构验收示例库" }).getByRole("button", { name: "查看结构" }).click()
        await testPage
            .locator("main aside")
            .getByRole("button", { name: /^orders/ })
            .click()
        assert((await testPage.getByLabel("表的业务说明").inputValue()) === "每条记录代表一笔订单", "Table note must persist")
        assert((await testPage.getByLabel("字段 amount 的业务说明").inputValue()) === "订单实付金额", "Field note must persist")
        assert(!(await testPage.getByLabel("允许 AI 使用字段 amount").isChecked()), "Selected scope must persist")
        assert(await testPage.getByText("订单对应客户", { exact: true }).isVisible(), "Confirmed relation must persist")
        await testPage.getByLabel("表的业务说明").fill("尚未保存的输入")
        await testPage.getByRole("button", { name: "返回数据源" }).click()
        assert(await testPage.getByText(/有未保存的说明/).isVisible(), "Returning to the list must retain drafts")
        await testPage.locator("li").filter({ hasText: "结构验收示例库" }).getByRole("button", { name: "查看结构" }).click()
        await testPage
            .locator("main aside")
            .getByRole("button", { name: /^orders/ })
            .click()
        assert((await testPage.getByLabel("表的业务说明").inputValue()) === "尚未保存的输入", "Draft must survive switching views")
        await testPage.getByRole("button", { name: "保存说明与范围" }).click()
        await testPage.getByText("已保存，刷新页面后仍会保留。").waitFor()
        await testPage.setViewportSize({ width: 390, height: 844 })
        const width = await testPage.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }))
        assert(width.content <= width.viewport + 1, `Unexpected horizontal page overflow: ${JSON.stringify(width)}`)
        assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`)
        return {
            realSqlite: true,
            compositeForeignKey: true,
            notesPersist: true,
            confirmedRelation: true,
            aiScope: true,
            draftPreserved: true,
            mobile: true,
            browserErrors: errors.length,
        }
    } finally {
        await context.close()
    }
}
