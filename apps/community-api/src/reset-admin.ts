import { OperationalError } from "./operational-error.js";
import { stdin, stdout } from "node:process";
import { diagnostics } from "./logging/public.js";
import { createDatabase, readAuthConfig } from "./auth.js";
import { resetOnlyAdminPassword } from "./reset-password.js";

async function hiddenPassword(message: string): Promise<string> {
  stdout.write(message);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
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
    stdin.on("data", onData);
  });
}
async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new OperationalError("ADMIN_TERMINAL_REQUIRED");
  const config = readAuthConfig(process.env);
  const first = await hiddenPassword("新管理员密码（至少 12 位）: ");
  const second = await hiddenPassword("再次输入新密码: ");
  if (first !== second) throw new OperationalError("ADMIN_PASSWORD_MISMATCH");
  const pool = createDatabase(config.databaseUrl);
  try {
    await resetOnlyAdminPassword(pool, first);
    stdout.write("密码已重设，所有已有会话已退出。\n");
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  diagnostics.error("admin.reset_failed", {}, error);
  process.exitCode = 1;
});
