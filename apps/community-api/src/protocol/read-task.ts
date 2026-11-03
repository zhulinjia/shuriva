import { createHash } from "node:crypto";
import {
  canonicalReadCancelFields,
  canonicalReadResultFields,
  canonicalReadTaskFields,
  type ReadTask,
  type ReadCancel,
  type ReadResult,
} from "@shuriva/core-contracts";
export type { ReadTask, ReadCancel, ReadResult } from "@shuriva/core-contracts";
export { readResultBodyFields } from "@shuriva/core-contracts";
const hash = (payload: string) => createHash("sha256").update(payload).digest("hex");
export const readTaskFields = (task: ReadTask): string[] => canonicalReadTaskFields(task, hash);
export const readCancelFields = (task: ReadCancel): string[] => canonicalReadCancelFields(task);
export const readResultFields = (task: ReadResult): string[] =>
  canonicalReadResultFields(task, hash);
