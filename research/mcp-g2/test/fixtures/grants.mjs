import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { grantAuthority } from "../../dist/grant-authority.js";

export async function grantFixture(pool, sessionReferenceDeadline, identity, clientId, resource) {
  const ddl = await readFile(new URL("../../schema/mcp-grants.sql", import.meta.url), "utf8");
  for (const statement of ddl.split(";").filter((value) => value.trim()))
    await pool.query(statement);
  const grantId = randomUUID();
  await pool.execute(
    "INSERT INTO mcp_grant (id,ownerId,clientId,approvalSessionId,resource,generation,expiresAt,createdAt) VALUES (?,?,?,?,?,1,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),UTC_TIMESTAMP(3))",
    [grantId, identity.ownerId, clientId, identity.sessionId, resource],
  );
  let beforeSession, afterConfirmation;
  async function transaction(work) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const result = await work(c);
      await c.commit();
      return result;
    } catch (error) {
      try {
        await c.rollback();
      } catch (rollback) {
        throw new AggregateError([error, rollback], "G2_GRANT_ROLLBACK_FAILED");
      }
      throw error;
    } finally {
      c.release();
    }
  }
  const authorize = grantAuthority({
    observe: (hash, decide) =>
      transaction(async (c) => {
        const [rows] = await c.execute(
          "SELECT g.*, t.issuedGeneration FROM mcp_grant g JOIN mcp_grant_token t ON t.grantId=g.id WHERE t.tokenHash=? FOR SHARE",
          [hash],
        );
        const row = rows[0];
        const record = row
          ? {
              ownerId: row.ownerId,
              clientId: row.clientId,
              sessionId: row.approvalSessionId,
              resource: row.resource,
              generation: Number(row.generation),
              issuedGeneration: Number(row.issuedGeneration),
              revoked: row.revokedAt !== null,
              expiresAt: row.expiresAt.getTime(),
            }
          : null;
        await beforeSession?.();
        const sessionExpiresAt = record
          ? await sessionReferenceDeadline(c, record.ownerId, record.sessionId)
          : undefined;
        const result = await decide({ record, sessionExpiresAt });
        await afterConfirmation?.(result);
        return result;
      }),
  });
  return {
    authorize,
    grantId,
    approve: (expectedGeneration, action) =>
      transaction(async (c) => {
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
          throw new Error("G2_APPROVAL_REQUIRED");
        const [rows] = await c.execute(
          "SELECT generation,revokedAt,expiresAt FROM mcp_grant WHERE id=? FOR UPDATE",
          [grantId],
        );
        const row = rows[0];
        if (
          !row ||
          Number(row.generation) !== expectedGeneration ||
          row.revokedAt !== null ||
          row.expiresAt.getTime() <= Date.now()
        )
          throw new Error("G2_APPROVAL_STALE");
        // Prevent an old attempt from changing the SDK's cached consent after a
        // generation advance. SDK tables are changed only through its public API.
        return action();
      }),
    generation: async () => {
      const [rows] = await pool.execute("SELECT generation FROM mcp_grant WHERE id=?", [grantId]);
      const value = Number(rows[0]?.generation);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("G2_GRANT_GENERATION_INVALID");
      return value;
    },
    pauseBeforeSession: (hook) => {
      beforeSession = hook;
    },
    pauseAfterConfirmation: (hook) => {
      afterConfirmation = hook;
    },
    register: async (token, approvedGeneration) => {
      if (!Number.isSafeInteger(approvedGeneration) || approvedGeneration < 1)
        throw new Error("G2_APPROVAL_REQUIRED");
      const [result] = await pool.execute(
        "INSERT INTO mcp_grant_token (tokenHash,grantId,issuedGeneration) SELECT ?,id,? FROM mcp_grant WHERE id=? AND generation=? AND revokedAt IS NULL AND expiresAt>UTC_TIMESTAMP(3)",
        [
          createHash("sha256").update(token).digest("hex"),
          approvedGeneration,
          grantId,
          approvedGeneration,
        ],
      );
      if (result.affectedRows !== 1) throw new Error("G2_APPROVAL_STALE");
    },
    revoke: () =>
      pool.execute(
        "UPDATE mcp_grant SET generation=generation+1,revokedAt=UTC_TIMESTAMP(3) WHERE id=?",
        [grantId],
      ),
    advance: () =>
      pool.execute("UPDATE mcp_grant SET generation=generation+1 WHERE id=?", [grantId]),
  };
}
