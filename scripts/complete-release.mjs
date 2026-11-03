import { unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { releaseFiles } from "./release-files.mjs";
import { collectLicenses } from "./release-inventory.mjs";

const [directory, revision, channel] = process.argv.slice(2);
if (
  !directory ||
  !/^[0-9a-f]{40}$/.test(revision ?? "") ||
  !["candidate", "release"].includes(channel)
)
  throw Error("Explicit release metadata required");
const root = resolve(directory);
const webRequire = createRequire(resolve("apps/community-web/package.json"));
const inventory = await collectLicenses({
  npmReports: [join(root, "npm-web.json")],
  deployedNpmRoots: [join(root, "platform")],
  goReport: join(root, "go-modules.txt"),
  goToolchainReport: join(root, "go-toolchain.json"),
  embeddedNpm: [resolve(webRequire.resolve("tailwindcss/package.json"), "..")],
  supplementsFile: resolve("docs/third-party/supplements.json"),
  output: join(root, "third-party"),
});
// Raw package-manager reports include local paths; only the portable inventory is redistributed.
for (const file of ["npm-web.json", "go-modules.txt", "go-toolchain.json"])
  await unlink(join(root, file));
const { files, links } = await releaseFiles(root);
if (inventory.missingNotices.length && channel === "release")
  throw Error("Missing dependency notices; release blocked");
await writeFile(
  join(root, "manifest.json"),
  `${JSON.stringify({ format: "shuriva-release-v1", channel, revision, source: channel === "candidate" ? "working-tree; revision is the base commit only" : "clean commit", target: "windows-amd64", node: process.version, dependencyInventory: inventory, files, links }, null, 2)}\n`,
);
console.log(
  `Created ${channel} manifest with ${files.length} files and ${inventory.count} dependency records; ${inventory.missingNotices.length} need notice review.`,
);
