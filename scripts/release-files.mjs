import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export async function readReleaseFile(path, limit = 16 * 1048576) {
  const expected = await lstat(path, { bigint: true });
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.size > BigInt(limit) ||
    !samePath(await realpath(path), resolve(path))
  )
    throw Error("Invalid release file or manifest link");
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size)
      throw Error("Release file changed");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== Number(before.size) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      !samePath(await realpath(path), resolve(path))
    )
      throw Error("Release file changed");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function privateContent(name) {
  const normalized = name.toLowerCase();
  return (
    [
      ".git",
      ".private",
      ".runtime",
      ".cache",
      ".ssh",
      ".aws",
      "backups",
      "dumps",
      ".env",
      ".envrc",
      ".npmrc",
      ".netrc",
      ".pypirc",
      "credentials.json",
    ].includes(normalized) ||
    (/^\.env\./.test(normalized) && normalized !== ".env.example") ||
    /^service-account.*\.json$/.test(normalized) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(normalized) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|log|dump|pid|sock|bolt|bbolt)$/.test(normalized) ||
    /\.(?:db|sqlite|sqlite3)(?:-.*)?$/.test(normalized) ||
    /\.sql\.(?:gz|zip|zst)$/.test(normalized)
  );
}

export async function releaseFiles(directory) {
  const root = resolve(directory),
    files = [],
    links = [];
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(root), root))
    throw Error("Release root cannot contain links");
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      if (privateContent(name)) throw Error("Runtime or private content in release");
      const stat = await lstat(path),
        portable = relative(root, path).replaceAll("\\", "/");
      if (stat.isSymbolicLink())
        throw Error("Release links are not portable and may escape package");
      if (path === join(root, "manifest.json")) {
        await readReleaseFile(path);
        continue;
      }
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile())
        files.push({
          path: portable,
          bytes: stat.size,
          sha256: createHash("sha256")
            .update(await readReleaseFile(path, 512 * 1048576))
            .digest("hex"),
        });
      else throw Error("Unsupported release filesystem entry");
    }
  }
  await walk(root);
  return { files, links };
}
