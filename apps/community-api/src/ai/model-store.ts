import { createHash, createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { type ModelConfig, modelEndpoint } from "./provider.js";

type Credential = Pick<Entry, "getPassword" | "setPassword" | "deletePassword">;
type CredentialFactory = (ownerId: string) => Credential;

function validOwner(ownerId: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(ownerId);
}

function validateConfig(value: unknown): ModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_MODEL");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3 ||
    typeof input.baseUrl !== "string" ||
    typeof input.model !== "string" ||
    typeof input.apiKey !== "string" ||
    !input.model.trim() ||
    input.model !== input.model.trim() ||
    Buffer.byteLength(input.model) > 256 ||
    Array.from(input.model).some((ch) => (ch.codePointAt(0) ?? 0) < 32) ||
    !/^[\x21-\x7e]{1,4096}$/.test(input.apiKey)
  )
    throw new Error("INVALID_MODEL");
  modelEndpoint(input.baseUrl);
  return { baseUrl: input.baseUrl, model: input.model, apiKey: input.apiKey };
}

/** Secrets and model configuration are stored together in the system credential store. */
export class ModelStore {
  private readonly versionKey = randomBytes(32);
  private readonly generations = new Map<string, string>();
  private readonly watchers = new Map<string, Set<AbortController>>();

  constructor(private readonly credential: CredentialFactory) {}

  get(ownerId: string): ModelConfig | null {
    if (!validOwner(ownerId)) throw new Error("INVALID_MODEL");
    const secret = this.credential(ownerId).getPassword();
    if (secret === null) return null;
    if (Buffer.byteLength(secret) > 8192) throw new Error("MODEL_STORE_UNAVAILABLE");
    try {
      return validateConfig(JSON.parse(secret) as unknown);
    } catch {
      throw new Error("MODEL_STORE_UNAVAILABLE");
    }
  }

  display(
    ownerId: string,
  ):
    | { configured: false }
    | { configured: true; baseUrl: string; model: string; configVersion: string } {
    const value = this.versioned(ownerId);
    return value
      ? {
          configured: true,
          baseUrl: value.config.baseUrl,
          model: value.config.model,
          configVersion: value.configVersion,
        }
      : { configured: false };
  }

  /** A process-scoped, non-reversible version; it never reveals the key. */
  versioned(ownerId: string): { config: ModelConfig; configVersion: string } | null {
    const config = this.get(ownerId);
    if (!config) return null;
    const configVersion = createHmac("sha256", this.versionKey)
      .update(ownerId)
      .update("\0")
      .update(this.generations.get(ownerId) ?? "")
      .update("\0")
      .update(JSON.stringify(config))
      .digest("base64url");
    return { config, configVersion };
  }

  /** Registration and configuration writes are synchronous on this process. */
  watch(ownerId: string, expectedVersion: string): { signal: AbortSignal; dispose: () => void } {
    if (this.versioned(ownerId)?.configVersion !== expectedVersion) throw new Error("STALE");
    const watcher = new AbortController();
    let ownerWatchers = this.watchers.get(ownerId);
    if (!ownerWatchers) {
      if (this.watchers.size >= 2048) throw new Error("CAPACITY");
      ownerWatchers = new Set();
      this.watchers.set(ownerId, ownerWatchers);
    }
    if (ownerWatchers.size >= 16) throw new Error("CAPACITY");
    ownerWatchers.add(watcher);
    return {
      signal: watcher.signal,
      dispose: () => {
        ownerWatchers?.delete(watcher);
        if (ownerWatchers?.size === 0 && this.watchers.get(ownerId) === ownerWatchers)
          this.watchers.delete(ownerId);
      },
    };
  }

  private invalidate(ownerId: string): void {
    this.generations.set(ownerId, randomBytes(32).toString("base64url"));
    const watchers = this.watchers.get(ownerId);
    if (watchers) for (const watcher of watchers) watcher.abort();
    this.watchers.delete(ownerId);
  }

  set(ownerId: string, value: unknown): void {
    if (!validOwner(ownerId)) throw new Error("INVALID_MODEL");
    const config = validateConfig(value);
    const secret = JSON.stringify(config);
    const entry = this.credential(ownerId);
    this.invalidate(ownerId);
    entry.setPassword(secret);
    if (entry.getPassword() !== secret) throw new Error("MODEL_STORE_UNAVAILABLE");
  }

  clear(ownerId: string): void {
    if (!validOwner(ownerId)) throw new Error("INVALID_MODEL");
    const entry = this.credential(ownerId);
    this.invalidate(ownerId);
    entry.deletePassword();
    if (entry.getPassword() !== null) throw new Error("MODEL_STORE_UNAVAILABLE");
  }
}

export function systemModelStore(statePath: string): ModelStore {
  const instance = resolve(statePath);
  return new ModelStore((ownerId) => {
    const name = createHash("sha256").update(instance).update("\0").update(ownerId).digest("hex");
    return new Entry("ai-workspace-model", name, { linux: { store: "secret-service" } });
  });
}
