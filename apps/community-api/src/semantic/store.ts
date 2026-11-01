import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { type BoundSourceAccess, DataSourceError, validId } from "../datasources/public.js";
import {
  emptySemanticDocument,
  type SemanticDocument,
  semanticDocumentSchema,
  staleSemanticEntries,
} from "./model.js";

interface ModelRow extends RowDataPacket {
  snapshotId: string;
  revision: number;
  content: unknown;
}

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

/** Semantic content is scoped independently of Connector authorization. */
export class SemanticStore {
  constructor(private readonly sources: BoundSourceAccess) {}

  async get(owner: string, workspace: string, source: string) {
    return this.sources.withBoundSnapshot(owner, workspace, source, async (c, latest) => {
      const [rows] = await c.execute<ModelRow[]>(
        "SELECT snapshotId, revision, content FROM semantic_model WHERE workspaceId=? AND sourceId=?",
        [workspace, source],
      );
      const row = rows[0];
      const document = row
        ? semanticDocumentSchema.parse(json(row.content))
        : emptySemanticDocument();
      const parsed = latest?.content ?? null;
      const stale = parsed ? staleSemanticEntries(document, parsed) : [];
      return {
        revision: row ? Number(row.revision) : 0,
        snapshotId: latest?.id ?? null,
        basedOnSnapshotId: row?.snapshotId ?? null,
        document,
        stale,
        snapshot: parsed,
      };
    });
  }

  async save(
    owner: string,
    workspace: string,
    source: string,
    expected: unknown,
    snapshotId: unknown,
    input: unknown,
  ) {
    if (
      !Number.isSafeInteger(expected) ||
      Number(expected) < 0 ||
      Number(expected) >= 4_294_967_295 ||
      typeof snapshotId !== "string" ||
      !validId(snapshotId)
    )
      throw new DataSourceError("INVALID");
    const parsed = semanticDocumentSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 256 * 1024)
      throw new DataSourceError("INVALID");
    const document: SemanticDocument = parsed.data;
    return this.sources.withBoundSnapshot(owner, workspace, source, async (c, latest) => {
      if (!latest || latest.id !== snapshotId) throw new DataSourceError("CONFLICT");
      if (staleSemanticEntries(document, latest.content).length)
        throw new DataSourceError("INVALID");
      const [rows] = await c.execute<ModelRow[]>(
        "SELECT revision FROM semantic_model WHERE workspaceId=? AND sourceId=? FOR UPDATE",
        [workspace, source],
      );
      if ((rows[0] ? Number(rows[0].revision) : 0) !== expected)
        throw new DataSourceError("CONFLICT");
      if (rows[0]) {
        const [updated] = await c.execute<ResultSetHeader>(
          "UPDATE semantic_model SET snapshotId=?, revision=revision+1, content=?, updatedAt=UTC_TIMESTAMP(3) WHERE workspaceId=? AND sourceId=? AND revision=?",
          [snapshotId, JSON.stringify(document), workspace, source, expected],
        );
        if (updated.affectedRows !== 1) throw new DataSourceError("CONFLICT");
      } else {
        await c.execute(
          "INSERT INTO semantic_model (workspaceId,sourceId,snapshotId,revision,content,updatedAt) VALUES (?,?,?,1,?,UTC_TIMESTAMP(3))",
          [workspace, source, snapshotId, JSON.stringify(document)],
        );
      }
      return { revision: Number(expected) + 1 };
    });
  }
}
