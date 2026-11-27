import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("dashboard and notifications preserve their layout while hidden and KeepAlive reads pause and resume", {
  skip: process.env.RUN_TASK_BROWSER_TESTS !== "1", timeout: 180000
}, async () => {
  const mocks = {
    auth: `import{reactive}from'vue';export const auth=reactive({user:window.initialUser});export const useAuthStore=()=>auth;`,
    app: `import{reactive}from'vue';const app=reactive({sidebarCollapsed:false,densityMode:'standard',toggleSidebar(){this.sidebarCollapsed=!this.sidebarCollapsed},setDensityMode(value){this.densityMode=value}});export const useAppStore=()=>app;`,
    tabs: `import{reactive}from'vue';const tabs=reactive({tabs:[{key:'/dashboard',title:'经营首页',pinned:true},{key:'/inventory/products',title:'其他页面',closable:true}],activeKey:'/dashboard',restoreTabs(){},openRoute(route){this.activeKey=route.path},findTab(key){return this.tabs.find(tab=>tab.key===key)},tabKeyForRoute(route){return route.path},refreshToken:0});export const useWorkspaceTabsStore=()=>tabs;`,
    router: `export const prefetchRouteComponent=()=>{};`,
    ai: `export const openAiEcommerceSuiteWindow=()=>{};export const openAiProductMaterialOptimizerWindow=()=>{};export const openAiVariantLabWindow=()=>{};`,
    upload: `export const uploadListingMedia=()=>{throw new Error('Unexpected fixture upload')};`,
    component: `export default{render(){return null}};`
  };
  const entry = `import{createApp,h}from'vue';import{createRouter,createMemoryHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import AdminLayout from'/frontend/admin/layouts/AdminLayout.vue';import Dashboard from'/frontend/admin/views/DashboardView.vue';import{auth}from'virtual:display-auth';import{apiClient,currentApiCacheScope}from'/frontend/admin/utils/api.js';
    localStorage.setItem('authToken','display-polling-fixture');localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));currentApiCacheScope();
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/dashboard',name:'dashboard',component:Dashboard,meta:{breadcrumb:['工作台','经营首页']}},{path:'/inventory/products',name:'inventory-products',component:{render:()=>h('section',{'data-testid':'inactive-page'},'其他页面')},meta:{breadcrumb:['库存管理','其他页面']}}]});
    await router.push('/dashboard');await router.isReady();window.displayRouter=router;window.verifyDisplayUser=()=>apiClient.get('/api/auth/me',{noCache:true});createApp(AdminLayout).use(router).use(ElementPlus).mount('#app');`;
  const bundle = await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
    name: "display-read-fixture", enforce: "pre", resolveId(source, importer) {
      if (source === "virtual:display-entry") return "\0display-entry";
      if (source === "virtual:display-auth") return "\0display-auth";
      if (!importer?.replaceAll("\\", "/").includes("frontend/admin")) return;
      const key = /stores\/auth(?:\.js)?$/.test(source) ? "auth" : /stores\/app(?:\.js)?$/.test(source) ? "app" : /stores\/workspaceTabs(?:\.js)?$/.test(source) ? "tabs" : source === "../router" ? "router"
        : /utils\/ai-variant-lab-window$/.test(source) ? "ai" : /api\/tools\/imageCropper$/.test(source) ? "upload" : /components\/(?:AppearanceSettings|EnterpriseMessenger|QuickToolsDialog)\.vue$/.test(source) ? "component" : null;
      if (key) return `\0display-${key}`;
    }, load(id) { if (id === "\0display-entry") return entry; if (id.startsWith("\0display-")) return mocks[id.slice("\0display-".length)]; }
  }], build: { write: false, cssCodeSplit: false, target: "esnext", rollupOptions: { input: "virtual:display-entry", output: { entryFileNames: "entry.js" } } } });
  const assets = new Map(bundle.output.map(row => [row.fileName, row.type === "asset" ? row.source : row.code]));
  const css = [...assets.keys()].find(name => name.endsWith(".css"));
  const artifacts = path.resolve(".verification/display-polling");
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const user = { id: 7, name: "验收负责人", roles: ["operations"], tenant: { id: 2, slug: "display-fixture", role: "owner", access_allowed: true,
    subscription_status: "active", subscription_expires_at: "2027-01-01T00:00:00Z" } };
  const calls = [], failures = [], errors = [];
  let revision = "r1", building = true, denied = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => failures.push({ url: request.url(), reason: request.failure()?.errorText }));
    await page.clock.install({ time: new Date("2026-11-27T12:00:00Z") });
    await page.addInitScript(value => {
      window.initialUser = value;
      let hidden = false;
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      window.setDisplayHidden = value => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); };
    }, user);
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, "http://localhost:8788", "the fixture cannot contact production or external services");
      if (url.pathname.startsWith("/api/")) {
        assert.equal(request.method(), "GET", "display QA cannot start a business task or mutate data");
        const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), bytes: 0, status: 200 }; calls.push(call);
        let response;
        if (url.pathname === "/api/system-notifications") {
          response = url.searchParams.has("summaryOnly") ? { unread: 1, total: 1, revision: "n1", summary_only: true }
            : url.searchParams.has("sinceRevision") ? { unread: 1, total: 1, revision: "n1", unchanged: true }
              : { unread: 1, total: 1, revision: "n1", rows: [{ id: 1, notification_type: "system", title: "验收通知", content: "仅展开后读取这段通知正文", status: "unread", severity: "info", created_at: "2026-11-27T12:00:00Z" }] };
        } else if (url.pathname === "/api/dashboard") {
          if (denied) { call.status = 403; response = { error: "Fixture dashboard authority revoked" }; }
          else {
            const snapshot = { status: building ? "building" : "snapshot", revision, date_key: "2026-11-27" };
            response = url.searchParams.has("statusOnly") ? { status_only: true, snapshot }
              : { snapshot, summary: {}, commerce: { today: { effective_revenue: 1000, profit: revision === "r1" ? 1234.56 : 1515.12 }, yesterday: {}, profit_trend: { month_total_profit: 2000 }, advertising: { today: {}, yesterday: {}, month: {} } }, alerts: { fbp: [], fbs: [], procurement: [] } };
          }
        } else if (url.pathname === "/api/auth/me") response = user;
        else if (["/api/online-products/limits", "/api/profit-ranking", "/api/fbp-opportunities"].includes(url.pathname)) response = { rows: [], summary: {} };
        else if (url.pathname === "/api/exchange-rates/tool/today") response = { public: { today: { business_date: "2026-11-27", available: true, rate: 12.5 } } };
        else if (url.pathname === "/api/system/update-status") response = { plugin: null };
        else throw Error(`Unexpected fixture API ${url.pathname}`);
        call.bytes = Buffer.byteLength(JSON.stringify(response));
        return route.fulfill({ status: call.status, json: response });
      }
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      const asset = assets.get(url.pathname.slice(1)); assert.notEqual(asset, undefined, url.pathname);
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: asset });
    });
    const settle = async () => { await new Promise(resolve => setTimeout(resolve, 40)); await page.clock.runFor(40); };
    const coreCount = () => calls.filter(call => call.path === "/api/dashboard").length;
    const fullCount = () => calls.filter(call => call.path === "/api/dashboard" && !call.query.statusOnly).length;
    const notificationCount = () => calls.filter(call => call.path === "/api/system-notifications").length;
    await page.goto("http://localhost:8788/admin.html");
    await page.locator(".profit-card strong").getByText("CNY 1,235", { exact: true }).waitFor();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100)); await settle();
    assert.equal(fullCount(), 1);
    assert.ok(calls.filter(call => call.path === "/api/system-notifications").every(call => call.query.summaryOnly === "1"));
    const layout = () => page.locator(".commerce-dashboard .hero-core-grid").evaluateAll(nodes => nodes.map(node => ({ classes: node.className, width: Math.round(node.getBoundingClientRect().width), children: node.children.length })));
    const beforeLayout = await layout();
    await page.screenshot({ path: path.join(artifacts, "dashboard-initial.png"), fullPage: true, animations: "disabled" });
    await page.clock.runFor(1600); await settle(); assert.equal(fullCount(), 1);
    assert.ok(calls.some(call => call.path === "/api/dashboard" && call.query.statusOnly === "1"));
    revision = "r2"; building = false;
    await page.clock.runFor(1600); await settle();
    await page.locator(".profit-card strong").getByText("CNY 1,515", { exact: true }).waitFor();
    assert.equal(fullCount(), 2); assert.deepEqual(await layout(), beforeLayout);
    await page.getByRole("button", { name: "消息通知", exact: true }).click(); await settle();
    const drawer = page.getByRole("dialog", { name: "消息通知", exact: true });
    await drawer.getByText("仅展开后读取这段通知正文", { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path === "/api/system-notifications").at(-1).query.summaryOnly, undefined);
    await page.screenshot({ path: path.join(artifacts, "notification-open.png"), fullPage: true, animations: "disabled" });
    await page.clock.fastForward(60000); await settle();
    assert.equal(calls.filter(call => call.path === "/api/system-notifications").at(-1).query.sinceRevision, "n1");
    assert.equal(await drawer.getByText("仅展开后读取这段通知正文", { exact: true }).count(), 1);
    await drawer.locator(".el-drawer__close-btn").click(); await page.clock.runFor(300); await settle();
    assert.equal(calls.filter(call => call.path === "/api/system-notifications").at(-1).query.summaryOnly, "1");
    await page.evaluate(() => window.setDisplayHidden(true));
    const hiddenCore = coreCount(), hiddenNotifications = notificationCount();
    await page.clock.fastForward(120000); await settle();
    assert.equal(coreCount(), hiddenCore); assert.equal(notificationCount(), hiddenNotifications);
    await page.evaluate(() => window.setDisplayHidden(false)); await settle();
    assert.equal(coreCount(), hiddenCore + 1); assert.equal(notificationCount(), hiddenNotifications + 1);
    const activeCore = coreCount();
    await page.evaluate(() => window.displayRouter.push("/inventory/products")); await settle();
    await page.getByTestId("inactive-page").waitFor();
    await page.clock.fastForward(60000); await settle(); assert.equal(coreCount(), activeCore);
    await page.evaluate(() => window.displayRouter.push("/dashboard")); await settle();
    assert.equal(coreCount(), activeCore + 1); assert.deepEqual(await layout(), beforeLayout);
    denied = true;
    await page.evaluate(() => window.dispatchEvent(new Event("erp:auth-verified"))); await settle();
    const rejectedCore = coreCount(); assert.ok(calls.some(call => call.path === "/api/dashboard" && call.status === 403));
    await page.clock.fastForward(120000); await settle();
    await page.evaluate(() => window.setDisplayHidden(true)); await page.evaluate(() => window.setDisplayHidden(false)); await settle();
    assert.equal(coreCount(), rejectedCore, "visibility cannot clear a forbidden dashboard scope");
    denied = false;
    await page.evaluate(() => window.verifyDisplayUser()); await page.clock.runFor(300); await settle();
    assert.equal(coreCount(), rejectedCore + 1);
    assert.deepEqual(await layout(), beforeLayout);
    await page.screenshot({ path: path.join(artifacts, "dashboard-resumed.png"), fullPage: true, animations: "disabled" });
    assert.deepEqual(errors, []);
    assert.ok(failures.every(failure => /ERR_ABORTED/.test(failure.reason || "")), JSON.stringify(failures));
    await fs.writeFile(path.join(artifacts, "network-summary.json"), JSON.stringify({ ok: true, mocked_origin: "http://localhost:8788", production_requests: 0, business_mutations: 0,
      simulated_visibility: true, keep_alive: true, layout_unchanged: true, calls, page_errors: errors, request_failures: failures }, null, 2) + "\n", "utf8");
  } finally { await browser.close(); }
});
