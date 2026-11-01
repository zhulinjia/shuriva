/** Official MySQL tools, confined to the fresh manifest and owned test schemas. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RowDataPacket } from "mysql2/promise";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isolatedMysql } from "../isolated-mysql.js";

async function cli(
  database: string,
  tool: "mysqldump" | "mysql",
  args: string[],
  input?: Buffer,
  rejectIdentity = false,
) {
  assert.match(database, /^g3_mut_api_[0-9a-f]{16}$/);
  const isolated = await isolatedMysql();
  const manifestPath = process.env.STAGE8_G3_MANIFEST;
  assert.ok(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { adminPassword: string };
  assert.equal(typeof manifest.adminPassword, "string");
  assert.match(manifest.adminPassword, /^[0-9a-f]{64}$/);
  const optionFile = join(
    dirname(manifestPath),
    `g4-client-${randomBytes(12).toString("hex")}.cnf`,
  );
  const procedure = `\`${database}\`.\`g4_pin_${randomBytes(8).toString("hex")}\``;
  let installed = false;
  const admin = await isolated.admin();
  try {
    // Windows ignores POSIX mode bits. Verify the actual inherited DACL before
    // placing the temporary client credential in the already-owned run root.
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; $p=$env:STACKORYN_G4_PRIVATE_DIRECTORY; $a=[IO.Directory]::GetAccessControl($p); $s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(-not $a.AreAccessRulesProtected){throw 'private directory required'}; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $s){throw 'foreign directory permission'}}",
      ],
      {
        windowsHide: true,
        env: { ...process.env, STACKORYN_G4_PRIVATE_DIRECTORY: dirname(manifestPath) },
      },
    );
    const [identity] = await admin.query<RowDataPacket[]>(
      "SELECT @@server_uuid uuid,@@datadir dir,@@pid_file pid",
    );
    const literal = (value: unknown) => {
      assert.equal(typeof value, "string");
      return `UNHEX('${Buffer.from(String(value)).toString("hex")}')`;
    };
    await admin.query(
      `CREATE PROCEDURE ${procedure}() SQL SECURITY INVOKER BEGIN IF @@port<>13308 OR BINARY @@server_uuid<>${literal(rejectIdentity ? "00000000-0000-0000-0000-000000000000" : identity[0]?.uuid)} OR BINARY @@datadir<>${literal(identity[0]?.dir)} OR BINARY @@pid_file<>${literal(identity[0]?.pid)} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='G4_TARGET_REFUSED'; END IF; END`,
    );
    installed = true;
    await writeFile(
      optionFile,
      `[client]\nprotocol=TCP\nhost=127.0.0.1\nport=13308\nuser=root\npassword=${manifest.adminPassword}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const output = await new Promise<Buffer>((resolve, reject) => {
      const env = { ...process.env };
      delete env.MYSQL_PWD;
      const child = spawn(
        `C:/Program Files/MySQL/MySQL Server 26.7/bin/${tool}.exe`,
        [
          `--defaults-file=${optionFile}`,
          "--no-login-paths",
          `--init-command=CALL ${procedure}()`,
          ...args,
        ],
        { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let failure = false;
      let diagnostic = "";
      const timer = setTimeout(() => {
        failure = true;
        child.kill();
      }, 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          failure = true;
          child.kill();
        } else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        /* Inspect only the fixed guard code; never log tool diagnostics. */
        diagnostic = (diagnostic + String(chunk)).slice(-4096);
      });
      child.stdin.on("error", () => {
        /* Exit status determines success. */
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(Error("G4 official MySQL tool unavailable"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure || code !== 0)
          reject(
            Error(
              diagnostic.includes("G4_TARGET_REFUSED")
                ? "G4_TARGET_REFUSED"
                : "G4 official MySQL backup/restore failed",
            ),
          );
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
    await isolated.verify(admin);
    return output;
  } finally {
    try {
      await rm(optionFile, { force: true });
    } finally {
      try {
        if (installed) {
          await isolated.verify(admin);
          await admin.query(`DROP PROCEDURE ${procedure}`);
        }
      } finally {
        await admin.end();
      }
    }
  }
}
export async function assertCliIdentityGuard(database: string) {
  await cli(database, "mysql", [database], Buffer.from("SELECT 1"));
  await assert.rejects(
    cli(database, "mysql", [database], Buffer.from("CREATE TABLE g4_guard_escape(id INT)"), true),
    { message: "G4_TARGET_REFUSED" },
  );
  const isolated = await isolatedMysql(),
    pool = isolated.pool(database);
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='g4_guard_escape'",
    );
    assert.equal(rows.length, 0);
  } finally {
    await pool.end();
  }
}
export async function encryptedSnapshot(database: string, path: string, key: Buffer) {
  assert.match(database, /^g3_mut_api_[0-9a-f]{16}$/);
  const sql = await cli(database, "mysqldump", [
    "--single-transaction",
    "--skip-lock-tables",
    "--skip-add-locks",
    "--skip-comments",
    "--no-tablespaces",
    "--set-gtid-purged=OFF",
    "--column-statistics=0",
    "--hex-blob",
    database,
  ]);
  try {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(sql), cipher.final()]);
    await writeFile(path, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), {
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    sql.fill(0);
  }
}
export async function restoreSnapshot(database: string, path: string, key: Buffer) {
  assert.match(database, /^g3_mut_api_[0-9a-f]{16}$/);
  const bytes = await readFile(path),
    decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const sql = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  try {
    await cli(database, "mysql", ["--binary-mode", "--local-infile=0", database], sql);
  } finally {
    sql.fill(0);
  }
}
