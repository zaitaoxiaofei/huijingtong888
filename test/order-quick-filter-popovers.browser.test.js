import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("order quick-filter popovers apply only confirmed drafts and remain composable", {
  skip: process.env.RUN_ORDER_QUICK_FILTER_BROWSER_TESTS !== "1", timeout: 120000
}, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "order-quick-filter-popovers-"));
  let browser;
  const errors = [];
  try {
    await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
      name: "order-quick-filter-fixture",
      resolveId(id) { if (id === "virtual:order-quick-filter") return "\0order-quick-filter"; },
      load(id) { if (id === "\0order-quick-filter") return `
        import {createApp,h} from 'vue'; import {createPinia} from 'pinia';
        import {createRouter,createWebHashHistory,RouterView} from 'vue-router';
        import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
        import OrdersPage from '/frontend/orders/OrdersPage.vue';
        const router=createRouter({history:createWebHashHistory(),routes:[{path:'/orders',component:OrdersPage}]});
        createApp({render:()=>h(RouterView)}).use(createPinia()).use(router).use(ElementPlus).mount('#app');
      `; }
    }], build: { outDir: output, minify: false, cssCodeSplit: false,
      rollupOptions: { input: "virtual:order-quick-filter", output: { entryFileNames: "entry.js" } } } });
    browser = await chromium.launch({
      executablePath: process.env.CHROME_EXECUTABLE || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined), headless: true
    });
    for (const width of [1920, 1366]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      const requests = [], rowRequests = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== "http://localhost:8788") return route.abort();
        if (url.pathname.startsWith("/api/")) {
          requests.push({ method: route.request().method(), url: url.pathname + url.search });
          if (route.request().method() !== "GET") return route.abort("blockedbyclient");
          if (url.pathname === "/api/orders") {
            if (url.searchParams.get("includeRows") !== "0") rowRequests.push(url.searchParams);
            return route.fulfill({ json: { rows: [], total: 0, page: 1, pageSize: 20,
              counts: { all: 0, awaiting_packaging: 0, dispute: 8, purchase_records_missing: 9 } } });
          }
          if (url.pathname === "/api/shops") return route.fulfill({ json: [{ id: 1, name: "筛选验证店铺" }] });
          if (url.pathname === "/api/orders/inventory-availability") return route.fulfill({ json: { rows: [] } });
          if (url.pathname === "/api/user-preferences") return route.fulfill({ json: {
            value: { order: ["dispute", "purchase_records_missing", "unbound", "pending_purchase", "purchase_in_transit", "all"] }
          } });
          return route.fulfill({ json: {} });
        }
        if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>' });
        const asset = url.pathname === "/style.css" ? path.join("assets", (await fs.readdir(path.join(output, "assets"))).find((name) => name.endsWith(".css"))) : url.pathname.slice(1);
        return route.fulfill({ contentType: asset.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(path.join(output, asset)) });
      });
      await page.goto("http://localhost:8788/admin.html#/orders");
      await page.addStyleTag({ content: "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }" });
      const near = page.locator(".orders-quick-filter-tag").filter({ hasText: "即将超时" });
      const transit = page.locator(".orders-quick-filter-tag").filter({ hasText: "采购在途超时" });
      const popup = page.locator(".orders-quick-filter-popover:visible");
      const tabs = page.locator(".orders-status-grid");
      await near.waitFor();
      assert.equal(await tabs.getByText("有争议", { exact: true }).count(), 0);
      assert.equal(await tabs.getByText("待补采购记录", { exact: true }).count(), 0);
      for (const label of ["待绑定库存", "待采购", "采购在途"]) await tabs.getByText(label, { exact: true }).waitFor();
      assert.equal(await page.locator(".orders-status-card .orders-quick-filter-tags").count(), 1);
      assert.equal(await page.locator(".vue-orders-shell > .orders-quick-filter-tags").count(), 0);
      const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const chooseDays = async (label) => {
        await popup.locator(".orders-quick-filter-days .el-select__wrapper").click();
        await popup.getByRole("option", { name: label, exact: true }).click();
      };
      const waitQuery = (expected) => page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/orders" && url.searchParams.get("includeRows") !== "0"
          && Object.entries(expected).every(([key, value]) => url.searchParams.get(key) === String(value));
      });
      const baseline = rowRequests.length;
      await near.click();
      await popup.locator(".el-select__selected-item").filter({ hasText: /^3 天$/ }).waitFor();
      await chooseDays("5 天");
      await settle();
      assert.equal(rowRequests.length, baseline, "changing the draft does not request filtered rows");
      await popup.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await popup.count(), 0);
      assert.equal(rowRequests.length, baseline, "cancel does not apply the draft");
      await near.click();
      await popup.locator(".el-select__selected-item").filter({ hasText: /^3 天$/ }).waitFor();
      await chooseDays("0 天");
      await page.locator(".vue-orders-shell").click({ position: { x: 5, y: 5 } });
      await popup.waitFor({ state: "hidden" });
      await settle();
      assert.equal(await popup.count(), 0);
      assert.equal(rowRequests.length, baseline, "outside clicks discard the draft");
      await near.click();
      await chooseDays("0 天");
      const nearApplied = waitQuery({ nearShipmentDeadline: 1, nearShipmentDeadlineDays: 0, procurementTransitOverdue: 0, page: 1 });
      await popup.getByRole("button", { name: "确认筛选", exact: true }).click();
      await nearApplied;
      assert.match(await near.getAttribute("class"), /is-active/);
      await transit.click();
      await popup.locator(".el-select__selected-item").filter({ hasText: /^3 天$/ }).waitFor();
      await chooseDays("10 天及以上");
      const bothApplied = waitQuery({ nearShipmentDeadline: 1, nearShipmentDeadlineDays: 0, procurementTransitOverdue: 1, procurementTransitOverdueDays: 10 });
      await popup.getByRole("button", { name: "确认筛选", exact: true }).click();
      await bothApplied;
      assert.match(await transit.getAttribute("class"), /is-active/);
      await transit.click();
      await popup.locator(".el-select__selected-item").filter({ hasText: /^10 天及以上$/ }).waitFor();
      if (process.env.ORDER_QUICK_FILTER_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.ORDER_QUICK_FILTER_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ORDER_QUICK_FILTER_SCREENSHOT_DIR, `order-quick-filters-${width}.png`), animations: "disabled" });
      }
      await popup.getByRole("button", { name: "取消", exact: true }).click();
      await near.click();
      const nearCleared = waitQuery({ nearShipmentDeadline: 0, procurementTransitOverdue: 1, procurementTransitOverdueDays: 10 });
      await popup.getByRole("button", { name: "取消筛选", exact: true }).click();
      await nearCleared;
      assert.doesNotMatch(await near.getAttribute("class"), /is-active/);
      assert.match(await transit.getAttribute("class"), /is-active/);
      await transit.click();
      const allCleared = waitQuery({ nearShipmentDeadline: 0, procurementTransitOverdue: 0 });
      await popup.getByRole("button", { name: "取消筛选", exact: true }).click();
      await allCleared;
      await transit.click();
      await popup.locator(".el-select__selected-item").filter({ hasText: /^3 天$/ }).waitFor();
      await popup.getByRole("button", { name: "取消", exact: true }).click();
      const ordinaryStatus = waitQuery({ status: "purchase_in_transit", nearShipmentDeadline: 0, procurementTransitOverdue: 0 });
      await tabs.getByText("采购在途", { exact: true }).click();
      await ordinaryStatus;
      assert.ok(requests.every((request) => request.method === "GET"));
      await page.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(output, { recursive: true, force: true });
  }
});
