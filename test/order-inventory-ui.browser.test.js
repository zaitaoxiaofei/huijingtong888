import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('compact inventory opens lazy component table and preserves management/receipt actions', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-overview-'));
  let browser;
  const errors = [], requests = [];
  let releaseSlow, delayAccessory = false, saved = false, failAccessory = false;
  const row = {
    id: 1, statusLabel: '等待发货', productDisplayRows: [], logisticsSummary: {}, profitSummary: {},
    availableActions: { showPurchase: true }, unboundItems: [], cancelCategoryText: '--', cancelReasonText: '--',
    procurementState: { hasOrderIncoming: true, inboundDetails: { quantity: 1 }, canRegisterOrderReceipt: true },
    inventorySummaries: [{ productId: 10, sku: 'SKU-1', inventoryMode: 'single', productName: '汽车装饰套装',
      inventoryNumber: '2-10', componentCount: 2, stock: { local: -5, fbp: 10 }, incoming: 1,
      pickingItems: [
        { product_id: 11, product_name: '不锈钢门槛条', inventory_number: '2-11', required_quantity: 1 },
        { product_id: 12, product_name: '车标贴片', inventory_number: '2-12', required_quantity: 1 }
      ] }],
    procurement_coverage: { needs_fulfillment: true, stock_location: 'LOCAL', inventory_needs_review: true, items: [
      { product_id: 11, product_name: '不锈钢门槛条', quantity: 1, stock_quantity: 0, incoming_quantity: 0, shortage_quantity: 1 },
      { product_id: 12, product_name: '车标贴片', quantity: 1, stock_quantity: 0, incoming_quantity: 1, shortage_quantity: 0 }
    ] }
  };
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'inventory-fixture', resolveId(id) { if (id === 'virtual:inventory') return '\0inventory'; },
      load(id) { if (id === '\0inventory') return `import {createApp,h,ref} from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Table from '/frontend/orders/components/OrdersTable.vue'; createApp({setup(){const event=ref('');return ()=>h('div',[h(Table,{rows:[${JSON.stringify(row)}],tableHeight:700,onEditInventoryProduct:id=>event.value='edit:'+id,onInventorySaved:()=>event.value='saved',onViewInventoryDetail:(row,id)=>event.value='detail:'+id,onConfirmProcurementInbound:row=>event.value='receipt:'+row.id}),h('p',{id:'event'},event.value)])}}).use(ElementPlus).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:inventory', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        requests.push(url.pathname + url.search);
        if (url.pathname === '/api/procurement/ledger' && route.request().method() === 'GET') {
          const id = Number(url.searchParams.get('product_id'));
          if (id === 12 && failAccessory) return route.fulfill({ status: 503, json: { error: '测试网络暂不可用' } });
          if (id === 12 && delayAccessory) await new Promise(resolve => { releaseSlow = resolve; });
          return route.fulfill({ json: { product: { id, name: id === 11 ? '不锈钢门槛条' : '车标贴片', code: `P-${id}` }, revision: 'v1',
            physical_estimate: saved ? 1 : 0, available_estimate: 0, current_stock_reserved: saved ? 1 : 0, incoming_quantity: 1, current_incoming: 0, current_shortage: saved ? 0 : 1,
            local_stock: -5, missing_purchase: 5, missing_receipt: 0, purchase_quantity: 0, received_quantity: 0,
            orders: [{ order_id: 1, order_item_id: id, posting_number: 'ORDER-1', needs_fulfillment: true, quantity: 1, stock_quantity: saved ? 1 : 0, incoming_quantity: 0, shortage_quantity: saved ? 0 : 1 }],
            movements: [], actions: [], purchases: [], cost_tasks: [], batches: [], sources: [] } });
        }
        if (url.pathname.startsWith('/api/procurement/ledger') && route.request().method() === 'POST') {
          if (!url.pathname.endsWith('/preview')) saved = true;
          return route.fulfill({ json: { local_before: -5, local_after: 1, physical_after: 1 } });
        }
        return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#4366cc"/></svg>' });
      }
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>' });
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByText('组合库存 · 2 种子产品').waitFor();
    assert.equal(await page.getByText('1 种缺货 · 1 种已覆盖').count(), 1);
    assert.equal(await page.getByRole('button', { name: '编辑库存', exact: true }).count(), 0);
    await page.getByRole('button', { name: '修改库存', exact: true }).click();
    assert.equal(await page.locator('#event').innerText(), 'edit:10');
    assert.equal(requests.length, 0, 'no per-row image or ledger requests on list');
    await page.getByRole('button', { name: '登记实收', exact: true }).click();
    assert.equal(await page.locator('#event').innerText(), 'receipt:1');
    await page.getByRole('button', { name: '库存明细' }).click();
    const drawer = page.getByRole('dialog', { name: '库存明细与历史核对' });
    await drawer.getByText('库存 ID：2-11', { exact: true }).waitFor();
    assert.match(await drawer.innerText(), /不锈钢门槛条/);
    assert.match(await drawer.innerText(), /车标贴片/);
    await drawer.getByRole('tab', { name: '订单分配', exact: true }).waitFor();
    assert.equal(await page.locator('.el-drawer').count(), 0, 'no intermediate drawer');
    assert.equal(await page.getByRole('dialog').count(), 1, 'viewing stock uses one overlay');
    assert.deepEqual(requests.filter(url => url.startsWith('/api/procurement/ledger')), ['/api/procurement/ledger?product_id=11'], 'only the selected shortage product loads');
    assert.equal(requests.some(url => url.startsWith('/api/products?')), false, 'order context does not search all products');
    assert.equal(await drawer.getByRole('tab').count(), 5);
    assert.equal(await drawer.getByRole('button', { name: '绑定子产品', exact: true }).count(), 0);
    await drawer.getByRole('button', { name: '更多操作' }).hover();
    await page.getByRole('menuitem', { name: '绑定管理' }).click();
    await drawer.getByRole('button', { name: '绑定子产品', exact: true }).waitFor();
    delayAccessory = true;
    const accessoryRequest = page.waitForRequest('**/api/procurement/ledger?product_id=12');
    await drawer.getByRole('button', { name: '车标贴片', exact: true }).click();
    await accessoryRequest;
    await drawer.getByRole('button', { name: '不锈钢门槛条', exact: true }).click();
    await drawer.getByText('P-11', { exact: true }).waitFor();
    releaseSlow();
    await drawer.getByRole('tab', { name: '采购与成本', exact: true }).click();
    await drawer.getByRole('button', { name: '核对现货', exact: true }).click();
    const form = page.getByRole('dialog', { name: '本地盘点调整', exact: true });
    await form.getByRole('spinbutton').fill('1');
    await form.getByRole('textbox').fill('库管实盘为1件');
    await form.getByRole('button', { name: '预览影响' }).click();
    await form.getByRole('button', { name: '确认保存纠正记录' }).click();
    await page.waitForFunction(() => document.querySelector('#event').textContent === 'saved');
    assert.equal(await drawer.getByRole('tab', { name: '采购与成本', exact: true }).getAttribute('aria-selected'), 'true', 'save preserves tab');
    assert.equal(await drawer.getByText('P-11', { exact: true }).count(), 1, 'late accessory result cannot replace selected product');
    const selected = drawer.locator('.selected-inventory-row');
    assert.match(await selected.innerText(), /不锈钢门槛条/);
    assert.equal(await selected.locator('td').last().innerText(), '0', 'save refreshes this order coverage in place');
    delayAccessory = false;
    failAccessory = true;
    await drawer.getByRole('button', { name: '车标贴片', exact: true }).click();
    await drawer.getByText('库存明细加载失败，请点击刷新对账重试', { exact: true }).waitFor();
    assert.equal(await drawer.getByText('P-11', { exact: true }).count(), 0, 'failure never shows the old product ledger');
    failAccessory = false;
    await drawer.getByRole('button', { name: '刷新对账', exact: true }).click();
    await drawer.getByText('P-12', { exact: true }).waitFor();
    await drawer.getByRole('button', { name: '不锈钢门槛条', exact: true }).click();
    await drawer.getByText('P-11', { exact: true }).waitFor();
    await drawer.getByRole('tab', { name: '订单分配', exact: true }).click();
    if (process.env.INVENTORY_UI_SCREENSHOT) await page.screenshot({ path: process.env.INVENTORY_UI_SCREENSHOT });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
