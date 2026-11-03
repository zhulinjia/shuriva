import { createHash } from "node:crypto";
import {
  canonicalSchemaResultFields,
  canonicalSchemaTaskFields,
  type SchemaTask,
  type SchemaResult,
} from "@shuriva/core-contracts";
export type { SchemaTask, SchemaResult } from "@shuriva/core-contracts";
export { schemaResultBodyFields } from "@shuriva/core-contracts";
export const schemaTaskFields = (
  input: Omit<SchemaTask, "signature" | "operation" | "protocol">,
): string[] => canonicalSchemaTaskFields(input);
export const schemaResultFields = (input: SchemaResult): string[] =>
  canonicalSchemaResultFields(input, (payload) =>
    createHash("sha256").update(payload).digest("hex"),
  );
