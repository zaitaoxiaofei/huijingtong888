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
    cost_tasks: [{ id: 7, quantity: 2, resolved_quantity: 0, reason: '实盘确认', created_at: '2026-09-27 00:00:00' }],
    orders: [{ order_item_id: 1, order_id: 1, posting_number: 'TEST-100', entered_transport: true, quantity: 100, missing_record_quantity: 98, missing_purchase_quantity: 98, missing_receipt_quantity: 0 },
      { order_item_id: 2, order_id: 2, posting_number: 'CURRENT-200', needs_fulfillment: true, quantity: 4, stock_quantity: 2, incoming_quantity: 2, shortage_quantity: 0 }],
    purchases: [{ id: 2, order_no: 'CG-OLD', actual_quantity: 2, received_quantity: 2, pending_quantity: 0, amount: 20, shipping_amount: 0, purchased_at: '2026-08-01 01:00:00' },
      { id: 1, order_no: 'CG-1', actual_quantity: 100, received_quantity: 2, pending_quantity: 98, amount: 1000, shipping_amount: 0, purchased_at: '2026-09-01 01:00:00' }] };
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
      if (url.pathname === '/api/products') return route.fulfill({ json: { rows: [{ id: 10, name: '测试商品 A' }, { id: 11, name: '替代商品 B' }, { id: 12, name: '车标配件' }] } });
      if (url.pathname.endsWith('/image')) return route.fulfill({ status: 404, body: '' });
      if (url.pathname === '/api/procurement/ledger' && route.request().method() === 'GET') return route.fulfill({ json: url.searchParams.get('product_id') === '12'
        ? { ...initial, product: { id: 12, name: '车标配件' }, revision: 'logo-v1', available_estimate: 10 }
        : url.searchParams.get('product_id') === '11' ? { ...initial, product: { id: 11, name: '替代商品 B' }, revision: 'target-v1', local_stock: 10 } : initial });
      if (url.pathname.startsWith('/api/procurement/ledger') && route.request().method() === 'POST') {
        const body = route.request().postDataJSON(); requests.push({ path: url.pathname, body });
        return route.fulfill({ json: url.pathname.endsWith('/preview') ? { local_before: 0, local_after: 0, local_delta: 0, physical_after: 0 } : { ok: true } });
      }
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByRole('tab', { name: '订单分配', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '订单分配', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByText('CURRENT-200', { exact: true }).waitFor();
    await page.getByText('已覆盖，无需重复采购', { exact: true }).waitFor();
    assert.equal(await page.getByText('TEST-100', { exact: true }).count(), 0, 'historical orders are separate from current coverage');
    assert.equal(await page.getByRole('button', { name: '补采购记录', exact: true }).count(), 0, 'historical forms are not mounted on entry');
    await page.screenshot({ path: '/tmp/procurement-ledger-overview.png', animations: 'disabled' });
    await page.getByRole('tab', { name: '历史核对', exact: true }).click();
    await page.getByText('TEST-100', { exact: true }).waitFor();
    await page.getByRole('button', { name: '补采购记录', exact: true }).click();
    const historicalDialog = page.getByRole('dialog', { name: '补历史采购', exact: true });
    await historicalDialog.getByText('只补历史采购来源，不增加现货或在途。实物与账面不符请单独盘点核对。').waitFor();
    assert.equal(await historicalDialog.getByRole('radio').count(), 0);
    await historicalDialog.getByRole('button', { name: 'Close this dialog' }).click();
    await page.getByRole('button', { name: '继续填写', exact: true }).click();
    assert.equal(await historicalDialog.isVisible(), true, 'cancelling discard preserves the form');
    await historicalDialog.getByRole('button', { name: 'Close this dialog' }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.getByRole('tab', { name: '采购与成本' }).click();
    const purchaseTable = page.locator('.el-table').filter({ hasText: 'CG-1' });
    assert.match(await purchaseTable.locator('tbody tr').first().innerText(), /CG-1/);
    await page.getByRole('button', { name: '100', exact: true }).click();
    assert.equal(await page.getByText('CG-OLD', { exact: true }).count(), 0);
    await page.getByText('全部采购', { exact: true }).click();
    await page.getByText('CG-OLD', { exact: true }).waitFor();
    await page.getByRole('button', { name: '纠正记录', exact: true }).first().click();
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
    await page.getByRole('tab', { name: '库存流水' }).click();
    await page.getByRole('button', { name: '库存转换', exact: true }).click();
    const conversion = page.getByRole('dialog', { name: '库存商品转换', exact: true });
    await conversion.getByRole('combobox').fill('替代');
    await page.getByRole('option', { name: '替代商品 B' }).click();
    await conversion.getByText('该商品本地库存 10').waitFor();
    await conversion.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.getByRole('button', { name: '更新本地库存', exact: true }).click();
    const countDialog = page.getByRole('dialog', { name: '更新本地库存', exact: true });
    assert.equal(await countDialog.getByRole('spinbutton').inputValue(), '');
    await countDialog.getByRole('spinbutton').fill('0');
    await countDialog.getByRole('button', { name: '确认更新', exact: true }).click();
    await page.getByText('请选择更新本地库存的调整原因（reason_code）', { exact: true }).waitFor();
    await countDialog.getByText('历史库存记错', { exact: true }).click();
    await countDialog.getByRole('textbox').fill('历史采购已补齐，仓库实盘确认为 0，保留采购在途');
    await page.screenshot({ path: '/tmp/inventory-update-reasons.png', animations: 'disabled' });
    await countDialog.getByRole('button', { name: '确认更新', exact: true }).click();
    await page.getByRole('dialog', { name: '确认更新本地库存', exact: true }).getByRole('button', { name: '确认更新', exact: true }).click();
    assert.equal(requests.at(-1).body.action_type, 'stocktake');
    assert.equal(requests.at(-1).body.counted_quantity, 0);
    assert.equal(requests.at(-1).body.reason_code, 'history_error');
    await page.getByRole('tab', { name: '采购与成本' }).click();
    await page.getByRole('button', { name: '补现货采购成本', exact: true }).click();
    const costDialog = page.getByRole('dialog', { name: '补现货采购成本', exact: true });
    await costDialog.getByRole('spinbutton').nth(0).fill('10');
    await costDialog.getByRole('spinbutton').nth(1).fill('200');
    await costDialog.locator('textarea').fill('实物已盘点，按供应商凭证补采购成本');
    await costDialog.getByRole('button', { name: '预览影响' }).click();
    await costDialog.getByText('本地账面库存：0 → 0').waitFor();
    await costDialog.getByRole('button', { name: '确认保存纠正记录' }).click();
    assert.equal(requests.at(-1).body.action_type, 'record_purchase');
    assert.equal(requests.at(-1).body.inventory_effect, 'already_accounted');
    assert.equal(requests.at(-1).body.amount, 200);
    assert.equal(requests.at(-1).body.quantity, 10);
    assert.match(requests.at(-1).body.purchased_at, /T00:00:00\+08:00$/);
    await page.getByRole('button', { name: '关联已有采购', exact: true }).click();
    const linkDialog = page.getByRole('dialog', { name: '关联已有采购成本', exact: true });
    await linkDialog.getByText('选择有金额且已收货的采购', { exact: true }).click();
    await page.getByRole('option', { name: /CG-1/ }).click();
    await linkDialog.locator('textarea').fill('已有采购凭证，核对完成');
    await linkDialog.getByRole('button', { name: '预览影响' }).click();
    await linkDialog.getByRole('button', { name: '确认保存纠正记录' }).click();
    assert.equal(requests.at(-1).body.cost_task_id, 7);
    assert.equal(requests.at(-1).body.purchase_item_id, 1);
    assert.equal(requests.at(-1).body.action_type, 'link_stock_cost');
    await page.getByRole('tab', { name: '订单分配', exact: true }).click();
    await page.getByRole('button', { name: '优先分配', exact: true }).click();
    const priorityDialog = page.getByRole('dialog', { name: '调整现货分配优先级', exact: true });
    await priorityDialog.locator('textarea').fill('紧急订单优先，保留调整原因');
    await priorityDialog.getByRole('button', { name: '预览影响' }).click();
    await priorityDialog.getByRole('button', { name: '确认保存纠正记录' }).click();
    assert.equal(requests.at(-1).body.action_type, 'set_priority');
    assert.equal(requests.at(-1).body.order_item_id, 2);
    assert.equal(requests.at(-1).body.priority, 1);
    await page.getByRole('tab', { name: '库存流水' }).click();
    await page.getByRole('button', { name: '库存转换', exact: true }).click();
    const multi = page.getByRole('dialog', { name: '库存商品转换', exact: true });
    await multi.getByRole('combobox').fill('替代');
    await page.getByRole('option', { name: '替代商品 B' }).click();
    await multi.getByText('该商品本地库存 10').waitFor();
    await multi.getByRole('button', { name: '添加消耗配件' }).click();
    await multi.getByRole('combobox').nth(1).fill('车标');
    await page.getByRole('option', { name: '车标配件', exact: true }).click();
    await multi.getByText('未占用 10', { exact: true }).waitFor();
    await multi.locator('textarea').fill('钥匙壳配车标组装');
    await multi.getByRole('button', { name: '预览影响' }).click();
    await multi.getByRole('button', { name: '确认保存纠正记录' }).click();
    assert.deepEqual(requests.at(-1).body.extra_sources, [{ product_id: 12, quantity: 1, revision: 'logo-v1' }]);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
