import "dotenv/config";
import { defineConfig } from "prisma/config";

// The draft schema can be validated without connecting to a database. Set
// DATABASE_URL only when preparing an isolated test database for migrations.
const url = process.env.DATABASE_URL?.trim();
const args = process.argv.slice(2);

// This draft does not match installed tables; do not apply it until unified.
const help = args.includes("--help") || args.includes("-h");
if (!help && ((args.includes("migrate") && ["dev", "deploy", "reset", "resolve"].some((name) => args.includes(name))) ||
  (args.includes("db") && args.includes("push")))) {
  throw new Error("Prisma schema is a draft and must not be applied to the database; see apps/community-api/README.md.");
}
// Prisma 7.10.1 may report success without output for diff without a URL.
if (!url && args.includes("migrate") && !help) {
  throw new Error("DATABASE_URL must be set for Prisma migration commands.");
}

export default defineConfig({
  schema: "archive/schema-product-draft.prisma",
  migrations: { path: "prisma/migrations" },
  ...(url ? { datasource: { url } } : {}),
});
