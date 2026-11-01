import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../.cache/stage8-review/", import.meta.url)));
const port = Number(process.argv[2] ?? 8768);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid review port");
const policy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", policy);
  res.setHeader("X-Content-Type-Options", "nosniff");
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  const filename =
    pathname === "/" || pathname === "/stage8-review.html"
      ? "stage8-review.html"
      : /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(pathname)
        ? pathname.slice(1)
        : null;
  if (!filename) {
    res.writeHead(404);
    res.end("Review static content only");
    return;
  }
  const target = resolve(root, filename),
    inside = relative(root, target);
  if (inside.startsWith("..") || inside.includes(":")) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const data = await readFile(target);
    res.setHeader(
      "Content-Type",
      filename.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : filename.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/html; charset=utf-8",
    );
    res.writeHead(200);
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404);
    res.end("Build the review artifact first");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Stage 8 design review: http://127.0.0.1:${port}/ (static, network connections denied)`,
  ),
);
