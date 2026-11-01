import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Entry } from "@napi-rs/keyring";

test("owned random vault entry persists across processes, confirms shared-user access, then is removed", async () => {
  const namespace = `stackoryn.g2.mcp.${randomUUID()}`;
  const account = randomUUID();
  const entry = new Entry(namespace, account);
  const secret = randomBytes(32).toString("base64url");
  assert.equal(entry.getPassword(), null);
  try {
    entry.setPassword(secret);
    const result = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/vault-reader.mjs", import.meta.url)), namespace, account],
      {
        windowsHide: true,
        timeout: 5000,
        env: { SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE },
      },
    );
    assert.equal(result.stdout, createHash("sha256").update(secret).digest("hex"));
  } finally {
    entry.deletePassword();
  }
  assert.equal(entry.getPassword(), null);
});
