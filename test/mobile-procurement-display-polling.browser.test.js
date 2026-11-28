import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';

test('real mobile procurement tabs paginate safely and pause hidden, inactive and unauthorized display reads', {
  skip: process.env.RUN_TASK_BROWSER_TESTS !== '1', timeout: 180000
}, async () => {
  const entry = `import{createApp,h}from'vue';import{createPinia}from'pinia';import{createRouter,createMemoryHistory,RouterView}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import Layout from'/frontend/admin/layouts/MobileLayout.vue';import Queue from'/frontend/admin/components/mobile/MobileWorkQueue.vue';import{useAuthStore}from'/frontend/admin/stores/auth.js';import{setAuthToken,currentApiCacheScope,apiClient}from'/frontend/admin/utils/api.js';
    const app=createApp({render:()=>h(RouterView)});app.use(createPinia());const auth=useAuthStore(),user={id:7,personId:7,name:'手机列表验收',roles:['procurement','packing'],tenant:{id:2,slug:'a',role:'member'}};auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('mobile-display-A');
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/mobile',component:Layout,children:[{path:'procurement',component:Queue,meta:{title:'手机采购'}},{path:'other',component:{render:()=>h('p',{'data-testid':'mobile-other'},'其他页面')},meta:{title:'其他页面'}}]}]});
    window.mobileDisplayRouter=router;window.verifyMobileDisplay=()=>apiClient.get('/api/auth/me',{noCache:true});window.changeMobileDisplayScope=()=>{auth.user={...user,tenant:{id:3,slug:'b',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('mobile-display-B');currentApiCacheScope();};await router.push('/mobile/procurement');await router.isReady();app.use(router).use(ElementPlus).mount('#app');`;
  const bundle = await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: 'error', plugins: [{
    name: 'mobile-display-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:mobile-display') return '\0mobile-display'; },
    load(id) { if (id === '\0mobile-display') return entry; },
    transform(code, id) {
      // Exercise the actual queue inside a persistent route cache without changing source UI.
      if (id.replaceAll('\\', '/').endsWith('/layouts/MobileLayout.vue')) return code.replace('<RouterView />', '<RouterView v-slot="{Component}"><KeepAlive><component :is="Component"/></KeepAlive></RouterView>');
    }
  }, vue()], build: { write: false, cssCodeSplit: false, target: 'esnext', rollupOptions: { input: 'virtual:mobile-display', output: { entryFileNames: 'entry.js' } } } });
  const assets = new Map(bundle.output.map(row => [row.fileName, row.type === 'asset' ? row.source : row.code]));
  const css = [...assets.keys()].find(name => name.endsWith('.css'));
  const artifacts = path.resolve('.verification/mobile-display-polling'); await fs.mkdir(artifacts, { recursive: true });
  const calls = [], errors = [];
  let warming = false, warmRemaining = 0, denied = false;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-11-28T04:00:00Z') });
    await page.addInitScript(() => {
      let hidden = false;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      window.setMobileDisplayHidden = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, 'http://localhost:8788', 'all requests must remain inside the isolated browser fixture');
      assert.equal(request.method(), 'GET', 'display QA must not execute business writes');
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"><div id="app"></div><script type="module" src="/entry.js"></script>` });
      if (url.pathname.startsWith('/api/')) {
        const query = Object.fromEntries(url.searchParams), scopeB = request.headers().authorization?.includes('mobile-display-B');
        const call = { path: url.pathname, query, bytes: 0, status: 200 }; calls.push(call);
        let response;
        const product = index => ({ id: (scopeB ? 201 : 101) + index, product_id: (scopeB ? 201 : 101) + index,
          name: `手机商品 ${(scopeB ? 201 : 101) + index}`, product_name: `手机商品 ${(scopeB ? 201 : 101) + index}`, inventory_number: `1-3-${index + 1}`, component_count: 0 });
        if (url.pathname === '/api/products') {
          const size = Number(query.pageSize || 20), start = (Number(query.page || 1) - 1) * size;
          response = { rows: Array.from({ length: 45 }, (_, i) => product(i)).slice(start, start + size), total: 45, page: Number(query.page), pageSize: size };
        } else if (url.pathname === '/api/inventory-workflow/alerts') {
          if (denied) { call.status = 403; response = { error: '手机列表权限已失效，请重新验证' }; }
          else {
            if (query.refresh === '1') warmRemaining = 1;
            const refreshing = warming || warmRemaining-- > 0, size = Number(query.pageSize || 20), start = (Number(query.page || 1) - 1) * size;
            response = { rows: Array.from({ length: 45 }, (_, i) => ({ ...product(i), workflow: { product_id: product(i).id, physical_recorded: 4, incoming: 2,
              supply_plan: { known: true, required_purchase: query.task === 'required' ? 2 : 0, optional_purchase: 3 } } })).slice(start, start + size),
              total: 45, page: Number(query.page), pageSize: size, snapshot: { available: true, stale: refreshing, refreshing, calculated_at: '2026-11-28T04:00:00Z' } };
          }
        } else if (url.pathname === '/api/inventory-workflow/purchase-arrivals') response = { rows: [{ ...product(0), id: 501,
          physical_quantity: 5, quantity: 5, status: 'pending_arrival', purchased_at: '2026-11-28 01:00:00', updated_at: '2026-11-28 01:00:00',
          order_no: 'MOBILE-FIXTURE', components: [] }], total: 1, page: 1, pageSize: Number(query.pageSize), days: [{ date: '2026-11-28', pending: 1, open: 1, arrived: 0 }], selected_day: '2026-11-28' };
        else if (url.pathname === '/api/auth/me') response = { id: 7, personId: 7, name: '手机列表验收', roles: ['procurement', 'packing'], tenant: { id: scopeB ? 3 : 2, slug: scopeB ? 'b' : 'a', role: 'member' } };
        else if (/^\/api\/products\/\d+\/image$/.test(url.pathname)) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#8baca1"/></svg>' });
        else throw Error(`Unexpected mobile display API ${url.pathname}`);
        call.bytes = Buffer.byteLength(JSON.stringify(response)); return route.fulfill({ status: call.status, json: response });
      }
      const asset = assets.get(decodeURIComponent(url.pathname.slice(1))); assert.notEqual(asset, undefined, `unexpected fixture resource ${url.pathname}`);
      return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: asset });
    });
    const settle = async () => { await new Promise(resolve => setTimeout(resolve, 40)); await page.clock.runFor(40); };
    const listCalls = () => calls.filter(call => ['/api/products', '/api/inventory-workflow/alerts', '/api/inventory-workflow/purchase-arrivals'].includes(call.path));
    const last = () => listCalls().at(-1);
    const nav = page.getByRole('navigation', { name: '库存任务', exact: true });
    await page.goto('http://localhost:8788/admin.html'); await page.locator('.mobile-record h3').getByText('手机商品 101', { exact: true }).waitFor();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100)); await settle();
    assert.equal(listCalls().length, 1); assert.equal(last().path, '/api/products'); assert.equal(last().query.includeStock, '0'); assert.equal(last().query.view, 'inventory');
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.locator('.mobile-record h3').getByText('手机商品 121', { exact: true }).waitFor();
    assert.equal(last().query.page, '2'); assert.equal(last().query.pageSize, '20');
    await page.getByRole('combobox', { name: '每页条数', exact: true }).selectOption('50'); await settle(); assert.equal(last().query.page, '1'); assert.equal(last().query.pageSize, '50');
    for (const [label, task] of [['必须采购', 'required'], ['保障补货', 'advisory']]) {
      await nav.getByRole('button', { name: label, exact: true }).click(); await settle();
      assert.equal(last().path, '/api/inventory-workflow/alerts'); assert.equal(last().query.task, task); assert.equal(last().query.compact, '1'); assert.equal(last().query.snapshot_only, '1');
      await page.locator('.mobile-work-queue').getByRole('button', { name: '刷新', exact: true }).click(); await settle(); assert.equal(last().query.refresh, '1');
      await page.clock.runFor(8000); await settle(); assert.equal(last().query.poll_snapshot, '1'); assert.equal(last().query.refresh, undefined);
      assert.ok(await page.locator('.mobile-record-grid').first().getByText('本地实物', { exact: false }).count());
    }
    await nav.getByRole('button', { name: '采购收货', exact: true }).click(); await settle(); assert.equal(last().query.status, 'pending'); assert.equal(last().query.day_mode, 'pending');
    await nav.getByRole('button', { name: '采购记录', exact: true }).click(); await settle(); assert.equal(last().query.status, 'all'); assert.equal(last().query.recent, '1'); assert.equal(last().query.day_mode, undefined);
    warming = true; await nav.getByRole('button', { name: '必须采购', exact: true }).click(); await settle();
    for (const width of [375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 }); await settle();
      assert.equal(await page.evaluate(() => [document.documentElement, document.body, document.querySelector('.mobile-work-queue')].every(el => el.scrollWidth <= el.clientWidth + 1)), true);
      await page.screenshot({ path: path.join(artifacts, `required-${width}.png`), animations: 'disabled' });
    }
    await page.evaluate(() => window.setMobileDisplayHidden(true)); const hiddenCount = listCalls().length;
    await page.clock.fastForward(120000); await settle(); assert.equal(listCalls().length, hiddenCount);
    warming = false; await page.evaluate(() => window.setMobileDisplayHidden(false)); await settle(); assert.equal(listCalls().length, hiddenCount + 1); assert.equal(last().query.refresh, undefined);
    warming = true; await page.locator('.mobile-work-queue').getByRole('button', { name: '查询', exact: true }).click(); await settle();
    await page.evaluate(() => window.mobileDisplayRouter.push('/mobile/other')); await page.getByTestId('mobile-other').waitFor(); const inactiveCount = listCalls().length;
    await page.clock.fastForward(120000); await settle(); assert.equal(listCalls().length, inactiveCount);
    warming = false; await page.evaluate(() => window.mobileDisplayRouter.push('/mobile/procurement')); await settle(); assert.equal(listCalls().length, inactiveCount + 1);
    denied = true; await page.locator('.mobile-work-queue').getByRole('button', { name: '查询', exact: true }).click(); await settle();
    await page.getByText('手机列表权限已失效，请重新验证', { exact: true }).waitFor(); const deniedCount = listCalls().length;
    await page.clock.fastForward(120000); await page.evaluate(() => window.setMobileDisplayHidden(true)); await page.evaluate(() => window.setMobileDisplayHidden(false)); await settle(); assert.equal(listCalls().length, deniedCount);
    denied = false; await page.evaluate(() => window.verifyMobileDisplay()); await page.clock.runFor(10); await settle(); assert.equal(listCalls().length, deniedCount + 1);
    await page.evaluate(() => window.verifyMobileDisplay()); await page.clock.runFor(10); await settle(); assert.equal(listCalls().length, deniedCount + 1);
    warming = true; await page.locator('.mobile-work-queue').getByRole('button', { name: '查询', exact: true }).click(); await settle();
    await page.evaluate(() => window.changeMobileDisplayScope()); const changedCount = listCalls().length;
    await page.clock.fastForward(24000); await settle(); assert.equal(listCalls().length, changedCount); assert.equal(await page.locator('.mobile-list-scroll>.mobile-record').count(), 0);
    warming = false; await page.evaluate(() => window.verifyMobileDisplay()); await page.clock.runFor(10); await settle();
    await page.locator('.mobile-record h3').getByText('手机商品 201', { exact: true }).waitFor(); assert.equal(listCalls().length, changedCount + 1);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(artifacts, 'network-summary.json'), JSON.stringify({ ok: true, synthetic_api: true, production_requests: 0, business_writes: 0,
      simulated_visibility: true, keep_alive: true, viewport_widths: [375,390,430], real_server_latency_measured: false,
      list_calls: listCalls(), page_errors: errors }, null, 2), 'utf8');
  } finally { await browser.close(); }
});
