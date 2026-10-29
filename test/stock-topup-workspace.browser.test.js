import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('warehouse reminder retries safely; compact workbench keeps shared inventory flow and purchase actions', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-topup-ui-'));
  let browser;
  const errors = [], posted = [], queries = [];
  const order = { id: 1, posting_number: 'ORDER-1', shop_name: '测试店铺', statusLabel: '等待发货', productDisplayRows: [], logisticsSummary: {}, profitSummary: {}, availableActions: {}, unboundItems: [], procurementState: {},
    procurement_coverage: { stock_location: 'LOCAL', needs_fulfillment: true, items: [
      { product_id: 11, product_name: '主体', quantity: 1, stock_quantity: 1, shortage_quantity: 0 },
      { product_id: 12, product_name: '配件', quantity: 1, stock_quantity: 0, shortage_quantity: 1 }
    ] } };
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'stock-topup-fixture', resolveId(id) { if (id === 'virtual:topup') return '\0topup'; },
      load(id) { if (id === '\0topup') return `import {createApp,h} from 'vue'; import {createPinia} from 'pinia'; import {createRouter,createMemoryHistory} from 'vue-router'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Table from '/frontend/orders/components/OrdersTable.vue'; import Page from '/frontend/admin/views/procurement/ProcurementWorkspaceView.vue'; const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:Page}]}); const component=location.search.includes('orders')?{render:()=>h(Table,{rows:[${JSON.stringify(order)}],canRemindProcurement:true,tableHeight:800})}:Page; createApp(component).use(createPinia()).use(router).use(ElementPlus).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:topup', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>' });
      if (url.pathname === '/api/procurement/stock-topups') {
        posted.push(route.request().postDataJSON());
        return route.fulfill(posted.length === 1 ? { status: 503, json: { error: '测试网络失败，请重试' } } : { json: { ok: true, id: 101, notified: 2 } });
      }
      if (url.pathname === '/api/procurement/requests') {
        queries.push(url.searchParams.get('demandType'));
        return route.fulfill({ json: { rows: [{ product_id: 11, product_name: '测试主体', suggested_purchase_qty: 3, primary_suggested_purchase_qty: 3, total_quantity: 3, recent_30d_qty: 30, week3_qty: 3, week2_qty: 4, week1_qty: 5, requests: [{ id: 101, quantity: 3, demand_type: 'warehouse_request', request_reason_code: 'inventory_stock_topup', person_name: '仓库甲' }] }], total: 1 } });
      }
      if (url.pathname === '/api/procurement/ledger') return route.fulfill({ json: { product: { id: 11, name: '测试主体' }, physical_estimate: 10, available_estimate: 6, flow_summary: { physical: 10, order_demand: 1, safety: 3, locked: 0, free: 6, incoming: 0, incoming_assigned: 0, orders: [], applications: [], purchases: [] }, orders: [], movements: [], purchases: [], batches: [], sources: [] } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { rows: [] } });
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(n => n.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html?orders');
    await page.getByRole('button', { name: '提醒采购', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '提醒采购 · 库存补足', exact: true });
    await dialog.waitFor();
    await dialog.locator('.el-select__wrapper').click();
    await page.getByRole('option').filter({ hasText: '配件' }).click();
    await dialog.getByRole('spinbutton').fill('3');
    await dialog.getByRole('textbox').fill('实物盘点缺少配件');
    await dialog.getByRole('button', { name: '提交并提醒' }).click();
    await page.getByText('测试网络失败，请重试', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '提交并提醒' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(posted.length, 2); assert.deepEqual(posted[0], posted[1]);
    assert.equal(posted[0].product_id, 12); assert.equal(posted[0].quantity, 3);
    assert.equal(posted[0].tenant_id, undefined);
    await page.getByRole('button', { name: '提醒采购', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('erp:auth-scope-changed')));
    await dialog.waitFor({ state: 'hidden' });
    await page.goto('http://localhost:8788/admin.html');
    await page.locator('.purchase-demand-heading').getByText('库存补足', { exact: true }).waitFor();
    assert.equal(queries[0], 'all');
    assert.deepEqual(await page.locator('.erp-filter-bar .el-form-item__label').allTextContents(), ['需求类型', '关键词', '供应商', '采购负责人', '采购平台']);
    assert.deepEqual(await page.locator('.erp-filter-bar__actions button').allTextContents(), ['查询', '重置', '导出采购记录', '采购选中（0）', '＋ 自由采购']);
    assert.equal(await page.getByRole('columnheader', { name: '需求原因', exact: true }).count(), 0);
    await page.getByText('30天 30', { exact: true }).waitFor();
    await page.getByText('三周 3 → 4 → 5', { exact: true }).waitFor();
    await page.getByRole('button', { name: '库存明细', exact: true }).click();
    const ledger = page.getByRole('dialog', { name: '库存明细与历史核对', exact: true });
    await ledger.getByText('库存流转与占用', { exact: true }).waitFor();
    await ledger.getByText('可用库存', { exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/stock-topup-shared-ledger.png', animations: 'disabled' });
    await ledger.getByRole('button', { name: 'Close this dialog' }).click();
    await ledger.waitFor({state:'hidden'});
    for (const width of [1920,1366]) {
      await page.setViewportSize({width,height:1000});
      const bar=page.locator('.erp-filter-bar');
      for (const button of await bar.getByRole('button').all()) { const b=await button.boundingBox(); if (b) assert.ok(b.x>=0&&b.x+b.width<=width,'toolbar stays inside viewport'); }
      await page.screenshot({path:`/tmp/stock-topup-workspace-${width}.png`,animations:'disabled'});
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
