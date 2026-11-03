import { DataSourceStore } from "../../src/datasources/store.js";
import { isolatedMysql } from "../isolated-mysql.js";

const [database, ownerId, workspaceId, sourceId] = process.argv.slice(2);
if (!database || !ownerId || !workspaceId || !sourceId)
  throw Error("missing isolated rebind scope");
const isolated = await isolatedMysql();
const pool = isolated.pool(database);
try {
  const sources = new DataSourceStore(pool, true);
  await sources.unbind(ownerId, workspaceId, sourceId);
  await sources.bind(ownerId, workspaceId, sourceId);
  const binding = await sources.boundSource(ownerId, workspaceId, sourceId);
  if (!binding?.bindingGeneration) throw Error("missing authoritative generation");
  process.stdout.write(binding.bindingGeneration);
} finally {
  await pool.end();
}
