#!/usr/bin/env node

/**
 * Cross-platform installer for shadcn-style registry components.
 *
 * Why this exists
 * ---------------
 * @shadcn/registry (as of 0.2.1) resolves each registry file's destination with
 * `resolveNestedFilePath()`, which splits the target directory on "/" only:
 *
 *   const segments = targetDirectory.split("/")
 *
 * On Windows, `resolvedPaths.components` is `I:\project\src\components`, so the
 * split produces a single segment and no match is found. The function then
 * falls back to the file's basename, flattening nested registry paths such as
 * `components/assistant-ui/elements/thread.aui.tsx` into
 * `src/components/thread.aui.tsx`.
 *
 * This project patches @shadcn/registry 0.2.1 (see patches/), so the locally
 * installed shadcn CLI now resolves nested paths correctly. This script is
 * still useful because assistant-ui's CLI delegates to `shadcn@latest` through
 * dlx, which downloads an unpatched copy into its own cache.
 *
 * This script runs the local shadcn CLI (so Base UI transforms, dependency
 * installs and registry resolution still happen), then, as a fallback:
 *   1. moves every flattened file back to its declared registry path;
 *   2. rewrites imports that shadcn adjusted to the flattened locations.
 *
 * Usage:
 *   node scripts/install-registry.mjs thread
 *   node scripts/install-registry.mjs https://r.assistant-ui.com/base/thread.json
 *   node scripts/install-registry.mjs thread --dry-run
 *   node scripts/install-registry.mjs thread --skip-cli   # only relocate files
 *
 * Options:
 *   --dry-run         resolve the registry tree and print the plan, change nothing
 *   --skip-cli        do not run shadcn; only relocate already-written files
 *   --overwrite       pass --overwrite to the shadcn CLI
 *   --keep-existing   keep an existing target file instead of replacing it
 *   --root <dir>      project root (default: nearest directory with components.json)
 *   --help            show this help
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ASSISTANT_REGISTRY = "https://r.assistant-ui.com"
const SHADCN_REGISTRY = "https://ui.shadcn.com"
const FILE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"]
const SCRIPT_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"]

function usage() {
  const text = fs.readFileSync(new URL(import.meta.url), "utf8")
  const start = text.indexOf(" * Usage:")
  const end = text.indexOf(" */", start)
  return text
    .slice(start, end)
    .split("\n")
    .map((line) => line.replace(/^ \* ?/, ""))
    .join("\n")
}

