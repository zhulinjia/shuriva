import { randomBytes } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { WorkspaceStore } from "../workspaces.js";
import type { ExternalConfig } from "./config.js";
import { ExternalLease } from "./lease.js";
import { verifyExternalSchema } from "./migration.js";
import type { ClientAudit } from "./model.js";
import { RuntimeOwnership } from "./ownership.js";
import { ExternalMcpService } from "./service.js";
import { ExternalMcpStore } from "./store.js";
import { systemClientVault } from "./vault.js";
export async function createExternalRuntime(
  config: ExternalConfig,
  storage: Pool,
  admission: Pool,
  audit: ClientAudit,
  executionHostId: string,
) {
  await verifyExternalSchema(storage);
  const key = randomBytes(32);
  try {
    const service = new ExternalMcpService(
      new ExternalMcpStore(storage),
      new ExternalLease(admission, await RuntimeOwnership.claim(storage), executionHostId),
      new WorkspaceStore(storage),
      systemClientVault(),
      { ...config, executionHostId },
      key,
      audit,
    );
    try {
      await service.initialize();
      return service;
    } catch (e) {
      await service.close();
      throw e;
    }
  } finally {
    key.fill(0);
  }
}
