import type { RegistrySigner } from "./registry-signer.js";

/** Shared identity coordination; state is read lazily after every rollback. */
export interface RegistryProtocolContext {
  readonly failed: boolean;
  readonly signer: RegistrySigner;
  activeIdentity(id: string): { readonly owner: string; readonly publicKey: string } | undefined;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  forConnector<T>(id: string, fn: () => Promise<T>, limit?: boolean): Promise<T>;
  /** Called inside exclusive to atomically consume and persist the nonce. */
  consumeReplay(id: string, now: number): Promise<void>;
}