function parseArgs(argv) {
  const options = {
    inputs: [],
    dryRun: false,
    skipCli: false,
    overwrite: false,
    keepExisting: false,
    root: null,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--skip-cli") options.skipCli = true
    else if (arg === "--overwrite") options.overwrite = true
    else if (arg === "--keep-existing") options.keepExisting = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--root") {
      index += 1
      if (!argv[index]) throw new Error("--root 需要一个目录参数")
      options.root = argv[index]
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数：${arg}`)
    } else {
      options.inputs.push(arg)
    }
  }

  return options
}

function findProjectRoot(start) {
  let current = path.resolve(start)
  while (true) {
    if (fs.existsSync(path.join(current, "components.json"))) return current
    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`从 ${start} 向上未找到 components.json`)
    }
    current = parent
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

/**
 * Minimal JSONC reader: tsconfig files may contain comments and trailing commas.
 * TypeScript 7 does not expose the compiler API used by earlier versions, so
 * this script parses the few options it needs directly.
 */
function stripJsonComments(text) {
  let output = ""
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        output += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }

    if (char === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }

    output += char
  }

  return output.replace(/,\s*([}\]])/g, "$1")
}

function readJsonc(file) {
  return JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8")))
}

function loadTsPaths(root) {
  const candidates = [
    "tsconfig.app.json",
    ...fs
      .readdirSync(root)
      .filter((name) => /^tsconfig.*\.json$/.test(name) || name === "jsconfig.json"),
    "tsconfig.json",
  ]

  const seen = new Set()
  for (const name of candidates) {
    if (seen.has(name)) continue
    seen.add(name)
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue

    const config = readJsonc(file)
    const options = config.compilerOptions ?? {}
    if (!options.paths) continue

    return {
      baseUrl: options.baseUrl
        ? path.resolve(path.dirname(file), options.baseUrl)
        : path.dirname(file),
      paths: options.paths,
    }
  }

  return null
}

function resolveAlias(alias, tsPaths) {
  if (!tsPaths) {
    throw new Error(
      "无法读取 tsconfig paths，不能解析 components.json 中的别名。"
    )
  }

  for (const [pattern, targets] of Object.entries(tsPaths.paths)) {
    const target = targets[0]
    const star = pattern.indexOf("*")
    if (star === -1) {
      if (alias === pattern) return path.resolve(tsPaths.baseUrl, target)
      continue
    }
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (!alias.startsWith(prefix) || !alias.endsWith(suffix)) continue
    const middle = alias.slice(prefix.length, alias.length - suffix.length)
    return path.resolve(tsPaths.baseUrl, target.replace("*", middle))
  }

  throw new Error(`无法用 tsconfig paths 解析别名：${alias}`)
}

function loadLayout(root) {
  const config = readJson(path.join(root, "components.json"))
  const aliases = config.aliases ?? {}
  const tsPaths = loadTsPaths(root)
  const resolved = {}

  for (const key of ["components", "ui", "utils", "lib", "hooks"]) {
    if (typeof aliases[key] === "string") {
      resolved[key] = resolveAlias(aliases[key], tsPaths)
    }
  }

  if (!resolved.components) {
    throw new Error("components.json 缺少 aliases.components")
  }
  if (!resolved.ui) {
    resolved.ui = path.join(resolved.components, "ui")
  }
  if (!resolved.hooks) {
    resolved.hooks = path.join(path.dirname(resolved.components), "hooks")
  }

  return {
    root,
    style: typeof config.style === "string" ? config.style : undefined,
    aliases,
    paths: resolved,
  }
}

const itemCache = new Map()

async function fetchItem(url) {
  if (itemCache.has(url)) return itemCache.get(url)

  const promise = (async () => {
    let response
    try {
      response = await fetch(url, {
        headers: { accept: "application/json" },
      })
    } catch (error) {
      throw new Error(`请求注册表失败：${url}\n${error.message}`)
    }

    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`注册表返回 ${response.status}：${url}`)
    }
    return response.json()
  })()

  itemCache.set(url, promise)
  return promise
}

async function resolveInputUrl(input, style) {
  if (/^https?:\/\//i.test(input)) {
    const item = await fetchItem(input)
    if (!item) throw new Error(`注册表项不存在：${input}`)
    return input
  }

  const assistantUrl = style?.startsWith("base-")
    ? `${ASSISTANT_REGISTRY}/styles/${style}/${input}.json`
    : `${ASSISTANT_REGISTRY}/${input}.json`

  if (await fetchItem(assistantUrl)) return assistantUrl

  const shadcnStyle = style ?? "new-york"
  const shadcnUrl = `${SHADCN_REGISTRY}/r/styles/${shadcnStyle}/${input}.json`
  if (await fetchItem(shadcnUrl)) return shadcnUrl

  throw new Error(
    `找不到注册表项 ${input}。已尝试：\n  ${assistantUrl}\n  ${shadcnUrl}`
  )
}

async function collectItems(inputUrls, style) {
  const items = new Map()
  const queue = [...inputUrls]

  while (queue.length > 0) {
    const url = queue.shift()
    if (items.has(url)) continue

    const item = await fetchItem(url)
    if (!item) throw new Error(`注册表项不存在：${url}`)
    items.set(url, item)

    for (const dependency of item.registryDependencies ?? []) {
      if (/^https?:\/\//i.test(dependency)) {
        queue.push(dependency)
      } else {
        queue.push(await resolveInputUrl(dependency, style))
      }
    }
  }

  return [...items.entries()].map(([url, item]) => ({ url, item }))
}

function targetDirectory(type, layout) {
  switch (type) {
    case "registry:ui":
      return layout.paths.ui ?? path.join(layout.paths.components, "ui")
    case "registry:hook":
      return layout.paths.hooks
    case "registry:lib":
      return layout.paths.lib
    case "registry:component":
    case "registry:block":
      return layout.paths.components
    default:
      return null
  }
}

function aliasFor(type, layout) {
  switch (type) {
    case "registry:ui":
      return layout.aliases.ui ?? `${layout.aliases.components}/ui`
    case "registry:hook":
      return layout.aliases.hooks
    case "registry:lib":
      return layout.aliases.lib
    case "registry:component":
    case "registry:block":
      return layout.aliases.components
    default:
      return null
  }
}

function canonicalPath(file, directory, type) {
  const segments = file.path.split("/").filter(Boolean)

  // Mirror shadcn's own rule: find the segment that names the target directory
  // (e.g. "components" or "ui") and keep everything after it. This is the part
  // that fails on Windows because shadcn splits the absolute target directory
  // on "/" instead of using path.sep.
  const directoryName = path.basename(directory)
  const matchIndex = segments.indexOf(directoryName)
  if (matchIndex !== -1 && matchIndex < segments.length - 1) {
    return path.join(directory, ...segments.slice(matchIndex + 1))
  }

  // Fallback for registry paths without a matching directory segment.
  if (segments[0] === "src") segments.shift()
  if (segments[0] === "components") {
    segments.shift()
    if (type === "registry:ui" && segments[0] === "ui") segments.shift()
  } else if (type === "registry:hook" && segments[0] === "hooks") {
    segments.shift()
  } else if (type === "registry:lib" && segments[0] === "lib") {
    segments.shift()
  } else if (type === "registry:ui" && segments[0] === "ui") {
    segments.shift()
  }

  return path.join(directory, ...segments)
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/")
}

function stripExtension(filePath) {
  for (const extension of FILE_EXTENSIONS) {
    if (filePath.endsWith(extension)) {
      return filePath.slice(0, -extension.length)
    }
  }
  return filePath
}

function buildPlan(items, layout) {
  const warnings = []
  const entriesByCanonical = new Map()

  for (const { item } of items) {
    for (const file of item.files ?? []) {
      const directory = targetDirectory(file.type, layout)
      if (!directory) {
        warnings.push(
          `跳过 ${item.name} 的 ${file.type} 文件（${file.path}）：该类型需要 target/framework 解析`
        )
        continue
      }

      const canonical = canonicalPath(file, directory, file.type)
      const flat = path.join(directory, path.basename(file.path))
      const alias = aliasFor(file.type, layout)

      const canonicalRelative = stripExtension(
        toPosix(path.relative(directory, canonical))
      )
      const flatRelative = stripExtension(path.basename(file.path))
      const canonicalSpecifier = alias
        ? `${alias}/${canonicalRelative}`
        : null
      const flatSpecifier = alias ? `${alias}/${flatRelative}` : null

      const entry = {
        item: item.name,
        registryPath: file.path,
        type: file.type,
        directory,
        canonical,
        flat,
        canonicalSpecifier,
        flatSpecifier,
      }

      const existing = entriesByCanonical.get(canonical)
      if (!existing) {
        entriesByCanonical.set(canonical, entry)
      } else if (existing.flat !== flat) {
        warnings.push(
          `发现同名文件冲突：${existing.registryPath} 与 ${file.path} 都会写入 ${canonical}`
        )
      }
    }
  }

  return {
    entries: [...entriesByCanonical.values()],
    warnings,
  }
}

function snapshotFlatFiles(entries) {
  const snapshot = new Map()
  for (const entry of entries) {
    if (entry.flat === entry.canonical) continue
    try {
      const stat = fs.statSync(entry.flat)
      snapshot.set(entry.flat, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      })
    } catch {
      // File does not exist yet; nothing to snapshot.
    }
  }
  return snapshot
}

function detectPackageManager(root) {
  const packageJsonPath = path.join(root, "package.json")
  if (fs.existsSync(packageJsonPath)) {
    const packageManager = readJson(packageJsonPath).packageManager
    if (typeof packageManager === "string") {
      if (packageManager.startsWith("pnpm@")) return "pnpm"
      if (packageManager.startsWith("yarn@")) return "yarn"
      if (packageManager.startsWith("bun@")) return "bun"
      if (packageManager.startsWith("npm@")) return "npm"
    }
  }

  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn"
  if (fs.existsSync(path.join(root, "bun.lockb"))) return "bun"
  return "npm"
}

function shadcnCommand(root, urls, overwrite) {
  const packageManager = detectPackageManager(root)
  const hasLocalShadcn = fs.existsSync(
    path.join(root, "node_modules", "shadcn", "package.json")
  )
  const addArgs = ["add", ...urls, "--yes"]
  if (overwrite) addArgs.push("--overwrite")

  if (packageManager === "pnpm") {
    return hasLocalShadcn
      ? ["pnpm", ["exec", "shadcn", ...addArgs]]
      : ["pnpm", ["dlx", "shadcn@latest", ...addArgs]]
  }

  if (packageManager === "bun") {
    return ["bunx", ["shadcn@latest", ...addArgs]]
  }

  return ["npx", ["shadcn@latest", ...addArgs]]
}

function runShadcn(root, urls, overwrite) {
  const [command, args] = shadcnCommand(root, urls, overwrite)
  const printable = [command, ...args].join(" ")
  console.log(`\n运行：${printable}\n`)

  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  })

  if (result.error) {
    throw new Error(`无法运行 shadcn：${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`shadcn add 失败，退出码 ${result.status}`)
  }
}

