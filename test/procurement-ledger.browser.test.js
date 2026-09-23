import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('ledger UI distinguishes historical debt, previews zero-stock purchase correction, and searches other inventory', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'procurement-ledger-browser-'));
  let browser;
  const initial = { product: { id: 10, name: '测试商品 A', code: 'A-10' }, revision: 'v1', local_stock: 0,
    physical_estimate: 2, current_stock_reserved: 2, available_estimate: 0,
    purchase_quantity: 102, received_quantity: 2, incoming_quantity: 100, current_shortage: 0, current_incoming: 2,
    missing_purchase: 98, missing_receipt: 0, movements: [], actions: [], sources: [], batches: [],
    orders: [{ order_item_id: 1, order_id: 1, posting_number: 'TEST-100', entered_transport: true, quantity: 100, missing_record_quantity: 98, missing_purchase_quantity: 98, missing_receipt_quantity: 0 }],
    purchases: [{ id: 1, order_no: 'CG-1', actual_quantity: 100, received_quantity: 0, pending_quantity: 100, amount: 1000, shipping_amount: 0, purchased_at: '2026-09-01 01:00:00' }] };
  const requests = [], errors = [];
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'ledger-fixture', resolveId(id) { if (id === 'virtual:ledger') return '\0ledger'; },
      load(id) { if (id === '\0ledger') return `import {createApp} from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Ledger from '/frontend/admin/components/procurement/ProcurementLedgerDialog.vue'; createApp(Ledger, {modelValue:true, productId:10}).use(ElementPlus).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:ledger', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === '/api/products') return route.fulfill({ json: { rows: [{ id: 10, name: '测试商品 A' }, { id: 11, name: '替代商品 B' }] } });
      if (url.pathname.endsWith('/image')) return route.fulfill({ status: 404, body: '' });
      if (url.pathname === '/api/procurement/ledger' && route.request().method() === 'GET') return route.fulfill({ json: url.searchParams.get('product_id') === '11' ? { ...initial, product: { id: 11, name: '替代商品 B' }, revision: 'target-v1', local_stock: 10 } : initial });
      if (url.pathname.startsWith('/api/procurement/ledger') && route.request().method() === 'POST') {
        const body = route.request().postDataJSON(); requests.push({ path: url.pathname, body });
        return route.fulfill({ json: url.pathname.endsWith('/preview') ? { local_before: 0, local_after: 0, local_delta: 0 } : { ok: true } });
      }
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByText('TEST-100', { exact: true }).waitFor();
    await page.getByRole('button', { name: '补采购记录', exact: true }).click();
    const historicalDialog = page.getByRole('dialog', { name: '补历史采购', exact: true });
    await historicalDialog.getByText('只补历史采购来源，不增加现货或在途。实物与账面不符请单独盘点核对。').waitFor();
    assert.equal(await historicalDialog.getByRole('radio').count(), 0);
    await historicalDialog.getByRole('button', { name: 'Close this dialog' }).click();
    await page.screenshot({ path: '/tmp/procurement-ledger-overview.png' });
    await page.getByRole('tab', { name: '采购数量与金额纠正' }).click();
    await page.getByRole('button', { name: '纠正记录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '纠正采购记录', exact: true });
    assert.equal(await dialog.getByRole('button', { name: '确认保存纠正记录' }).isDisabled(), true);
    await dialog.getByRole('spinbutton').nth(0).fill('98');
    await dialog.getByRole('textbox').fill('原采购录多 2 件，核对供应商凭证后纠正');
    await dialog.getByRole('button', { name: '预览影响' }).click();
    await dialog.getByText('本地账面库存：0 → 0').waitFor();
    await page.screenshot({ path: '/tmp/procurement-ledger-preview.png' });
    await dialog.getByRole('button', { name: '确认保存纠正记录' }).click();
    await page.getByText('已保存对账记录，库存和历史缺口已重新计算').waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.quantity, 98);
    assert.equal(requests[1].body.revision, 'v1');
    assert.equal(requests[0].body.request_key, requests[1].body.request_key);
    await page.getByRole('tab', { name: '本地库存去向' }).click();
    await page.getByRole('button', { name: '转换为其他商品库存' }).click();
    const conversion = page.getByRole('dialog', { name: '库存商品转换', exact: true });
    await conversion.getByRole('combobox').fill('替代');
    await page.getByRole('option', { name: '替代商品 B' }).click();
    await conversion.getByText('该商品本地库存 10').waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
