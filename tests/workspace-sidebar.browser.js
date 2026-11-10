// Run with `playwright-cli -s=shuriva-layout run-code --filename=tests/workspace-sidebar.browser.js`
// against the local production preview on port 4179. The browser context is isolated.
async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 } })
  const testPage = await context.newPage()
  const errors = []
  testPage.on("pageerror", (error) => errors.push(error.message))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const key = "shuriva-demo-v1"
  const result = {}

  try {
    await testPage.goto("http://127.0.0.1:4179/workspaces/customer-360")
    const sidebar = testPage.getByRole("complementary", { name: "AI 工作台助手" })
    await sidebar.waitFor()
    const toolbar = testPage.locator(".workspace-toolbar")
    assert(await toolbar.getByText("已保存", { exact: true }).isVisible(), "A clean workspace should show its saved state in the toolbar")
    assert(await toolbar.getByRole("button", { name: /保存修改|放弃修改/ }).count() === 0, "A clean workspace should not show draft actions")
    assert(await testPage.getByRole("button", { name: /编辑布局|用 AI 修改/ }).count() === 0, "The AI panel should be open and layout editing removed")
    assert(await testPage.locator(".react-grid-layout, [data-workspace-grip]").count() === 0, "No drag grid or handles should be rendered")
    assert(await testPage.locator(".workspace-metrics > *").count() === 3, "All three metrics should render")
    await testPage.getByRole("textbox", { name: "搜索订单、客户或可见邮箱" }).fill("ORD-")
    assert(await testPage.getByRole("textbox", { name: "搜索订单、客户或可见邮箱" }).inputValue() === "ORD-", "Search should remain usable")
    await testPage.getByRole("textbox", { name: "搜索订单、客户或可见邮箱" }).clear()

    const separator = testPage.getByRole("separator", { name: "调整 AI 侧栏宽度" })
    const beforeWidth = (await sidebar.boundingBox()).width
    const divider = await separator.boundingBox()
    await testPage.mouse.move(divider.x + divider.width / 2, divider.y + 100)
    await testPage.mouse.down()
    await testPage.mouse.move(divider.x - 55, divider.y + 100, { steps: 10 })
    await testPage.mouse.up()
    await testPage.waitForTimeout(150)
    assert((await sidebar.boundingBox()).width > beforeWidth + 40, "The AI sidebar should still resize")
    result.sidebarResize = true

    await testPage.getByRole("button", { name: "隐藏手机号列" }).click()
    await testPage.getByText("草稿预览已更新", { exact: false }).waitFor()
    await toolbar.getByText("未保存草稿", { exact: true }).waitFor()
    assert(await toolbar.getByRole("button", { name: "保存修改" }).isVisible(), "Save should belong to the workspace toolbar")
    assert(await toolbar.getByRole("button", { name: "放弃修改" }).isVisible(), "Discard should belong to the workspace toolbar")
    assert(await sidebar.getByRole("button", { name: /保存修改|放弃修改/ }).count() === 0, "Draft actions should not appear beneath the chat composer")
    const toolbarTop = (await toolbar.boundingBox()).y
    await testPage.locator(".workspace-split-canvas").evaluate((canvas) => { canvas.scrollTop = 600 })
    assert(Math.abs((await toolbar.boundingBox()).y - toolbarTop) < 1, "The draft actions should stay visible while the workspace scrolls")
    await testPage.getByRole("textbox", { name: "描述工作台修改需求" }).fill("请说明当前工作台")
    await testPage.getByRole("button", { name: "发送" }).click()
    await toolbar.getByText("AI 正在修改…", { exact: true }).waitFor()
    assert(await toolbar.getByRole("button", { name: "保存修改" }).isDisabled(), "Save should be unavailable while AI is modifying the draft")
    assert(await toolbar.getByRole("button", { name: "放弃修改" }).isDisabled(), "Discard should be unavailable while AI is modifying the draft")
    await testPage.getByRole("button", { name: "保存修改" }).click()
    await toolbar.getByText("已保存", { exact: true }).waitFor()
    assert(await toolbar.getByRole("button", { name: /保存修改|放弃修改/ }).count() === 0, "Saving should clear the draft actions")
    const legacy = { version: 1, cols: 12, blocks: [{ i: "orders", x: 3, y: 44, w: 8, h: 620 }] }
    await testPage.evaluate(({ key, legacy }) => {
      const state = JSON.parse(localStorage.getItem(key))
      state.workspaces.find((item) => item.id === "customer-360").layout = legacy
      localStorage.setItem(key, JSON.stringify(state))
    }, { key, legacy })
    await testPage.reload()
    await testPage.getByRole("button", { name: "日期范围改为最近 7 天" }).click()
    await testPage.getByRole("button", { name: "保存修改" }).waitFor({ state: "visible" })
    await toolbar.getByText("AI 正在修改…", { exact: true }).waitFor({ state: "hidden" })
    await testPage.getByRole("button", { name: "保存修改" }).click()
    await toolbar.getByText("已保存", { exact: true }).waitFor()
    const saved = await testPage.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)).workspaces.find((item) => item.id === "customer-360"), key)
    assert(JSON.stringify(saved.layout) === JSON.stringify(legacy), "An old saved layout must not be destroyed")
    assert(saved.config.defaultDays === "7", "AI modifications must still save")
    result.aiSaveAndLegacyData = true

    await testPage.getByRole("textbox", { name: "描述工作台修改需求" }).fill("隐藏使用趋势")
    await testPage.getByRole("button", { name: "发送" }).click()
    await toolbar.getByText("未保存草稿", { exact: true }).waitFor()
    await testPage.getByRole("button", { name: "放弃修改" }).click()
    await testPage.getByRole("dialog").getByRole("button", { name: "放弃修改" }).click()
    assert(await testPage.getByRole("heading", { name: "产品使用趋势" }).count() === 1, "Discard should restore the saved workspace")
    assert(await sidebar.isVisible(), "Discard must not close the AI sidebar")
    result.aiDiscard = true

    await testPage.getByRole("button", { name: "数据与模块" }).click()
    await testPage.getByRole("button", { name: "修改绑定" }).click()
    await testPage.getByRole("button", { name: "更改工作台数据源" }).click()
    await testPage.getByRole("checkbox", { name: "选择 订单测试库" }).click()
    await testPage.getByRole("button", { name: "确认选择" }).click()
    const bindingDialog = testPage.getByRole("dialog")
    await bindingDialog.getByRole("combobox", { name: "订单明细的数据源" }).click()
    await testPage.getByRole("option", { name: "订单测试库 · PostgreSQL" }).click()
    await bindingDialog.getByRole("button", { name: "完成" }).click()
    await testPage.getByText("数据源暂时不可用").waitFor()
    assert(await testPage.getByRole("heading", { name: "客户资料" }).count() === 1, "The profile should remain available when orders are offline")
    assert(await testPage.getByRole("heading", { name: "产品使用趋势" }).count() === 1, "The trend should remain available when orders are offline")
    await testPage.getByRole("button", { name: "放弃修改" }).click()
    await testPage.getByRole("dialog").getByRole("button", { name: "放弃修改" }).click()
    result.independentSources = true

    await testPage.getByRole("textbox", { name: "描述工作台修改需求" }).fill("隐藏使用趋势")
    await testPage.getByRole("button", { name: "发送" }).click()
    await toolbar.getByText("未保存草稿", { exact: true }).waitFor()
    const savedState = await testPage.evaluate((storageKey) => localStorage.getItem(storageKey), key)
    await testPage.evaluate((storageKey) => {
      const state = JSON.parse(localStorage.getItem(storageKey))
      state.workspaces.find((workspace) => workspace.id === "customer-360").version += 1
      localStorage.setItem(storageKey, JSON.stringify(state))
    }, key)
    await testPage.getByRole("button", { name: "保存修改" }).click()
    await testPage.getByText("工作台已在其他页面修改或删除", { exact: false }).waitFor()
    assert(await testPage.getByRole("button", { name: "保存修改" }).isEnabled(), "A version conflict must retain the draft")
    await testPage.evaluate(({ storageKey, state }) => localStorage.setItem(storageKey, state), { storageKey: key, state: savedState })
    await testPage.evaluate(() => {
      window.originalSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (storageKey, value) {
        if (storageKey === "shuriva-demo-v1") throw new DOMException("full", "QuotaExceededError")
        return window.originalSetItem.call(this, storageKey, value)
      }
    })
    await testPage.getByRole("button", { name: "保存修改" }).click()
    await testPage.getByText("浏览器存储不可用", { exact: false }).waitFor()
    assert(await testPage.getByRole("button", { name: "保存修改" }).isEnabled(), "Storage failure must retain the draft")
    await testPage.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; delete window.originalSetItem })
    await testPage.getByRole("button", { name: "放弃修改" }).click()
    await testPage.getByRole("dialog").getByRole("button", { name: "放弃修改" }).click()
    result.failureRecovery = true

    const widths = []
    for (const width of [1440, 1100, 900, 700, 390]) {
      await testPage.setViewportSize({ width, height: 900 })
      await testPage.waitForTimeout(250)
      const state = await testPage.evaluate(() => {
        const canvas = document.querySelector(".workspace-canvas")
        const metrics = [...document.querySelectorAll(".workspace-metrics > *")].map((item) => item.getBoundingClientRect())
        return {
          viewport: innerWidth,
          canvas: Math.round(canvas.getBoundingClientRect().width),
          overflow: document.documentElement.scrollWidth > innerWidth,
          overlapping: metrics.some((a, index) => metrics.slice(index + 1).some((b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1)),
        }
      })
      assert(!state.overflow && !state.overlapping, `Responsive layout must not overlap at ${width}px`)
      assert(await sidebar.isVisible(), `AI panel must be visible at ${width}px`)
      widths.push(state)
    }
    result.responsive = widths

    await testPage.setViewportSize({ width: 1440, height: 900 })
    const originalState = await testPage.evaluate((storageKey) => localStorage.getItem(storageKey), key)
    await testPage.evaluate((storageKey) => {
      const state = JSON.parse(localStorage.getItem(storageKey))
      state.workspaces.find((workspace) => workspace.id === "customer-360").title = "这是一个很长的工作台名称".repeat(8)
      localStorage.setItem(storageKey, JSON.stringify(state))
    }, key)
    await testPage.reload()
    await testPage.getByRole("textbox", { name: "描述工作台修改需求" }).fill("隐藏使用趋势")
    await testPage.getByRole("button", { name: "发送" }).click()
    await toolbar.getByText("未保存草稿", { exact: true }).waitFor()
    await testPage.setViewportSize({ width: 320, height: 640 })
    await testPage.waitForTimeout(250)
    const longTitleLayout = await testPage.evaluate(() => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      toolbarHeight: document.querySelector(".workspace-toolbar").getBoundingClientRect().height,
      canvasHeight: document.querySelector(".workspace-split-canvas").getBoundingClientRect().height,
    }))
    assert(longTitleLayout.documentWidth <= longTitleLayout.viewportWidth, "A long workspace title must not overflow a narrow viewport")
    assert(longTitleLayout.toolbarHeight < longTitleLayout.canvasHeight * 0.6, "A long title must leave the workspace preview usable")
    assert(await toolbar.getByRole("button", { name: "保存修改" }).isVisible(), "Save should remain visible with a long title")
    await toolbar.getByRole("button", { name: "放弃修改" }).click()
    await testPage.getByRole("dialog").getByRole("button", { name: "放弃修改" }).click()
    await toolbar.getByText("已保存", { exact: true }).waitFor()
    await testPage.evaluate(({ storageKey, state }) => localStorage.setItem(storageKey, state), { storageKey: key, state: originalState })
    await testPage.setViewportSize({ width: 1440, height: 900 })
    await testPage.evaluate(() => localStorage.setItem("shuriva-demo-ui-v1", JSON.stringify({ state: { edition: "team", previewRole: "owner" }, version: 0 })))
    await testPage.reload()
    await testPage.getByRole("textbox", { name: "描述工作台修改需求" }).fill("隐藏使用趋势")
    await testPage.getByRole("button", { name: "发送" }).click()
    await toolbar.getByText("未保存草稿", { exact: true }).waitFor()
    await testPage.getByRole("combobox", { name: "切换预览角色" }).click()
    await testPage.getByRole("option", { name: "客服", exact: true }).click()
    await testPage.getByText("当前为只读演示角色", { exact: false }).waitFor()
    assert(await testPage.getByRole("button", { name: "保存修改" }).count() === 0, "Read-only roles must not save")
    await testPage.getByRole("combobox", { name: "切换预览角色" }).click()
    await testPage.getByRole("option", { name: "数据管理员", exact: true }).click()
    await testPage.getByRole("button", { name: "保存修改" }).waitFor()
    assert(await testPage.getByRole("button", { name: "保存修改" }).isEnabled(), "The owner's draft should survive role preview")
    await testPage.getByRole("button", { name: "放弃修改" }).click()
    await testPage.getByRole("dialog").getByRole("button", { name: "放弃修改" }).click()
    result.rolePreview = true

    await testPage.evaluate(() => localStorage.setItem("shuriva-demo-ui-v1", JSON.stringify({ state: { edition: "community", previewRole: "owner" }, version: 0 })))
    const editor = await context.newPage()
    editor.on("pageerror", (error) => errors.push(error.message))
    await editor.goto("http://127.0.0.1:4179/editor/customer-360")
    await editor.getByText("实时预览").waitFor()
    assert(await editor.getByRole("complementary", { name: "AI 工作台助手" }).isVisible(), "The older editor should use the right-side panel")
    assert(await editor.locator(".react-grid-layout, [data-workspace-grip]").count() === 0, "The older editor must not expose drag controls")
    await editor.close()
    result.oldEditor = true

    const creation = await context.newPage()
    creation.on("pageerror", (error) => errors.push(error.message))
    await creation.goto("http://127.0.0.1:4179/create")
    await creation.getByRole("textbox", { name: "描述你想完成的业务任务" }).fill("创建订单和客户的业务工作台")
    await creation.getByRole("button", { name: "开始构建工作台" }).click()
    await creation.getByRole("textbox", { name: "工作台名称" }).waitFor({ timeout: 15000 })
    assert(await creation.locator(".workspace-metrics > *").count() === 3, "Creation preview must show the same metric structure")
    assert(await creation.locator(".react-grid-layout, [data-workspace-grip]").count() === 0, "Creation should not expose drag controls")
    assert(await creation.getByRole("complementary", { name: "AI 工作台助手" }).isVisible(), "Creation must show the AI sidebar")
    await creation.getByRole("button", { name: "保存工作台" }).click()
    await creation.waitForURL("**/workspaces/workspace-*", { timeout: 10000 })
    const created = await creation.evaluate((storageKey) => {
      const id = location.pathname.split("/").pop()
      return JSON.parse(localStorage.getItem(storageKey)).workspaces.find((workspace) => workspace.id === id)
    }, key)
    assert(created.layout === undefined, "New workspaces should not save obsolete drag layout data")
    assert(created.bindings.orders && created.bindings.profile, "Creation must retain separate source bindings")
    await creation.close()
    result.creation = true

    assert(errors.length === 0, `Page errors: ${errors.join("; ")}`)
    result.pageErrors = errors.length
    return result
  } finally {
    await context.close()
  }
}
