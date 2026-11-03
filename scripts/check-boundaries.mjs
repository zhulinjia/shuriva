import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["apps/community-api", "apps/community-web", "packages"];
const blockedCore = ["@nestjs/", "@prisma/", "prisma", "mysql2", "better-auth", "react", "express"];
const features = new Set([
  "auth",
  "ai",
  "connectors",
  "datasources",
  "history",
  "mutations",
  "queries",
  "semantic",
  "logging",
  "mcp",
  "mcp-client",
]);
const diagnosticEvents = new Set();
const eventSource = ts.createSourceFile(
  "events.ts",
  await readFile(path.join(root, "apps/community-api/src/logging/events.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
function collectEventNames(node) {
  if (ts.isStringLiteral(node)) diagnosticEvents.add(node.text);
  ts.forEachChild(node, collectEventNames);
}
collectEventNames(eventSource);

function staticModuleText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function runtimeModuleLoader(node) {
  return (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  );
}

function moduleTarget(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
    return staticModuleText(node.moduleSpecifier);
  if (runtimeModuleLoader(node) && node.arguments.length >= 1)
    return staticModuleText(node.arguments[0]);
  return undefined;
}

function violation(source, specifier, kind = "import") {
  const from = source.replaceAll("\\", "/");
  const fromKey = from.toLowerCase();
  if (
    fromKey.startsWith("apps/community-api/src/") &&
    (specifier.startsWith("/") || path.isAbsolute(specifier) || /^file:/i.test(specifier))
  )
    return "absolute file imports are not allowed in API production code";
  let resolved = "";
  if (specifier.startsWith(".") || /^file:/i.test(specifier)) {
    try {
      // CommonJS treats # and % as literal path characters; ESM uses URL semantics.
      if (kind === "require" && specifier.startsWith("."))
        resolved = path.resolve(root, path.dirname(from), specifier).replaceAll("\\", "/");
      else {
        const base = pathToFileURL(`${path.resolve(root, path.dirname(from))}${path.sep}`);
        resolved = fileURLToPath(new URL(specifier, base)).replaceAll("\\", "/");
      }
    } catch {
      return "invalid module file URL";
    }
  }
  const relative = resolved ? path.relative(root, resolved).replaceAll("\\", "/") : "";
  const relativeKey = relative.toLowerCase();
  const toApi =
    relativeKey.startsWith("apps/community-api/") ||
    specifier.startsWith("@workspace/community-api");
  const toWeb =
    relativeKey.startsWith("apps/community-web/") ||
    specifier.startsWith("@workspace/community-web");
  const toUI =
    relativeKey === "packages/ui" ||
    relativeKey.startsWith("packages/ui/") ||
    specifier === "@workspace/ui" ||
    specifier.startsWith("@workspace/ui/");
  if (from.startsWith("apps/community-web/") && toApi)
    return "web must not depend on API internals";
  if (from.startsWith("apps/community-api/") && (toWeb || toUI))
    return "API must not depend on the web or UI";
  if (from.startsWith("packages/") && (toApi || toWeb))
    return "shared packages must not depend on applications";
  if (relativeKey === ".private" || relativeKey.startsWith(".private/"))
    return "public code must not depend on private implementations";
  if (
    (from.startsWith("packages/core/") || from.startsWith("packages/core-contracts/")) &&
    (toUI || blockedCore.some((name) => specifier === name || specifier.startsWith(name)))
  )
    return "core must not depend on infrastructure or UI";
  if (/^@workspace\/[^/]+\/(?:src|dist)(?:\/|$)/.test(specifier))
    return "use a package public entry point, not src or dist";
  const originFeature = /^apps\/community-api\/src\/([^/]+)\//.exec(fromKey)?.[1];
  const destinationFeature = /^apps\/community-api\/src\/([^/]+)\//.exec(relativeKey)?.[1];
  if (
    fromKey.startsWith("apps/community-api/src/") &&
    /^apps\/community-api\/src\/mcp\/approval-handoff-core(?:\.[cm]?[jt]s)?$/.test(relativeKey) &&
    fromKey !== "apps/community-api/src/mcp/approval-handoff.ts"
  )
    return "approval handoff clock injection is private to its platform wrapper";
  if (
    features.has(originFeature) &&
    features.has(destinationFeature) &&
    originFeature !== destinationFeature &&
    !/\/public\.[cm]?[jt]s$/.test(relativeKey)
  )
    return "feature modules must use a peer's explicit public boundary";
  if (
    /^apps\/community-api\/src\/mutations\/(?:service|ports|outcome)\.ts$/.test(from) &&
    /^(?:mysql2|@nestjs|express)(?:\/|$)/.test(specifier)
  )
    return "application/domain rules must not import the database or HTTP driver";
  return undefined;
}

function moduleProblem(source, node) {
  const target = moduleTarget(node);
  if (
    source.replaceAll("\\", "/").startsWith("apps/community-api/src/") &&
    runtimeModuleLoader(node) &&
    !target
  )
    return "runtime module imports must use a static specifier";
  const kind =
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require"
      ? "require"
      : "import";
  return target ? violation(source, target, kind) : undefined;
}

async function files(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (["node_modules", "dist", "generated"].includes(entry.name)) continue;
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(name)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(name);
  }
  return result;
}

if (process.argv.includes("--self-test")) {
  const cases = [
    ["apps/community-web/src/App.tsx", "../../community-api/src/auth", true],
    ["apps/community-api/src/app.ts", "@workspace/ui", true],
    ["packages/ui/src/index.tsx", "../../../apps/community-api/src/auth", true],
    ["packages/core/src/index.ts", "mysql2/promise", true],
    ["packages/core-contracts/src/index.ts", "mysql2/promise", true],
    ["packages/core-contracts/src/index.ts", "express", true],
    ["packages/core-contracts/src/index.ts", "../../ui/src/index.tsx", true],
    ["packages/core-contracts/src/index.ts", "../../../.private/shuriva-cloud/src/main.js", true],
    ["apps/community-web/src/App.tsx", "../../../.private/shuriva-cloud/src/main.js", true],
    ["packages/core-contracts/src/index.ts", "zod", false],
    ["packages/core-contracts/src/index.ts", "./read-payload.js", false],
    ["packages/core-contracts/src/index.ts", "../../ui", true],
    ["packages/core-contracts/src/index.ts", "../../../.private", true],
    ["packages/core-contracts/src/index.ts", "../../x#y/../ui", true, "require"],
    ["packages/core-contracts/src/index.ts", "../../../x#y/../.private/entry.cjs", true, "require"],
    ["packages/core-contracts/src/index.ts", "../../x#y/../ui", false, "import"],
    ["apps/community-web/src/App.tsx", "@workspace/ui", false],
    ["apps/community-api/src/app.ts", "./auth.js", false],
    ["apps/community-web/src/App.tsx", "@workspace/ui/src/button", true],
    ["apps/community-api/src/semantic/store.ts", "../datasources/store.js", true],
    ["apps/community-api/src/semantic/store.ts", "../datasources/snapshot.js", true],
    ["apps/community-api/src/semantic/routes.ts", "../datasources/errors.js", true],
    ["apps/community-api/src/semantic/store.ts", "../datasources/public.js", false],
    ["apps/community-api/src/semantic/routes.ts", "../queries/service.js", true],
    ["apps/community-api/src/semantic/routes.ts", "../queries/public.js", false],
    ["apps/community-api/src/queries/service.ts", "../datasources/store.js", true],
    ["apps/community-api/src/queries/service.ts", "../datasources/public.js", false],
    ["apps/community-api/src/connectors/registry.ts", "../queries/read-task.js", true],
    ["apps/community-api/src/connectors/registry.ts", "../protocol/read-task.js", false],
    ["apps/community-api/src/mutations/ports.ts", "mysql2/promise", true],
    ["apps/community-api/src/mutations/outcome.ts", "mysql2/promise", true],
    ["apps/community-api/src/mutations/outcome.ts", "express", true],
    ["apps/community-api/src/mutations/store.ts", "mysql2/promise", false],
    ["apps/community-api/src/mcp/approval-handoff.ts", "./approval-handoff-core.js", false],
    ["apps/community-api/src/mcp/other.ts", "./approval-handoff-core.js", true],
    ["apps/community-api/src/mcp/other.ts", "./approval-handoff-core", true],
    ["apps/community-api/src/mcp/other.ts", "./approval-handoff-core.js?x=1", true],
    ["apps/community-api/src/mcp/other.ts", "./approval%2Dhandoff-core.js#x", true],
    ["apps/community-api/src/auth/other.ts", "../MCP/Approval-handoff-core.js?x=1", true],
    ["apps/community-api/src/app.ts", "/mcp/approval-handoff-core.js?x=1", true],
    [
      "apps/community-api/src/app.ts",
      `${pathToFileURL(path.join(root, "apps/community-api/src/mcp/approval-handoff-core.js")).href.replace(/^file:/, "FILE:")}?x=1`,
      true,
    ],
    ["apps/community-api/src/app.ts", "./mcp/approval-handoff-core.js", true],
    ["apps/community-api/src/history/store.ts", "../datasources/store.js", true],
    ["apps/community-api/src/history/store.ts", "../datasources/public.js", false],
    ["apps/community-api/src/mutations/store.ts", "../datasources/store.js", true],
    ["apps/community-api/src/mutations/store.ts", "../datasources/public.js", false],
  ];
  for (const [from, target, expected, kind] of cases)
    if (Boolean(violation(from, target, kind)) !== expected)
      throw new Error(`Boundary rule failed: ${from} -> ${target}`);
  for (const [snippet, expected] of [
    [
      "import(`./approval-handoff-core.js`)",
      "approval handoff clock injection is private to its platform wrapper",
    ],
    [
      "import(`./approval-handoff-core.js?x=1`, {})",
      "approval handoff clock injection is private to its platform wrapper",
    ],
    ["import(`./public.js`, {})", undefined],
    ["import(variable)", "runtime module imports must use a static specifier"],
  ]) {
    const sample = ts.createSourceFile("sample.ts", snippet, ts.ScriptTarget.Latest, true);
    const problems = [];
    function inspectSample(node) {
      const problem = moduleProblem("apps/community-api/src/mcp/other.ts", node);
      if (problem) problems.push(problem);
      ts.forEachChild(node, inspectSample);
    }
    inspectSample(sample);
    if (expected ? problems.length !== 1 || problems[0] !== expected : problems.length !== 0)
      throw new Error(
        "Boundary scanner must reject template-literal imports of the private clock seam",
      );
  }
  for (const [snippet, expected] of [
    ['require("../../x#y/../ui")', true],
    ['require("../../../x#y/../.private/entry.cjs")', true],
    ['import("../../x#y/../ui")', false],
    ['require("./literal#name.cjs")', false],
    ['require("./literal%23name.cjs")', false],
  ]) {
    const sample = ts.createSourceFile("sample.ts", snippet, ts.ScriptTarget.Latest, true);
    const problems = [];
    function inspectPath(node) {
      const problem = moduleProblem("packages/core-contracts/src/index.ts", node);
      if (problem) problems.push(problem);
      ts.forEachChild(node, inspectPath);
    }
    inspectPath(sample);
    if (problems.length > 0 !== expected)
      throw new Error(`Module path semantics failed: ${snippet}`);
  }
  console.log("Boundary rule self-test passed.");
} else {
  let errors = 0;
  for (const dir of scanRoots)
    for (const name of await files(dir)) {
      const source = ts.createSourceFile(
        name,
        await readFile(path.join(root, name), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function walk(node) {
        if (
          name.replaceAll("\\", "/").startsWith("apps/community-api/src/") &&
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "diagnostics" &&
          ["debug", "info", "warn", "error"].includes(node.expression.name.text)
        ) {
          const event = node.arguments[0];
          if (!event || !ts.isStringLiteral(event) || !diagnosticEvents.has(event.text)) {
            console.error(`${name}: diagnostics require a registered constant event code`);
            errors++;
          }
        }
        if (
          name.replaceAll("\\", "/").startsWith("apps/community-api/src/") &&
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "console" &&
          node.expression.name.text === "error"
        ) {
          console.error(`${name}: use structured diagnostics rather than raw console.error`);
          errors++;
        }
        const reason = moduleProblem(name, node);
        if (reason) {
          console.error(`${name}: ${reason}`);
          errors++;
        }
        ts.forEachChild(node, walk);
      }
      walk(source);
    }
  if (errors) process.exitCode = 1;
  else {
    const result = await promisify(execFile)("go", ["test", "./internal/architecture"], {
      cwd: path.join(root, "connector/go"),
      env: { ...process.env, GOARCH: "amd64" },
    });
    process.stdout.write(result.stdout);
    console.log("TypeScript and Go dependency boundaries passed.");
  }
}
