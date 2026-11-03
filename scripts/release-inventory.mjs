import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readReleaseFile } from "./release-files.mjs";

/** Uses package-manager metadata and installed license texts; never reads application configuration. */
export async function collectLicenses({
  npmReports,
  deployedNpmRoots = [],
  goReport,
  goToolchainReport,
  embeddedNpm = [],
  supplementsFile,
  output,
}) {
  if (!isAbsolute(output)) throw Error("License output must be absolute");
  await mkdir(output, { recursive: true });
  const components = new Map();
  const supplements = new Map();
  if (supplementsFile) {
    const supplied = JSON.parse((await readReleaseFile(supplementsFile)).toString("utf8"));
    if (supplied.format !== "shuriva-license-supplements-v1" || !Array.isArray(supplied.components))
      throw Error("Invalid license supplements");
    for (const entry of supplied.components) {
      if (
        entry.ecosystem !== "npm" ||
        typeof entry.name !== "string" ||
        typeof entry.version !== "string" ||
        typeof entry.license !== "string" ||
        typeof entry.file !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        new URL(entry.source).protocol !== "https:"
      )
        throw Error("Invalid license supplement binding");
      const source = resolve(dirname(supplementsFile), entry.file),
        rel = relative(dirname(supplementsFile), source);
      if (isAbsolute(entry.file) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
        throw Error("License supplement escaped source directory");
      const text = await readReleaseFile(source, 1048576);
      if (createHash("sha256").update(text).digest("hex") !== entry.sha256)
        throw Error("License supplement checksum mismatch");
      const key = `npm:${entry.name}@${entry.version}`;
      if (supplements.has(key)) throw Error("Duplicate license supplement");
      supplements.set(key, { ...entry, text });
    }
  }
  async function add(ecosystem, name, version, directory, declaredLicense = null, extra = {}) {
    const key = `${ecosystem}:${name}@${version}`;
    if (components.has(key)) return;
    const id = createHash("sha256").update(key).digest("hex"),
      notices = [];
    for (const file of (await readdir(directory)).sort()) {
      if (
        !/^(?:licen[sc]e|copying|notice|authors|patents|copyright)(?:[._-][a-z0-9._-]+)?$/i.test(
          file,
        )
      )
        continue;
      const source = join(directory, file),
        stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576)
        throw Error("Invalid dependency notice");
      const target = `${id}/${file}`;
      await mkdir(join(output, id), { recursive: true });
      await writeFile(join(output, target), await readReleaseFile(source, 1048576));
      notices.push(target);
    }
    const supplement = supplements.get(key);
    let supplementalNotice;
    if (supplement && !notices.some((name) => /\/(?:licen[sc]e|copying)(?:[._-]|$)/i.test(name))) {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (metadata.license !== supplement.license || declaredLicense !== supplement.license)
        throw Error("License supplement declaration mismatch");
      const target = `${id}/LICENSE.supplement.txt`;
      await mkdir(join(output, id), { recursive: true });
      await writeFile(join(output, target), supplement.text);
      notices.push(target);
      supplementalNotice = {
        source: supplement.source,
        sha256: supplement.sha256,
        license: supplement.license,
      };
    }
    components.set(key, {
      ecosystem,
      name,
      version,
      declaredLicense,
      notices,
      ...extra,
      ...(supplementalNotice ? { supplementalNotice } : {}),
    });
  }
  async function npmPackage(directory, reportedLicense) {
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (typeof metadata.name !== "string" || typeof metadata.version !== "string")
      throw Error("Invalid installed package identity");
    await add(
      "npm",
      metadata.name,
      metadata.version,
      directory,
      reportedLicense ?? metadata.license ?? null,
    );
  }
  // pnpm installs the graph. This only inventories packages actually shipped:
  // pnpm 12's hoisted license report still emits nonexistent virtual paths.
  async function installedPackages(nodeModules) {
    let entries;
    try {
      const stat = await lstat(nodeModules);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Deployed npm inventory requires a link-free tree");
      entries = await readdir(nodeModules);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const path = join(nodeModules, name),
        stat = await lstat(path);
      if (stat.isSymbolicLink()) throw Error("Deployed npm inventory requires a link-free tree");
      if (!stat.isDirectory()) continue;
      if (name.startsWith("@")) {
        for (const member of (await readdir(path)).sort()) {
          const directory = join(path, member),
            memberStat = await lstat(directory);
          if (!memberStat.isDirectory() || memberStat.isSymbolicLink())
            throw Error("Invalid deployed scoped package");
          await npmPackage(directory);
          await installedPackages(join(directory, "node_modules"));
        }
      } else {
        await npmPackage(path);
        await installedPackages(join(path, "node_modules"));
      }
    }
  }
  for (const root of deployedNpmRoots) {
    if (!isAbsolute(root)) throw Error("Explicit deployed package root required");
    await installedPackages(join(root, "node_modules"));
  }
  for (const report of npmReports) {
    const groups = JSON.parse(await readFile(report, "utf8"));
    for (const packages of Object.values(groups)) {
      if (!Array.isArray(packages)) throw Error("Unexpected pnpm license metadata");
      for (const pkg of packages) {
        if (!Array.isArray(pkg.paths)) throw Error("License report lacks package paths");
        for (const directory of pkg.paths) {
          await npmPackage(directory, pkg.license);
        }
      }
    }
  }
  for (const directory of embeddedNpm) await npmPackage(directory);
  for (const line of (await readFile(goReport, "utf8")).trim().split(/\r?\n/)) {
    const [name, version, directory] = line.split("|");
    if (!version) continue; // The main module is covered by the product LICENSE.
    if (!name || !directory || !isAbsolute(directory)) throw Error("Unexpected Go module metadata");
    await add("go", name, version, directory);
  }
  if (goToolchainReport) {
    const toolchain = JSON.parse(await readFile(goToolchainReport, "utf8"));
    if (
      typeof toolchain.root !== "string" ||
      !isAbsolute(toolchain.root) ||
      !/^go[0-9][^\s]*$/.test(toolchain.version) ||
      typeof toolchain.standardPackages !== "string"
    )
      throw Error("Invalid Go toolchain inventory");
    await add("go-toolchain", "Go runtime and standard library", toolchain.version, toolchain.root);
    const vendor = join(toolchain.root, "src/vendor"),
      packageModules = new Map();
    let module;
    for (const line of (await readFile(join(vendor, "modules.txt"), "utf8")).split(/\r?\n/)) {
      const header = /^# ([^\s]+) (v[^\s]+)$/.exec(line);
      if (header) module = { name: header[1], version: header[2] };
      else if (line && !line.startsWith("#")) {
        if (!module) throw Error("Invalid Go vendored module metadata");
        packageModules.set(line, module);
      }
    }
    for (const line of toolchain.standardPackages.split(/\r?\n/)) {
      const [name, directory] = line.split("|");
      if (!name?.startsWith("vendor/")) continue;
      const owned = packageModules.get(name.slice("vendor/".length));
      if (
        !owned ||
        !directory ||
        resolve(directory) !== resolve(vendor, name.slice("vendor/".length))
      )
        throw Error("Unrecognized compiled Go vendored package");
      await add("go-toolchain-vendor", owned.name, owned.version, join(vendor, owned.name), null, {
        toolchain: toolchain.version,
      });
    }
  }
  const result = [...components.values()].sort((a, b) =>
    `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(`${b.ecosystem}:${b.name}@${b.version}`),
  );
  if (!result.length) throw Error("Empty dependency inventory");
  await writeFile(
    join(output, "licenses.json"),
    `${JSON.stringify({ format: "shuriva-licenses-v1", components: result }, null, 2)}\n`,
  );
  return {
    count: result.length,
    missingNotices: result
      .filter(
        (component) =>
          !component.notices.some((name) => /\/(?:licen[sc]e|copying)(?:[._-]|$)/i.test(name)),
      )
      .map(({ ecosystem, name, version }) => ({ ecosystem, name, version })),
  };
}
