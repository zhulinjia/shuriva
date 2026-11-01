import { createHash } from "node:crypto";
import type { SemanticDocument, SemanticSnapshot } from "./model.js";

/** Matches the Connector's length-prefixed digest; raw enum values never leave for the model. */
export function semanticStructureHash(snapshot: SemanticSnapshot, table: string): string {
  const physical = snapshot.tables.find((entry) => entry.name === table);
  if (!physical) throw new Error("STALE");
  const columns = snapshot.columns
    .filter((column) => column.table === table)
    .sort((a, b) => a.position - b.position);
  const parts = ["semantic-structure-v1", snapshot.database, table, physical.kind];
  for (const column of columns)
    parts.push(column.name, column.type, column.nullable ? "1" : "0", String(column.position));
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size).update(bytes);
  }
  return hash.digest("hex");
}

/** Compare relevant saved physical structure with freshly attested Connector metadata. */
export function assertSemanticStructure(
  document: SemanticDocument,
  snapshot: SemanticSnapshot | null,
  current: ReadonlyMap<string, string>,
): void {
  const referenced = new Set([
    ...document.entities.map((item) => item.table),
    ...document.fields.map((item) => item.table),
    ...document.relationships.flatMap((item) => [item.from.table, item.to.table]),
    ...document.metrics.map((item) => item.field.table),
  ]);
  for (const table of referenced) {
    if (!current.has(table)) continue;
    if (!snapshot || semanticStructureHash(snapshot, table) !== current.get(table))
      throw new Error("STALE");
  }
}
