import { join, resolve } from "node:path";
import { readReleaseFile, releaseFiles } from "./release-files.mjs";

const [directory] = process.argv.slice(2);
if (!directory || process.argv.length !== 3)
  throw Error("Usage: node scripts/verify-release.mjs ABSOLUTE_RELEASE_DIRECTORY");
const root = resolve(directory),
  manifest = JSON.parse((await readReleaseFile(join(root, "manifest.json"))).toString("utf8"));
if (
  manifest.format !== "shuriva-release-v1" ||
  !["candidate", "release"].includes(manifest.channel)
)
  throw Error("Unrecognized release manifest");
const { files, links } = await releaseFiles(root);
if (
  JSON.stringify(files) !== JSON.stringify(manifest.files) ||
  JSON.stringify(links) !== JSON.stringify(manifest.links)
)
  throw Error("Release integrity check failed: missing, extra, changed files or links");
console.log(
  `Integrity verified for ${manifest.channel}: ${files.length} files, ${links.length} internal links. This is a checksum check, not a publisher signature.`,
);