function sameContent(first, second) {
  try {
    return fs.readFileSync(first).equals(fs.readFileSync(second))
  } catch {
    return false
  }
}

function relocate(entries, before, options) {
  const moved = []
  const warnings = []

  for (const entry of entries) {
    if (entry.flat === entry.canonical) continue

    const flatExists = fs.existsSync(entry.flat)
    if (!flatExists) {
      if (!fs.existsSync(entry.canonical)) {
        warnings.push(
          `缺少文件：CLI 未写出 ${entry.flat}，目标 ${entry.canonical} 也不存在`
        )
      }
      continue
    }

    const previous = before.get(entry.flat)
    const stat = fs.statSync(entry.flat)
    if (
      previous &&
      previous.mtimeMs === stat.mtimeMs &&
      previous.size === stat.size
    ) {
      warnings.push(
        `未移动 ${entry.flat}：安装前后没有变化，可能是已有文件，请手工确认`
      )
      continue
    }

    fs.mkdirSync(path.dirname(entry.canonical), { recursive: true })

    if (fs.existsSync(entry.canonical)) {
      if (sameContent(entry.flat, entry.canonical)) {
        fs.rmSync(entry.flat)
        continue
      }
      if (options.keepExisting) {
        warnings.push(
          `保留已有文件 ${entry.canonical}；新文件仍在 ${entry.flat}`
        )
        continue
      }
      const backup = `${entry.canonical}.bak`
      fs.copyFileSync(entry.canonical, backup)
      warnings.push(`已备份 ${entry.canonical} -> ${backup}`)
    }

    fs.renameSync(entry.flat, entry.canonical)
    moved.push(entry)
  }

  return { moved, warnings }
}

