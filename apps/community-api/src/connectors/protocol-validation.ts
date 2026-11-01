import { createPublicKey, verify } from "node:crypto";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const B64 = /^[A-Za-z0-9_-]+$/;
export function decode(value: string, length: number): Buffer | undefined {
  if (!B64.test(value)) return;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length && bytes.toString("base64url") === value ? bytes : undefined;
}
export function safeText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
  );
}
export function validateAgentVersion(version: unknown): version is string {
  return safeText(version, 64) && /^[A-Za-z0-9._+-]+$/.test(version);
}
export function verifySignature(publicKey: string, signature: string, fields: string[]): boolean {
  const key = decode(publicKey, 32);
  const sig = decode(signature, 64);
  if (!key || !sig) return false;
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]);
    return verify(
      null,
      Buffer.from(fields.join("\n"), "utf8"),
      createPublicKey({ key: spki, format: "der", type: "spki" }),
      sig,
    );
  } catch {
    return false;
  }
}
