import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("enterprise owner sees real dashboard profit and scoped read-only payroll while employee and changed authority retain no private view", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1", timeout: 180000 }, async () => {
  const mocks = {
    auth: `import{reactive}from'vue';export const auth=reactive({user:window.initialUser});export const useAuthStore=()=>auth;`,
    app: `import{reactive}from'vue';const app=reactive({sidebarCollapsed:false,densityMode:'standard',toggleSidebar(){this.sidebarCollapsed=!this.sidebarCollapsed},setDensityMode(v){this.densityMode=v}});export const useAppStore=()=>app;`,
    tabs: `import{reactive}from'vue';export const tabs=reactive({tabs:[{key:'/dashboard',title:'经营首页',pinned:true},{key:'/finance/payroll',title:'员工工资',closable:true},{key:'/profit/monthly-billing',title:'月度账单',closable:true}],activeKey:'/dashboard',restoreTabs(){},openRoute(route){this.activeKey=route.path},findTab(key){return this.tabs.find(tab=>tab.key===key)},tabKeyForRoute(route){return route.path},refreshToken:0});export const useWorkspaceTabsStore=()=>tabs;`,
    router: `export const prefetchRouteComponent=()=>{};`,
    ai: `export const openAiEcommerceSuiteWindow=()=>{};export const openAiProductMaterialOptimizerWindow=()=>{};export const openAiVariantLabWindow=()=>{};`,
    upload: `export const uploadListingMedia=()=>{throw new Error('unused fixture upload')};`,
    component: `export default{render(){return null}};`
  };
  const entry = `import{createApp}from'vue';import{createRouter,createMemoryHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import AdminLayout from'/frontend/admin/layouts/AdminLayout.vue';import Dashboard from'/frontend/admin/views/DashboardView.vue';import Payroll from'/frontend/admin/views/finance/PayrollView.vue';import{auth}from'virtual:finance-auth';import{canAccessPage}from'/src/shared/permissions.js';import{currentApiCacheScope}from'/frontend/admin/utils/api.js';import{applyAppearancePreferences}from'/frontend/admin/utils/theme-presets.js';
    localStorage.setItem('authToken','finance-authority-fixture');localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));currentApiCacheScope();
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/dashboard',name:'dashboard',component:Dashboard,meta:{breadcrumb:['工作台','经营首页']}},{path:'/finance/payroll',name:'finance-payroll',component:Payroll,meta:{breadcrumb:['财务中心','员工工资']}},{path:'/profit/monthly-billing',name:'profit-monthly-billing',component:{template:'<h1>本企业月度账单</h1>'},meta:{breadcrumb:['财务中心','月度账单']}}]});
    router.beforeEach(to=>canAccessPage(auth.user,to.path)?true:'/dashboard');await router.push('/dashboard');await router.isReady();window.financeRouter=router;window.setFinanceUser=user=>{auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));currentApiCacheScope()};window.setFinanceTheme=mode=>applyAppearancePreferences({version:1,mode,palettes:{light:'teal',dark:'teal'}},document);window.setFinanceTheme('light');createApp(AdminLayout).use(router).use(ElementPlus).mount('#app');`;
  const bundle = await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
    name: "enterprise-finance-fixture", enforce: "pre", resolveId(source, importer) {
      if (source === "virtual:finance-entry") return "\0finance-entry";
      if (source === "virtual:finance-auth") return "\0finance-auth";
      if (!importer?.replaceAll("\\", "/").includes("frontend/admin")) return;
      const key = /stores\/auth(?:\.js)?$/.test(source) ? "auth" : /stores\/app(?:\.js)?$/.test(source) ? "app" : /stores\/workspaceTabs(?:\.js)?$/.test(source) ? "tabs" : source === "../router" ? "router"
        : /utils\/ai-variant-lab-window$/.test(source) ? "ai" : /api\/tools\/imageCropper$/.test(source) ? "upload" : /components\/(?:AppearanceSettings|EnterpriseMessenger|QuickToolsDialog)\.vue$/.test(source) ? "component" : null;
      if (key) return `\0finance-${key}`;
    }, load(id) { if (id === "\0finance-entry") return entry; if (id.startsWith("\0finance-")) return mocks[id.slice("\0finance-".length)]; }
  }], build: { write: false, cssCodeSplit: false, target: "esnext", rollupOptions: { input: "virtual:finance-entry", output: { entryFileNames: "entry.js" } } } });
  const assets = new Map(bundle.output.map(row => [row.fileName, row.type === "asset" ? row.source : row.code]));
  const css = [...assets.keys()].find(name => name.endsWith(".css"));
  const artifacts = path.resolve(".verification/enterprise-finance-authority");
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
  const defaultOwner = { id: 6, name: "负责人样例", roles: ["admin", "operations"], platform_role: null, tenant: { id: 1, slug: "default", role: "owner", status: "active", subscription_status: "active", subscription_expires_at: expiry, access_allowed: true } };
  const ownerA = { ...defaultOwner, id: 20, name: "A 企业负责人", roles: ["operations"], tenant: { ...defaultOwner.tenant, id: 2, slug: "company-a" } };
  const employee = { ...defaultOwner, id: 8, name: "普通运营样例", roles: ["manager", "operations", "packing"], tenant: { ...defaultOwner.tenant, role: "member" } };
  let user = defaultOwner, holdPeriod = false, releaseHeld = null, heldStarted;
  const heldRequest = new Promise(resolve => { heldStarted = resolve; });
  const calls = [], errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(value => { window.initialUser = value; }, defaultOwner);
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, "http://localhost:8788");
      if (url.pathname.startsWith("/api/")) {
        assert.equal(route.request().method(), "GET", "owner never sends payroll mutations");
        calls.push(url.pathname);
        let response;
        if (url.pathname === "/api/system-notifications") response = { rows: [], unread: 0 };
        else if (url.pathname === "/api/dashboard") response = { commerce: { today: { revenue: 1000, profit: user.tenant.id === 1 ? 1234.56 : 987.65 }, yesterday: {}, profit_trend: { month_total_profit: 2000 }, advertising: { today: {}, yesterday: {}, month: {} } }, summary: {}, alerts: { fbp: [], fbs: [], procurement: [] }, snapshot: { status: "ready" } };
        else if (["/api/online-products/limits", "/api/profit-ranking", "/api/fbp-opportunities"].includes(url.pathname)) response = { rows: [], summary: {} };
        else if (url.pathname === "/api/exchange-rates/tool/today") response = { public: { today: { business_date: "2026-10-26", available: true, rate: 12.5 } } };
        else if (url.pathname === "/api/payroll/setup") response = { companies: [{ id: user.tenant.id * 100, name: `${user.tenant.slug} 用工公司` }], people: [], schemes: [{ id: 1, name: "所属工资方案" }], policies: [], profiles: [] };
        else if (url.pathname === "/api/payroll/period") {
          response = { period: { id: user.tenant.id * 100, status: "locked" }, rows: [{ person_name: user.tenant.id === 1 ? "默认企业员工" : "A企业员工", net_salary: user.tenant.id === 1 ? 5400 : 9900 }], summary: { gross_salary: user.tenant.id === 1 ? 6000 : 11000, net_salary: user.tenant.id === 1 ? 5400 : 9900, employer_total_cost: 12000 } };
          if (holdPeriod) {
            holdPeriod = false;
            await new Promise(resolve => { releaseHeld = async () => { try { await route.fulfill({ json: response }); } finally { resolve(); } }; heldStarted(); });
            return;
          }
        } else throw new Error(`Unexpected fixture API ${url.pathname}`);
        return route.fulfill({ json: response });
      }
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      const response = assets.get(url.pathname.slice(1));
      assert.notEqual(response, undefined, url.pathname);
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: response });
    });
    await page.goto("http://localhost:8788/admin.html");
    await page.locator(".profit-card strong").getByText("CNY 1,235", { exact: true }).waitFor();
    assert.equal(await page.locator(".profit-card").count(), 1);
    assert.equal(await page.locator(".month-profit-card").count(), 1);
    await page.locator(".erp-sidebar").getByText("财务中心", { exact: true }).click();
    await page.locator(".erp-sidebar").getByText("月度账单", { exact: true }).waitFor();
    await page.locator(".erp-sidebar").getByText("员工工资", { exact: true }).waitFor();
    assert.equal(await page.locator(".erp-sidebar").getByText("系统管理", { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(artifacts, "owner-dashboard-light.png"), fullPage: true });
    await page.evaluate(() => window.financeRouter.push("/finance/payroll"));
    await page.locator(".payroll-page").getByText("默认企业员工", { exact: true }).waitFor();
    assert.equal(await page.locator(".payroll-page").getByRole("button", { name: "生成试算", exact: true }).count(), 0);
    assert.equal(await page.locator(".payroll-page").getByRole("button", { name: "审核", exact: true }).count(), 0);
    assert.equal(await page.locator(".payroll-page").getByRole("button", { name: "锁定", exact: true }).count(), 0);
    await page.screenshot({ path: path.join(artifacts, "owner-payroll-light.png"), fullPage: true });
    holdPeriod = true;
    await page.locator(".payroll-page").getByRole("button", { name: "刷新", exact: true }).click();
    await heldRequest;
    user = ownerA;
    await page.evaluate(value => window.setFinanceUser(value), ownerA);
    await page.locator(".payroll-page").getByText("A企业员工", { exact: true }).waitFor();
    await releaseHeld();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(".payroll-page").getByText("默认企业员工", { exact: true }).count(), 0);
    const setupCalls = calls.filter(path => path === "/api/payroll/setup").length;
    user = { ...ownerA, tenant: { ...ownerA.tenant, role: "member" } };
    await page.evaluate(value => window.setFinanceUser(value), user);
    await page.waitForFunction(() => !document.querySelector(".payroll-page")?.textContent.includes("A企业员工"));
    assert.equal(calls.filter(path => path === "/api/payroll/setup").length, setupCalls, "same-person owner removal does not issue unauthorized salary reads");
    user = employee;
    await page.evaluate(value => window.setFinanceUser(value), employee);
    await page.evaluate(() => window.financeRouter.push("/dashboard"));
    await page.locator(".commerce-dashboard").waitFor();
    assert.equal(await page.locator(".profit-card,.month-profit-card").count(), 0);
    assert.equal(await page.locator(".erp-sidebar").getByText("财务中心", { exact: true }).count(), 0);
    const beforeDenied = calls.filter(path => path === "/api/payroll/setup").length;
    await page.evaluate(() => window.financeRouter.push("/finance/payroll"));
    assert.equal(await page.evaluate(() => window.financeRouter.currentRoute.value.path), "/dashboard");
    assert.equal(calls.filter(path => path === "/api/payroll/setup").length, beforeDenied);
    await page.evaluate(() => window.setFinanceTheme("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(artifacts, "employee-dashboard-dark-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    if (releaseHeld) await releaseHeld().catch(() => {});
    await browser.close();
  }
});
