import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('inventory alert detail uses scoped ledger routes and only exposes stocktake', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-alert-detail-'));
  const requests = [];
  const errors = [];
  let browser;
  const ledger = {
    product: { id: 10, name: '测试库存', inventory_number: '1-10', stock_unit: '件' },
    revision: 'stock-v1', local_stock: 10, physical_estimate: 10, available_estimate: 8,
    open_order_demand: 2, current_stock_reserved: 2, fbp_reserved: 0,
    incoming_quantity: 0, current_incoming: 0, current_shortage: 0,
    orders: [{ order_id: 1, order_item_id: 1, posting_number: 'ORDER-1', needs_fulfillment: true, quantity: 2,
      stock_quantity: 2, incoming_quantity: 0, shortage_quantity: 0 }],
    movements: [], actions: []
  };
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'inventory-ledger-fixture',
      resolveId(id) { if (id === 'virtual:inventory-ledger') return '\0inventory-ledger'; },
      load(id) {
        if (id === '\0inventory-ledger') return `import { createApp, h } from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Ledger from '/frontend/admin/components/procurement/ProcurementLedgerDialog.vue'; const initialAction = new URLSearchParams(location.search).has('stocktake') ? 'stocktake' : ''; createApp({ render: () => h(Ledger, { modelValue: true, productId: 10, inventoryMode: true, stocktakeEnabled: true, initialAction }, { 'inventory-relations': () => h('div', '关联店铺 RuVibe Mart · SKU 12345') }) }).use(ElementPlus).mount('#app');`;
      }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:inventory-ledger', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname.endsWith('/image')) return route.fulfill({ status: 404, body: '' });
      if (url.pathname === '/api/inventory/ledger' && route.request().method() === 'GET') {
        requests.push({ path: url.pathname, method: 'GET' });
        return route.fulfill({ json: ledger });
      }
      if (url.pathname.startsWith('/api/inventory/ledger') && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        requests.push({ path: url.pathname, method: 'POST', body });
        return route.fulfill({ json: url.pathname.endsWith('/preview')
          ? { physical_before: 10, physical_after: body.stocktake_type === 'available' ? 7 : 8,
              available_before: 8, available_after: body.stocktake_type === 'available' ? 5 : 6,
              stocktake_delta: body.stocktake_type === 'available' ? -3 : -2,
              open_order_demand: 2, order_reserved: 2, fbp_reserved: 0, reason: '历史库存记错' }
          : { ok: true } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 403, json: { error: 'Unexpected API route' } });
      const asset = url.pathname === '/style.css'
        ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css')))
        : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByText('关联店铺 RuVibe Mart · SKU 12345').waitFor();
    assert.equal(await page.getByRole('button', { name: '库存转换' }).count(), 0);
    assert.equal(await page.getByRole('tab', { name: '采购与成本' }).count(), 0);
    assert.equal(await page.getByRole('tab', { name: '历史核对' }).count(), 0);
    assert.equal(requests.some(row => row.path.startsWith('/api/procurement')), false);

    await page.getByRole('button', { name: '更新本地库存' }).click();
    const dialog = page.getByRole('dialog', { name: '更新本地库存' });
    await dialog.getByText('更新仓库实物数（推荐）', { exact: true }).click();
    await dialog.getByRole('spinbutton').fill('8');
    await dialog.getByText('历史库存记错', { exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: '确认更新' }).isEnabled(), true);
    await dialog.getByRole('button', { name: '确认更新' }).click();
    await dialog.getByText('仓库实物 10 → 8；剩余可用 8 → 6').waitFor();
    await page.getByRole('dialog', { name: '再次确认库存更新' }).getByRole('button', { name: '确认更新' }).click();
    assert.deepEqual(requests.filter(row => row.method === 'POST').map(row => row.path), ['/api/inventory/ledger/preview', '/api/inventory/ledger']);
    assert.equal(requests.at(-2).body.action_type, 'stocktake');
    assert.equal(requests.at(-1).body.counted_quantity, 8);

    await page.getByRole('button', { name: '更新本地库存' }).click();
    const availableDialog = page.getByRole('dialog', { name: '更新本地库存' });
    await availableDialog.getByText('更新剩余可用数', { exact: true }).click();
    await availableDialog.getByRole('spinbutton').fill('5');
    await availableDialog.getByText('历史库存记错', { exact: true }).click();
    await availableDialog.getByRole('button', { name: '预览变动' }).click();
    await availableDialog.getByText('仓库实物 10 → 7；剩余可用 8 → 5').waitFor();
    await availableDialog.getByRole('spinbutton').fill('4');
    await availableDialog.getByRole('button', { name: '确认更新' }).click();
    await page.getByRole('dialog', { name: '再次确认库存更新' }).getByRole('button', { name: '确认更新' }).click();
    assert.deepEqual(requests.filter(row => row.method === 'POST').map(row => row.path), [
      '/api/inventory/ledger/preview', '/api/inventory/ledger',
      '/api/inventory/ledger/preview', '/api/inventory/ledger/preview', '/api/inventory/ledger'
    ]);
    assert.equal(requests.at(-1).body.stocktake_type, 'available');
    assert.equal(requests.at(-2).body.available_quantity, 4);
    assert.equal(requests.at(-1).body.available_quantity, 4);
    const ledgerReadsBeforeDirectOpen = requests.filter(row => row.method === 'GET').length;
    await page.goto('http://localhost:8788/admin.html?stocktake=1');
    await page.getByRole('dialog', { name: '更新本地库存' }).waitFor();
    assert.equal(requests.filter(row => row.method === 'GET').length, ledgerReadsBeforeDirectOpen + 1, 'direct stocktake waits for the ledger to load');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(output, { recursive: true, force: true });
  }
});
