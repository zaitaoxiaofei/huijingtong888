import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("exchange entries preserve the dashboard grid and the existing shared dialog boundary", async () => {
  const dashboard = await fs.readFile("frontend/admin/views/DashboardView.vue", "utf8");
  const layout = await fs.readFile("frontend/admin/layouts/AdminLayout.vue", "utf8");
  const dialog = await fs.readFile("frontend/admin/components/QuickToolsDialog.vue", "utf8");
  const view = await fs.readFile("frontend/admin/views/tools/ExchangeRateToolView.vue", "utf8");
  const ai = dashboard.indexOf('class="primary-metric ai-usage-card"');
  const card = dashboard.indexOf("<DailyExchangeRateCard />", ai);
  assert.ok(ai > 0 && card > ai);
  assert.match(dashboard.slice(ai, card), /<\/article>\s*<\/el-tooltip>\s*$/);
  assert.match(dashboard, /grid-template-columns:\s*repeat\(8,\s*minmax\(0,\s*1fr\)\)/);
  assert.ok(layout.indexOf('aria-label="打开汇率工具"') > layout.indexOf('aria-label="打开简易计算器"'));
  assert.match(dialog, /exchange:\s*defineAsyncComponent\(\(\) => import\("\.\.\/views\/tools\/ExchangeRateToolView\.vue"\)\)/);
  assert.match(dialog, /exchange: "汇率工具"/);
  assert.match(view, /eligible_items === 0 \? '暂无新规则结算'/);
  assert.match(view, /eligible_items === 0 \? '暂无适用订单'/);
  assert.doesNotMatch(view, /本月另有/);
});

