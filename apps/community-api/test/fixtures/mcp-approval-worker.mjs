import { randomBytes } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { createApprovalHandoff } from "../../dist/src/mcp/approval-handoff.js";

try {
  createApprovalHandoff(randomBytes(32));
  parentPort.postMessage("unexpected success");
} catch (error) {
  parentPort.postMessage(error.message);
}
