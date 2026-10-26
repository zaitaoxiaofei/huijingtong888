import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("exchange tool is lazy, read-only, theme-aware and does not retain another account's impact", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1" }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "exchange-rate-tool-"));
  const entry = `import {createApp,h,ref,defineAsyncComponent} from 'vue';
    import ElementPlus,{ElDialog} from 'element-plus'; import 'element-plus/dist/index.css';
    import '/frontend/admin/styles/index.css'; import '/frontend/admin/styles/erp-theme.css';
    import {applyAppearancePreferences} from '/frontend/admin/utils/theme-presets.js';
    const Tool=defineAsyncComponent(()=>import('/frontend/admin/views/tools/ExchangeRateToolView.vue'));
    window.applyExchangeTheme=(mode)=>applyAppearancePreferences({version:1,mode,palettes:{[mode]:'teal'}},document);
    createApp({setup(){const visible=ref(false),scope=ref(0);return()=>h('main',[
      h('button',{id:'open',onClick:()=>visible.value=true},'打开汇率工具'),
      h('button',{id:'switch',onClick:()=>{visible.value=false;scope.value++;localStorage.setItem('baodanAuthUser',JSON.stringify({id:scope.value+1,tenant:{id:scope.value+1}}))}},'切换账号'),
      h(ElDialog,{class:'exchange-tool-fixture',modelValue:visible.value,'onUpdate:modelValue':v=>visible.value=v,title:'汇率与汇差',width:'min(1200px, 93vw)',top:'4vh',destroyOnClose:true},()=>visible.value?h(Tool,{key:scope.value,embedded:true}):null)
    ])}}).use(ElementPlus).mount('#app');`;
  const point = (business_date, rate, archive_id) => ({ business_date, rate, rate_rub_per_cny: rate, rate_cny_per_rub: rate ? 1 / rate : null, source_date: rate ? business_date : null, archive_id });
  const payload = { timezone: "Asia/Shanghai", as_of: "2026-10-26T09:30:00Z", public: {
    range: { preset: "year", from: "2026-10-24", to: "2026-10-26" }, currency_from: "CNY", currency_to: "RUB", source: "cbr",
    points: [point("2026-10-24", 10, 11), point("2026-10-25", null, null), point("2026-10-26", 12.5, 12)],
    today: { ...point("2026-10-26", 12.5, 12), available: true }, latest: point("2026-10-26", 12.5, 12),
    coverage: { expected_days: 3, available_days: 2, missing_days: 1, complete: false }
  }, month_impact: {
    month: "2026-10", currency: "CNY", realized: { amount_cny: -16, eligible_items: 1, included_items: 1, pending_items: 0, excluded_items: 0, coverage_complete: true, reasons: [] },
    open: { net_impact_cny: null, known_rub_revenue_impact_cny: 5, eligible_items: 2, included_items: 1, pending_items: 1, excluded_items: 0, coverage_complete: false, reasons: [{ code: "ORIGINAL_SALE_CURRENCY_UNKNOWN", count: 1 }] }, excluded: { legacy_items: 3 }
  } };
  let browser, publicOnly = false, responseMode = "normal";
  const requests = [], errors = [];
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: "error", plugins: [vue(), {
      name: "exchange-rate-tool-fixture", resolveId(id) { if (id === "virtual:exchange-tool") return "\0exchange-tool"; },
      load(id) { if (id === "\0exchange-tool") return entry; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: "virtual:exchange-tool", output: { entryFileNames: "entry.js" } } } });
    const css = (await fs.readdir(path.join(output, "assets"))).find(name => name.endsWith(".css"));
    const chrome = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost:8788/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<html><head><link rel="stylesheet" href="/assets/${css}"><style>.exchange-tool-fixture.el-dialog{display:flex;flex-direction:column;max-height:92vh;overflow:hidden}.exchange-tool-fixture .el-dialog__body{min-height:0;overflow-y:auto;flex:1}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      if (url.pathname.startsWith("/api/")) {
        assert.equal(request.method(), "GET");
        assert.equal(url.pathname, "/api/exchange-rates/tool");
        requests.push(url.search);
        assert.equal(url.searchParams.has("tenant_id"), false);
        if (responseMode === "error") return route.fulfill({ status: 503, json: { error: "测试：汇率暂不可用，请稍后刷新" } });
        if (responseMode === "missing") return route.fulfill({ json: { ...payload, public: { ...payload.public,
          points: [point("2026-10-26", null, null)], today: { ...point("2026-10-26", null, null), available: false, reason: "TODAY_ARCHIVE_MISSING" }, latest: null,
          coverage: { expected_days: 1, available_days: 0, missing_days: 1, complete: false }
        }, month_impact: { ...payload.month_impact, realized: { ...payload.month_impact.realized, amount_cny: null, pending_items: 1, coverage_complete: false, reasons: [{ code: "ACTUAL_SETTLEMENT_PENDING", count: 1 }] }, open: { ...payload.month_impact.open, known_rub_revenue_impact_cny: null, reasons: [{ code: "TODAY_ARCHIVE_MISSING", count: 2 }] } } } });
        if (responseMode.startsWith("reference")) return route.fulfill({ json: { ...payload, month_impact: { ...payload.month_impact, open: {
          ...payload.month_impact.open, estimated_sales_income_fx_cny: responseMode === "reference-unknown" ? null : -25,
          known_rub_revenue_impact_cny: -5, reference_cny_impact_cny: -20, reference_rub_revenue: 1000,
          reference_cny_items: 1, confirmed_rub_items: 1, eligible_items: 2, included_items: 2, pending_items: 0, coverage_complete: true, reasons: []
        } } } });
        return route.fulfill({ json: { ...payload, month_impact: publicOnly ? null : payload.month_impact } });
      }
      const assetPath = path.resolve(output, `.${url.pathname}`);
      assert.ok(assetPath.startsWith(`${path.resolve(output)}${path.sep}`));
      return route.fulfill({ contentType: assetPath.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(assetPath) });
    });
    const originalUrl = "http://localhost:8788/admin.html#/orders";
    await page.goto(originalUrl);
    assert.equal(requests.length, 0);
    await page.locator("#open").click();
    const tool = page.locator(".exchange-rate-tool");
    await tool.getByText("1 元 = 12.5000 卢布", { exact: true }).waitFor();
    assert.equal(requests.length, 1, "first scope discovery does not discard the first successful response");
    assert.equal(requests[0], "?range=year");
    assert.equal(await tool.getByText(/最近可用：/).count(), 0, "today's quote does not also show the missing-day fallback");
    assert.equal(await tool.locator("h2").count(), 0);
    assert.equal(await tool.locator(".exchange-rate-tool__line").count(), 2, "missing date breaks daily line");
    assert.equal(await tool.locator(".exchange-rate-tool__point").count(), 2);
    assert.equal(await tool.locator(".is-negative").innerText(), "−¥16.00");
    assert.equal(await tool.locator(".is-positive").innerText(), "+¥5.00");
    await tool.getByText("部分订单的原币销售收入待核对", { exact: true }).waitFor();
    await tool.locator(".el-radio-button").filter({ hasText: "近一月" }).click();
    await page.waitForFunction(() => document.querySelector('.exchange-rate-tool input[value="month"]')?.checked);
    await tool.getByText("1 元 = 12.5000 卢布", { exact: true }).waitFor();
    assert.equal(requests.at(-1), "?range=month");
    assert.equal(page.url(), originalUrl);
    for (const mode of ["light", "dark"]) {
      await page.evaluate(mode => window.applyExchangeTheme(mode), mode);
      const color = await tool.locator(".exchange-rate-tool__impact-card > strong.is-negative").evaluate(el => ({ text: getComputedStyle(el).color, expected: getComputedStyle(el).getPropertyValue("--erp-danger-text").trim() }));
      assert.ok(color.expected);
      const rgbExpected = await page.evaluate(color => { const node = document.createElement('i'); node.style.color = color; document.body.append(node); const rgb = getComputedStyle(node).color; node.remove(); return rgb; }, color.expected);
      assert.equal(color.text, rgbExpected);
      if (process.env.EXCHANGE_TOOL_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.EXCHANGE_TOOL_SCREENSHOT_DIR, { recursive: true });
        await page.locator(".el-dialog__body").evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: path.join(process.env.EXCHANGE_TOOL_SCREENSHOT_DIR, `exchange-${mode}.png`), animations: "disabled", fullPage: true });
        await tool.locator(".exchange-rate-tool__impact-grid").screenshot({ path: path.join(process.env.EXCHANGE_TOOL_SCREENSHOT_DIR, `exchange-impact-${mode}.png`), animations: "disabled" });
      }
    }
    responseMode = "reference";
    await tool.getByRole("button", { name: "刷新", exact: true }).click();
    const forecast = tool.locator(".exchange-rate-tool__impact-card").nth(1);
    await forecast.getByRole("heading", { name: "待签收预计销售收入汇差（参考估算）", exact: true }).waitFor();
    await forecast.getByText("−¥25.00", { exact: true }).waitFor();
    await forecast.getByText("人民币参考估算 1 项 · 已确认卢布收入 1 项", { exact: true }).waitFor();
    assert.equal(await forecast.getByText("−¥5.00", { exact: true }).count(), 0, "headline uses combined forecast, not only the confirmed RUB subset");
    await forecast.getByText("人民币标价按下单日汇率估算卢布参考收入，再按今日汇率比较；不含费用，不是官方结算金额。", { exact: true }).waitFor();
    if (process.env.EXCHANGE_TOOL_SCREENSHOT_DIR) await forecast.screenshot({ path: path.join(process.env.EXCHANGE_TOOL_SCREENSHOT_DIR, "exchange-reference-cny.png"), animations: "disabled" });
    responseMode = "reference-unknown";
    await tool.getByRole("button", { name: "刷新", exact: true }).click();
    await forecast.locator(":scope > strong").getByText("待核对", { exact: true }).waitFor();
    assert.equal(await forecast.getByText("−¥5.00", { exact: true }).count(), 0, "explicit unknown combined total must not fall back to a known subset");
    responseMode = "reference";
    await tool.getByRole("button", { name: "刷新", exact: true }).click();
    await forecast.getByText("−¥25.00", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector(".exchange-rate-tool__overview").getBoundingClientRect().width < 390);
    assert.ok(await tool.evaluate(el => el.scrollWidth <= el.clientWidth), "mobile tool has no overall horizontal overflow");
    if (process.env.EXCHANGE_TOOL_SCREENSHOT_DIR) {
      await page.locator(".el-dialog__body").evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: path.join(process.env.EXCHANGE_TOOL_SCREENSHOT_DIR, "exchange-mobile.png"), animations: "disabled", fullPage: true });
    }
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "汇率与汇差", exact: true }).waitFor({ state: "hidden" });
    await page.locator("#switch").click();
    publicOnly = true;
    responseMode = "normal";
    await page.locator("#open").click();
    await tool.getByText("当前账号可查看公共参考汇率。企业汇差涉及财务数据，仅向有财务权限的成员开放。", { exact: true }).waitFor();
    assert.equal(await tool.locator(".exchange-rate-tool__impact-card").count(), 0);
    assert.equal(await tool.getByText("−¥16.00", { exact: true }).count(), 0);
    responseMode = "error";
    await tool.getByRole("button", { name: "刷新", exact: true }).click();
    await tool.getByText("测试：汇率暂不可用，请稍后刷新", { exact: true }).waitFor();
    assert.equal(await tool.locator(".exchange-rate-tool__reference").count(), 0, "error never leaves another response's numbers visible");
    if (process.env.EXCHANGE_TOOL_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.EXCHANGE_TOOL_SCREENSHOT_DIR, "exchange-error.png"), animations: "disabled", fullPage: true });
    responseMode = "missing";
    await tool.getByRole("button", { name: "刷新", exact: true }).click();
    await tool.getByText("今日尚未存档", { exact: true }).waitFor();
    await tool.getByText("所选日期暂无可用汇率存档", { exact: true }).waitFor();
    assert.equal(await tool.locator(".exchange-rate-tool__impact-card > strong").filter({ hasText: "待核对" }).count(), 2);
    assert.equal(await tool.locator(".exchange-rate-tool__point").count(), 0);
    if (process.env.EXCHANGE_TOOL_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.EXCHANGE_TOOL_SCREENSHOT_DIR, "exchange-missing.png"), animations: "disabled", fullPage: true });
    assert.equal(page.url(), originalUrl);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(path.resolve(output)), path.resolve(os.tmpdir()));
    assert.match(path.basename(output), /^exchange-rate-tool-/);
    await fs.rm(output, { recursive: true, force: true });
  }
});