test("actual header and daily card open one lazy exchange dialog without routing or leaking a prior tenant response", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1", timeout: 180000 }, async () => {
  const mocks = {
    auth: `import {reactive} from 'vue';export const auth=reactive({user:window.initialUser});export const useAuthStore=()=>auth;`,
    app: `import{reactive}from'vue';const state=reactive({sidebarCollapsed:false,densityMode:'standard',toggleSidebar(){this.sidebarCollapsed=!this.sidebarCollapsed;},setDensityMode(value){this.densityMode=value;}});export const useAppStore=()=>state;`,
    tabs: `import{reactive}from'vue';export const tabs=reactive({tabs:[{key:'home',title:'经营首页',route:'/dashboard',pinned:true},{key:'orders',title:'订单列表',route:'/orders',closable:true}],activeKey:'home',restoreTabs(){},openRoute(){},findTab(key){return this.tabs.find(tab=>tab.key===key)},tabKeyForRoute(route){return route.path},refreshToken:0});export const useWorkspaceTabsStore=()=>tabs;`,
    navigation: `export const navigationMenus=[];export const navigationMenusForRole=()=>[];`,
    router: `export const prefetchRouteComponent=()=>{};`,
    ai: `export const openAiEcommerceSuiteWindow=()=>{};export const openAiProductMaterialOptimizerWindow=()=>{};export const openAiVariantLabWindow=()=>{};`,
    upload: `export const uploadListingMedia=()=>{throw new Error('unused fixture upload')};`,
    component: `export default{render(){return null}};`
  };
  const entry = `import{createApp,h}from'vue';import{createRouter,createMemoryHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import AdminLayout from'/frontend/admin/layouts/AdminLayout.vue';import DailyExchangeRateCard from'/frontend/admin/components/DailyExchangeRateCard.vue';import{auth}from'virtual:exchange-entry-auth';import{tabs}from'virtual:exchange-entry-tabs';import{currentApiCacheScope}from'/frontend/admin/utils/api.js';import{applyAppearancePreferences}from'/frontend/admin/utils/theme-presets.js';
    localStorage.setItem('authToken','exchange-entry-fixture');localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));currentApiCacheScope();
    const Dashboard={render(){return h('section',{class:'fixture-dashboard'},[h('h1','经营首页'),h('div',{class:'fixture-metric-row'},[h('article',{class:'primary-metric'},[h('div','AI 消耗'),h('strong','¥3.80')]),h(DailyExchangeRateCard)])])}};
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/dashboard',component:Dashboard,meta:{breadcrumb:['工作台','经营首页']}},{path:'/orders',component:{template:'<div>订单页</div>'}}]});const app=createApp(AdminLayout).use(router).use(ElementPlus);await router.push('/dashboard');await router.isReady();
    window.setExchangeUser=user=>{auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));currentApiCacheScope()};window.exchangeRouter=router;window.exchangeTabs=tabs;window.setExchangeTheme=mode=>applyAppearancePreferences({version:1,mode,palettes:{light:'teal',dark:'teal'}},document);window.setExchangeTheme('light');app.mount('#app');`;
  const bundle = await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
    name: "exchange-entry-fixture", enforce: "pre",
    resolveId(source, importer) {
      if (source === "virtual:exchange-entry") return "\0exchange-entry-main";
      if (source === "virtual:exchange-entry-auth") return "\0exchange-entry-auth";
      if (source === "virtual:exchange-entry-tabs") return "\0exchange-entry-tabs";
      if (!importer?.replaceAll("\\", "/").includes("frontend/admin")) return;
      const key = /stores\/auth(?:\.js)?$/.test(source) ? "auth" : /stores\/app(?:\.js)?$/.test(source) ? "app" : /stores\/workspaceTabs(?:\.js)?$/.test(source) ? "tabs"
        : /constants\/navigation\.js$/.test(source) ? "navigation" : source === "../router" ? "router" : /utils\/ai-variant-lab-window$/.test(source) ? "ai"
          : /api\/tools\/imageCropper$/.test(source) ? "upload" : /components\/(?:AppearanceSettings|EnterpriseMessenger)\.vue$/.test(source) ? "component" : null;
      if (key) return `\0exchange-entry-${key}`;
    },
    load(id) { if (id === "\0exchange-entry-main") return entry; if (id.startsWith("\0exchange-entry-")) return mocks[id.slice("\0exchange-entry-".length)]; }
  }], build: { write: false, cssCodeSplit: false, target: "esnext", rollupOptions: { input: "virtual:exchange-entry", output: { entryFileNames: "entry.js" } } } });
  const assets = new Map(bundle.output.map(item => [item.fileName, item.type === "asset" ? item.source : item.code]));
  const css = [...assets.keys()].find(file => file.endsWith(".css"));
  const artifacts = path.resolve(".verification/exchange-rate-entry");
  await fs.mkdir(artifacts, { recursive: true });
  const executablePath = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/chromium");
  const browser = await chromium.launch({ executablePath, headless: true });
  const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
  const userA = { id: 901, name: "测试运营 A", username: "fixture-a", roles: ["operator"], tenant: { id: 201, name: "测试企业 A", role: "owner", status: "active", subscription_status: "active", subscription_expires_at: expiry, access_allowed: true } };
  const userB = { ...userA, id: 902, name: "测试运营 B", username: "fixture-b", tenant: { ...userA.tenant, id: 202, name: "测试企业 B", role: "member" } };
  const point = { business_date: "2026-10-26", source_date: "2026-10-23", archive_id: "512", rate: 12.5, rate_rub_per_cny: 12.5, rate_cny_per_rub: 0.08 };
  const publicMarket = { range: { preset: "year", from: "2025-10-27", to: "2026-10-26" }, currency_from: "CNY", currency_to: "RUB", source: "cbr", points: [point], today: { ...point, available: true }, latest: point, coverage: { expected_days: 365, available_days: 1, missing_days: 364, complete: false } };
  const privateImpact = { month: "2026-10", currency: "CNY", realized: { amount_cny: -1234.56, eligible_items: 1, included_items: 1, pending_items: 0, excluded_items: 0, coverage_complete: true, reasons: [] }, open: { known_rub_revenue_impact_cny: 0, eligible_items: 0, included_items: 0, pending_items: 0, excluded_items: 0, coverage_complete: true, reasons: [] }, excluded: { legacy_items: 2 } };
  const calls = [], errors = [];
  let activeUser = userA, missingToday = false, holdTool = false, releaseHeld = null;
  let heldStarted;
  const heldRequestStarted = new Promise(resolve => { heldStarted = resolve; });
  try {
    const page = await browser.newPage({ viewport: { width: 1480, height: 950 } });
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(user => { window.initialUser = user; }, userA);
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, "http://localhost:8788", "all traffic stays intercepted in the dedicated local fixture");
      if (url.pathname.startsWith("/api/")) {
        calls.push({ path: url.pathname, query: url.search, method: route.request().method() });
        assert.equal(route.request().method(), "GET", "entry points never write business data");
        if (url.pathname === "/api/system-notifications") return route.fulfill({ json: { rows: [], unread: 0 } });
        if (url.pathname === "/api/exchange-rates/tool/today") return route.fulfill({ json: { timezone: "Asia/Shanghai", as_of: "2026-10-26T09:30:00Z", public: {
          today: missingToday ? { ...point, available: false, rate: null, rate_rub_per_cny: null, rate_cny_per_rub: null, archive_id: null, reason: "TODAY_ARCHIVE_MISSING" } : { ...point, available: true },
          latest: missingToday ? { ...point, business_date: "2026-10-25", rate: 99.9999 } : point
        } } });
        if (url.pathname === "/api/exchange-rates/tool") {
          const response = { timezone: "Asia/Shanghai", as_of: "2026-10-26T09:30:00Z", public: publicMarket, month_impact: activeUser.id === userA.id ? privateImpact : null };
          if (holdTool) {
            holdTool = false;
            await new Promise(resolve => { releaseHeld = async () => { try { await route.fulfill({ json: response }); } finally { resolve(); } }; heldStarted(); });
            return;
          }
          return route.fulfill({ json: response });
        }
        throw new Error(`Unexpected API ${url.pathname}`);
      }
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}.fixture-dashboard{padding:20px}.fixture-metric-row{display:grid;grid-template-columns:repeat(2,minmax(0,260px));gap:14px}.primary-metric{padding:16px;border:1px solid var(--erp-border);border-radius:var(--erp-radius);background:var(--erp-card);min-width:0}.primary-metric>strong{display:block;margin:12px 0;font-size:26px}.metric-label,.metric-footer{display:flex;align-items:center;gap:8px}.metric-footer{margin-top:12px;justify-content:space-between;font-size:12px}@media(max-width:600px){.fixture-metric-row{grid-template-columns:minmax(0,1fr)}}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      const body = assets.get(url.pathname.slice(1));
      assert.notEqual(body, undefined, `fixture asset ${url.pathname}`);
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body });
    });
    const originalUrl = "http://localhost:8788/admin.html#/dashboard";
    await page.goto(originalUrl);
    const card = page.getByRole("button", { name: "每日汇率，打开汇率工具", exact: true });
    await card.getByText("12.5000", { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path === "/api/exchange-rates/tool").length, 0, "homepage card does not load annual history or private finance");
    assert.equal(calls.filter(call => call.path === "/api/exchange-rates/tool/today").length, 1);
    assert.equal(await page.locator(".exchange-rate-tool").count(), 0);
    const initialTabs = await page.locator(".erp-workspace-tab").count();
    assert.equal(initialTabs, 2);
    const calculator = page.getByRole("button", { name: "打开简易计算器", exact: true });
    const exchange = page.getByRole("button", { name: "打开汇率工具", exact: true });
    assert.equal(await exchange.evaluate(el => el.previousElementSibling?.getAttribute("aria-label")), "打开简易计算器");
    assert.ok((await exchange.boundingBox()).x > (await calculator.boundingBox()).x);
    await page.screenshot({ path: path.join(artifacts, "exchange-header-card-light.png"), fullPage: true });
    await exchange.click();
    const dialog = page.getByRole("dialog", { name: "汇率工具", exact: true });
    await dialog.locator(".exchange-rate-tool").waitFor();
    await dialog.getByText("−¥1234.56", { exact: true }).waitFor();
    await dialog.getByText("暂无适用订单", { exact: true }).waitFor();
    assert.equal(calls.find(call => call.path === "/api/exchange-rates/tool").query, "?range=year");
    assert.equal(await dialog.locator("h2").count(), 0);
    assert.equal(page.url(), originalUrl);
    assert.equal(await page.locator(".erp-workspace-tab").count(), initialTabs);
    await page.screenshot({ path: path.join(artifacts, "exchange-shared-dialog-light.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Close this dialog", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await card.click();
    await dialog.getByText("−¥1234.56", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "汇率工具", exact: true }).count(), 1);
    assert.equal(calls.filter(call => call.path === "/api/exchange-rates/tool").length, 1, "card reuses the same scoped tool rather than creating a route or second instance");
    assert.equal(page.url(), originalUrl);
    assert.equal(await page.locator(".erp-workspace-tab").count(), initialTabs);
    holdTool = true;
    await dialog.getByRole("button", { name: "刷新", exact: true }).click();
    await heldRequestStarted;
    activeUser = userB;
    missingToday = true;
    await page.evaluate(user => window.setExchangeUser(user), userB);
    await dialog.waitFor({ state: "hidden" });
    await card.getByText("待更新", { exact: true }).waitFor();
    assert.equal(await card.getByText("99.9999", { exact: true }).count(), 0, "missing today never substitutes yesterday's quote");
    assert.equal(await card.getByText("2026-10-26", { exact: true }).count(), 1);
    await exchange.click();
    await dialog.getByText("当前账号可查看公共参考汇率。企业汇差涉及财务数据，仅向有财务权限的成员开放。", { exact: true }).waitFor();
    await releaseHeld();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.getByText("−¥1234.56", { exact: true }).count(), 0, "late enterprise A response cannot expose private data in B's dialog");
    assert.equal(await dialog.locator(".exchange-rate-tool__impact-card").count(), 0);
    assert.equal(page.url(), originalUrl);
    assert.equal(await page.locator(".erp-workspace-tab").count(), initialTabs);
    await page.evaluate(() => window.setExchangeTheme("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await dialog.locator(".exchange-rate-tool").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: path.join(artifacts, "exchange-shared-dialog-dark-mobile.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Close this dialog", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.screenshot({ path: path.join(artifacts, "exchange-card-missing-dark-mobile.png"), fullPage: true });
    assert.deepEqual(errors, [], "actual layout, shared dialog and daily card produce no runtime errors");
  } finally {
    if (releaseHeld) await releaseHeld().catch(() => {});
    await browser.close();
  }
});
