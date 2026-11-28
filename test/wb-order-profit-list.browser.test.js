import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';

test('WB list explicitly recalculates single, current-page and selected profits without cross-platform or stale-tenant writes', {
  skip: process.env.RUN_TASK_BROWSER_TESTS !== '1', timeout: 180000
}, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-order-profit-list-'));
  const writes = [], reads = [], errors = [];
  let browser, releasePost, postHeld, holdPost = false, missingInputs = false, revision = 0;
  const row = (id, platform) => ({
    id, platform, shop_id: platform === 'wb' ? 20 : 30, shop_name: `${platform} 利润验证店铺`,
    posting_number: `${platform.toUpperCase()}-PROFIT-${id}`, status: 'awaiting_packaging',
    wb_supplier_status: 'new', wb_status: 'waiting', ordered_at: '2026-11-27T06:45:37Z',
    wb_amount_cny: platform === 'wb' ? 56.55 : null, revenue: 56.55, item_count: 1,
    skus: `SKU-${id}`, sku_names: `SKU-${id}:利润验证商品${id}`, sku_quantities: `SKU-${id}:1`,
    sku_order_item_ids: `SKU-${id}:${id * 100}`, sku_images: `SKU-${id}:/fixture-product.svg`,
    product_names: `利润验证商品${id}`, fulfillment_type_key: 'fbs', fulfillment_type_label: 'FBS',
    inventory_availability: [], wb_profit: null
  });
  const records = [row(17, 'wb'), row(18, 'wb'), row(19, 'ozon')];
  const entry = `
    import {createApp,h} from 'vue';import {createPinia} from 'pinia';
    import {createRouter,createWebHashHistory,RouterView} from 'vue-router';
    import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';
    import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';
    import OrdersPage from '/frontend/orders/OrdersPage.vue';
    import {useAuthStore} from '/frontend/admin/stores/auth.js';
    import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';
    const app=createApp({render:()=>h(RouterView)});app.use(createPinia()).use(ElementPlus);
    const auth=useAuthStore();
    const user={id:1,personId:1,roles:['operations'],tenant:{id:2,slug:'profit-a',role:'member'}};
    auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('wb-list-profit-fixture');currentApiCacheScope();
    window.setProfitTestRoles=roles=>{auth.user={...auth.user,roles};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));};
    window.switchProfitListTenant=()=>{const next={...auth.user,tenant:{id:3,slug:'profit-b',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(next));auth.user=next;setAuthToken('wb-list-profit-other-tenant');currentApiCacheScope();};
    const router=createRouter({history:createWebHashHistory(),routes:[{path:'/orders',component:OrdersPage,props:{platformTabs:true}}]});
    app.use(router);await router.isReady();app.mount('#app');
  `;
  try {
    await build({
      configFile: false, root: process.cwd(), publicDir: false, logLevel: 'error',
      plugins: [vue(), {
        name: 'wb-order-profit-list-fixture',
        resolveId(id) { if (id === 'virtual:wb-order-profit-list') return '\0wb-order-profit-list'; },
        load(id) { if (id === '\0wb-order-profit-list') return entry; }
      }],
      build: { outDir: output, cssCodeSplit: false,
        rollupOptions: { input: 'virtual:wb-order-profit-list', output: { entryFileNames: 'entry.js' } } }
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== 'http://localhost:8788') return route.abort();
      if (url.pathname === '/api/wb/orders/recalculate-profit') {
        assert.equal(request.method(), 'POST');
        const body = request.postDataJSON();
        writes.push({ path: url.pathname, body });
        assert.match(body.command_id, /^[0-9a-f-]{36}$/i, 'each deliberate recalculation has an idempotency command ID');
        assert.ok(body.order_ids.every(id => id === 17 || id === 18), 'Ozon orders never enter a WB recalculation');
        assert.equal(Object.hasOwn(body, 'tenant_id'), false, 'tenant comes from the authenticated server context');
        if (holdPost) {
          holdPost = false;
          postHeld();
          await new Promise(resolve => { releasePost = resolve; });
        }
        const results = body.order_ids.map(id => {
          const record = records.find(record => record.id === id);
          const pending = missingInputs && id === 18;
          record.wb_profit = { estimated_profit_cny: pending ? null : 24.57, provisional: true,
            calculated_at: '2026-11-28T03:00:00Z', revision_id: ++revision,
            missing_inputs: pending ? [{ field: 'purchaseCost', label: '采购成本' }] : [] };
          record.estimated_profit = record.wb_profit.estimated_profit_cny;
          return { order_id: id, status: pending ? 'needs_inputs' : 'saved', ...record.wb_profit,
            ...(pending ? { error: '请核对采购成本' } : {}) };
        });
        return route.fulfill({ json: { ok: true, updated_count: results.filter(result => result.status === 'saved').length, results } }).catch(() => {});
      }
      if (url.pathname.startsWith('/api/')) {
        assert.equal(request.method(), 'GET', 'initial reads and platform changes cannot perform background writes');
        reads.push(url.pathname + url.search);
        if (url.pathname === '/api/orders') {
          const platform = url.searchParams.get('platform');
          const secondTenant = request.headers().authorization?.includes('other-tenant');
          // The extra Ozon row deliberately tests a defensive boundary even if a list response is mixed.
          const rows = secondTenant ? [] : platform === 'ozon' ? records.filter(record => record.platform === 'ozon') : records;
          return route.fulfill({ json: { rows, total: rows.length, page: 1, pageSize: 20,
            counts: { all: rows.length, awaiting_packaging: rows.length } } });
        }
        if (url.pathname === '/api/wb/shops') return route.fulfill({ json: [{ id: 20, name: 'WB 利润验证店铺', platform: 'wb' }] });
        if (url.pathname === '/api/shops') return route.fulfill({ json: [{ id: 30, name: 'Ozon 利润验证店铺', platform: 'ozon' }] });
        if (url.pathname === '/api/orders/inventory-availability') return route.fulfill({ json: { rows: [] } });
        if (url.pathname === '/api/user-preferences') return route.fulfill({ json: { value: null } });
        return route.fulfill({ json: { rows: [], total: 0, products: [] } });
      }
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body{margin:0}#app{height:100vh}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === '/fixture-product.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#91a7ba"/></svg>' });
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      const file = url.pathname === '/style.css'
        ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css')))
        : decodeURIComponent(url.pathname.slice(1));
      const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript';
      return route.fulfill({ contentType, body: await fs.readFile(path.join(output, file)) });
    });
    await page.goto('http://localhost:8788/admin.html#/orders?platform=wb');
    const orderRow = id => page.locator('.orders-table .el-table__body-wrapper tbody tr').filter({ hasText: `${id === 19 ? 'OZON' : 'WB'}-PROFIT-${id}` });
    const recalculateRow = id => orderRow(id).getByRole('button', { name: '重算利润', exact: true });
    const profit = id => orderRow(id).getByText('CNY 24.57', { exact: true });
    const toolbarButton = label => page.locator('.orders-toolbar-card').getByRole('button', { name: label, exact: true });
    await orderRow(17).getByText('未重算', { exact: true }).waitFor();
    await orderRow(18).getByText('未重算', { exact: true }).waitFor();
    await toolbarButton('重算本页利润').waitFor();
    assert.equal(writes.length, 0, 'opening the list never recalculates or writes profits automatically');
    assert.equal(await recalculateRow(19).count(), 0, 'Ozon row keeps its own profit controls');

    const beforeSingle = reads.filter(url => url.startsWith('/api/orders?')).length;
    await recalculateRow(17).click();
    await profit(17).waitFor();
    assert.deepEqual(writes.at(-1).body.order_ids, [17]);
    assert.ok(reads.filter(url => url.startsWith('/api/orders?')).length > beforeSingle, 'a successful save reloads persisted list values');
    await orderRow(18).getByText('未重算', { exact: true }).waitFor();
    await toolbarButton('重算本页利润').click();
    await profit(18).waitFor();
    assert.deepEqual(writes.at(-1).body.order_ids, [17, 18], 'current-page mode includes WB orders on this page only');

    await orderRow(18).locator('.el-checkbox').first().click();
    await toolbarButton('重算已选利润').click();
    await toolbarButton('重算已选利润').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.orders-toolbar-card .el-button.is-loading'));
    assert.deepEqual(writes.at(-1).body.order_ids, [18], 'selected mode does not recalculate unselected WB orders');
    await orderRow(19).locator('.el-checkbox').first().click();
    const beforeMixed = writes.length;
    await toolbarButton('重算已选利润').click();
    await page.getByText('请单独选择 WB 订单重算利润，不要混选其他平台订单。', { exact: true }).waitFor();
    assert.equal(writes.length, beforeMixed, 'mixed-platform selection is rejected before posting');
    await orderRow(19).locator('.el-checkbox').first().click();
    await orderRow(18).locator('.el-checkbox').first().click();

    await page.reload();
    await profit(17).waitFor();
    await profit(18).waitFor();
    assert.equal(writes.length, beforeMixed, 'reload reads the saved values without another calculation');
    missingInputs = true;
    await recalculateRow(18).click();
    await orderRow(18).getByText('待补齐参数', { exact: true }).waitFor();
    assert.equal(await profit(18).count(), 0, 'new missing inputs replace an outdated known-profit projection');
    await page.getByText(/采购成本/).filter({ hasText: '请核对采购成本' }).waitFor();
    missingInputs = false;

    await page.evaluate(() => window.setProfitTestRoles(['packing']));
    assert.equal(await page.getByRole('button', { name: /重算.*利润/ }).count(), 0, 'orders.read-only members cannot persist profits');
    await page.evaluate(() => window.setProfitTestRoles(['operations']));
    await recalculateRow(17).waitFor();
    const beforeOzon = writes.length;
    await page.locator('.marketplace-switcher [data-platform="ozon"]').click();
    await orderRow(19).waitFor();
    assert.equal(await page.getByRole('button', { name: /重算本页利润|重算已选利润/ }).count(), 0, 'Ozon platform has no WB batch action');
    assert.equal(writes.length, beforeOzon);
    await page.locator('.marketplace-switcher [data-platform="wb"]').click();
    await recalculateRow(17).waitFor();
    await fs.mkdir('.verification', { recursive: true });
    await page.screenshot({ path: '.verification/wb-order-profit-list.png', animations: 'disabled' });

    const held = new Promise(resolve => { postHeld = resolve; });
    holdPost = true;
    await recalculateRow(17).click();
    await held;
    const beforeScopeChange = reads.filter(url => url.startsWith('/api/orders?')).length;
    await page.evaluate(() => window.switchProfitListTenant());
    await orderRow(17).waitFor({ state: 'hidden' });
    releasePost();
    await page.waitForFunction(() => !document.querySelector('.orders-toolbar-card .el-button.is-loading'));
    assert.equal(await orderRow(17).count(), 0, 'a previous enterprise response cannot restore its order or profit');
    assert.equal(reads.filter(url => url.startsWith('/api/orders?')).length, beforeScopeChange, 'a stale recalculation completion does not trigger a new-scope list refresh');
    assert.equal(new Set(writes.map(write => write.body.command_id)).size, writes.length);
    assert.deepEqual(errors, []);
  } finally {
    releasePost?.();
    await browser?.close();
    const target = path.resolve(output);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('wb-order-profit-list-'));
    await fs.rm(target, { recursive: true, force: true });
  }
});
