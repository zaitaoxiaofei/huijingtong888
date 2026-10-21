import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("workspace tabs render the confirmed route while navigation is pending and preserve cached forms and restored query tabs", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1" }, async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tabs-source-"));
  const layout = await fs.readFile("frontend/admin/layouts/AdminLayout.vue", "utf8");
  const routeView = layout.match(/<RouterView v-slot="\{ Component, route: currentRoute \}">[\s\S]*?<\/RouterView>/)?.[0];
  assert.ok(routeView, "exercise the actual layout's RouterView/KeepAlive template");
  const click = layout.match(/function handleTabClick\(key\) \{[\s\S]*?\n}/)?.[0];
  const close = layout.match(/async function handleTabClose\(key\) \{[\s\S]*?\n}/)?.[0];
  assert.ok(click && close, "exercise the actual close and select handlers");
  const fixture = `<script setup>
    import {KeepAlive,computed,watch} from 'vue';
    import {RouterView,useRoute,useRouter} from 'vue-router';
    import {useWorkspaceTabsStore} from '/frontend/admin/stores/workspaceTabs.js';
    const route=useRoute(),router=useRouter(),tabsStore=useWorkspaceTabsStore();
    tabsStore.restoreTabs(router);
    const workspaceTabs=computed(()=>tabsStore.tabs),activeTabKey=computed(()=>tabsStore.activeKey);
    const rememberIntendedRoute=()=>{},showRouteSwitching=()=>{},confirmClosingWorkbenchTabs=async()=>true;
    ${click}
    ${close}
    watch(()=>route.fullPath,()=>tabsStore.openRoute(route),{immediate:true});
    window.workspaceTabsStore=tabsStore;
  </script><template>
    <nav><div v-for="tab in workspaceTabs" :key="tab.key" class="fixture-tab" :data-key="tab.key" :data-active="tab.key===activeTabKey">
      <button type="button" class="select-tab" @click="handleTabClick(tab.key)">{{tab.title}}</button>
      <button v-if="tab.closable" type="button" class="close-tab" :aria-label="'Close '+tab.key" @click="handleTabClose(tab.key)">×</button>
    </div></nav>${routeView}
  </template>`;
  const entry = `import {createApp,h,defineComponent,ref} from 'vue';
    import {createPinia} from 'pinia';
    import {createRouter,createWebHashHistory,RouterView,useRoute} from 'vue-router';
    import Shell from '/WorkspaceTabsFixture.vue';
    window.workspaceMounts={};
    const page=label=>defineComponent({name:'Fixture'+label,setup(){
      const note=ref(''),route=useRoute();window.workspaceMounts[label]=(window.workspaceMounts[label]||0)+1;
      return()=>h('section',{'class':'fixture-page','data-page':label},[
        h('h2',label),h('input',{'aria-label':label+' note',value:note.value,onInput:event=>note.value=event.target.value}),
        h('pre',{'class':'route-context'},route.fullPath)]);
    }});
    const pages={dashboard:page('dashboard'),orders:page('orders'),procurement:page('procurement'),listing:page('listing'),editor:page('editor')};
    const router=createRouter({history:createWebHashHistory(),routes:[{path:'/',component:Shell,children:[
      {path:'',redirect:'/dashboard'},
      {path:'dashboard',component:()=>Promise.resolve(pages.dashboard),meta:{title:'Dashboard'}},
      {path:'orders',component:()=>Promise.resolve(pages.orders),meta:{title:'Orders'}},
      {path:'procurement',component:()=>Promise.resolve(pages.procurement),meta:{title:'Procurement'}},
      {path:'listing-automation',component:()=>Promise.resolve(pages.listing),meta:{title:'Listing',tabKey:'workbench'}},
      {path:'draft-editor',component:()=>Promise.resolve(pages.editor),meta:{title:'Editor',tabKey:'fullPath'}}
    ]}]});
    let holdPath='',resume=null;
    router.beforeEach(to=>{if(to.path!==holdPath)return;holdPath='';return new Promise(resolve=>{resume=resolve})});
    window.workspaceFixture={navigate:target=>router.push(target),hold:path=>{holdPath=path},
      get pending(){return Boolean(resume)},resume:()=>{const done=resume;resume=null;done?.()}};
    createApp({render:()=>h(RouterView)}).use(createPinia()).use(router).mount('#app');`;
  let server, browser;
  try {
    server = await createServer({ configFile: false, root: process.cwd(), cacheDir, logLevel: "error", appType: "custom",
      server: { middlewareMode: true, hmr: false }, optimizeDeps: { include: ["vue", "vue-router", "pinia", "@element-plus/icons-vue"] },
      plugins: [vue(), {
        name: "workspace-tabs-source-fixture",
        resolveId(id) { if (["/workspace-tabs-entry.js", "/WorkspaceTabsFixture.vue"].includes(id)) return id; },
        load(id) { if (id === "/workspace-tabs-entry.js") return entry; if (id === "/WorkspaceTabsFixture.vue") return fixture; }
      }]
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.route("http://localhost:8788/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="app"></div><script type="module" src="/workspace-tabs-entry.js"></script></body></html>' });
      assert.ok(!url.pathname.startsWith("/api/"), "this source-only routing fixture contacts no business API");
      const modulePath = url.pathname.startsWith("/@id/")
        ? decodeURIComponent(url.pathname.slice(5)).replace(/^__x00__/, "\0")
        : url.pathname;
      const transformed = await server.transformRequest(`${modulePath}${url.search}`);
      assert.ok(transformed, `Missing source module ${url.pathname}`);
      return route.fulfill({ contentType: "text/javascript", body: transformed.code });
    });
    const navigate = async target => {
      await page.evaluate(target => window.workspaceFixture.navigate(target), target);
      await page.locator(".route-context").filter({ hasText: target }).waitFor();
    };
    const selectTab = key => page.locator(`.fixture-tab[data-key=${JSON.stringify(key)}] .select-tab`);
    await page.goto("http://localhost:8788/admin.html#/dashboard");
    await page.getByRole("heading", { name: "dashboard", exact: true }).waitFor();
    await navigate("/orders");
    await page.getByLabel("orders note", { exact: true }).fill("unsaved order form");
    await navigate("/procurement");
    await page.getByLabel("procurement note", { exact: true }).fill("unsaved purchase form");
    await page.evaluate(() => window.workspaceFixture.hold("/orders"));
    await page.getByRole("button", { name: "Close /procurement", exact: true }).click();
    await page.waitForFunction(() => window.workspaceFixture.pending);
    await page.evaluate(() => window.workspaceFixture.resume());
    await page.waitForFunction(() => location.hash === "#/orders");
    await page.waitForFunction(() => document.querySelector(".route-context")?.textContent === "/orders");
    assert.deepEqual(errors, [], "closing a tab must not assign the old component to the neighbor's KeepAlive key");
    assert.equal(await page.locator(".fixture-page").getAttribute("data-page"), "orders", "closing the active procurement tab must never cache procurement under the orders key");
    assert.equal(await page.getByLabel("orders note", { exact: true }).inputValue(), "unsaved order form");
    assert.equal(await page.evaluate(() => window.workspaceMounts.orders), 1, "returning to the neighbor must reuse its form instance");
    await navigate("/procurement?status=open");
    await navigate("/orders?shopId=42");
    assert.equal(await page.getByLabel("orders note", { exact: true }).inputValue(), "unsaved order form", "path-keyed query updates preserve the cached page");
    await page.getByRole("button", { name: "Close /procurement", exact: true }).click();
    assert.equal(page.url().split("#")[1], "/orders?shopId=42", "closing an inactive tab leaves the current route unchanged");
    assert.equal(await page.getByLabel("orders note", { exact: true }).inputValue(), "unsaved order form");
    assert.deepEqual(errors, []);

    // A fresh app verifies real restoration and the existing workbench/fullPath identities.
    await page.evaluate(() => sessionStorage.clear());
    await page.goto("http://localhost:8788/admin.html?fixture=restore#/dashboard");
    await page.getByRole("heading", { name: "dashboard", exact: true }).waitFor();
    await navigate("/listing-automation?workbenchId=a&draftId=1&tabTitle=Draft+A");
    await page.getByLabel("listing note", { exact: true }).fill("workbench a form");
    await navigate("/listing-automation?workbenchId=b&draftId=2&tabTitle=Draft+B");
    await page.getByLabel("listing note", { exact: true }).fill("workbench b form");
    await selectTab("/listing-automation?workbenchId=a").click();
    await page.waitForFunction(() => location.hash.includes("draftId=1"));
    assert.equal(await page.getByLabel("listing note", { exact: true }).inputValue(), "workbench a form");
    await navigate("/draft-editor?recordId=1&tabTitle=Record+one");
    await page.getByLabel("editor note", { exact: true }).fill("record one form");
    await navigate("/draft-editor?recordId=2&tabTitle=Record+two");
    await page.getByLabel("editor note", { exact: true }).fill("record two form");
    await selectTab("/draft-editor?recordId=1").click();
    await page.waitForFunction(() => location.hash.includes("recordId=1"));
    assert.equal(await page.getByLabel("editor note", { exact: true }).inputValue(), "record one form");
    await page.reload();
    await page.getByRole("heading", { name: "editor", exact: true }).waitFor();
    assert.equal(await page.locator('.fixture-tab[data-active="true"]').getAttribute("data-key"), "/draft-editor?recordId=1");
    assert.equal(await page.locator(".fixture-tab").count(), 5);
    assert.equal(await page.locator(".fixture-tab").filter({ hasText: "Draft A" }).count(), 1);
    assert.equal(await page.locator(".fixture-tab").filter({ hasText: "Record one" }).count(), 1);
    assert.deepEqual(errors, []);

    // Restored tabs have no cached component until their first visit. This is
    // the cold-cache version of the URL/selected-tab versus visible-page bug.
    await page.evaluate(() => sessionStorage.setItem("ozon-admin-workspace-tabs", JSON.stringify({
      activeKey: "/procurement",
      tabs: [
        { title: "Dashboard", closable: false, pinned: true, route: { path: "/dashboard", fullPath: "/dashboard" } },
        { title: "Orders", closable: true, route: { path: "/orders", fullPath: "/orders?shopId=42" } },
        { title: "Procurement", closable: true, route: { path: "/procurement", fullPath: "/procurement" } }
      ]
    })));
    await page.goto("http://localhost:8788/admin.html?fixture=cold-tabs#/procurement");
    await page.getByRole("heading", { name: "procurement", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.workspaceMounts.orders || 0), 0);
    await page.evaluate(() => window.workspaceFixture.hold("/orders"));
    await page.getByRole("button", { name: "Close /procurement", exact: true }).click();
    await page.waitForFunction(() => window.workspaceFixture.pending);
    await page.evaluate(() => window.workspaceFixture.resume());
    await page.waitForFunction(() => location.hash === "#/orders?shopId=42");
    await page.waitForFunction(() => document.querySelector(".route-context")?.textContent === "/orders?shopId=42");
    assert.equal(await page.locator(".fixture-page").getAttribute("data-page"), "orders", "a restored, unvisited order tab must not display the previous procurement component");
    assert.equal(await page.locator('.fixture-tab[data-active="true"]').getAttribute("data-key"), "/orders");
    assert.equal(await page.evaluate(() => window.workspaceMounts.orders), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server?.close();
    assert.equal(path.dirname(path.resolve(cacheDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cacheDir).startsWith("workspace-tabs-source-"));
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
