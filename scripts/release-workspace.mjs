import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function directoryAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Release ancestors cannot be links or non-directories");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
}
export async function createReleaseDirectory(workspace) {
  if (!isAbsolute(workspace)) throw Error("Explicit absolute workspace required");
  const cache = join(workspace, ".cache", "releases");
  // Validate existing ancestors before creating even the releases child.
  await directoryAncestors(cache);
  await mkdir(cache, { recursive: true });
  await directoryAncestors(cache);
  const output = join(cache, `shuriva-community-${randomUUID().replaceAll("-", "")}`);
  await mkdir(output);
  return output;
}
export async function cleanReleaseOutputs(workspace) {
  if (!isAbsolute(workspace)) throw Error("Explicit absolute workspace required");
  const root = resolve(workspace);
  const outputs = [
    "apps/community-api/dist",
    "apps/community-web/dist",
    "packages/core-contracts/dist",
  ];
  async function noLinks(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw Error("Build outputs cannot contain links");
    if (stat.isDirectory())
      for (const entry of await readdir(path)) await noLinks(join(path, entry));
  }
  for (const name of outputs) {
    const output = resolve(root, name);
    if (output !== join(root, ...name.split("/"))) throw Error("Build output escaped workspace");
    await directoryAncestors(output);
    try {
      await noLinks(output);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await rm(output, { recursive: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, workspace] = process.argv.slice(2);
  if (!workspace || process.argv.length !== 4)
    throw Error("Explicit release workspace action required");
  if (action === "prepare") console.log(await createReleaseDirectory(workspace));
  else if (action === "clean") await cleanReleaseOutputs(workspace);
  else throw Error("Unknown release workspace action");
}
