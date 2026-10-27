import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("separate rule pages render read-only company access and platform manual classification", {
  skip: process.env.RUN_SETTINGS_RULE_BROWSER_TESTS !== "1"
}, async () => {
  const entry = `import {createApp,h} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';
    import Settings from '/frontend/admin/views/settings/SettingsView.vue';import Packaging from '/frontend/admin/views/tools/PackagingFeeRuleView.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';
    const params=new URLSearchParams(location.search);const app=createApp({setup(){const auth=useAuthStore();auth.user=params.get('role')==='platform'?{id:1,roles:['operations'],platform_role:'super_admin',tenant:{id:1,slug:'default',role:'owner'}}:{id:2,roles:[],tenant:{id:2,slug:'a',role:'owner'}};return()=>params.get('view')==='packaging'?h(Packaging):h(Settings,{section:params.get('view')||'logistics'});}});app.use(createPinia());app.use(ElementPlus);app.mount('#app');`;
  const server = await createServer({ configFile: false, root: process.cwd(), optimizeDeps: { include: ["vue", "pinia", "element-plus"] },
    server: { host: "127.0.0.1", port: 8788, strictPort: true, watch: { ignored: ["**/.verification/**", "**/public/**", "**/dist/**", "**/.deploy-artifacts/**"] } },
    plugins: [vue(), { name: "settings-rule-fixture", resolveId: id => id === "virtual:settings-rules" ? "\0settings-rules" : undefined,
      load: id => id === "\0settings-rules" ? entry : undefined,
      configureServer(server) { server.middlewares.use("/admin.html", async (_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await server.transformIndexHtml("/admin.html", '<html lang="zh-CN"><meta charset="utf-8"><body style="margin:24px;background:#f5f7fb"><div id="app"></div><script type="module" src="/@id/virtual:settings-rules"></script></body></html>')); }); }
    }] });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
    page.setDefaultTimeout(20000);
    const writes = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:8788") return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      let result;
      if (request.method() === "POST") {
        assert.equal(url.pathname, "/api/order-cancellation-rules/classifications");
        writes.push(request.postDataJSON()); result = { id: 9, historical_profit_changed: false };
      } else if (url.pathname === "/api/settings/packaging-fee-rule") result = { low_sale_threshold_cny: 50, low_fee_cny: 0.5, high_fee_cny: 1 };
      else if (url.pathname === "/api/logistics-rules") result = [{ id: 1, name: "OGL 快递", carrier: "OGL", mode: "per_gram", enabled: 1, effective_from: "2026-10-01 00:00:00", per_gram_cny: 0.03 }];
      else if (url.pathname === "/api/order-cancellation-rules") result = [];
      else if (url.pathname === "/api/order-cancellation-rules/unclassified") result = { pending: writes.length ? [] : [{ original: "Official unknown reason", reason_id: "9999", order_count: 2, last_seen_at: "2026-10-26 00:00:00" }], classified: [], types: [{ value: "wrong_item", label: "收到的商品不符" }] };
      else throw Error(`Unexpected fixture API: ${url.pathname}`);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
    });
    await page.goto("http://127.0.0.1:8788/admin.html?view=packaging&role=owner");
    await page.getByText("当前为只读，调整共用规则请联系平台管理员。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "保存规则" }).count(), 0);
    assert.equal(await page.getByRole("spinbutton").first().isDisabled(), true);
    await page.goto("http://127.0.0.1:8788/admin.html?view=logistics&role=owner");
    await page.getByText("OGL 快递", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "新增物流规则" }).count(), 0);
    await mkdir(".verification", { recursive: true });
    await page.screenshot({ path: ".verification/settings-logistics-owner.png", fullPage: true });
    await page.goto("http://127.0.0.1:8788/admin.html?view=cancel&role=platform");
    await page.getByRole("button", { name: "人工归类", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator(".el-select").click();
    await page.getByRole("option", { name: "收到的商品不符", exact: true }).click();
    await dialog.getByText("核对备注", { exact: true }).click();
    await page.screenshot({ path: ".verification/settings-cancellation-platform.png", fullPage: true });
    await dialog.getByRole("button", { name: "保存分类", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(writes, [{ original: "Official unknown reason", reason_code: "wrong_item", note: "" }]);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await server.close(); }
});
