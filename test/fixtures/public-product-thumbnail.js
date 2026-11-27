import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createPublicImageThumbnailService } from "../../src/services/public-image-thumbnail.js";

export async function startPublicProductThumbnailPreview() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "public-thumbnail-browser-"));
  const pixels = Buffer.alloc(900 * 1200 * 3);
  for (let y = 0; y < 1200; y++) for (let x = 0; x < 900; x++) {
    const offset = (y * 900 + x) * 3;
    pixels[offset] = Math.round(x * 255 / 899); pixels[offset + 1] = Math.round(y * 255 / 1199); pixels[offset + 2] = 170;
  }
  const original = await sharp(pixels, { raw: { width: 900, height: 1200, channels: 3 } }).png().toBuffer();
  const sourceUrl = `https://fixture-images.oss-cn-heyuan.aliyuncs.com/listing-media/aa/${createHash("sha256").update(original).digest("hex")}.png`;
  const source = { buffer: original, contentType: "image/png" };
  const env = { OSS_ENABLED: "true", OSS_INTERNAL_READ: "true", OSS_BUCKET: "fixture-images", OSS_REGION: "oss-cn-heyuan", OSS_ACCESS_KEY_ID: "fixture", OSS_ACCESS_KEY_SECRET: "fixture" };
  const calls = { derivative: 0, originReads: 0, publicPreviews: 0, productThumbnails: 0, productOriginals: 0, failures: 0 };
  const service = createPublicImageThumbnailService({ env, cacheDirectory: path.join(temporary, "image-cache"), readSource: async () => { calls.originReads++; return source; } });
  const entry = `import {createApp,ref,nextTick} from 'vue';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import ProductImagePreview from '/frontend/admin/components/ProductImagePreview.vue';import {publicImageThumbnailUrl} from '/frontend/admin/utils/image-thumbnail-url.js';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';
localStorage.setItem('baodanAuthUser',JSON.stringify({id:1,tenant:{id:2,slug:'thumbnail-fixture'}}));setAuthToken('thumbnail-fixture');currentApiCacheScope();window.imageErrors=[];
const source=${JSON.stringify(sourceUrl)};
const app=createApp({components:{ProductImagePreview},setup(){const rows=ref([{id:1,title:'公共 OSS 商品原图',src:source},{id:2,title:'库存商品原图预览',src:'/api/products/123/image?thumb=1&w=180'},{id:3,title:'不支持派生时回到原图',src:source.replace('fixture-images.','another-bucket.')}]),report=ref('等待检查');let nodes=[];
return{rows,source,report,publicImageThumbnailUrl,original:'/api/image-proxy?url='+encodeURIComponent(source),async refresh(){nodes=[...document.querySelectorAll('tbody .erp-image-preview__image img')];rows.value=rows.value.map(row=>({...row}));await nextTick();report.value='已刷新，图片节点保持：'+nodes.every((node,i)=>node===document.querySelectorAll('tbody .erp-image-preview__image img')[i]);},async verify(){const stats=await(await fetch('/__thumbnail-stats')).json();report.value=JSON.stringify({calls:stats,images:[...document.querySelectorAll('tbody .erp-image-preview')].map(node=>({box:[node.getBoundingClientRect().width,node.getBoundingClientRect().height],natural:[node.querySelector('img')?.naturalWidth,node.querySelector('img')?.naturalHeight]})),viewer:document.querySelector('.el-image-viewer__img')?.naturalWidth||0,errors:window.imageErrors},null,2);}}},template:'<section style="padding:24px"><h2>列表缩略图本地验收</h2><p>公共 OSS 列表、原图预览、失败回退；布局保持 64 × 84。</p><el-button @click="refresh">刷新列表</el-button><el-button @click="verify">检查显示和请求</el-button><el-table :data="rows" row-key="id" style="max-width:900px;margin-top:16px"><el-table-column prop="title" label="场景" width="340"/><el-table-column label="图片" width="130"><template #default="{row}"><ProductImagePreview :src="row.src" :proxy-remote="true" size="portrait"/></template></el-table-column></el-table><h3>WB 列表 helper 接线示例</h3><el-image :src="publicImageThumbnailUrl(source)" :preview-src-list="[original]" preview-teleported fit="cover" style="width:64px;height:84px"/><pre style="font-size:12px">{{report}}</pre></section>'});app.use(ElementPlus);app.config.errorHandler=error=>window.imageErrors.push(error.message);app.mount('#app');`;
  const server = await createServer({ configFile: false, root: process.cwd(), publicDir: false, cacheDir: path.join(temporary, "vite"),
    resolve: { alias: [{ find: /^vue$/, replacement: "vue/dist/vue.esm-bundler.js" }] }, optimizeDeps: { noDiscovery: true, include: ["vue", "element-plus"] }, logLevel: "error",
    server: { host: "127.0.0.1", port: 8788, strictPort: true }, plugins: [vue(), { name: "public-thumbnail-fixture", resolveId(id) { if (id === "/__public-thumbnail.js") return id; }, load(id) { if (id === "/__public-thumbnail.js") return entry; }, configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/") { res.setHeader("Content-Type", "text/html"); return res.end('<html><body><div id="app"></div><script type="module" src="/__public-thumbnail.js"></script></body></html>'); }
        if (url.pathname === "/__thumbnail-stats") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(calls)); }
        if (url.pathname === "/api/image-proxy") { calls.publicPreviews++; res.setHeader("Content-Type", "image/png"); return res.end(original); }
        if (url.pathname === "/api/products/123/image") {
          res.setHeader("Content-Type", url.searchParams.get("thumb") === "1" ? "image/webp" : "image/png");
          if (url.searchParams.get("thumb") === "1") { calls.productThumbnails++; return res.end(await sharp(original).resize({ width: 180, height: 238, fit: "cover" }).webp().toBuffer()); }
          calls.productOriginals++; return res.end(original);
        }
        if (url.pathname !== "/api/image-thumbnail") return next();
        calls.derivative++;
        try {
          const payload = await service.get(url.searchParams.get("url"), { width: Number(url.searchParams.get("w") || 180) });
          res.setHeader("Content-Type", payload.contentType); res.setHeader("Cache-Control", payload.cacheControl); return res.end(payload.buffer);
        } catch (failure) { calls.failures++; res.statusCode = failure.status || 500; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: failure.message })); }
      });
    } }] });
  try { await server.listen(); }
  catch (failure) { await fs.rm(temporary, { recursive: true, force: true }); throw failure; }
  return { server, calls, async close() { await server.close(); await fs.rm(temporary, { recursive: true, force: true }); } };
}
