import { createApp } from "./app.js"
import { createStorage } from "./storage.js"

function configuredPort(value: string | undefined): number {
  const port = value === undefined ? 3000 : Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("SHURIVA_PORT must be an integer from 0 to 65535")
  }
  return port
}

async function main() {
  const host = process.env.SHURIVA_HOST || "127.0.0.1"
  const port = configuredPort(process.env.SHURIVA_PORT)
  const storage = createStorage()
  let app: Awaited<ReturnType<typeof createApp>> | undefined

  try {
    app = await createApp(storage, { serveStatic: true, enableLogging: true })
    await app.listen({ host, port })
  } catch (error) {
    try {
      await app?.close()
    } finally {
      storage.db.close()
    }
    throw error
  }

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    try {
      try {
        await app.close()
      } finally {
        storage.db.close()
      }
    } catch {
      // Errors can contain connection details; do not print the error object.
      app.log.error("Server shutdown failed")
      process.exitCode = 1
    }
  }
  process.once("SIGINT", () => void stop())
  process.once("SIGTERM", () => void stop())
}

main().catch((error: unknown) => {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  if (code === "EADDRINUSE") console.error("Server failed to start: address is already in use")
  else if (error instanceof Error && error.message.startsWith("SHURIVA_PORT")) console.error(error.message)
  else console.error("Server failed to start; check its configuration and data directory")
  process.exitCode = 1
})
