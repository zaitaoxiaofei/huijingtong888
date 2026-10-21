import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("private messages preserve failed drafts, retry safely, paginate concurrent messages and clear account scope", {
  skip: process.env.RUN_ENTERPRISE_MESSAGES_BROWSER_TESTS !== "1", timeout: 120000
}, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "enterprise-messenger-browser-"));
  let browser, lateThread;
  const errors = [], sends = [], reads = [], threadRequests = [];
  const peers = [{ id: 2, name: "同事乙" }, { id: 3, name: "同事丙" }];
  const rows = [{ id: 4, sender_id: 1, recipient_id: 2, text: "旧的已发消息", created_at: "2026-10-21T00:00:00Z" },
    { id: 5, sender_id: 2, recipient_id: 1, text: "历史 <script>window.chatInjected=true</script>", created_at: "2026-10-21T01:00:00Z" }];
  const entry = `import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';
    import {createRouter,createWebHashHistory} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';
    import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';
    import Messenger from '/frontend/admin/components/EnterpriseMessenger.vue';import Tools from '/frontend/admin/components/QuickToolsDialog.vue';
    import {useAuthStore} from '/frontend/admin/stores/auth.js';import {applyAppearancePreferences} from '/frontend/admin/utils/theme-presets.js';
    const pinia=createPinia();const auth=useAuthStore(pinia);const scope=ref(0);
    auth.applyLoginResult({token:'fixture-a',user:{id:1,name:'我',roles:['operations'],tenant:{id:1,name:'企业甲',slug:'default'}}});
    window.switchChatScope=()=>{auth.applyLoginResult({token:'fixture-b',user:{id:7,name:'另一用户',roles:['operations'],tenant:{id:2,name:'企业乙',slug:'b'}}});scope.value++};
    window.chatTheme=(mode,palette)=>applyAppearancePreferences({version:1,mode,palettes:{[mode]:palette}},document);
    const router=createRouter({history:createWebHashHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]});
    createApp({setup(){const visible=ref(false);return()=>h('main',[h('h1','原业务页面'),h(Messenger,{key:scope.value}),h('button',{id:'calculator',onClick:()=>visible.value=true},'简易计算器'),h(Tools,{key:scope.value,tool:'calculator',modelValue:visible.value,'onUpdate:modelValue':v=>visible.value=v})])}}).use(pinia).use(router).use(ElementPlus).mount('#app');`;
  try {
    await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
      name: "enterprise-messenger-fixture", resolveId(id) { if (id === "virtual:enterprise-messenger") return "\0enterprise-messenger"; },
      load(id) { if (id === "\0enterprise-messenger") return entry; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: "virtual:enterprise-messenger", output: { entryFileNames: "entry.js" } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
    const css = (await fs.readdir(path.join(output, "assets"))).find(name => name.endsWith(".css"));
    let failFirstSend = true, failFirstRead = true, holdPeerThree = false;
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://localhost:8788") return route.abort();
      if (url.pathname.startsWith("/api/enterprise/messages/")) {
        const b = request.method() === "POST" ? request.postDataJSON() : null;
        const secondCompany = request.headers().authorization === "Bearer fixture-b";
        const endpoint = url.pathname.split("/").at(-1);
        if (endpoint === "unread") return route.fulfill({ json: { unread_count: 1 } });
        if (endpoint === "contacts") return route.fulfill({ json: { rows: secondCompany ? [{ id: 8, name: "新企业同事" }] : peers } });
        if (endpoint === "conversations") return route.fulfill({ json: { rows: secondCompany ? [] : peers.map(peer => ({ peer, last_message: { text: "会话摘要" }, unread_count: peer.id === 2 ? 1 : 0 })) } });
        if (endpoint === "thread") {
          threadRequests.push(url.search);
          if (holdPeerThree && url.searchParams.get("peer_id") === "3") {
            await new Promise(resolve => { lateThread = resolve; });
            return route.fulfill({ json: { rows: [{ id: 99, sender_id: 3, recipient_id: 1, text: "迟到的丙私信", created_at: "2026-10-21T00:00:00Z" }], has_more: false } }).catch(() => {});
          }
          const selected = secondCompany || url.searchParams.get("peer_id") !== "2" ? [] : rows.filter(row => !url.searchParams.has("after_id") || row.id > Number(url.searchParams.get("after_id")));
          return route.fulfill({ json: { rows: selected, has_more: false } });
        }
        if (endpoint === "read") {
          reads.push(b);
          if (failFirstRead) { failFirstRead = false; return route.fulfill({ status: 503, json: { error: "模拟已读确认失败" } }); }
          return route.fulfill({ json: { ok: true, updated_count: b.message_ids.length, unread_count: 0 } });
        }
        if (endpoint === "send") {
          sends.push(b);
          if (failFirstSend) { failFirstSend = false; return route.fulfill({ status: 503, json: { error: "模拟发送失败，请重试" } }); }
          rows.push({ id: 6, sender_id: 2, recipient_id: 1, text: "发送期间收到的消息", created_at: "2026-10-21T02:00:00Z" });
          const message = { id: 7, sender_id: 1, recipient_id: b.peer_id, text: b.text, reference: { type: "procurement", id: 81, label: "采购需求 #81", route: "/procurement/workspace?message_request_id=81", available: true }, created_at: "2026-10-21T02:01:00Z" };
          rows.push(message); return route.fulfill({ json: { message, duplicate: false } });
        }
        if (endpoint === "reference") return route.fulfill({ json: { reference: { type: "procurement", id: 81, available: true }, record: { id: 81, product_name: "已取消的采购需求商品", quantity: 20, status: "cancelled", note: "保留历史以便追踪", created_at: "2026-10-21T00:00:00Z" } } });
        if (endpoint === "references") return route.fulfill({ json: { rows: [] } });
        throw new Error(`Unexpected message API ${endpoint}`);
      }
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<link rel="stylesheet" href="/assets/${css}"><div id="app"></div><script type="module" src="/entry.js"></script>` });
      const file = path.resolve(output, `.${url.pathname}`); assert.ok(file.startsWith(path.resolve(output) + path.sep));
      return route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    const originalUrl = "http://localhost:8788/admin.html#/orders";
    await page.goto(originalUrl);
    await page.getByRole("button", { name: "企业私信", exact: true }).click();
    await page.getByRole("button", { name: /同事乙/ }).click();
    await page.getByText("历史 <script>window.chatInjected=true</script>", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.chatInjected), undefined);
    assert.match(await page.locator(".messenger-message > small").last().innerText(), /09:00:00/);
    await page.waitForFunction(() => !document.querySelector('.messenger-message .el-loading-mask'));
    assert.deepEqual(reads[0], { peer_id: 2, message_ids: [5] });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(() => document.querySelector('.messenger-message__bubble'));
    for (let attempt = 0; attempt < 40 && reads.length < 2; attempt++) await page.waitForTimeout(25);
    assert.ok(reads.length >= 2 && reads[1].message_ids.includes(5), "a failed read receipt retries already rendered IDs even with an empty incremental page");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("erp:open-private-message", { detail: { reference: { type: "order", id: 90, label: "订单测试90" } } })));
    await page.getByText("订单测试90", { exact: true }).waitFor();
    const input = page.getByRole("textbox", { name: "私信内容", exact: true });
    await input.fill("采购20件，请核对订单"); await page.getByRole("button", { name: "发送私信", exact: true }).click();
    await page.getByText("模拟发送失败，请重试", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "采购20件，请核对订单");
    await page.getByRole("button", { name: "发送私信", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.messenger-composer textarea')?.value === '');
    assert.equal(sends.length, 2); assert.equal(sends[0].client_message_id, sends[1].client_message_id);
    assert.deepEqual(sends[1].reference, { type: "order", id: 90 });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByText("发送期间收到的消息", { exact: true }).waitFor();
    assert.ok(threadRequests.some(q => q.includes("after_id=5")), "outgoing acknowledgement must not skip a concurrent incoming message");
    assert.ok(reads.some(read => read.message_ids.includes(6)));
    assert.ok(reads.every(read => !read.message_ids.includes(4) && !read.message_ids.includes(7)), "only received, rendered IDs are marked read");
    await page.getByRole("button", { name: "采购需求 #81", exact: false }).click();
    const detail = page.getByRole("dialog", { name: "引用的采购需求", exact: true });
    await detail.getByText("已取消的采购需求商品", { exact: true }).waitFor();
    await detail.getByText("已取消", { exact: true }).waitFor();
    await page.keyboard.press("Escape"); await detail.waitFor({ state: "hidden" });
    assert.ok(await page.getByRole("dialog", { name: "企业私信", exact: true }).isVisible());
    holdPeerThree = true;
    await page.getByRole("button", { name: /同事丙/ }).click();
    await page.getByRole("button", { name: /同事乙/ }).click();
    lateThread?.(); await page.waitForTimeout(150);
    assert.equal(await page.getByText("迟到的丙私信", { exact: true }).count(), 0);
    await input.fill("不能带到另一企业的草稿");
    await page.evaluate(() => window.switchChatScope());
    await page.getByRole("dialog", { name: "企业私信", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "企业私信", exact: true }).click();
    assert.equal(await page.getByText("不能带到另一企业的草稿", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /同事乙/ }).count(), 0);
    await page.keyboard.press("Escape");
    await page.locator("#calculator").click();
    const calculator = page.getByRole("dialog", { name: "简易计算器", exact: true });
    await calculator.getByRole("textbox", { name: "计算算式" }).fill("20 × 18.5 + 12");
    await calculator.getByRole("textbox", { name: "计算算式" }).press("Enter");
    await calculator.getByText("= 382", { exact: true }).waitFor();
    await calculator.getByRole("button", { name: "3", exact: true }).click();
    assert.equal(await calculator.getByText("= 382", { exact: true }).count(), 0, "editing with calculator keys clears the previous result");
    for (const mode of ["light", "dark"]) {
      await page.evaluate(mode => window.chatTheme(mode, "violet"), mode);
      const color = await calculator.locator(".quick-calculator__keys button").first().evaluate(el => getComputedStyle(el).backgroundColor);
      assert.notEqual(color, "rgba(0, 0, 0, 0)");
    }
    await page.keyboard.press("Escape"); await calculator.waitFor({ state: "hidden" }); assert.equal(page.url(), originalUrl);
    assert.deepEqual(errors, []);
  } finally {
    lateThread?.(); await browser?.close();
    assert.ok(path.resolve(output).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(output, { recursive: true, force: true });
  }
});
