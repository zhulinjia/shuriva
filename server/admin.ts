import { hash } from "argon2"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { createStorage } from "./storage.js"

async function secret(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw new Error("Run this command from an interactive terminal")
  stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  let value = ""
  try {
    return await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        stdin.off("data", receive)
        stdin.off("end", onEnd)
        stdin.off("error", onError)
      }
      const receive = (chunk: Buffer) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\u0003") {
            cleanup()
            reject(new Error("Cancelled"))
            return
          }
          if (char === "\r" || char === "\n") {
            cleanup()
            resolve(value)
            return
          }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
          else if (char >= " ") value += char
          if (value.length > 1024) {
            cleanup()
            reject(new Error("Password is too long"))
            return
          }
        }
      }
      const onEnd = () => { cleanup(); reject(new Error("Input closed")) }
      const onError = () => { cleanup(); reject(new Error("Input failed")) }
      stdin.on("data", receive)
      stdin.once("end", onEnd)
      stdin.once("error", onError)
    })
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
    stdout.write("\n")
  }
}

async function main() {
  const storage = createStorage()
  try {
    const existing = storage.db.prepare("SELECT username FROM admin WHERE id = 1").get() as { username: string } | undefined
    const reset = process.argv[2] === "reset-password"
    if (existing && !reset) throw new Error("An administrator already exists. Use admin reset-password to recover access.")
    if (!existing && reset) throw new Error("No administrator exists yet")
    let username = existing?.username
    if (!username) {
      const input = createInterface({ input: stdin, output: stdout })
      try {
        username = (await input.question("Administrator username: ")).trim()
      } finally {
        input.close()
      }
      if (!username || username.length > 120) throw new Error("Invalid username")
    }
    const password = await secret("Password (at least 12 characters): ")
    const confirmation = await secret("Confirm password: ")
    if (password.length < 12 || password !== confirmation) {
      throw new Error("Passwords do not match or are outside the permitted length")
    }
    const passwordHash = await hash(password)
    storage.db.transaction(() => {
      storage.db.prepare(
        "INSERT INTO admin(id, username, password_hash) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET username=excluded.username, password_hash=excluded.password_hash",
      ).run(username, passwordHash)
      storage.db.prepare("DELETE FROM sessions").run()
    })()
    stdout.write("Administrator credentials saved. Existing sessions were revoked.\n")
  } finally {
    storage.db.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Administrator setup failed")
  process.exitCode = 1
})
