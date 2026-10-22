import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("registration, member redemption and platform voucher UI preserve account scope", {
  skip: process.env.RUN_ONBOARDING_BROWSER_TESTS !== "1", timeout: 120000
}, async () => {
  const entry = `import {createApp,h,ref,KeepAlive} from 'vue';import {createPinia} from 'pinia';
    import {createRouter,createWebHashHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';
    import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';
    import Login from '/frontend/admin/views/LoginView.vue';import Membership from '/frontend/admin/views/MembershipView.vue';
    import Vouchers from '/frontend/admin/components/SubscriptionVouchersPanel.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {getAuthToken} from '/frontend/admin/utils/api.js';
    const pinia=createPinia();const auth=useAuthStore(pinia);
    const plans=[{code:'monthly',name:'月卡',duration_days:30,active:1}];
    const router=createRouter({history:createWebHashHistory(),routes:[{path:'/login',component:Login},{path:'/membership',component:Membership},
      {path:'/vouchers',component:{setup(){const visible=ref(true);window.fixtureVoucherVisible=value=>visible.value=value;return()=>h(KeepAlive,null,{default:()=>visible.value?h(Vouchers,{plans}):null})}}},{path:'/:pathMatch(.*)*',component:{render:()=>h('p','基础工具')}}]});
    window.fixtureGo=path=>router.push(path);
    window.fixtureToken=getAuthToken;
    window.fixtureAccount=(platform=false)=>auth.applyLoginResult({token:platform?'fixture-platform':'fixture-other',user:{id:platform?2:3,name:'测试账户',roles:['operator'],platform_role:platform?'super_admin':null,tenant:{id:platform?8:9,name:'独立空间',role:'owner',subscription_status:'active',access_allowed:true,subscription_expires_at:'2026-11-21T00:00:00Z'}}});
    createApp({render:()=>h(RouterView)}).use(pinia).use(router).use(ElementPlus).mount('#app');`;
  const bundle = await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
    name: "account-onboarding-fixture", resolveId(id) { if (id === "virtual:onboarding") return "\0onboarding"; },
    load(id) { if (id === "\0onboarding") return entry; }
  }], build: { write: false, cssCodeSplit: false, rollupOptions: { input: "virtual:onboarding", output: { entryFileNames: "entry.js" } } } });
  const assets = new Map(bundle.output.map(item => [item.fileName, item.type === "asset" ? item.source : item.code]));
  const stylesheet = [...assets.keys()].find(name => name.endsWith(".css"));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(12000);
    const errors = [], registrations = [], activations = [], vouchers = [];
    let active = false, deliverQr, holdVoucher = false, releaseVoucher;
    const code = `BD-${"A".repeat(48)}`;
    const tenant = () => ({ id: 8, name: "小林的团队", role: "owner", subscription_status: active ? "active" : "unactivated", access_allowed: active,
      subscription_expires_at: active ? "2026-11-21T00:00:00Z" : null });
    const user = () => ({ id: 1, name: "小林", username: "new-operator", roles: ["operator"], tenant: tenant() });
    const membership = () => ({ tenant_id: 8, tenant_name: "小林的团队", status: tenant().subscription_status,
      expires_at: tenant().subscription_expires_at, access_allowed: active, can_activate: true });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://localhost:8788") return route.abort();
      if (url.pathname === "/api/auth/register") {
        registrations.push(request.postDataJSON());
        return route.fulfill({ json: { ok: true, token: "fixture-registered", user: user() } });
      }
      if (url.pathname === "/api/auth/qr/start") return route.fulfill({ json: { sid: "pending-qr", qrImageUrl: "/qr-image?sid=pending-qr" } });
      if (url.pathname === "/api/auth/qr/status") return new Promise(resolve => {
        deliverQr = async () => { await route.fulfill({ json: { status: "confirmed", token: "stale-qr-account", user: { ...user(), id: 99 }, redirect: "/dashboard" } }); resolve(); };
      });
      if (url.pathname === "/api/auth/me") return route.fulfill({ json: user() });
      if (url.pathname === "/api/auth/membership") return route.fulfill({ json: membership() });
      if (url.pathname === "/api/auth/activate") {
        const body = request.postDataJSON(); activations.push(body);
        if (body.activation_code !== code) return route.fulfill({ status: 400, json: { error: "激活码无效，请核对后重试" } });
        active = true; return route.fulfill({ json: { ok: true, membership: membership() } });
      }
      if (url.pathname === "/api/tenants/subscription-vouchers") {
        if (request.method() === "POST") {
          if (holdVoucher) await new Promise(resolve => { releaseVoucher = resolve; });
          const voucher = { id: 1, code_hint: code.slice(-6), plan_name: "月卡", duration_days: 30, status: "active", redeemable_until: "2026-11-21T00:00:00Z" };
          vouchers.push(voucher); return route.fulfill({ json: { ok: true, activation_code: code, voucher } });
        }
        return route.fulfill({ json: { rows: vouchers } });
      }
      if (url.pathname === "/api/auth/wechat/status") return route.fulfill({ json: { enabled: false } });
      if (url.pathname.startsWith("/api/")) throw new Error(`Unexpected API ${url.pathname}`);
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<link rel="stylesheet" href="/${stylesheet}"><div id="app"></div><script type="module" src="/entry.js"></script>` });
      const asset = assets.get(url.pathname.slice(1));
      if (asset === undefined) return route.abort();
      return route.fulfill({ body: asset, contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    await page.goto("http://localhost:8788/admin.html#/login");
    await page.getByRole("button", { name: "登录", exact: true }).focus();
    await page.getByRole("button", { name: "登录", exact: true }).press("Enter");
    await page.getByRole("button", { name: "扫码登录", exact: true }).click();
    for (let attempt = 0; !deliverQr && attempt < 80; attempt++) await page.waitForTimeout(25);
    assert.ok(deliverQr, "QR poll is in flight before opening registration");
    await page.getByRole("button", { name: "注册新账号", exact: true }).click();
    await page.getByPlaceholder("字母、数字、下划线或连字符").fill("new-operator");
    await page.getByPlaceholder("同事们怎么称呼你").fill("小林");
    await page.getByPlaceholder("选填，稍后也可以设置").fill("小林的团队");
    await page.getByPlaceholder("至少 8 位，不能只包含数字").fill("Fixture-safe-42");
    await page.getByPlaceholder("再次输入密码").fill("not-matching");
    await page.getByRole("button", { name: "注册并进入" }).click();
    await page.getByText("两次输入的密码不一致", { exact: true }).waitFor();
    assert.equal(registrations.length, 0);
    await page.getByPlaceholder("再次输入密码").fill("Fixture-safe-42");
    await page.getByRole("button", { name: "注册并进入" }).click();
    await page.getByRole("heading", { name: "待激活会员" }).waitFor();
    assert.equal(registrations.length, 1);
    const lateQrResponse = page.waitForResponse(response => response.url().includes("/api/auth/qr/status"));
    await deliverQr(); await lateQrResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => window.fixtureToken()), "fixture-registered", "stale QR confirmation cannot replace the registered account");
    assert.equal(registrations[0].enterprise_name, "小林的团队");
    assert.equal(await page.getByText("长期有效", { exact: true }).count(), 0);
    const input = page.getByPlaceholder("请输入会员激活码");
    await input.fill("wrong-code"); await page.getByRole("button", { name: "激活会员", exact: true }).click();
    await page.getByText("激活码无效，请核对后重试", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "wrong-code");
    await input.fill(code); await page.getByRole("button", { name: "激活会员", exact: true }).click();
    await page.getByRole("heading", { name: /会员剩余/ }).waitFor();
    assert.equal(activations.length, 2);
    assert.match(await page.locator(".membership-status dd").last().innerText(), /2026\/11\/21 08:00:00/);
    assert.equal(await input.inputValue(), "");
    await page.waitForFunction(() => !document.querySelector('.membership-activation-form .el-form-item')?.classList.contains('is-error'));
    if (process.env.ACCOUNT_ONBOARDING_ARTIFACT_DIR) {
      await fs.mkdir(process.env.ACCOUNT_ONBOARDING_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ACCOUNT_ONBOARDING_ARTIFACT_DIR, "membership-active.png"), fullPage: true });
    }
    await page.evaluate(() => { window.fixtureAccount(true); return window.fixtureGo("/vouchers"); });
    await page.locator(".vouchers-issue .el-select").click();
    await page.getByRole("option", { name: "月卡 · 30 天" }).click();
    await page.getByRole("button", { name: "生成激活码", exact: true }).click();
    await page.getByRole("dialog", { name: "激活码已生成" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "新生成的会员激活码" }).inputValue(), code);
    await page.evaluate(() => window.fixtureAccount(false));
    await page.getByRole("dialog", { name: "激活码已生成" }).waitFor({ state: "hidden" });
    assert.equal(await page.locator(".vouchers-panel").getByText("AAAAAA", { exact: true }).count(), 0);
    await page.evaluate(() => window.fixtureAccount(true));
    holdVoucher = true;
    await page.getByRole("button", { name: "生成激活码", exact: true }).click();
    for (let attempt = 0; !releaseVoucher && attempt < 80; attempt++) await page.waitForTimeout(25);
    assert.ok(releaseVoucher, "issuance is pending before KeepAlive deactivation");
    await page.evaluate(() => window.fixtureVoucherVisible(false));
    const lateVoucherResponse = page.waitForResponse(response => response.url().includes("/api/tenants/subscription-vouchers") && response.request().method() === "POST");
    releaseVoucher(); await lateVoucherResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.getByRole("dialog", { name: "激活码已生成" }).count(), 0, "deactivated issuance cannot reveal a code over another page");
    await page.evaluate(() => window.fixtureVoucherVisible(true));
    assert.equal(await page.getByRole("dialog", { name: "激活码已生成" }).count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.fixtureGo("/login"));
    await page.getByRole("button", { name: "还没有账号？免费注册" }).click();
    const dialog = page.getByRole("dialog", { name: "注册爆单 ERP" });
    await dialog.waitFor();
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, "registration dialog fits mobile viewport");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
