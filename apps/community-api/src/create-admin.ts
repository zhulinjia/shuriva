import { OperationalError } from "./operational-error.js";
import { stdin, stdout } from "node:process";
import { diagnostics } from "./logging/public.js";
import { createInterface } from "node:readline/promises";
import type { RowDataPacket } from "mysql2/promise";
import { createAuth, createDatabase, readAuthConfig } from "./auth.js";

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new OperationalError("ADMIN_TERMINAL_REQUIRED");
  const config = readAuthConfig(process.env);
  const pool = createDatabase(config.databaseUrl);
  const connection = await pool.getConnection();
  const prompt = createInterface({ input: stdin, output: stdout });
  let locked = false;
  try {
    const [lock] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK('ai_workspace_admin_setup', 10) AS acquired",
    );
    if (lock[0]?.acquired !== 1) throw new OperationalError("ADMIN_SETUP_LOCK_UNAVAILABLE");
    locked = true;
    const [rows] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM `user`");
    if (Number(rows[0]?.count) !== 0) throw new OperationalError("ADMIN_ALREADY_EXISTS");
    const username = (await prompt.question("管理员用户名: ")).trim();
    const email = (await prompt.question("管理员邮箱: ")).trim();
    const name = (await prompt.question("显示名称: ")).trim();
    // Hide password input from the terminal without accepting it in CLI arguments.
    stdout.write("管理员密码（至少 12 位）: ");
    prompt.close();
    const password = await readPassword();
    const auth = createAuth(config, pool);
    await auth.api.signUpEmail({ body: { email, name, password, username } });
    stdout.write("管理员账号已创建。\n");
  } finally {
    prompt.close();
    if (locked) await connection.query("SELECT RELEASE_LOCK('ai_workspace_admin_setup')");
    connection.release();
    await pool.end();
  }
}

async function readPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (data: string) => {
      for (const char of data) {
        if (char === "\u0003") {
          cleanup();
          reject(new OperationalError("ADMIN_CANCELLED"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}
main().catch((error: unknown) => {
  diagnostics.error("admin.initialize_failed", {}, error);
  process.exitCode = 1;
});
