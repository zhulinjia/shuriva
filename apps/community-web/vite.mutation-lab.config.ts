import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// This review configuration must never inherit the product API proxy or .env files.
const rawTarget = process.env.G3_REVIEW_API_TARGET;
if (!rawTarget)
  throw Error("G3_REVIEW_API_TARGET must explicitly point to the isolated review API");
const target = new URL(rawTarget);
if (
  target.protocol !== "http:" ||
  target.hostname !== "127.0.0.1" ||
  !target.port ||
  target.username ||
  target.password ||
  target.pathname !== "/" ||
  target.search ||
  target.hash
)
  throw Error("Review API must be an explicit HTTP loopback origin");
const port = Number(process.env.G3_REVIEW_WEB_PORT ?? "5189");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid review web port");

export default defineConfig({
  root: import.meta.dirname,
  envDir: false,
  cacheDir: resolve(import.meta.dirname, "../../.cache/g3-mutation-lab-vite"),
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "mutation-lab-entry",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/") {
            res.writeHead(302, { Location: "/mutation-lab.html" });
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {
      "/api": {
        target: target.origin,
        changeOrigin: false,
        configure(proxy) {
          // Never forward cookies belonging to a separate localhost product app.
          proxy.on("proxyReq", (request, incoming) => {
            const cookie = incoming.headers.cookie
              ?.split(";")
              .map((value) => value.trim())
              .filter((value) => value.startsWith("g3-review="))
              .join("; ");
            if (cookie) request.setHeader("Cookie", cookie);
            else request.removeHeader("Cookie");
          });
        },
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "../../.cache/g3-mutation-lab"),
    emptyOutDir: false,
    rollupOptions: { input: resolve(import.meta.dirname, "mutation-lab.html") },
  },
});
