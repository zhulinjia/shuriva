import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ExternalMcpError } from "./model.js";
export async function noLinks(raw: string) {
  const target = resolve(raw);
  for (let p = target; ; p = dirname(p)) {
    if ((await lstat(p)).isSymbolicLink())
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LINK_REJECTED");
    if (dirname(p) === p) break;
  }
  if ((await realpath(target)).toLowerCase() !== target.toLowerCase())
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LINK_REJECTED");
  return target;
}
export async function fileHash(file: string, max = 268435456) {
  await noLinks(file);
  const s = await lstat(file);
  if (!s.isFile() || s.size > max) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_LIMIT");
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  return { sha256: hash.digest("hex"), size: s.size };
}
