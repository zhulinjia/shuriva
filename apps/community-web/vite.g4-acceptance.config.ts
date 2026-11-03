import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

if (process.env.STAGE8_G4_ACCEPTANCE !== "1") throw Error("explicit G4 acceptance required");
// Separate loopback host prevents forwarding cookies from the user's product.
// Normal product entry/components and real authentication are used unchanged.
export default defineConfig({
  root: import.meta.dirname,
  envDir: false,
  cacheDir: resolve(import.meta.dirname, "../../.cache/g4-acceptance-vite"),
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.2",
    port: 5193,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:43129", changeOrigin: false },
      "^/\\.well-known/oauth-authorization-server/api/auth(?:\\?.*)?$": {
        target: "http://127.0.0.1:43129",
        changeOrigin: false,
      },
      "^/\\.well-known/openid-configuration/api/auth(?:\\?.*)?$": {
        target: "http://127.0.0.1:43129",
        changeOrigin: false,
      },
    },
  },
});
