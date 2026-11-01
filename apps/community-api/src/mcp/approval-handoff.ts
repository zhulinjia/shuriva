import { isMainThread } from "node:worker_threads";
import { createApprovalHandoffCore } from "./approval-handoff-core.js";

export type { ApprovalBinding } from "./approval-handoff-core.js";

/** The public factory fixes the platform clock; callers cannot substitute a
 * clock that fails to include suspension. Other OS support requires a verified
 * suspend-aware timer and is intentionally not enabled yet. */
export function createApprovalHandoff(key: Buffer) {
  if (!isMainThread) throw new Error("MCP_HANDOFF_WORKER_UNSUPPORTED");
  if (process.platform !== "win32") throw new Error("MCP_HANDOFF_PLATFORM_UNSUPPORTED");
  return createApprovalHandoffCore(key, {
    monotonic: () => Number(process.hrtime.bigint() / 1_000_000n),
  });
}
