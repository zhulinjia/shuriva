import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { test } from "node:test"
import { requestWorkspace } from "../../server/ai/provider.js"

test("the AI provider sends the Chinese Markdown file as its system prompt", { timeout: 15_000 }, async (t) => {
    const requests: { messages: { role: string; content: string }[] }[] = []
    const provider = createServer((request, response) => {
        let body = ""
        request.setEncoding("utf8")
        request.on("data", (chunk: string) => {
            body += chunk
        })
        request.on("end", () => {
            requests.push(JSON.parse(body) as { messages: { role: string; content: string }[] })
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ accepted: true }) } }] }))
        })
    })
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
    t.after(
        () =>
            new Promise<void>((resolve) => {
                provider.close(() => resolve())
                provider.closeAllConnections()
            }),
    )
    const address = provider.address()
    assert.ok(address && typeof address === "object")

    const context = { instruction: "查看记录", sources: [], current: null }
    const result = await requestWorkspace(
        { provider: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model", apiKey: "test-key" },
        context,
    )

    assert.deepEqual(result, { accepted: true })
    assert.equal(requests.length, 1)
    const system = requests[0]?.messages.find((message) => message.role === "system")
    const user = requests[0]?.messages.find((message) => message.role === "user")
    const markdown = await readFile(new URL("../../server/ai/workspace-prompt.md", import.meta.url), "utf8")
    assert.ok(system)
    assert.equal(system.content, markdown.trim())
    assert.match(system.content, /工作台/)
    assert.deepEqual(JSON.parse(user?.content ?? "null"), context)
})
