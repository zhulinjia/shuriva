import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["apps/community-api", "apps/community-web", "packages"];
const blockedCore = ["@nestjs/", "@prisma/", "prisma", "mysql2", "better-auth", "react", "express"];
const features = new Set([
  "ai",
  "connectors",
  "datasources",
  "history",
  "mutations",
  "queries",
  "semantic",
  "logging",
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

function violation(source, specifier) {
  const from = source.replaceAll("\\", "/");
  const resolved = specifier.startsWith(".")
    ? path.resolve(root, path.dirname(from), specifier).replaceAll("\\", "/")
    : "";
  const relative = resolved ? path.relative(root, resolved).replaceAll("\\", "/") : "";
  const toApi =
    relative.startsWith("apps/community-api/") || specifier.startsWith("@workspace/community-api");
  const toWeb =
    relative.startsWith("apps/community-web/") || specifier.startsWith("@workspace/community-web");
  const toUI =
    relative.startsWith("packages/ui/") ||
    specifier === "@workspace/ui" ||
    specifier.startsWith("@workspace/ui/");
  if (from.startsWith("apps/community-web/") && toApi)
    return "web must not depend on API internals";
  if (from.startsWith("apps/community-api/") && (toWeb || toUI))
    return "API must not depend on the web or UI";
  if (from.startsWith("packages/") && (toApi || toWeb))
    return "shared packages must not depend on applications";
  if (
    from.startsWith("packages/core/") &&
    blockedCore.some((name) => specifier === name || specifier.startsWith(name))
  )
    return "core must not depend on infrastructure or UI";
  if (/^@workspace\/[^/]+\/(?:src|dist)(?:\/|$)/.test(specifier))
    return "use a package public entry point, not src or dist";
  const originFeature = /^apps\/community-api\/src\/([^/]+)\//.exec(from)?.[1];
  const destinationFeature = /^apps\/community-api\/src\/([^/]+)\//.exec(relative)?.[1];
  if (
    features.has(originFeature) &&
    features.has(destinationFeature) &&
    originFeature !== destinationFeature &&
    !/\/public\.[cm]?[jt]s$/.test(relative)
  )
    return "feature modules must use a peer's explicit public boundary";
  if (
    /^apps\/community-api\/src\/mutations\/(?:service|ports|outcome)\.ts$/.test(from) &&
    /^(?:mysql2|@nestjs|express)(?:\/|$)/.test(specifier)
  )
    return "application/domain rules must not import the database or HTTP driver";
  return undefined;
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
    ["apps/community-api/src/history/store.ts", "../datasources/store.js", true],
    ["apps/community-api/src/history/store.ts", "../datasources/public.js", false],
    ["apps/community-api/src/mutations/store.ts", "../datasources/store.js", true],
    ["apps/community-api/src/mutations/store.ts", "../datasources/public.js", false],
  ];
  for (const [from, target, expected] of cases)
    if (Boolean(violation(from, target)) !== expected)
      throw new Error(`Boundary rule failed: ${from} -> ${target}`);
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
        let target;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          target = node.moduleSpecifier.text;
        else if (
          ts.isCallExpression(node) &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        )
          target = node.arguments[0].text;
        if (target) {
          const reason = violation(name, target);
          if (reason) {
            console.error(`${name}: ${target}: ${reason}`);
            errors++;
          }
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
