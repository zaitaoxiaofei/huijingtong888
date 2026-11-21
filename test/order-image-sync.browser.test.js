import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';

test('desktop and mobile repair images only on click, retry an unchanged URL once, and discard stale tenant responses', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1', timeout: 180000 }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'order-image-sync-'));
  let browser, releasePost, holdPost = false, postFailure = false;
  const writes = [], reads = [], errors = [], imageRequests = [];
  const proxyUrl = '/api/image-proxy?url=https%3A%2F%2Fimages.example.test%2Fmain.png';
  const imageState = new Map([[1, false], [3, false]]);
  const row = (id, image) => ({ id, platform: 'ozon', shop_id: 1, shop_name: '主图验证店铺', posting_number: `IMAGE-${id}`, status: 'awaiting_packaging', ordered_at: '2026-11-20T01:00:00Z', revenue: 50, item_count: 1, skus: `SKU-${id}`, sku_names: `SKU-${id}:验证商品${id}`, sku_quantities: `SKU-${id}:1`, sku_order_item_ids: `SKU-${id}:${id * 100 + 1}`, sku_images: `SKU-${id}:${image}`, product_names: `验证商品${id}`, fulfillment_type_key: 'fbs', fulfillment_type_label: 'FBS', inventory_availability: [] });
  const records = [row(1, proxyUrl), row(2, '/good-image.svg'), row(3, ''), row(4, '')];
  const detail = id => ({ order: records.find(row => row.id === id), items: [{ id: id * 100 + 1, ozon_sku: `SKU-${id}`, ozon_name: `验证商品${id}`, quantity: 1, image_url: id === 1 ? `${proxyUrl}&detail=1` : id === 3 && imageState.get(3) ? '/repaired-image.svg' : '', product_name: '已绑定库存' }], finance: [] });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#8bb8a7"/></svg>';
  const entry = `import {createApp,h} from 'vue';import {createPinia} from 'pinia';import {createRouter,createWebHashHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import Orders from '/frontend/orders/OrdersPage.vue';import MobileLayout from '/frontend/admin/layouts/MobileLayout.vue';import MobileOrders from '/frontend/admin/views/mobile/MobileOrdersView.vue';import MobileDetail from '/frontend/admin/views/mobile/MobileOrderDetailView.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';const app=createApp({render:()=>h(RouterView)});app.use(createPinia()).use(ElementPlus);const auth=useAuthStore();auth.user={id:1,personId:1,roles:['operations'],tenant:{id:2,slug:'a',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('order-image-fixture');const router=createRouter({history:createWebHashHistory(),routes:[{path:'/orders',component:Orders},{path:'/mobile',component:MobileLayout,children:[{path:'orders',component:MobileOrders},{path:'orders/:id',component:MobileDetail}]},{path:'/blank',component:{render:()=>h('p','已离开订单')}}]});window.imageRouter=router;window.imageRole=roles=>{auth.user={...auth.user,roles};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));};window.imageScope=()=>{auth.user={...auth.user,tenant:{id:3,slug:'b',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('other-image-tenant');currentApiCacheScope();};app.use(router);await router.isReady();app.mount('#app');`;
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', publicDir: false, plugins: [vue(), { name: 'order-image-fixture', resolveId(id) { if (id === 'virtual:order-images') return '\0order-images'; }, load(id) { if (id === '\0order-images') return entry; } }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:order-images', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, 'http://localhost:8788', 'image QA must not access production or external images');
      if (url.pathname === '/api/image-proxy') {
        imageRequests.push(url.pathname + url.search);
        assert.equal(url.searchParams.get('require_original'), '1');
        return route.fulfill(imageState.get(1) ? { contentType: 'image/svg+xml', body: svg } : { status: 502, body: '原图暂不可用' });
      }
      if (url.pathname.endsWith('-image.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: svg });
      if (/^\/api\/orders\/\d+\/sync-images$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/')[3]);
        writes.push({ path: url.pathname, body: request.postDataJSON() });
        assert.equal(request.method(), 'POST'); assert.deepEqual(request.postDataJSON(), { item_id: id * 100 + 1 });
        if (holdPost) { holdPost = false; await new Promise(resolve => { releasePost = resolve; }); }
        if (postFailure) { postFailure = false; return route.fulfill({ status: 502, json: { error: '主图服务暂时不可用，请重试' } }); }
        imageState.set(id, true);
        return route.fulfill({ json: { ok: true, order_id: id, updated_count: id === 1 ? 0 : 1, failed_count: 0, items: [{ id: id * 100 + 1, image_url: id === 1 ? proxyUrl : '/repaired-image.svg', updated: id !== 1 }] } }).catch(() => {});
      }
      if (url.pathname.startsWith('/api/')) {
        assert.equal(request.method(), 'GET', 'only a clicked single-order image action may submit a write');
        reads.push(url.pathname + url.search);
        if (url.pathname === '/api/orders') return route.fulfill({ json: { rows: records, total: records.length, page: 1, pageSize: 20, counts: { all: records.length, awaiting_packaging: records.length } } });
        if (/^\/api\/orders\/\d+$/.test(url.pathname)) return route.fulfill({ json: detail(Number(url.pathname.split('/')[3])) });
        if (url.pathname === '/api/shops') return route.fulfill({ json: [{ id: 1, name: '主图验证店铺', platform: 'ozon' }] });
        if (url.pathname === '/api/orders/inventory-availability') return route.fulfill({ json: { rows: [] } });
        return route.fulfill({ json: { rows: [], total: 0, products: [] } });
      }
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app" style="height:100vh"></div><script type="module" src="/entry.js"></script></body></html>' });
      const file = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : decodeURIComponent(url.pathname.slice(1));
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, file)) });
    });
    await page.goto('http://localhost:8788/admin.html#/orders');
    const desktopRow = id => page.locator('.orders-table tbody tr').filter({ hasText: `IMAGE-${id}` });
    const button = row => row.getByRole('button', { name: /补同步订单/ });
    await button(desktopRow(1)).waitFor(); await button(desktopRow(3)).waitFor();
    await page.waitForTimeout(300); assert.equal(writes.length, 0, 'missing and failed images never automatically repair');
    assert.equal(await button(desktopRow(2)).count(), 0);
    await page.evaluate(() => { window.goodOrderImage = document.querySelectorAll('.orders-table tbody tr')[1].querySelector('.orders-thumb img'); });
    const listReads = reads.filter(url => url.startsWith('/api/orders?')).length;
    holdPost = true; await button(desktopRow(1)).click();
    await page.waitForFunction(() => document.querySelector('.orders-table .el-button.is-loading'));
    await button(desktopRow(1)).evaluate(element => element.click()); assert.equal(writes.length, 1, 'busy item cannot submit twice');
    releasePost();
    await page.waitForFunction(() => [...document.querySelectorAll('.orders-table tbody tr')][0].querySelector('.orders-thumb img')?.naturalWidth > 0);
    assert.equal(imageRequests.length, 2, 'same URL is retried exactly once after the explicit click');
    assert.equal(await button(desktopRow(1)).count(), 0);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.orders-table tbody tr')[1].querySelector('.orders-thumb img') === window.goodOrderImage), true);
    assert.equal(reads.filter(url => url.startsWith('/api/orders?')).length, listReads, 'repair does not reload all orders');
    await fs.mkdir('.verification', { recursive: true });
    await page.waitForFunction(() => document.querySelectorAll('.el-message').length === 0);
    await page.screenshot({ path: '.verification/order-image-sync-desktop.png', animations: 'disabled' });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.imageRouter.push('/mobile/orders'));
    const mobileCard = id => page.locator('.mobile-order-card').filter({ hasText: `IMAGE-${id}` });
    await button(mobileCard(3)).waitFor();
    const beforeMobile = writes.length; await page.waitForTimeout(200); assert.equal(writes.length, beforeMobile);
    postFailure = true; await button(mobileCard(3)).click();
    await page.getByText('主图服务暂时不可用，请重试', { exact: true }).waitFor();
    assert.equal(writes.length, beforeMobile + 1); assert.equal(await button(mobileCard(3)).isEnabled(), true);
    await button(mobileCard(3)).click();
    await mobileCard(3).locator('.mobile-order-card__body img').waitFor();
    assert.equal(writes.length, beforeMobile + 2);
    await page.evaluate(() => window.imageRole(['packing']));
    assert.equal(await page.getByRole('button', { name: /补同步订单/ }).count(), 0, 'orders.read-only packing role cannot write images');
    await page.evaluate(() => window.imageRole(['operations']));
    await button(mobileCard(4)).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.el-message').length === 0);
    await page.screenshot({ path: '.verification/order-image-sync-mobile-list.png', animations: 'disabled' });

    imageState.set(1, false);
    await page.evaluate(() => window.imageRouter.push('/mobile/orders/1'));
    await page.getByRole('heading', { name: 'IMAGE-1', exact: true }).waitFor();
    await page.getByRole('button', { name: /补同步订单 IMAGE-1/ }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.el-message').length === 0);
    await page.screenshot({ path: '.verification/order-image-sync-mobile-detail.png', animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    const beforeDetail = writes.length;
    holdPost = true; await page.getByRole('button', { name: /补同步订单 IMAGE-1/ }).click();
    await page.waitForFunction(() => document.querySelector('.mobile-item-card .is-loading'));
    await page.evaluate(() => window.imageScope());
    releasePost(); await page.waitForTimeout(150);
    assert.equal(writes.length, beforeDetail + 1);
    assert.equal(await page.locator('.mobile-item-card').count(), 0, 'old tenant response cannot restore cleared order details');
    await page.evaluate(() => window.imageRouter.push('/blank'));
    await page.getByText('已离开订单', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    releasePost?.(); await browser?.close();
    const target = path.resolve(output);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('order-image-sync-'));
    await fs.rm(target, { recursive: true, force: true });
  }
});
