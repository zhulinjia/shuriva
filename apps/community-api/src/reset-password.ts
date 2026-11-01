import { hashPassword } from "better-auth/crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

/** Only a local operator with database access can invoke this recovery workflow. */
export async function resetOnlyAdminPassword(pool: Pool, password: string): Promise<void> {
  if (password.length < 12 || password.length > 128)
    throw new Error("密码长度须为 12 至 128 个字符");
  const passwordHash = await hashPassword(password);
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [users] = await c.query<RowDataPacket[]>("SELECT id FROM `user` FOR UPDATE");
    if (users.length !== 1 || typeof users[0]?.id !== "string")
      throw new Error("只有存在且仅存在一个管理员时才能重设密码");
    const id = users[0].id;
    const [accounts] = await c.execute<RowDataPacket[]>(
      "SELECT id FROM `account` WHERE userId = ? AND providerId = 'credential' FOR UPDATE",
      [id],
    );
    if (accounts.length !== 1 || typeof accounts[0]?.id !== "string")
      throw new Error("账号凭据状态异常，请检查数据库");
    const [result] = await c.execute<ResultSetHeader>(
      "UPDATE `account` SET password = ?, updatedAt = UTC_TIMESTAMP(3) WHERE id = ? AND userId = ? AND providerId = 'credential'",
      [passwordHash, accounts[0].id, id],
    );
    if (result.affectedRows !== 1) throw new Error("无法更新管理员凭据");
    await c.execute("DELETE FROM `session` WHERE userId = ?", [id]);
    await c.commit();
  } catch (error) {
    await c.rollback();
    throw error;
  } finally {
    c.release();
  }
}
