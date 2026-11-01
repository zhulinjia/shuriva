import { OperationalError } from "./operational-error.js";

/** Keep verification detail for internal assertions. Diagnostics expose only
 * the fixed code/guidance, never metadata supplied by a database server. */
export class MigrationVerificationError extends OperationalError {
  constructor(detail: string) {
    super("MIGRATION_SCHEMA_INVALID");
    this.message = detail;
  }
}
