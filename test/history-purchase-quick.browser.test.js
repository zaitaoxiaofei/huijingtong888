import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('quick history form loads full gap, previews cost allocations and saves the exact preview once', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'history-purchase-quick-'));
  let browser;
  const requests = [], errors = [];
  const allocations = [{ order_item_id: 1, posting_number: 'OLD-A', quantity: 2, amount: 20, shipping_amount: 2 },
    { order_item_id: 2, posting_number: 'OLD-B', quantity: 3, amount: 30, shipping_amount: 3 }];
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'quick-fixture', resolveId(id) { if (id === 'virtual:quick') return '\0quick'; },
      load(id) { if (id === '\0quick') return `import {createApp} from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Dialog from '/frontend/admin/components/procurement/HistoricalPurchaseQuickDialog.vue'; createApp(Dialog, {productId:10}).use(ElementPlus).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:quick', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === '/api/procurement/ledger' && route.request().method() === 'GET') return route.fulfill({ json: {
        product: { id: 10, name: '库存 A', code: 'A-10' }, revision: 'v1', missing_purchase: 5, missing_receipt: 2,
        orders: [{ order_item_id: 1, posting_number: 'OLD-A', entered_transport: true, transport_at: '2026-08-02T00:00:00Z', missing_purchase_quantity: 2 },
          { order_item_id: 2, posting_number: 'OLD-B', entered_transport: true, transport_at: '2026-08-03T00:00:00Z', missing_purchase_quantity: 3 }]
      } });
      if (url.pathname.startsWith('/api/procurement/ledger') && route.request().method() === 'POST') {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true, allocations, local_delta: 0 } });
      }
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    const dialog = page.getByRole('dialog', { name: '补齐历史采购记录' });
    await dialog.getByText('库存 A · A-10').waitFor();
    const inputs = dialog.getByRole('spinbutton');
    assert.equal(await inputs.nth(0).inputValue(), '5');
    await inputs.nth(1).fill('50');
    await inputs.nth(2).fill('5');
    await dialog.getByPlaceholder('北京时间，按实际采购批次填写').fill('2026-08-04 12:00:00');
    await dialog.getByPlaceholder('填写历史漏记原因或采购凭证编号').fill('旧单凭证 A');
    await dialog.getByRole('button', { name: '预览分配' }).click();
    assert.equal(requests.length, 0, 'invalid purchase date is blocked before submitting');
    assert.match(await dialog.innerText(), /2026[/-]08[/-]02 08:00:00/);
    assert.equal(await inputs.nth(1).inputValue(), '50.00', 'amount survives date validation');
    await dialog.getByPlaceholder('北京时间，按实际采购批次填写').fill('2026-08-01 12:00:00');
    await dialog.getByPlaceholder('填写历史漏记原因或采购凭证编号').fill('旧单凭证 A');
    await dialog.getByRole('button', { name: '预览分配' }).click();
    await dialog.getByText('按历史订单先后分配数量，货款与运费按数量分摊；确认下面的订单后保存', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '确认补齐采购记录' }).click();
    await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].quantity, 5);
    assert.equal(requests[0].amount, 50);
    assert.equal(requests[0].shipping_amount, 5);
    assert.equal(requests[0].inventory_effect, 'already_accounted');
    assert.equal(requests[0].action_type, 'historical_purchase_bulk');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
