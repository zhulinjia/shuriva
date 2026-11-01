import { databaseConnectionOptions } from "./auth/database.js";
import { OperationalError } from "./operational-error.js";

/** Validate CLI intent and connection configuration before creating any pool. */
export function readMigrationCommand(env: NodeJS.ProcessEnv, args: string[]) {
  const stages = {
    "--stage3": "stage3",
    "--stage6": "stage6",
    "--stage7": "stage7",
    "--stage8": "stage8",
  } as const;
  const option = args[0];
  if (args.length > 1 || (option !== undefined && !Object.hasOwn(stages, option)))
    throw new OperationalError("MIGRATION_OPTION_INVALID");
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new OperationalError("MIGRATION_DATABASE_REQUIRED");
  databaseConnectionOptions(databaseUrl);
  return {
    databaseUrl,
    stage: option === undefined ? ("baseline" as const) : stages[option as keyof typeof stages],
  };
}
