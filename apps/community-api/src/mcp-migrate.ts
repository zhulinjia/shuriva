import { createDatabase } from "./auth.js";
import { verifyDatabaseCurrent } from "./migrations.js";
import { readMigrationCommand } from "./migration-command.js";
import { migrateMcpSchema } from "./mcp/migration.js";
import { diagnostics } from "./logging/public.js";

const input = readMigrationCommand(process.env, []);
const pool = createDatabase(input.databaseUrl);
try {
  if (process.argv.length !== 2) throw new Error("MCP_MIGRATION_ARGUMENT_REJECTED");
  await verifyDatabaseCurrent(pool, true, true, true);
  await migrateMcpSchema(pool);
} catch (error) {
  diagnostics.error("migration.failed", {}, error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
