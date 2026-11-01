import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A separate review artifact; the normal product build has no dependency on this entry.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: resolve(import.meta.dirname, "../../.cache/stage8-review"),
    emptyOutDir: false,
    rollupOptions: { input: resolve(import.meta.dirname, "stage8-review.html") },
  },
});
