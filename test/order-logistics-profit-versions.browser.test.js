import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("orders retain the profit detail and lazily reveal version evidence without recalculation", {
  skip: process.env.RUN_ORDER_LOGISTICS_VERSION_BROWSER_TESTS !== "1", timeout: 120000
}, async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "orders-logistics-version-ui-"));
  let browser;
  const requests = [], errors = [];
  const row = {
    id: 1, posting_number: "UI-100-1", shop_id: 1, shop_name: "验证店铺", status: "awaiting_packaging",
    ordered_at: "2026-10-21T08:00:00Z", updated_at: "2026-10-21T09:00:00Z", revenue: 50,
    estimated_profit: 0, actual_profit: 0, settlement_states: "pending", profit_statuses: "estimated",
    actual_profit_ready: 0, profit_formula_versions: "V1", profit_calculation_legacy: 1,
    fulfillment_type_label: "FBS", logistics_carrier_label: "OGL", logistics_service_class: "Extra Small",
    logistics_service_class_source: "billing_rule", logistics_transport_mode_label: "陆运", logistics_transport_mode_source: "ozon_raw",
    delivery_method_name: "OGL Extra Small", skus: "SKU-1", product_names: "汽车保护套", item_count: 1
  };
  const unrecordedRow = { ...row, id: 2, posting_number: "UI-200-1", profit_formula_versions: undefined, profit_calculation_legacy: undefined };
  const serviceClasses = ["Extra Small", "Small", "Budget", "Big", "Premium Small", "Premium Big"];
  const logisticsServiceClassOptions = [{ value: "all", label: "全部物流渠道" }, ...serviceClasses.map((label) => ({ value: label.toLowerCase().replaceAll(" ", "_"), label }))];
  const detail = {
    order: row,
    items: [{ id: 11, ozon_sku: "SKU-1", product_name: "汽车保护套", quantity: 1, sale_price: 50, estimated_profit: 0, actual_profit: 0, settlement_state: "pending", profit_status: "estimated" }],
    finance: [],
    profit_detail_snapshot: {
      summary: { saleAmount: 50, estimatedProfit: 0, actualProfit: null, estimatedCostTotal: 50, actualCostTotal: null, actualProfitReady: false },
      detailRows: ["订单金额", "采购成本", "国内运费", "国际运费", "包装处理费", "Ozon佣金", "收单费", "Ozon服务费", "售后损失", "其他费用", "成本合计", "利润"].map((label, index) => ({
        key: index === 11 ? "profit" : `cost-${index}`, label, estimated: index === 0 || index === 10 ? 50 : 0, actual: null, diff: null
      }))
    },
    profit_calculation_versions: { available: true, items: [{ order_item_id: 11, formula_version: "V1", legacy_baseline: true, revisions: [{
      id: 21, revision_no: 1, layer: "estimate", formula_version: "V1", source: "legacy_baseline", reason: "登记历史已有金额",
      legacy_baseline: true, input_completeness: "legacy_unknown", created_at: "2026-10-21T10:00:00Z",
      inputs: { input_completeness: "legacy_unknown" }, outputs: { item: { estimated_profit: 0, actual_profit: 0 } }
    }] }] }
  };
  try {
    await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
      name: "order-version-fixture", resolveId(id) { if (id === "virtual:order-version") return "\0order-version"; },
      load(id) { if (id === "\0order-version") return `
        import {createApp,h} from 'vue'; import {createPinia} from 'pinia';
        import {createRouter,createWebHashHistory,RouterView} from 'vue-router';
        import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
        import OrdersPage from '/frontend/orders/OrdersPage.vue';
        const router=createRouter({history:createWebHashHistory(),routes:[{path:'/orders',component:OrdersPage}]});
        createApp({render:()=>h(RouterView)}).use(createPinia()).use(router).use(ElementPlus).mount('#app');
      `; }
    }], build: { outDir: outputDir, minify: false, cssCodeSplit: false, rollupOptions: { input: "virtual:order-version", output: { entryFileNames: "entry.js" } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined), headless: true });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://localhost:8788") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        requests.push({ method: route.request().method(), url: url.pathname + url.search });
        if (url.pathname === "/api/orders/1") return route.fulfill({ json: detail });
        if (url.pathname === "/api/orders") return route.fulfill({ json: { rows: [row, unrecordedRow], total: 2, page: 1, pageSize: 20, counts: { all: 2, awaiting_packaging: 2 }, logisticsServiceClassOptions } });
        if (url.pathname === "/api/shops") return route.fulfill({ json: [{ id: 1, name: "验证店铺" }] });
        return route.fulfill({ json: {} });
      }
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>' });
      const asset = url.pathname === "/style.css" ? path.join("assets", (await fs.readdir(path.join(outputDir, "assets"))).find((name) => name.endsWith(".css"))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(path.join(outputDir, asset)) });
    });
    await page.goto("http://localhost:8788/admin.html#/orders");
    await page.addStyleTag({ content: "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }" });
    await page.getByText("FBS · OGL", { exact: true }).first().waitFor();
    await page.getByText("渠道: Extra Small", { exact: false }).first().waitFor();
    await page.getByText("运输: 陆运", { exact: true }).first().waitFor();
    await page.getByText("待结算", { exact: true }).first().waitFor();
    await page.locator("#app").getByText("全部物流商", { exact: true }).waitFor();
    await page.locator("#app").getByText("全部物流渠道", { exact: true }).click();
    for (const label of serviceClasses) await page.getByRole("option", { name: label, exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("未记录", { exact: true }).first().hover();
    await page.getByText("尚无版本记录，未登记公式版本或历史基线。", { exact: true }).waitFor();
    assert.match(await page.locator(".orders-money-cell").first().innerText(), /预计: CNY 0\.00/);
    await page.getByRole("button", { name: "查看利润详情", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "订单利润详情", exact: true });
    await dialog.getByText("国际运费", { exact: true }).waitFor();
    for (const label of ["预估金额", "真实金额", "差异", "说明"]) assert.ok(await dialog.getByText(label, { exact: true }).count());
    await dialog.getByRole("button", { name: "重算利润", exact: true }).waitFor();
    assert.equal(await dialog.locator(".profit-calculation-versions").count(), 0, "version appendix is not mounted initially");
    if (process.env.ORDER_LOGISTICS_PROFIT_SCREENSHOT) await page.screenshot({ path: process.env.ORDER_LOGISTICS_PROFIT_SCREENSHOT, animations: "disabled" });
    await dialog.getByText("计算依据与版本记录", { exact: true }).click();
    await dialog.locator(".profit-calculation-item").waitFor();
    assert.equal(await dialog.locator(".profit-calculation-revision .el-table").count(), 0, "collapsed revisions do not mount evidence tables");
    await dialog.locator(".profit-calculation-revision summary").click();
    await dialog.getByRole("heading", { name: "保存结果", exact: true }).waitFor();
    assert.match(await dialog.locator(".profit-calculation-revision").innerText(), /历史输入未完整留存/);
    assert.match(await dialog.locator(".profit-calculation-revision .el-table").innerText(), /预估利润[\s\S]*0[\s\S]*真实利润[\s\S]*0/);
    assert.ok(requests.every((request) => request.method === "GET"), "opening details cannot recalculate or mutate orders");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
