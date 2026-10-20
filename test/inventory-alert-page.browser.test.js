import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('inventory alert desktop toolbar stays compact and lead time controls save both values', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-alert-page-'));
  let browser;
  const requests = [];
  const stockModes = [];
  const errors = [];
  const row = {
    product_id: 10, product_name: '测试库存', inventory_number: '1-10', image_url: '',
    available_stock: 8, physical_stock: 10, incoming_stock: 0, open_order_demand_qty: 2,
    production_lead_days: 7, warehouse_logistics_days: 2,
    recent_7d_qty: 14, recent_15d_qty: 30, recent_30d_qty: 60, daily_sales_7d: 2,
    alert_quantity: 18, suggested_purchase_qty: 10, alert_type: 'low_stock',
    shops: [], skus: [], shop_count: 0, sku_count: 0
  };
  const fbpRow = {
    ...row, shop_name: '测试店铺', ozon_sku: 'FBP-TEST-1', offer_id: 'OFFER-1',
    product_all_time_qty: 100, all_time_qty: 50, older_7d_qty: 20, prev_7d_qty: 12,
    recent_7d_qty: 7, fbp_available: 30, suggested_qty: 25,
    local_physical_stock: 10, local_available_stock: 8,
    trend_type: 'continuous_decline', trend_text: '连续下滑，待复核'
  };
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'inventory-alert-page-fixture',
      resolveId(id) { if (id === 'virtual:inventory-alert-page') return '\0inventory-alert-page'; },
      load(id) {
        if (id === '\0inventory-alert-page') return `import { createApp, h } from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import '/frontend/admin/styles/index.css'; import { createPinia } from 'pinia'; import { createRouter, createMemoryHistory, RouterView } from 'vue-router'; import Page from '/frontend/admin/views/inventory/InventoryAlertsPage.vue'; import InventoryView from '/frontend/admin/views/inventory/InventoryView.vue'; import { useAuthStore } from '/frontend/admin/stores/auth.js'; const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inventory', component: InventoryView, children: [{ path: 'alerts', name: 'inventory-alerts', meta: { title: '库存预警' }, component: Page }] }] }); const pinia = createPinia(); const auth = useAuthStore(pinia); auth.user = { roles: ['manager'] }; const app = createApp({ render: () => h('main', { class: 'fixture-shell' }, h(RouterView)) }); app.use(pinia).use(router).use(ElementPlus); router.push('/inventory/alerts').then(() => app.mount('#app'));`;
      }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:inventory-alert-page', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"><style>html,body,#app{height:100%;margin:0}.fixture-shell{width:calc(100vw - 220px);height:100%;margin-left:220px;overflow:hidden}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === '/api/stock-alerts') {
        const mode = url.searchParams.get('mode');
        stockModes.push(mode);
        if (mode === 'fbp-operations') assert.equal(url.searchParams.get('fbpFocus'), 'replenishment');
        return route.fulfill({ json: { rows: [mode === 'fbp-operations' ? fbpRow : row], total: 1, meta: { low_stock: 1, out_of_stock: 0, in_transit: 0, healthy: 0 } } });
      }
      if (url.pathname === '/api/shops') return route.fulfill({ json: [] });
      if (url.pathname === '/api/inventory/ledger' && route.request().method() === 'GET') return route.fulfill({ json: { product: { id: 10, name: '测试库存', inventory_number: '1-10' }, revision: 'v1', physical_estimate: 10, available_estimate: 8, open_order_demand: 2, fbp_reserved: 0, current_stock_reserved: 2, incoming_quantity: 0, current_incoming: 0, current_shortage: 0, orders: [], movements: [], actions: [] } });
      if (url.pathname === '/api/inventory/products/lead-times' && route.request().method() === 'POST') {
        requests.push(route.request().postDataJSON());
        row.production_lead_days = requests.at(-1).production_lead_days;
        row.warehouse_logistics_days = requests.at(-1).warehouse_logistics_days;
        return route.fulfill({ json: { ok: true, product_id: 10, production_lead_days: row.production_lead_days, warehouse_logistics_days: row.warehouse_logistics_days } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 403, json: { error: 'Unexpected API route' } });
      const asset = url.pathname === '/style.css'
        ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css')))
        : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByText('测试库存').waitFor();
    const layout = await page.evaluate(() => {
      const box = selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      const table = document.querySelector('.inventory-table-wrap');
      return {
        title: box('.erp-page-header__copy'),
        viewButtons: box('.inventory-header-status'),
        status: box('.alert-status-filters'),
        search: box('.inventory-toolbar-form .el-input'),
        searchAction: box('.erp-filter-bar__actions'),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        tableScrollable: [table, ...table.querySelectorAll('.el-scrollbar__wrap, .el-table__body-wrapper')]
          .some(element => element.scrollWidth > element.clientWidth)
      };
    });
    assert.ok(layout.viewButtons.x > layout.title.x + layout.title.width, 'view tabs sit beside the title');
    assert.ok(Math.abs(layout.viewButtons.y - layout.title.y) < 25, 'view tabs and title share one row');
    assert.ok(Math.abs(layout.status.y - layout.search.y) < 25, 'status and search share one desktop row');
    assert.ok(Math.abs(layout.search.y - layout.searchAction.y) < 25, 'search actions share the same row');
    assert.ok(layout.documentWidth <= layout.viewportWidth, 'wide table stays inside its scroll frame');
    await page.screenshot({ path: '/tmp/inventory-alert-ui-desktop.png', animations: 'disabled' });
    await page.setViewportSize({ width: 1280, height: 960 });
    const narrow = await page.evaluate(() => {
      const table = document.querySelector('.inventory-table-wrap');
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        tableScrollable: [table, ...table.querySelectorAll('.el-scrollbar__wrap, .el-table__body-wrapper')]
          .some(element => element.scrollWidth > element.clientWidth)
      };
    });
    assert.ok(narrow.documentWidth <= narrow.viewportWidth, 'narrow desktop still has no page-wide overflow');
    assert.equal(narrow.tableScrollable, true, 'narrow desktop can scroll the table internally');
    await page.setViewportSize({ width: 1600, height: 960 });

    await page.getByRole('button', { name: '修改时长' }).first().click();
    const leadDialog = page.getByRole('dialog', { name: '修改库存周转时间' });
    const selectors = leadDialog.locator('.el-select');
    await selectors.nth(0).click();
    await page.getByRole('option', { name: '10 天' }).click();
    await selectors.nth(1).click();
    await page.getByRole('option', { name: '3 天' }).last().click();
    await leadDialog.getByRole('button', { name: '保存时长' }).click();
    assert.deepEqual(requests, [{
      product_id: 10, production_lead_days: 10, warehouse_logistics_days: 3,
      expected_production_lead_days: 7, expected_warehouse_logistics_days: 2
    }]);
    await page.getByRole('tab', { name: 'FBP SKU 视角' }).click();
    await page.getByRole('columnheader', { name: 'FBP SKU' }).waitFor();
    await page.getByText('库存合计 100').waitFor();
    await page.getByRole('columnheader', { name: '本 SKU 建议备货' }).waitFor();
    await page.getByRole('button', { name: '创建备货单' }).waitFor();
    await page.getByText('连续下滑，待复核').waitFor();
    await page.screenshot({ path: '/tmp/inventory-alert-fbp-operations.png', animations: 'disabled' });
    assert.deepEqual(stockModes, ['inventory-alerts', 'inventory-alerts', 'fbp-operations'], 'switching view makes one SKU request');
    await page.getByRole('tab', { name: '库存视角' }).click();
    await page.getByRole('columnheader', { name: '库存分析' }).waitFor();
    assert.deepEqual(stockModes, ['inventory-alerts', 'inventory-alerts', 'fbp-operations', 'inventory-alerts'], 'switching back makes one inventory request');
    await page.locator('.inventory-alert-table').getByRole('button', { name: '更新本地库存' }).click();
    await page.getByRole('dialog', { name: '更新本地库存' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(output, { recursive: true, force: true });
  }
});
