import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('workspace purchase correction previews formal-item changes, preserves saved totals, and rejects stale edits', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'procurement-history-browser-'));
  let browser;
  const item = { id: 501, product_id: 10, product_name: '测试采购商品', quantity: '40', amount: '9.00', shipping_amount: '0.00', status: 'inbound_done', purchase_order_no: 'PO-501', created_at: '2026-09-01T01:00:00Z' };
  const requests = [], errors = [];
  let saved = false, stale = false, conflict = false;
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'history-fixture', resolveId(id) { if (id === 'virtual:history') return '\0history'; },
      load(id) { if (id === '\0history') return `import {createApp} from 'vue'; import {createPinia} from 'pinia'; import {createRouter,createMemoryHistory} from 'vue-router'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Page from '/frontend/admin/views/procurement/ProcurementWorkspaceView.vue'; const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:Page}]}); createApp(Page).use(createPinia()).use(router).use(ElementPlus).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:history', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === '/api/procurement/requests') return route.fulfill({ json: { rows: [{ product_id: 10, product_name: item.product_name, stock: 0, suggested_purchase_qty: 2, total_quantity: 2, historical_purchased_quantity: item.quantity, historical_purchase_amount: item.amount, historical_purchase_count: 1 }], total: 1 } });
      if (url.pathname === '/api/procurement/purchase-history') return route.fulfill({ json: [item] });
      if (url.pathname === '/api/procurement/ledger' && route.request().method() === 'GET') return route.fulfill({ json: { revision: saved ? 'v2' : 'v1', purchases: [{ ...item, actual_quantity: stale ? 99 : item.quantity, received_quantity: 40 }] } });
      if (url.pathname.startsWith('/api/procurement/ledger') && route.request().method() === 'POST') {
        const body = route.request().postDataJSON(); requests.push({ path: url.pathname, body });
        if (url.pathname.endsWith('/preview')) return route.fulfill({ json: { revision: saved ? 'v2' : 'v1', local_before: 40, local_after: body.action_type === 'record_purchase' && body.inventory_effect === 'missing_inbound' ? 43 : 30, affected_orders: [{ posting_number: 'ORDER-1', before: 40, after: 30 }] } });
        if (conflict) return route.fulfill({ status: 409, json: { error: '采购、订单或库存已变化，请刷新对账后重新提交' } });
        saved = true; Object.assign(item, { quantity: body.quantity, amount: body.amount, shipping_amount: body.shipping_amount });
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { rows: [] } });
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByRole('button', { name: '查看采购记录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '测试采购商品 · 采购记录', exact: true });
    const quantity = dialog.getByRole('spinbutton', { name: '采购数量', exact: true });
    await quantity.waitFor();
    assert.equal(await dialog.getByRole('columnheader', { name: '采购单号', exact: true }).count(), 1);
    await quantity.fill('30');
    await dialog.getByRole('spinbutton', { name: '采购金额', exact: true }).fill('90');
    await dialog.getByRole('spinbutton', { name: '运费', exact: true }).fill('5');
    assert.match(await dialog.locator('.purchase-history-summary').innerText(), /40 件/);
    assert.match(await dialog.locator('.purchase-history-summary').innerText(), /¥9.00/);
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByText('请在该行的纠错原因中说明修改依据，再保存采购记录', { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    await dialog.getByRole('textbox', { name: '纠错原因' }).fill('核对采购凭证，数量和货款录错');
    await dialog.getByText('入库也录多了', { exact: true }).click();
    await page.screenshot({ path: '/tmp/procurement-history-edit.png' });
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认采购纠错', exact: true });
    await confirmation.getByText('本地库存：40 → 30', { exact: true }).waitFor();
    await confirmation.getByText('ORDER-1', { exact: true }).waitFor();
    assert.equal(requests.length, 1);
    await page.screenshot({ path: '/tmp/procurement-history-confirm.png' });
    await confirmation.getByRole('button', { name: '确认保存', exact: true }).click();
    await page.getByText('采购记录已纠正，采购汇总、库存和关联订单已同步更新', { exact: true }).waitFor();
    await dialog.locator('.purchase-history-summary').getByText('30 件', { exact: true }).waitFor();
    assert.equal(requests[0].body.request_key, requests[1].body.request_key);
    assert.equal(requests[0].body.revision, undefined);
    assert.equal(requests[1].body.purchase_item_id, 501);
    assert.equal(requests[1].body.action_type, 'revise_purchase');
    assert.equal(requests[1].body.correct_received, true);
    assert.equal(requests[1].body.revision, 'v1');
    assert.equal(requests[1].body.quantity, 30);
    assert.equal(requests[1].body.amount, 90);
    assert.equal(requests[1].body.shipping_amount, 5);
    await dialog.getByRole('button', { name: '＋ 补录一次采购', exact: true }).click();
    const backfill = page.getByRole('dialog', { name: '补录一次采购', exact: true });
    await backfill.getByRole('spinbutton', { name: '补录数量', exact: true }).fill('3');
    await backfill.getByRole('spinbutton', { name: '补录货款', exact: true }).fill('18');
    await backfill.getByRole('spinbutton', { name: '补录运费', exact: true }).fill('2');
    await backfill.locator('input[placeholder="选择北京时间"]').fill('2026/08/01 12:00:00');
    await backfill.locator('input[placeholder="选择北京时间"]').press('Escape');
    await backfill.getByText('已收货，补记本地入库', { exact: true }).click();
    await backfill.getByRole('textbox', { name: '备注', exact: true }).fill('补记供应商实际采购');
    await backfill.getByRole('button', { name: '保存补录', exact: true }).click();
    const backfillConfirmation = page.getByRole('dialog', { name: '确认采购补录', exact: true });
    await backfillConfirmation.getByText('本地库存：40 → 43', { exact: true }).waitFor();
    await backfillConfirmation.getByRole('button', { name: '确认保存', exact: true }).click();
    await page.getByText('采购已补录，时间与收货状态已保存', { exact: true }).waitFor();
    assert.equal(requests.at(-1).body.action_type, 'record_purchase');
    assert.match(requests.at(-1).body.purchased_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    assert.equal(requests.at(-1).body.inventory_effect, 'missing_inbound');
    conflict = true;
    await dialog.getByRole('textbox', { name: '纠错原因' }).fill('验证并发冲突提示');
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认保存', exact: true }).click();
    await page.getByText('采购、订单或库存已变化，请刷新对账后重新提交', { exact: true }).waitFor();
    assert.equal(await confirmation.isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
