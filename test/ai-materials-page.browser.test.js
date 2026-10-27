import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("AI material previews and scope reset work in light/dark while matrix generation no longer loads hidden assets", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1", timeout: 180000 }, async () => {
  const entry = `import{createApp,h}from'vue';import{RouterView,createRouter,createMemoryHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import Materials from'/frontend/admin/views/settings/MaterialCenterView.vue';import Matrix from'/frontend/admin/views/listing/ShopAssetVariantCenter.vue';import{auth}from'virtual:materials-auth';import{currentApiCacheScope}from'/frontend/admin/utils/api.js';import{applyAppearancePreferences}from'/frontend/admin/utils/theme-presets.js';
    localStorage.setItem('authToken','materials-fixture');localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));currentApiCacheScope();const router=createRouter({history:createMemoryHistory(),routes:[{path:'/ai-materials',name:'ai-materials',component:Materials},{path:'/asset-variant-center',name:'asset-variant-center',component:Matrix}]});await router.push('/ai-materials');await router.isReady();window.materialRouter=router;window.setMaterialUser=user=>{auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));currentApiCacheScope()};window.setMaterialTheme=mode=>applyAppearancePreferences({version:1,mode,palettes:{light:'teal',dark:'teal'}},document);window.setMaterialTheme('light');createApp({render:()=>h(RouterView)}).use(router).use(ElementPlus).mount('#app');`;
  const bundle = await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), { name: "materials-fixture", enforce: "pre",
    resolveId(source, importer) {
      if (source === "virtual:materials-entry") return "\0materials-entry";
      if (source === "virtual:materials-auth" || (importer?.replaceAll("\\", "/").includes("frontend/admin") && /stores\/auth(?:\.js)?$/.test(source))) return "\0materials-auth";
    },
    load(id) { if (id === "\0materials-entry") return entry; if (id === "\0materials-auth") return `import{reactive}from'vue';export const auth=reactive({user:window.initialUser});export const useAuthStore=()=>auth;`; }
  }], build: { write: false, cssCodeSplit: false, target: "esnext", rollupOptions: { input: "virtual:materials-entry", output: { entryFileNames: "entry.js" } } } });
  const assets = new Map(bundle.output.map(item => [item.fileName, item.type === "asset" ? item.source : item.code]));
  const css = [...assets.keys()].find(name => name.endsWith(".css"));
  const artifacts = path.resolve(".verification/ai-materials");
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const userA = { id: 21, name: "演示运营A", roles: ["operations"], tenant: { id: 2, slug: "a", role: "member", access_allowed: true } };
  const userB = { ...userA, id: 31, name: "演示运营B", tenant: { ...userA.tenant, id: 3, slug: "b" } };
  let user = userA, holdMaterial = false, releaseHeld = null, heldStarted;
  const heldRequest = new Promise(resolve => { heldStarted = resolve; });
  const calls = [], errors = [];
  const rows = () => [
    { id: 1, title: `${user.tenant.slug} AI图片`, asset_type: "image", url: "/uploads/material-demo.svg", source_type: "ai_generated", role: "main", status: "active", updated_at: "2026-10-26 01:00:00" },
    { id: 2, title: `${user.tenant.slug} AI视频`, asset_type: "video", url: "/uploads/material-demo.mp4", source_type: "ai_generated", role: "video", status: "active" },
    { id: 3, title: `${user.tenant.slug} AI文本`, asset_type: "text", content_text: `${user.tenant.slug}：这是一段可预览的 AI 文案。`, source_type: "ai_generated", role: "description", status: "ready" }
  ];
  try {
    const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(value => { window.initialUser = value; }, userA);
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, "http://localhost:8788");
      if (url.pathname.startsWith("/uploads/")) return route.fulfill({ contentType: url.pathname.endsWith(".mp4") ? "video/mp4" : "image/svg+xml", body: url.pathname.endsWith(".mp4") ? "" : '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#146e65"/><text x="42" y="220" fill="white" font-size="30">AI fixture</text></svg>' });
      if (url.pathname.startsWith("/api/")) {
        calls.push({ path: url.pathname, method: request.method(), query: url.search });
        if (url.pathname === "/api/material-assets") {
          assert.equal(url.searchParams.get("source_type"), "ai_generated");
          assert.equal(url.searchParams.get("recent_days"), "7");
          assert.equal(request.method(), "GET");
          const matching = rows().filter(row => (!url.searchParams.get("asset_type") || row.asset_type === url.searchParams.get("asset_type")) && (!url.searchParams.get("keyword") || row.title.includes(url.searchParams.get("keyword"))));
          const response = { rows: matching, total: matching.length, page: 1, pageSize: 20 };
          if (holdMaterial) { holdMaterial = false; await new Promise(resolve => { releaseHeld = async () => { try { await route.fulfill({ json: response }); } finally { resolve(); } }; heldStarted(); }); return; }
          return route.fulfill({ json: response });
        }
        if (url.pathname === "/api/listing/ai-variant-assets") { assert.equal(url.searchParams.get("recent_days"), "7"); return route.fulfill({ json: [] }); }
        if (url.pathname === "/api/asset-variant-engine/bootstrap") return route.fulfill({ json: { shops: [{ id: 11, name: "演示店铺", status: "active" }], tailCategories: [], tailTemplates: [] } });
        if (url.pathname === "/api/products/20") return route.fulfill({ json: { id: 20, name: "受保护来源商品", image_url: "/uploads/material-demo.svg", detail_image_urls: ["/uploads/detail-demo.svg"], sale_price_rmb: 50 } });
        if (url.pathname === "/api/asset-variant-engine/jobs") return route.fulfill({ json: [] });
        if (url.pathname === "/api/asset-variant-engine/generate") {
          assert.equal(request.method(), "POST");
          const body = request.postDataJSON();
          assert.match(body.material.mainImage, /material-demo\.svg/);
          assert.equal(body.material.detailImages.length, 1);
          return route.fulfill({ json: { batchId: "fixture-batch", variants: [{ id: 111, shopId: 11, shopName: "演示店铺", batchId: "fixture-batch", title: "已生成店铺版本", titleRu: "已生成店铺版本", titleZh: "受保护来源商品", productInfo: { dimensions: {} }, images: [{ type: "main", previewUrl: "/uploads/material-demo.svg", outputPath: "main.png" }, { type: "detail", previewUrl: "/uploads/detail-demo.svg", outputPath: "detail.png" }], videos: [{ url: "/uploads/material-demo.mp4", name: "fixture.mp4" }] }] } });
        }
        throw new Error(`Unexpected API ${request.method()} ${url.pathname}`);
      }
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      const body = assets.get(url.pathname.slice(1));
      assert.notEqual(body, undefined, url.pathname);
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body });
    });
    await page.goto("http://localhost:8788/admin.html");
    await page.getByRole("heading", { name: "AI素材", exact: true }).waitFor();
    await page.getByText("a AI图片", { exact: true }).waitFor();
    assert.equal(await page.getByText("店铺矩阵素材", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "wide asset table must scroll inside its panel");
    await page.locator(".el-table__row").filter({ hasText: "a AI图片" }).getByRole("button", { name: "预览", exact: true }).click();
    assert.equal(await page.getByRole("dialog").locator(".dialog-image").count(), 1);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByPlaceholder("搜索名称、批次、车型、类目、文件名").fill("AI文本");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.el-table__row').length === 1);
    assert.equal(await page.getByText("a AI图片", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "清空", exact: true }).click();
    await page.getByText("a AI图片", { exact: true }).waitFor();
    await page.locator(".el-table__row").filter({ hasText: "a AI文本" }).getByRole("button", { name: "预览", exact: true }).click();
    await page.getByRole("dialog").locator("pre").getByText("a：这是一段可预览的 AI 文案。", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.locator(".el-table__row").filter({ hasText: "a AI视频" }).getByRole("button", { name: "预览", exact: true }).click();
    assert.equal(await page.getByRole("dialog").locator("video").count(), 1);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    for (const mode of ["light", "dark"]) { await page.evaluate(mode => window.setMaterialTheme(mode), mode); await page.screenshot({ path: path.join(artifacts, `materials-${mode}.png`), fullPage: true }); }
    holdMaterial = true;
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await heldRequest;
    user = userB;
    await page.evaluate(value => window.setMaterialUser(value), userB);
    await page.getByText("b AI图片", { exact: true }).waitFor();
    await releaseHeld();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText("a AI图片", { exact: true }).count(), 0);
    assert.equal(calls.some(call => call.path === "/api/listing/media/assets" || call.path.includes("delete-media-group")), false);
    await page.evaluate(() => window.materialRouter.push({ path: "/asset-variant-center", query: { source: "selection", productId: "20" } }));
    await page.getByRole("heading", { name: "店铺矩阵裂变", exact: true }).waitFor();
    const generate = page.getByRole("button", { name: "一键生成当前版本", exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('一键生成当前版本') && !button.disabled));
    await generate.click();
    await page.getByRole("button", { name: "编辑上架", exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('编辑上架') && !button.disabled));
    assert.equal(await page.getByText("统一素材资产", { exact: true }).count(), 0);
    assert.equal(calls.some(call => call.path === "/api/listing/media/assets"), false, "generation never loads the removed hidden 500-row library");
    for (const mode of ["light", "dark"]) { await page.evaluate(mode => window.setMaterialTheme(mode), mode); await page.screenshot({ path: path.join(artifacts, `matrix-${mode}.png`), fullPage: true }); }
    assert.deepEqual(errors, []);
  } finally { if (releaseHeld) await releaseHeld().catch(() => {}); await browser.close(); }
});
