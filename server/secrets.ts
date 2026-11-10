import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const VERSION = "v1"
const IV_BYTES = 12
const TAG_BYTES = 16

function decodeBase64(value: string, expectedLength?: number): Buffer {
  const decoded = Buffer.from(value, "base64")
  if (decoded.toString("base64") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error("Invalid encrypted value")
  }
  return decoded
}

export function createSecretCodec(key: Buffer) {
  if (key.length !== 32) throw new Error("Invalid master key")

  function seal(value: unknown): string {
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error("Value is not serializable")

    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()])
    return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":")
  }

  function open(value: string): unknown {
    const parts = value.split(":")
    if (parts.length !== 4) throw new Error("Invalid encrypted value")
    const [version, iv, tag, ciphertext] = parts
    if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted value")

    const decipher = createDecipheriv("aes-256-gcm", key, decodeBase64(iv, IV_BYTES))
    decipher.setAuthTag(decodeBase64(tag, TAG_BYTES))
    const plaintext = Buffer.concat([decipher.update(decodeBase64(ciphertext)), decipher.final()])
    return JSON.parse(plaintext.toString("utf8")) as unknown
  }

  return { seal, open }
}
