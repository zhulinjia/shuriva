import { OperationalError } from "./operational-error.js";
import { hashPassword } from "better-auth/crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

/** Only a local operator with database access can invoke this recovery workflow. */
export async function resetOnlyAdminPassword(pool: Pool, password: string): Promise<void> {
  if (password.length < 12 || password.length > 128)
    throw new OperationalError("ADMIN_PASSWORD_LENGTH");
  const passwordHash = await hashPassword(password);
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [users] = await c.query<RowDataPacket[]>("SELECT id FROM `user` FOR UPDATE");
    if (users.length !== 1 || typeof users[0]?.id !== "string")
      throw new OperationalError("ADMIN_COUNT_INVALID");
    const id = users[0].id;
    const [accounts] = await c.execute<RowDataPacket[]>(
      "SELECT id FROM `account` WHERE userId = ? AND providerId = 'credential' FOR UPDATE",
      [id],
    );
    if (accounts.length !== 1 || typeof accounts[0]?.id !== "string")
      throw new OperationalError("ADMIN_CREDENTIAL_INVALID");
    const [result] = await c.execute<ResultSetHeader>(
      "UPDATE `account` SET password = ?, updatedAt = UTC_TIMESTAMP(3) WHERE id = ? AND userId = ? AND providerId = 'credential'",
      [passwordHash, accounts[0].id, id],
    );
    if (result.affectedRows !== 1) throw new OperationalError("ADMIN_PASSWORD_UPDATE_FAILED");
    await c.execute("DELETE FROM `session` WHERE userId = ?", [id]);
    await c.commit();
  } catch (error) {
    await c.rollback();
    throw error;
  } finally {
    c.release();
  }
}
