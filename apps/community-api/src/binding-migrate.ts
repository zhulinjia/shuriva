import { createDatabase } from "./auth.js";
import { migrateBindingIdentities } from "./datasources/binding-migration.js";
import { diagnostics } from "./logging/public.js";
import { readMigrationCommand } from "./migration-command.js";
import { verifyDatabaseCurrent } from "./migrations.js";

const input = readMigrationCommand(process.env, []);
const pool = createDatabase(input.databaseUrl);
try {
  if (process.argv.length !== 2) throw new Error("BINDING_MIGRATION_ARGUMENT_REJECTED");
  await verifyDatabaseCurrent(pool, true, true, true, true);
  await migrateBindingIdentities(pool);
} catch (error) {
  diagnostics.error("migration.failed", {}, error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
