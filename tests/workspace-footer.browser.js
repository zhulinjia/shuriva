// Run with `playwright-cli -s=shuriva-footer-check run-code --filename=tests/workspace-footer.browser.js`
// against the local Vite server on port 4187. The browser context is isolated.
async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 } })
  const testPage = await context.newPage()
  const errors = []
  const results = []
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  testPage.on("pageerror", (error) => errors.push(error.message))

  const checkSplit = async (label) => {
    await testPage.locator(".workspace-split").waitFor()
    await testPage.getByRole("complementary", { name: "AI 工作台助手" }).waitFor()
    await testPage.waitForTimeout(300)
    const beforeScroll = await testPage.evaluate(() => {
      const split = document.querySelector(".workspace-split")
      const canvas = document.querySelector(".workspace-split-canvas")
      const footer = canvas.querySelector("footer")
      const globalFooter = document.querySelector(".app-shell-footer")
      return {
        viewport: [innerWidth, innerHeight],
        documentHeight: document.documentElement.scrollHeight,
        documentWidth: document.documentElement.scrollWidth,
        splitBottom: split.getBoundingClientRect().bottom,
        canvasHeight: canvas.clientHeight,
        canvasContentHeight: canvas.scrollHeight,
        footerText: footer?.textContent,
        globalFooterDisplay: getComputedStyle(globalFooter).display,
      }
    })
    assert(beforeScroll.documentHeight <= beforeScroll.viewport[1] + 1, `${label}: unexpected document scrollbar: ${JSON.stringify(beforeScroll)}`)
    assert(beforeScroll.documentWidth <= beforeScroll.viewport[0] + 1, `${label}: unexpected horizontal scrollbar: ${JSON.stringify(beforeScroll)}`)
    assert(Math.abs(beforeScroll.splitBottom - beforeScroll.viewport[1]) <= 1, `${label}: split does not reach viewport bottom: ${JSON.stringify(beforeScroll)}`)
    assert(beforeScroll.globalFooterDisplay === "none", `${label}: global footer still occupies space`)
    assert(beforeScroll.footerText.includes("全部使用虚构数据"), `${label}: preview disclaimer missing`)

    const afterScroll = await testPage.locator(".workspace-split-canvas").evaluate((canvas) => {
      canvas.scrollTop = canvas.scrollHeight
      const area = canvas.getBoundingClientRect()
      const footer = canvas.querySelector("footer").getBoundingClientRect()
      return { top: footer.top - area.top, bottom: footer.bottom - area.bottom, windowScrollY: window.scrollY }
    })
    assert(afterScroll.top >= -1 && afterScroll.bottom <= 1, `${label}: footer is not reachable inside the canvas: ${JSON.stringify(afterScroll)}`)
    assert(afterScroll.windowScrollY === 0, `${label}: scrolling the canvas moved the document`)
    results.push({ label, ...beforeScroll })
  }

  try {
    await testPage.goto("http://127.0.0.1:4187/workspaces/customer-360")
    for (const viewport of [{ width: 1440, height: 1321 }, { width: 1440, height: 900 }, { width: 700, height: 900 }, { width: 390, height: 844 }]) {
      await testPage.setViewportSize(viewport)
      await checkSplit(`workspace ${viewport.width}x${viewport.height}`)
    }
    assert(results.some((result) => result.canvasContentHeight > result.canvasHeight), "Long workspace content should retain internal scrolling")

    await testPage.setViewportSize({ width: 1440, height: 900 })
    await testPage.evaluate(() => localStorage.setItem("shuriva-demo-ui-v1", JSON.stringify({ state: { edition: "team", previewRole: "owner" }, version: 0 })))
    await testPage.reload()
    await testPage.getByRole("combobox", { name: "切换预览角色" }).waitFor()
    await checkSplit("workspace team role preview")

    await testPage.evaluate(() => localStorage.setItem("shuriva-demo-ui-v1", JSON.stringify({ state: { edition: "community", previewRole: "owner" }, version: 0 })))
    await testPage.goto("http://127.0.0.1:4187/editor/customer-360")
    await testPage.getByText("实时预览").waitFor()
    await checkSplit("editor desktop")
    assert(await testPage.locator(".workspace-split-canvas").getByText("编辑和预览均为本地模拟", { exact: false }).count() === 1, "Editor notice must remain in the canvas")
    assert(await testPage.locator(".workspace-split-canvas").getByRole("button", { name: "返回工作台" }).count() === 1, "Editor return control must remain available")
    await testPage.setViewportSize({ width: 390, height: 844 })
    await checkSplit("editor mobile")

    await testPage.setViewportSize({ width: 1440, height: 900 })
    await testPage.goto("http://127.0.0.1:4187/create")
    await testPage.getByRole("textbox", { name: "描述你想完成的业务任务" }).waitFor()
    assert(await testPage.locator(".app-shell-footer").isVisible(), "Create entry should keep the global footer")
    await testPage.getByRole("textbox", { name: "描述你想完成的业务任务" }).fill("创建订单和客户的业务工作台")
    await testPage.getByRole("button", { name: "开始构建工作台" }).click()
    await testPage.getByRole("textbox", { name: "工作台名称" }).waitFor({ timeout: 15000 })
    await checkSplit("creation draft")
    assert(await testPage.locator(".workspace-split-canvas").getByText("这是本地 Mock 草稿", { exact: false }).count() === 1, "Creation mock notice must remain in the canvas")

    await testPage.goto("http://127.0.0.1:4187/workspaces")
    await testPage.locator(".app-shell-footer").waitFor()
    assert(await testPage.locator(".workspace-split").count() === 0, "Workspace list should not contain a split view")
    assert(await testPage.locator(".app-shell-footer").isVisible(), "Workspace list should keep the global footer")
    assert(errors.length === 0, `Page errors: ${errors.join("; ")}`)
    return { results, pageErrors: errors.length, ordinaryPagesKeepFooter: true }
  } finally {
    await context.close()
  }
}
