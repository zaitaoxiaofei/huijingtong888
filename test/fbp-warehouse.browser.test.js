import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('warehouse dialogs print per SKU plus two, retain partial success and sync operations', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'fbp-warehouse-'));
  let browser;
  const requests = [], errors = [], printed = new Map();
  let failSecond = true;
  const orders = [1, 2].map(id => ({ id, order_no: 'FBP-' + id, shop_id: id, shop_name: '店铺 ' + id, status: 'approved', created_at: '2026-09-20',
    items: [{ id, order_id: id, shop_id: id, product_id: 10, inventory_number: '1-1', product_name: '汽车钥匙壳', online_product_id: id, ozon_sku: 'SKU-' + id,
      final_qty: id === 1 ? 100 : 50, approved_qty: id === 1 ? 100 : 50, barcode_printed_qty: 0,
      warehouse: { ledger_stock: 200, reserved_fbp: 150, procurement_incoming: 20, fbp_pending: 15, last_shipped_qty: 80, last_shipped_at: '2026-09-18', sku_shipments: {} } }] }));
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'fbp-fixture', resolveId(id) { if (id === 'virtual:fbp') return '\0fbp'; },
      load(id) { if (id === '\0fbp') return `import {createApp,h,ref,provide} from 'vue'; import {createPinia} from 'pinia'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Page from '/frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue'; createApp({setup(){provide('inventoryFbpReplenishmentStatus',ref('pending_dispatch'));return ()=>h(Page)}}).use(createPinia()).use(ElementPlus).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:fbp', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/shops') return route.fulfill({ json: [{ id: 1, name: '店铺 1' }, { id: 2, name: '店铺 2' }] });
      if (url.pathname === '/api/fbp-replenishment-orders') return route.fulfill({ json: { rows: orders, total: 2, page: 1, pageSize: 100 } });
      if (url.pathname === '/api/products/barcode-label') { requests.push(route.request().postDataJSON()); return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF' }); }
      if (url.pathname.endsWith('/barcode-printed')) {
        const body = route.request().postDataJSON(); requests.push(body);
        if (body.item_id === 2 && failSecond) { failSecond = false; return route.fulfill({ status: 503, json: { error: '模拟响应中断' } }); }
        if (!printed.has(body.request_key)) {
          printed.set(body.request_key, body);
          orders.find(row => row.id === body.order_id).items[0].barcode_printed_qty += body.quantity;
        }
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>' });
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByText('库存视角', { exact: true }).click();
    await page.getByRole('button', { name: '查看明细', exact: true }).waitFor();
    assert.equal(await page.locator('.el-table__expand-icon').count(), 0);
    await page.getByRole('button', { name: '查看明细', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '店铺备货明细', exact: true });
    await detail.getByText('SKU-1', { exact: false }).first().waitFor();
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '打印标签', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '按店铺 / SKU 打印标签', exact: true });
    assert.deepEqual(await dialog.getByRole('spinbutton').evaluateAll(nodes => nodes.map(n => n.value)), ['102', '52']);
    await dialog.getByRole('button', { name: '生成并打开打印', exact: true }).click();
    const results = page.getByRole('dialog', { name: '逐项确认打印结果', exact: true });
    await results.waitFor();
    assert.deepEqual(requests[0].items.map(row => row.quantity), [102, 52]);
    assert.equal(printed.size, 0, 'generating labels cannot mark printing complete');
    await results.getByRole('button', { name: '确认所选实际打印数量', exact: true }).click();
    await results.getByText('模拟响应中断', { exact: true }).waitFor();
    assert.equal(printed.size, 1);
    await results.getByRole('button', { name: '确认所选实际打印数量', exact: true }).click();
    await results.waitFor({ state: 'hidden' });
    assert.equal(printed.size, 2);
    const retries = requests.filter(row => row.item_id === 2);
    assert.equal(retries[0].request_key, retries[1].request_key);
    await page.getByText('标签已确认 154 / 应打 154').waitFor();
    if (process.env.FBP_UI_SCREENSHOT) await page.screenshot({ path: process.env.FBP_UI_SCREENSHOT });
    await page.getByText('运营视角', { exact: true }).click();
    await page.getByText(/已确认 102 \/ 应打 102 张/).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
