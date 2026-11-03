import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

// Restricted test relay: the selected upstream service receives discovery and
// the explicitly approved synthetic echo only. No request body is retained.
const modulePath = process.argv[2];
if (!modulePath || !isAbsolute(modulePath)) throw Error("absolute server module required");
const { createApp } = await import(pathToFileURL(modulePath).href);
const { app } = createApp();
const allowed = new Set(["server/discover", "tools/list", "subscriptions/listen"]);
const server = createServer((request, response) => {
  const method = request.headers["mcp-method"];
  const name = request.headers["mcp-name"];
  const protocol =
    request.headers["mcp-protocol-version"] === "2026-07-28" ? "2026-07-28" : "other";
  const customHeader = Object.keys(request.headers).some(
    (key) =>
      key.startsWith("mcp-param-") ||
      ["authorization", "proxy-authorization", "cookie", "x-api-key"].includes(key),
  );
  const isEcho = method === "tools/call" && name === "echo";
  process.stdout.write(
    `${JSON.stringify({ event: "request", method, echo: isEcho, customHeader, protocol })}\n`,
  );
  if (customHeader || typeof method !== "string" || (!allowed.has(method) && !isEcho)) {
    response.writeHead(403).end();
    return;
  }
  app(request, response);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no loopback listener");
  process.stdout.write(`${JSON.stringify({ event: "ready", port: address.port })}\n`);
});
