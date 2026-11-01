import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Entry } from "@napi-rs/keyring";

/** The key remains in the OS credential store, never in registry files or logs. */
export function registrySecret(path: string, service = "ai-workspace-connector-registry"): string {
  const name = createHash("sha256").update(resolve(path)).digest("hex");
  // Linux must use a persistent Secret Service, not the nonpersistent kernel keyring fallback.
  const entry = new Entry(service, name, { linux: { store: "secret-service" } });
  const existing = entry.getPassword();
  if (existing !== null) {
    if (!/^[0-9a-f]{64}$/.test(existing)) throw new Error("Connector registry key is invalid");
    return existing;
  }
  const secret = randomBytes(32).toString("hex");
  entry.setPassword(secret);
  if (entry.getPassword() !== secret) throw new Error("Connector registry key could not be saved");
  return secret;
}
