import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Express } from "express";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { OperationalError } from "./operational-error.js";

type Asset = { content: Buffer; type: string };
const types: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const expected = await lstat(path, { bigint: true });
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.size > BigInt(limit) ||
    !samePath(await realpath(path), path)
  )
    throw Error("file");
  // Windows has no Node O_NOFOLLOW. Verify the opened identity before reading,
  // and the canonical location on both sides of the bounded handle read.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size !== expected.size ||
      before.mtimeNs !== expected.mtimeNs ||
      before.ctimeNs !== expected.ctimeNs ||
      !samePath(await realpath(path), path)
    )
      throw Error("changed file");
    const content = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== Number(before.size) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      !samePath(await realpath(path), path)
    )
      throw Error("changed file");
    return content.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function verifyEntryResources(index: Buffer, files: ReadonlyMap<string, Asset>, origin: string) {
  const document = parse(index.toString("utf8"));
  let scripts = 0;
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ("tagName" in node) {
      if (node.tagName === "base") throw Error("base URI unsupported");
      const attributes = new Map(node.attrs.map(({ name, value }) => [name, value]));
      const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
      const kind =
        node.tagName === "script"
          ? "js"
          : node.tagName === "link" && rel.includes("stylesheet")
            ? "css"
            : node.tagName === "link" && rel.includes("modulepreload")
              ? "js"
              : undefined;
      if (kind) {
        const raw = attributes.get(node.tagName === "script" ? "src" : "href");
        if (!raw) throw Error("entry resource missing");
        const resource = new URL(raw, origin);
        if (
          resource.origin !== new URL(origin).origin ||
          !resource.pathname.endsWith(`.${kind}`) ||
          !files.has(resource.pathname)
        )
          throw Error("entry resource unavailable");
        if (node.tagName === "script") scripts++;
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(document);
  if (!scripts) throw Error("entry script missing");
}

/** Only the explicit build directory is read. Its bounded allowlist is immutable until restart. */
export async function mountWebAssets(
  server: Express,
  directory: string,
  origin: string,
): Promise<void> {
  if (!isAbsolute(directory)) throw new OperationalError("WEB_ASSETS_INVALID");
  const root = resolve(directory),
    assets = join(root, "assets");
  const expectedHost = new URL(origin).host;
  let index: Buffer;
  const files = new Map<string, Asset>();
  try {
    for (const folder of [root, assets]) {
      if (
        !(await lstat(folder)).isDirectory() ||
        (await lstat(folder)).isSymbolicLink() ||
        (await realpath(folder)).toLowerCase() !== folder.toLowerCase()
      )
        throw Error("link");
    }
    const indexPath = join(root, "index.html");
    index = await boundedFile(indexPath, 1048576);
    let total = index.length;
    const names = await readdir(assets);
    if (names.length < 1 || names.length > 256) throw Error("assets");
    for (const name of names) {
      const extension = /^[A-Za-z0-9_.-]+\.([a-z0-9]+)$/.exec(name)?.[1];
      if (!extension || !Object.hasOwn(types, extension)) throw Error("asset type");
      const type = types[extension];
      if (!type) throw Error("asset type");
      const remaining = 64 * 1048576 - total;
      if (remaining <= 0) throw Error("budget");
      const content = await boundedFile(join(assets, name), Math.min(20 * 1048576, remaining));
      total += content.length;
      if (total > 64 * 1048576) throw Error("budget");
      files.set(`/assets/${name}`, { content, type });
    }
    verifyEntryResources(index, files, origin);
  } catch {
    throw new OperationalError("WEB_ASSETS_INVALID");
  }
  server.use((req, res, next) => {
    const isIndex = req.path === "/" || req.path === "/index.html";
    if (!isIndex && !req.path.startsWith("/assets/")) return next();
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.host !== expectedHost) return void res.status(403).end();
    if (req.method !== "GET" && req.method !== "HEAD") return void res.status(405).end();
    const asset = isIndex
      ? { content: index, type: "text/html; charset=utf-8" }
      : files.get(req.path);
    if (!asset) return void res.status(404).end();
    res.setHeader("Content-Type", asset.type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.end(req.method === "HEAD" ? undefined : asset.content);
  });
}
