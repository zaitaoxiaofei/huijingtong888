import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';
import { buildOrderProfitDetailSnapshotPayload } from '../src/services/order-profit-detail-snapshots.js';

test('mobile real order detail shows desktop model, unknowns, zero settlement and lazy evidence at phone widths', {
  skip: process.env.RUN_MOBILE_ORDER_PROFIT_BROWSER_TESTS !== '1', timeout: 120000
}, async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-order-profit-'));
  let browser;
  const requests = [], errors = [];
  const order = { id: 1, shop_name: '验证店铺', posting_number: 'PROFIT-1', status: 'awaiting_packaging', estimated_profit: 999, actual_profit: 999 };
  const items = [
    { id: 11, ozon_sku: 'S1', product_name: '商品一', quantity: 2, sale_price: 40, frozen_purchase_cost: 5, frozen_international_shipping: 2, estimated_profit: 60 },
    { id: 12, ozon_sku: 'S2', product_name: '商品二', quantity: 1, sale_price: 30, frozen_purchase_cost: 8, frozen_international_shipping: 3, estimated_profit: 17 }
  ];
  const snapshot = buildOrderProfitDetailSnapshotPayload(order, items, []);
  let detail = { order, items, finance: [], profit_detail_snapshot: snapshot, profit_calculation_versions: { available: true, items: [{ order_item_id: 11, formula_version: 'V1', legacy_baseline: true, revisions: [{
    id: 21, revision_no: 1, layer: 'estimate', formula_version: 'V1', source: 'legacy_baseline', legacy_baseline: true,
    input_completeness: 'legacy_unknown', created_at: '2026-11-05T16:00:00Z', inputs: { input_completeness: 'legacy_unknown' }, outputs: { item: { estimated_profit: 0 } }
  }] }] } };
  try {
    await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: 'error', plugins: [vue(), {
      name: 'mobile-profit-fixture', resolveId(id) { if (id === 'virtual:mobile-profit') return '\0mobile-profit'; },
      load(id) { if (id === '\0mobile-profit') return `
        import {createApp,h} from 'vue';import {createPinia} from 'pinia';import {createRouter,createWebHashHistory,RouterView} from 'vue-router';
        import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';
        import Page from '/frontend/admin/views/mobile/MobileOrderDetailView.vue';
        const router=createRouter({history:createWebHashHistory(),routes:[{path:'/mobile/orders/:id',component:Page}]});
        createApp({render:()=>h(RouterView)}).use(createPinia()).use(router).use(ElementPlus).mount('#app');
      `; }
    }], build: { outDir: outputDir, minify: false, cssCodeSplit: false, rollupOptions: { input: 'virtual:mobile-profit', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== 'http://localhost:8788') return route.abort();
      if (url.pathname.startsWith('/api/')) {
        requests.push({ method: request.method(), path: url.pathname });
        if (request.method() !== 'GET') return route.abort();
        if (url.pathname === '/api/orders/1') return route.fulfill({ json: detail });
        return route.fulfill({ json: { products: [] } });
      }
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0}#app{padding:12px;box-sizing:border-box}*,*:before,*:after{box-sizing:border-box}</style><div id="app"></div><script type="module" src="/entry.js"></script>' });
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(outputDir, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(outputDir, asset)) });
    });
    const open = async () => { await page.goto('http://localhost:8788/admin.html#/mobile/orders/1'); await page.getByRole('heading', { name: '订单利润明细', exact: true }).waitFor(); };
    await open();
    const panel = page.locator('.mobile-order-profit');
    assert.match(await panel.innerText(), /全部 2 项商品合计/);
    assert.match(await panel.locator('[data-metric="estimate"]').innerText(), /CNY 77\.00/);
    assert.match(await panel.locator('[data-metric="actual"]').innerText(), /待结算/);
    assert.match(await panel.locator('[data-profit-row="purchase"]').innerText(), /CNY 18\.00/);
    assert.equal(await panel.locator('[data-profit-row]').count(), snapshot.detailRows.length);
    assert.deepEqual(await panel.locator('[data-profit-row]').evaluateAll(rows => rows.map(row => row.dataset.profitRow)), snapshot.detailRows.map(row => row.key));
    assert.equal(await panel.locator('.profit-calculation-versions').count(), 0);
    for (const width of [320, 375, 430, 768]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no page overflow at ${width}`);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await panel.getByText('计算依据与版本记录', { exact: true }).click();
    await panel.locator('.profit-calculation-item').waitFor();
    await panel.locator('.profit-calculation-revision summary').click();
    assert.match(await panel.locator('.profit-calculation-revision').innerText(), /2026\/11\/06 00:00:00/);
    assert.match(await panel.locator('.profit-calculation-revision').innerText(), /历史输入未完整留存/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'expanded evidence stays within phone');
    if (process.env.MOBILE_ORDER_PROFIT_SCREENSHOT) {
      await panel.getByText('计算依据与版本记录', { exact: true }).click();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.MOBILE_ORDER_PROFIT_SCREENSHOT, fullPage: true });
    }
    detail = { ...detail, profit_detail_snapshot: { ...snapshot, summary: { ...snapshot.summary, actualProfitReady: true, actualProfit: 0 }, detailRows: snapshot.detailRows.map(row => row.key === 'purchase' ? { ...row, estimated: null, estimatedText: '未留存完整预估依据' } : row.key === 'profit' ? { ...row, actual: 0, diff: -77 } : row) } };
    await page.reload();
    await panel.locator('[data-metric="actual"]').getByText('CNY 0.00', { exact: true }).waitFor();
    assert.match(await panel.locator('[data-profit-row="purchase"]').innerText(), /未留存完整预估依据/);
    assert.match(await panel.locator('[data-profit-row="profit"]').innerText(), /CNY -77\.00/);
    detail = { order, items, finance: [] };
    await page.reload();
    await panel.getByText(/暂未取得订单预估明细/).waitFor();
    assert.equal(await panel.locator('[data-profit-row]').count(), 0);
    assert.equal(await panel.getByText('CNY 0.00', { exact: true }).count(), 0);
    assert.ok(requests.length >= 6 && requests.every(request => request.method === 'GET'), 'detail and evidence are read-only');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
