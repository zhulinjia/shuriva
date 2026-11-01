import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Test-only entry: loopback mock has no database or model access and is explicit.
if (process.env.ARCHITECTURE_LAB !== "1") throw Error("isolated review flag required");
export default defineConfig({
  root: import.meta.dirname,
  envDir: false,
  cacheDir: "../../.cache/architecture-lab-vite",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5188,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:43211",
        configure(proxy) {
          proxy.on("proxyReq", (request) => request.removeHeader("cookie"));
        },
      },
    },
  },
});
