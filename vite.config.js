import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";
import ElementPlus from "unplugin-element-plus/vite";
import path from "node:path";

const buildStamp = process.env.OZON_BUILD_STAMP || String(Date.now());

export default defineConfig({
  base: "/vue-apps/",
  plugins: [
    vue(),
    Components({
      resolvers: [ElementPlusResolver()]
    }),
    ElementPlus()
  ],
  publicDir: false,
  build: {
    outDir: path.resolve("public/vue-apps"),
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
          if (id.includes("element-plus")) return "vendor-element-plus";
          if (id.includes("@element-plus/icons-vue")) return "vendor-element-plus-icons";
          if (id.includes("vue-router")) return "vendor-vue-router";
          if (id.includes("pinia")) return "vendor-pinia";
          if (id.includes("/vue/")) return "vendor-vue";
          return "vendor";
        },
        entryFileNames: `assets/[name]-view-[hash]-${buildStamp}.js`,
        chunkFileNames: `assets/[name]-[hash]-${buildStamp}.js`,
        assetFileNames: `assets/[name]-[hash]-${buildStamp}[extname]`
      }
    }
  }
});
