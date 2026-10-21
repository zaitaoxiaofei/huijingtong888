import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, compileScript, compileStyle, compileTemplate } from "@vue/compiler-sfc";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";
import { calculatePricing, calculateProfit } from "../frontend/admin/utils/pricing-tool.js";
import { getThemePreset } from "../frontend/admin/utils/theme-presets.js";

test("quick tools and the existing routed calculators compile in both display modes", async () => {
  for (const filename of ["components/QuickToolsDialog.vue", "views/tools/ProfitCalculatorView.vue", "views/tools/PricingToolView.vue", "views/tools/RfbsCommissionPicker.vue"]) {
    const source = await fs.readFile(`frontend/admin/${filename}`, "utf8");
    const { descriptor, errors } = parse(source, { filename });
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: "quick-tools-test" });
    const template = compileTemplate({ source: descriptor.template.content, filename, id: "quick-tools-test", compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, []);
    for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, filename, id: "data-v-quick-tools-test", scoped: style.scoped }).errors, []);
  }
});

test("quick tools calculate without navigation, retain scoped inputs and close nested overlays", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1" }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "quick-tools-dialog-"));
  const entry = `import {createApp,h,ref} from 'vue';
    import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
    import '/frontend/admin/styles/index.css'; import '/frontend/admin/styles/erp-theme.css';
    import Dialog from '/frontend/admin/components/QuickToolsDialog.vue';
    import {applyAppearancePreferences} from '/frontend/admin/utils/theme-presets.js';
    window.applyQuickToolAppearance=(mode,palette)=>applyAppearancePreferences({version:1,mode,palettes:{[mode]:palette}},document);
    createApp({setup(){const visible=ref(false),tool=ref('profit'),scope=ref(0);
      return ()=>h('main',[
        h('h1','原业务页面'),h('input',{id:'page-note',placeholder:'原页面输入'}),
        h('button',{id:'open-profit',onClick:()=>{tool.value='profit';visible.value=true}},'打开利润计算器'),
        h('button',{id:'open-pricing',onClick:()=>{tool.value='pricing';visible.value=true}},'打开定价工具'),
        h('button',{id:'switch-scope',onClick:()=>{visible.value=false;scope.value++}},'切换账号企业'),
        h(Dialog,{key:scope.value,tool:tool.value,modelValue:visible.value,'onUpdate:modelValue':value=>visible.value=value})]);
    }}).use(ElementPlus).mount('#app');`;
  let browser;
  const errors = [], requests = [];
  const rule = { id: 1, version_group_id: 1, enabled: 1, effective_from: "2020-01-01 00:00:00", effective_to: null,
    name: "GUOO 标准 Small", carrier: "GUOO", channel: "standard", mode: "per_gram", min_weight_g: 1, max_weight_g: 500,
    min_price_rub: 1, max_price_rub: 100000, base_fee_cny: 0, per_gram_cny: 0.04, per_ticket_cny: 5 };
  const catalog = { version: "fixture", sourceFile: "fixture.xlsx", rows: [{ id: "car", block: "汽车用品", category: "汽车配件", blockRu: "", categoryRu: "", rates: [12, 17, 20.5] }] };
  const expectedInput = { saleCny: 128, purchaseCost: 28, weight: 300, length: 20, width: 20, height: 10,
    commissionRate: 12, freight: 17, exchangeRate: 10, domesticCost: 0, adRate: 0, otherRate: 0,
    returnRate: 0, returnLoss: 0, targetMargin: 20, discountRate: 0 };
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: "error", plugins: [vue(), {
      name: "quick-tools-dialog-fixture",
      resolveId(id) { if (id === "virtual:quick-tools") return "\0quick-tools"; },
      load(id) { if (id === "\0quick-tools") return entry; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: "virtual:quick-tools", output: { entryFileNames: "entry.js" } } } });
    const css = (await fs.readdir(path.join(output, "assets"))).find(name => name.endsWith(".css"));
    const chrome = process.env.CHROME_PATH || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost:8788/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<html><head><link rel="stylesheet" href="/assets/${css}"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      if (url.pathname.startsWith("/api/")) {
        requests.push({ path: url.pathname, method: request.method() });
        assert.equal(request.method(), "GET", "calculators never write business data");
        const responses = {
          "/api/tools/pricing/logistics-rules": [rule],
          "/api/tools/pricing/reference-rate": { rate: 10, source_date: "2026-10-21" },
          "/api/tools/pricing/rfbs-marketplace": catalog
        };
        assert.ok(Object.hasOwn(responses, url.pathname), `Unexpected API: ${url.pathname}`);
        return route.fulfill({ json: responses[url.pathname] });
      }
      const assetPath = path.resolve(output, `.${url.pathname}`);
      assert.ok(assetPath.startsWith(`${path.resolve(output)}${path.sep}`));
      return route.fulfill({ contentType: assetPath.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(assetPath) });
    });
    const originalUrl = "http://localhost:8788/admin.html#/inventory/alerts";
    await page.goto(originalUrl);
    await page.locator("#page-note").fill("保留当前页面内容");
    assert.equal(requests.length, 0, "closed tools load no API data");
    assert.equal(await page.locator(".profit-page, .pricing-page").count(), 0);

    await page.locator("#open-profit").click();
    const profit = page.getByRole("dialog", { name: "利润计算器", exact: true });
    await profit.locator(".profit-page.is-embedded").waitFor();
    await profit.getByText("俄罗斯央行 2026-10-21").waitFor();
    assert.equal(requests.length, 3);
    assert.equal(await profit.getByRole("heading", { name: "OZON 跨境利润计算器" }).count(), 0, "embedded mode removes only the duplicate title");
    const fill = async (dialog, label, value, index = 0) => {
      const input = dialog.locator(".el-form-item").filter({ has: page.locator(".el-form-item__label", { hasText: label }) }).getByRole("spinbutton").nth(index);
      await input.fill(String(value)); await input.press("Tab");
    };
    await fill(profit, "实际售价", 128); await fill(profit, "采购成本", 28);
    await fill(profit, "包裹重量", 300);
    for (const [index, value] of [20, 20, 10].entries()) await fill(profit, "包裹尺寸", value, index);
    await profit.locator(".rfbs-trigger input").click();
    await page.locator(".rfbs-menu").getByRole("button", { name: "≤ ₽1,500 12%", exact: true }).click();
    await profit.getByRole("button", { name: "开始计算", exact: true }).click();
    await profit.locator(".headline strong").waitFor();
    assert.equal((await profit.locator(".headline strong").innerText()).trim(), `¥ ${calculateProfit(expectedInput).profit.toFixed(2)}`);
    assert.equal(page.url(), originalUrl);
    const scroll = await profit.locator(".el-dialog__body").evaluate(el => ({ height: el.clientHeight, full: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    assert.ok(scroll.full > scroll.height && scroll.overflow === "auto", "long calculator content scrolls inside the dialog");

    await profit.locator(".rfbs-trigger input").click();
    await page.locator(".rfbs-menu").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".rfbs-menu").waitFor({ state: "detached" });
    assert.equal(await profit.isVisible(), true, "first Escape closes only the commission menu");
    await page.keyboard.press("Escape");
    await profit.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#page-note").inputValue(), "保留当前页面内容");
    assert.equal(page.url(), originalUrl);

    await page.locator("#open-profit").click();
    await profit.locator(".headline strong").waitFor();
    assert.equal(requests.length, 3, "reopening reuses this dialog instance's inputs and loaded data");
    await profit.locator(".rfbs-trigger input").click();
    await page.locator(".rfbs-menu").waitFor();
    await profit.getByRole("button", { name: "Close this dialog" }).click();
    await profit.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".rfbs-menu").count(), 0, "X clears all teleported tool overlays");

    await page.locator("#open-pricing").click();
    const pricing = page.getByRole("dialog", { name: "定价工具", exact: true });
    await pricing.locator(".pricing-page.is-embedded").waitFor();
    await pricing.getByText("俄罗斯央行 2026-10-21").waitFor();
    assert.equal(requests.length, 6);
    await fill(pricing, "采购成本", 28); await fill(pricing, "包裹重量", 300);
    for (const [index, value] of [20, 20, 10].entries()) await fill(pricing, "包裹尺寸", value, index);
    await pricing.locator(".rfbs-trigger input").click();
    await page.locator(".rfbs-menu").getByRole("button", { name: "≤ ₽1,500 12%", exact: true }).click();
    await pricing.getByRole("button", { name: "开始计算", exact: true }).click();
    await pricing.locator(".price-pair strong").first().waitFor();
    assert.equal((await pricing.locator(".price-pair strong").first().innerText()).trim(), `₽ ${calculatePricing(expectedInput).saleRub.toFixed(2)}`);
    await page.keyboard.press("Escape"); await pricing.waitFor({ state: "hidden" });
    await page.locator("#open-profit").click();
    await profit.locator(".headline strong").waitFor();
    assert.equal(requests.length, 6, "switching tools preserves each tool's independent state");

    const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(", ")})`;
    for (const mode of ["light", "dark"]) for (const palette of ["blue", "teal", "violet"]) {
      await page.evaluate(({ mode, palette }) => window.applyQuickToolAppearance(mode, palette), { mode, palette });
      const preset = getThemePreset(mode, palette);
      await page.waitForFunction(expected => {
        const button = getComputedStyle(document.querySelector(".profit-page .calculate-button"));
        const accent = getComputedStyle(document.querySelector(".profit-page h3"));
        const result = getComputedStyle(document.querySelector(".profit-page .headline strong"));
        const panel = getComputedStyle(document.querySelector(".profit-page .results > .el-card"));
        return button.backgroundColor === expected.fill && button.color === expected.contrast && accent.borderLeftColor === expected.accent && result.color === expected.accent && panel.backgroundColor === expected.faint;
      }, { fill: rgb(preset.tokens["primary-fill"]), contrast: rgb(preset.tokens["primary-contrast"]), accent: rgb(preset.accent), faint: rgb(preset.tokens["primary-faint"]) });
      await profit.locator(".rfbs-trigger input").click();
      const selected = page.locator(".rfbs-column button.active").last();
      assert.equal(await selected.evaluate(el => getComputedStyle(el).backgroundColor), rgb(preset.soft), `commission selection follows ${mode}/${palette}`);
      await page.keyboard.press("Escape");
      await page.locator(".rfbs-menu").waitFor({ state: "detached" });
      if (process.env.QUICK_TOOLS_SCREENSHOT_DIR && mode === "light" && palette === "teal") {
        await fs.mkdir(process.env.QUICK_TOOLS_SCREENSHOT_DIR, { recursive: true });
        await profit.locator(".el-dialog__body").evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: path.join(process.env.QUICK_TOOLS_SCREENSHOT_DIR, "profit-desktop-teal.png"), animations: "disabled" });
      }
    }
    const colors = await profit.locator(".el-input__inner").first().evaluate(el => ({ text: getComputedStyle(el).color, background: getComputedStyle(el.closest(".el-input__wrapper")).backgroundColor }));
    assert.equal(colors.text, "rgb(214, 222, 236)");
    assert.equal(colors.background, "rgb(22, 34, 53)");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".profit-page .el-card")).backgroundColor === "rgb(16, 26, 43)");
    await profit.locator(".el-dialog__body").evaluate(el => { el.scrollTop = 0; });
    if (process.env.QUICK_TOOLS_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.QUICK_TOOLS_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.QUICK_TOOLS_SCREENSHOT_DIR, "profit-desktop-dark.png"), animations: "disabled" });
    }
    await page.keyboard.press("Escape"); await profit.waitFor({ state: "hidden" });
    await page.locator("#switch-scope").click();
    await page.locator("#open-profit").click();
    await profit.getByText("填写参数后计算利润", { exact: true }).waitFor();
    assert.equal(await profit.locator(".headline").count(), 0, "remounting for a changed auth scope drops all cached tool inputs");
    assert.equal(requests.length, 9);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector(".quick-tools-dialog").getBoundingClientRect().y >= 0);
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".profit-page .el-card")).backgroundColor === "rgb(16, 26, 43)");
    const rect = await profit.locator(".el-dialog").boundingBox();
    assert.ok(rect.width <= 390 * 0.93 + 1 && rect.x >= 0 && rect.x + rect.width <= 391, `mobile dialog stays inside 93vw: ${JSON.stringify(rect)}`);
    assert.ok(await profit.locator(".profit-page").evaluate(el => el.scrollWidth <= el.clientWidth), "embedded mobile form has no horizontal overflow");
    if (process.env.QUICK_TOOLS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.QUICK_TOOLS_SCREENSHOT_DIR, "profit-mobile-dark.png"), animations: "disabled" });
    await page.keyboard.press("Escape"); await profit.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(path.resolve(output)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(output).startsWith("quick-tools-dialog-"));
    await fs.rm(output, { recursive: true, force: true });
  }
});
