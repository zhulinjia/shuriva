import { copyFile } from "node:fs/promises"

for (const file of ["workspace-prompt.md", "connection-test-prompt.md"]) {
    await copyFile(new URL(`../server/ai/${file}`, import.meta.url), new URL(`../dist-server/server/ai/${file}`, import.meta.url))
}
