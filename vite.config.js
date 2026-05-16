import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

export default defineConfig({
  base: "/vue-apps/",
  plugins: [vue()],
  publicDir: false,
  build: {
    outDir: path.resolve("public/vue-apps"),
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      input: {
        admin: path.resolve("frontend/admin/main.js"),
        config: path.resolve("frontend/config/main.js")
      },
      output: {
        entryFileNames: "assets/[name]-view.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
