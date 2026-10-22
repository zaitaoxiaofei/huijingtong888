import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

const enabled = process.env.RUN_ACCOUNT_HEADER_BROWSER_TESTS === "1";

// Bundle the actual layout and account controls. Only unrelated pages, stores
// and tools are replaced; all HTTP requests are intercepted without a listener.
test("account header supports avatars, Chinese logout and real membership states on desktop and dark mobile", { skip: !enabled, timeout: 180000 }, async () => {
  const mocks = {
    auth: `import {reactive} from 'vue'; import {apiClient,currentApiCacheScope} from '/frontend/admin/utils/api.js';
      export const auth=reactive({user:window.initialUser,async logout(){await apiClient.post('/api/auth/logout',{});this.user=null;},async verifySession(){const user=await apiClient.get('/api/auth/me',{routeScoped:false,noCache:true});this.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));currentApiCacheScope();return user;}});export const useAuthStore=()=>auth;`,
    app: `import{reactive}from'vue';const state=reactive({sidebarCollapsed:false,densityMode:'standard',toggleSidebar(){this.sidebarCollapsed=!this.sidebarCollapsed;},setDensityMode(value){this.densityMode=value;}});export const useAppStore=()=>state;`,
    tabs: `export const useWorkspaceTabsStore=()=>({tabs:[],activeKey:'',restoreTabs(){},openRoute(){},findTab(){},tabKeyForRoute(route){return route.path;},refreshToken:0});`,
    navigation: `export const navigationMenus=[];export const navigationMenusForRole=()=>[];`,
    router: `export const prefetchRouteComponent=()=>{};`,
    ai: `export const openAiEcommerceSuiteWindow=()=>{};export const openAiProductMaterialOptimizerWindow=()=>{};export const openAiVariantLabWindow=()=>{};`,
    upload: `export const uploadListingMedia=()=>{throw new Error('unused fixture upload');};`,
    component: `export default{render(){return null;}};`
  };
  const entry = `import{createApp}from'vue';import{createRouter,createMemoryHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import AdminLayout from'/frontend/admin/layouts/AdminLayout.vue';import{auth}from'virtual:account-auth';import{currentApiCacheScope}from'/frontend/admin/utils/api.js';import{applyAppearancePreferences}from'/frontend/admin/utils/theme-presets.js';
    localStorage.setItem('authToken','account-header-fixture');localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));currentApiCacheScope();
    const routes=['/dashboard','/membership','/login'].map(path=>({path,component:{template:'<div>Fixture page</div>'},meta:{breadcrumb:['工作台']}}));const router=createRouter({history:createMemoryHistory(),routes});const app=createApp(AdminLayout).use(router).use(ElementPlus);await router.push('/membership');await router.isReady();
    window.setFixtureUser=user=>{auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));currentApiCacheScope();};window.fixtureAuth=auth;window.fixtureRouter=router;window.setFixtureTheme=mode=>applyAppearancePreferences({version:1,mode,palettes:{light:'violet',dark:'violet'}},document);window.setFixtureTheme('light');app.mount('#app');`;
  const bundle = await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
    name: "account-header-fixture",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "virtual:account-header") return "\0account-header-entry";
      if (source === "virtual:account-auth") return "\0account-header-auth";
      if (!importer?.replaceAll("\\", "/").includes("frontend/admin")) return;
      const key = /stores\/auth(?:\.js)?$/.test(source) ? "auth" : /stores\/app(?:\.js)?$/.test(source) ? "app" : /stores\/workspaceTabs(?:\.js)?$/.test(source) ? "tabs"
        : /constants\/navigation\.js$/.test(source) ? "navigation" : source === "../router" ? "router"
          : /utils\/ai-variant-lab-window$/.test(source) ? "ai" : /api\/tools\/imageCropper$/.test(source) ? "upload"
            : /components\/(?:AppearanceSettings|EnterpriseMessenger|QuickToolsDialog)\.vue$/.test(source) ? "component" : null;
      if (key) return `\0account-header-${key}`;
    },
    load(id) { if (id === "\0account-header-entry") return entry; if (id.startsWith("\0account-header-")) return mocks[id.slice("\0account-header-".length)]; }
  }], build: { write: false, cssCodeSplit: false, target: "esnext", rollupOptions: { input: "virtual:account-header", output: { entryFileNames: "entry.js" } } } });
  const assets = new Map(bundle.output.map(item => [item.fileName, item.type === "asset" ? item.source : item.code]));
  const css = [...assets.keys()].find(file => file.endsWith(".css"));
  const artifactDirectory = path.resolve(process.env.ACCOUNT_HEADER_ARTIFACT_DIR || path.join(os.tmpdir(), "ozon-account-header-ui"));
  await fs.mkdir(artifactDirectory, { recursive: true });
  const executablePath = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : "/usr/bin/chromium");
  const browser = await chromium.launch({ executablePath, headless: true });
  const expiry = new Date(Date.now() + 5 * 86400000).toISOString();
  const activeUser = { id: 81, name: "小单同学", username: "header-fixture", roles: ["operator"], tenant: { id: 18, name: "演示企业", role: "owner", status: "active", subscription_status: "active", subscription_expires_at: expiry, access_allowed: true } };
  const errors = [], calls = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    await page.addInitScript(user => { window.initialUser = user; }, activeUser);
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, "http://localhost:8788");
      if (url.pathname.startsWith("/api/")) {
        calls.push({ path: url.pathname, method: route.request().method(), body: route.request().postDataJSON() });
        let body;
        if (url.pathname === "/api/auth/me") body = activeUser;
        else if (url.pathname === "/api/auth/activate") body = { ok: true, membership: { tenant_id: 18, status: "active", expires_at: expiry, access_allowed: true } };
        else if (url.pathname === "/api/auth/logout") body = { ok: true };
        else if (url.pathname === "/api/system-notifications") body = { rows: [], unread: 0 };
        else throw new Error(`Unexpected API ${url.pathname}`);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      }
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      const body = assets.get(url.pathname.slice(1));
      assert.notEqual(body, undefined, `fixture asset ${url.pathname}`);
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body });
    });
    await page.goto("http://localhost:8788/admin.html");
    const account = page.getByRole("button", { name: "小单同学，打开账户菜单" });
    try { await account.waitFor(); } catch (failure) { throw new Error(`${failure.message}\nRuntime: ${errors.join("; ")}\nBody: ${await page.locator("body").innerText()}`); }
    assert.match(await page.locator(".erp-membership-chip").innerText(), /会员剩余 [45] 天/);
    assert.equal(await page.getByText("Logout", { exact: true }).count(), 0);
    await account.click();
    await page.getByRole("menuitem", { name: "个人资料", exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifactDirectory, "header-light-desktop.png"), fullPage: true });
    await page.getByRole("menuitem", { name: "个人资料", exact: true }).click();
    const profile = page.getByRole("dialog", { name: /个人资料/ });
    await profile.waitFor();
    assert.equal(await profile.getByPlaceholder("请输入姓名").inputValue(), "小单同学");
    await page.keyboard.press("Escape");
    await account.click();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "退出登录", exact: true });
    await confirmation.waitFor();
    assert.equal(await confirmation.getByText("确定要退出当前账户吗？").count(), 1);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(calls.filter(call => call.path === "/api/auth/logout").length, 0);

    await page.evaluate(user => window.setFixtureUser(user), { ...activeUser, tenant: { ...activeUser.tenant, subscription_status: "unactivated", subscription_expires_at: null, access_allowed: false } });
    await page.locator(".erp-membership-chip").getByText("待激活会员").waitFor();
    assert.equal(await page.getByRole("button", { name: "消息通知" }).count(), 0);
    await account.click();
    await page.getByRole("menuitem", { name: "个人资料", exact: true }).click();
    await profile.waitFor();
    assert.equal(await profile.locator("button[title='更换头像']").isDisabled(), true, "unactivated profile cannot initiate a paid media upload");
    assert.equal(await profile.locator("input[type='file']").isDisabled(), true, "the upload input is also disabled");
    assert.equal(await profile.getByText("激活会员后可上传头像", { exact: true }).count(), 1);
    assert.equal(await profile.getByPlaceholder("请输入姓名").isEditable(), true, "nickname remains editable without activation");
    assert.equal(await profile.getByPlaceholder("修改密码时请输入当前密码").isEditable(), true, "password controls remain editable without activation");
    await page.keyboard.press("Escape");
    await profile.waitFor({ state: "hidden" });
    await page.locator(".erp-membership-chip").click();
    const activation = page.getByRole("dialog", { name: "激活 / 续期会员", exact: true });
    await activation.waitFor();
    await activation.getByPlaceholder("请输入会员激活码").fill(" BD-FIXTURE-CODE ");
    await activation.getByRole("button", { name: "激活会员", exact: true }).click();
    await activation.waitFor({ state: "hidden" });
    assert.deepEqual(calls.find(call => call.path === "/api/auth/activate").body, { activation_code: "BD-FIXTURE-CODE" });
    assert.match(await page.locator(".erp-membership-chip").innerText(), /会员剩余 [45] 天/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.setFixtureTheme("dark"));
    await account.click();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "mobile header stays inside the viewport");
    const dropdown = await page.locator(".erp-account-dropdown").boundingBox();
    assert.ok(dropdown.x >= 0 && dropdown.x + dropdown.width <= 391, "account dropdown stays inside the mobile viewport");
    await page.locator(".el-message").waitFor({ state: "hidden" });
    await page.screenshot({ path: path.join(artifactDirectory, "header-dark-mobile.png"), fullPage: true });
    await page.mouse.click(12, 80);
    await page.locator(".erp-account-dropdown").waitFor({ state: "hidden" });

    await page.evaluate(() => window.setFixtureUser({ id: 99, name: "平台管理员", username: "platform", roles: [], platform_role: "super_admin", tenant: null }));
    assert.equal(await page.locator(".erp-membership-chip").count(), 0);
    await page.getByRole("button", { name: "平台管理员，打开账户菜单" }).click();
    await page.getByText("平台管理账户", { exact: true }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "激活会员", exact: true }).count(), 0);
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await confirmation.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.waitForFunction(() => window.fixtureAuth.user === null);
    assert.equal(calls.filter(call => call.path === "/api/auth/logout").length, 1);
    assert.deepEqual(errors, [], "actual account controls produce no runtime errors");
    console.log(`Account header screenshot: ${path.join(artifactDirectory, "header-dark-mobile.png")}`);
  } finally { await browser.close(); }
});
