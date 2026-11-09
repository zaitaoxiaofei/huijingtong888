import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";
import ElementPlus from "unplugin-element-plus/vite";
import path from "node:path";

// Release provenance belongs in release.json. Unchanged assets must retain
// their content-addressed URLs across builds and releases.
const frontendOutDir = path.resolve(process.env.OZON_VITE_OUT_DIR || "public/vue-apps");

export default defineConfig({
  base: "/vue-apps/",
  define: {
    __APP_RELEASE_VERSION__: "globalThis.__ERP_RELEASE_METADATA__?.version",
    __APP_RELEASE_CHANNEL__: "globalThis.__ERP_RELEASE_METADATA__?.channel"
  },
  plugins: [
    vue(),
    Components({
      resolvers: [ElementPlusResolver()]
    }),
    ElementPlus()
  ],
  publicDir: false,
  build: {
    outDir: frontendOutDir,
    emptyOutDir: false,
    assetsDir: "assets",
    cssCodeSplit: true,
    manifest: true,
    rollupOptions: {
      input: {
        admin: path.resolve("frontend/admin/main.js"),
        config: path.resolve("frontend/config/main.js")
      },
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // Spreadsheet exports must not join Vue's shared first-paint vendor.
          if (id.includes("/exceljs/")) return "vendor-exceljs";
          if (id.includes("element-plus")) return "vendor-element-plus";
          if (id.includes("@element-plus/icons-vue")) return "vendor-element-plus-icons";
          if (id.includes("vue-router")) return "vendor-vue-router";
          if (id.includes("pinia")) return "vendor-pinia";
          if (id.includes("/vue/")) return "vendor-vue";
          return "vendor";
        },
        entryFileNames: "assets/[name]-view-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
