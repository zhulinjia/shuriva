import { readFileSync } from "node:fs"

export const WORKSPACE_SYSTEM_PROMPT = readFileSync(new URL("./workspace-prompt.md", import.meta.url), "utf8").trim()
export const CONNECTION_TEST_SYSTEM_PROMPT = readFileSync(new URL("./connection-test-prompt.md", import.meta.url), "utf8").trim()
