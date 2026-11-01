import { createHash } from "node:crypto";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const found = new Map();
const visited = new Set();
async function inspect(directory) {
  directory = await realpath(directory).catch(() => null);
  if (!directory || visited.has(directory)) return;
  visited.add(directory);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  } catch {
    return;
  }
  const key = `${metadata.name}@${metadata.version}`;
  const files = [];
  for (const name of await readdir(directory)) {
    if (!/^(LICENSE|LICENCE|NOTICE|COPYING|THIRD.PARTY)/i.test(name)) continue;
    const bytes = await readFile(path.join(directory, name)).catch(() => null);
    if (bytes)
      files.push({
        name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        excerpt: bytes.toString("utf8").slice(0, 180),
      });
  }
  found.set(key, {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license ?? null,
    files,
  });
  const modules = path.resolve(directory, ...metadata.name.split("/").map(() => ".."));
  for (const name of Object.keys({
    ...metadata.dependencies,
    ...metadata.optionalDependencies,
    ...metadata.peerDependencies,
  }))
    await inspect(path.join(modules, name));
}
const manifest = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
  await inspect(path.join(project, "node_modules", name));
const ledger = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.versions.node,
  count: ledger.length,
  missingLicense: ledger.filter((entry) => !entry.license).map((entry) => entry.name),
  missingText: ledger.filter((entry) => !entry.files.length).map((entry) => entry.name),
  packages: ledger,
};
await writeFile(
  new URL("../../../.cache/stage9-g2-dependency-ledger.json", import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    installedPackages: report.count,
    missingLicense: report.missingLicense,
    missingText: report.missingText,
    licenses: [...new Set(ledger.map((entry) => entry.license))],
  }),
);
