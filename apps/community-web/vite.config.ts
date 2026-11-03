import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const apiTarget = process.env.API_PROXY_TARGET || "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": apiTarget,
      "^/\\.well-known/oauth-authorization-server/api/auth(?:\\?.*)?$": apiTarget,
      "^/\\.well-known/openid-configuration/api/auth(?:\\?.*)?$": apiTarget,
    },
  },
});