function replaceSpecifier(content, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(["'])${escaped}\\1`, "g")
  return content.replace(pattern, (_, quote) => `${quote}${to}${quote}`)
}

function rewriteImports(entries) {
  const replacements = new Map()
  for (const entry of entries) {
    if (
      !entry.flatSpecifier ||
      !entry.canonicalSpecifier ||
      entry.flatSpecifier === entry.canonicalSpecifier
    ) {
      continue
    }
    replacements.set(entry.flatSpecifier, entry.canonicalSpecifier)
  }

  if (replacements.size === 0) return []

  const changed = []
  const files = new Set(
    entries.map((entry) => entry.canonical).filter((file) => fs.existsSync(file))
  )

  for (const file of files) {
    const original = fs.readFileSync(file, "utf8")
    let next = original

    for (const [from, to] of replacements) {
      next = replaceSpecifier(next, from, to)
      for (const extension of SCRIPT_EXTENSIONS) {
        next = replaceSpecifier(next, `${from}${extension}`, `${to}${extension}`)
      }
    }

    if (next !== original) {
      fs.writeFileSync(file, next)
      changed.push(file)
    }
  }

  return changed
}

function printPlan(plan) {
  console.log("\n安装计划：\n")
  for (const entry of plan.entries) {
    const relative = path.relative(process.cwd(), entry.canonical)
    if (entry.flat === entry.canonical) {
      console.log(`  保留  ${relative}`)
    } else {
      console.log(`  归位  ${relative}`)
    }
  }

  if (plan.warnings.length > 0) {
    console.log("\n提示：")
    for (const warning of plan.warnings) console.log(`  - ${warning}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help || options.inputs.length === 0) {
    console.log(usage())
    process.exit(options.help ? 0 : 1)
  }

  const root = options.root
    ? path.resolve(options.root)
    : findProjectRoot(process.cwd())

  if (!fs.existsSync(path.join(root, "components.json"))) {
    throw new Error(`${root} 下没有 components.json`)
  }

  const layout = loadLayout(root)
  const inputUrls = []
  for (const input of options.inputs) {
    inputUrls.push(await resolveInputUrl(input, layout.style))
  }

  const items = await collectItems(inputUrls, layout.style)
  const plan = buildPlan(items, layout)

  if (options.dryRun) {
    printPlan(plan)
    return
  }

  const before = options.skipCli
    ? new Map()
    : snapshotFlatFiles(plan.entries)

  if (!options.skipCli) {
    runShadcn(root, inputUrls, options.overwrite)
  }

  const { moved, warnings } = relocate(plan.entries, before, options)
  const changed = rewriteImports(plan.entries)

  console.log("")
  for (const entry of moved) {
    console.log(
      `已归位  ${path.relative(root, entry.flat)}  ->  ${path.relative(
        root,
        entry.canonical
      )}`
    )
  }
  for (const file of changed) {
    console.log(`已修正 import  ${path.relative(root, file)}`)
  }

  for (const warning of [...plan.warnings, ...warnings]) {
    console.warn(`警告：${warning}`)
  }

  if (moved.length === 0 && changed.length === 0) {
    console.log("没有需要归位或修正的文件。")
  }
}

main().catch((error) => {
  console.error(`\n安装失败：${error.message}`)
  process.exit(1)
})
