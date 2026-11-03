import { fileHash, noLinks } from "./program-files.js";

export { fileHash, noLinks } from "./program-files.js";

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { copyFile, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ExternalMcpError } from "./model.js";
import { digest } from "./tool-policy.js";
import { pinExecutable } from "./windows-files.js";

const descriptor = z.strictObject({
  name: z.string().min(1).max(80),
  entry: z.string().min(1).max(240),
  secretEnvironment: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(16),
});
const manifestSchema = descriptor.extend({
  version: z.literal(1),
  files: z
    .array(
      z.strictObject({
        path: z.string().max(512),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().min(0).max(67108864),
      }),
    )
    .min(1)
    .max(5000),
});
export type InstalledProgram = {
  id: string;
  name: string;
  entry: string;
  secretEnvironment: string[];
  manifest: string;
  manifestHash: string;
  node: string;
  nodeHash: string;
  host: string;
  hostHash: string;
  installationHash: string;
};
function inside(root: string, name: string) {
  const p = resolve(root, name),
    part = relative(root, p);
  if (
    isAbsolute(name) ||
    isAbsolute(part) ||
    !part ||
    part.startsWith("..") ||
    name.includes("\0") ||
    name.includes(":")
  )
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_PATH_REJECTED");
  return p;
}
function validEnv(names: string[]) {
  if (
    new Set(names).size !== names.length ||
    names.some(
      (n) =>
        n.startsWith("NODE_") ||
        n.startsWith("SHURIVA_") ||
        ["PATH", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "HOME", "USERPROFILE"].includes(n),
    )
  )
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_ENV_REJECTED");
}
async function boundedFile(path: string, limit: number) {
  await noLinks(path);
  const f = await open(path, "r");
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LIMIT");
    const data = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await f.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LIMIT");
    return data.subarray(0, offset);
  } finally {
    await f.close();
  }
}
async function packageBoundary(root: string) {
  const p: unknown = JSON.parse(
    (await boundedFile(join(root, "package.json"), 16384)).toString("utf8"),
  );
  if (
    !p ||
    typeof p !== "object" ||
    !("type" in p) ||
    !["module", "commonjs"].includes(String(p.type))
  )
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_PACKAGE_REQUIRED");
}
export async function privateDirectory(path: string, host: string, fresh = false) {
  await noLinks(dirname(path));
  const unpin = await pinExecutable(host);
  try {
    await promisify(execFile)(
      host,
      ["--prepare-directory", path, ...(fresh ? ["--new-directory"] : [])],
      {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024,
        env: { SYSTEMROOT: process.env.SystemRoot ?? "" },
      },
    );
  } catch {
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_ACL_REJECTED", 503);
  } finally {
    unpin();
  }
}
async function inventory(root: string) {
  const files = new Set<string>(),
    pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    if (!dir) break;
    await noLinks(dir);
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, item.name);
      await noLinks(p);
      if (item.isDirectory()) pending.push(p);
      else {
        if (!item.isFile() || files.size >= 5001)
          throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LIMIT");
        files.add(p.toLowerCase());
      }
    }
  }
  return files;
}
export class ProgramCatalog {
  constructor(
    readonly root: string,
    readonly host: string,
    readonly node = process.execPath,
  ) {}
  async list() {
    let dirs: Dirent[];
    try {
      dirs = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    const items = [];
    for (const d of dirs) {
      if (d.isDirectory() && /^[a-f0-9-]{36}$/.test(d.name)) {
        const p = await this.inspect(d.name);
        items.push({
          id: p.id,
          name: p.name,
          installationHash: p.installationHash,
          secretEnvironment: p.secretEnvironment,
          executable: p.node,
          arguments: [
            "--import",
            "<本次运行目录>/platform-loader.mjs",
            "--",
            join(dirname(p.manifest), p.entry),
          ],
        });
        if (items.length > 32) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LIMIT");
      }
    }
    return items;
  }
  async inspect(id: string): Promise<InstalledProgram> {
    if (!/^[a-f0-9-]{36}$/.test(id) || process.platform !== "win32" || process.arch !== "x64")
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_UNSUPPORTED");
    const root = await noLinks(join(this.root, id)),
      manifest = join(root, "installation.json"),
      raw = await boundedFile(manifest, 1048576);
    if (raw.length > 1048576) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LIMIT");
    const m = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
    validEnv(m.secretEnvironment);
    await packageBoundary(root);
    const seen = new Set<string>();
    let total = 0;
    for (const f of m.files) {
      const path = inside(root, f.path);
      if (seen.has(path.toLowerCase())) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_REJECTED");
      seen.add(path.toLowerCase());
      const actual = await fileHash(path, 67108864);
      total += actual.size;
      if (actual.sha256 !== f.sha256 || actual.size !== f.size || total > 67108864)
        throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_CHANGED", 409);
    }
    if (!seen.has(inside(root, m.entry).toLowerCase()))
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_REJECTED");
    const actualFiles = await inventory(root);
    actualFiles.delete(manifest.toLowerCase());
    if (actualFiles.size !== seen.size || [...actualFiles].some((p) => !seen.has(p)))
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_CHANGED", 409);
    const node = await noLinks(this.node),
      host = await noLinks(this.host),
      nodeHash = (await fileHash(node)).sha256,
      hostHash = (await fileHash(host, 33554432)).sha256,
      manifestHash = createHash("sha256").update(raw).digest("hex");
    return {
      id,
      name: m.name,
      entry: m.entry,
      secretEnvironment: m.secretEnvironment,
      manifest,
      manifestHash,
      node,
      nodeHash,
      host,
      hostHash,
      installationHash: digest({ manifestHash, nodeHash, hostHash }),
    };
  }
}
/** Explicit OS-admin deployment command; the web/API cannot install code. */
export async function installProgram(source: string, root: string, host: string) {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== "win32" || process.arch !== "x64" || !systemRoot)
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_UNSUPPORTED");
  source = await noLinks(source);
  await packageBoundary(source);
  const input = descriptor.parse(
    JSON.parse((await boundedFile(join(source, "mcp-package.json"), 16384)).toString("utf8")),
  );
  validEnv(input.secretEnvironment);
  inside(source, input.entry);
  const files: Array<{ path: string; sha256: string; size: number }> = [];
  let total = 0;
  const pending = [source];
  while (pending.length) {
    const dir = pending.pop();
    if (!dir) break;
    await noLinks(dir);
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, item.name);
      if (item.isSymbolicLink() || item.name === "installation.json")
        throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_REJECTED");
      if (item.isDirectory()) pending.push(p);
      else {
        const info = await fileHash(p, 67108864);
        total += info.size;
        if (total > 67108864 || files.length >= 5000)
          throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LIMIT");
        files.push({ path: relative(source, p).split(sep).join("/"), ...info });
      }
    }
  }
  if (!files.some((f) => f.path === input.entry))
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_REJECTED");
  await mkdir(dirname(root), { recursive: true });
  await privateDirectory(root, host);
  const id = randomUUID(),
    destination = join(root, id);
  await privateDirectory(destination, host, true);
  try {
    if (process.platform !== "win32")
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_UNSUPPORTED");
    for (const item of files) {
      const from = inside(source, item.path),
        to = inside(destination, item.path);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to, constants.COPYFILE_EXCL);
      if ((await fileHash(to)).sha256 !== item.sha256)
        throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_CHANGED", 409);
    }
    await writeFile(
      join(destination, "installation.json"),
      JSON.stringify({
        ...input,
        version: 1,
        files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
      }),
      { flag: "wx", mode: 0o600 },
    );
    return id;
  } catch (error) {
    const own = await realpath(destination);
    if (dirname(own).toLowerCase() !== resolve(root).toLowerCase())
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_CLEANUP_REJECTED");
    await rm(own, { recursive: true, force: true });
    throw error;
  }
}
