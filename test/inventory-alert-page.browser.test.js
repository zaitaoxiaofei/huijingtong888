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
  const errors = [];
  const row = {
    product_id: 10, product_name: '测试库存', inventory_number: '1-10', image_url: '',
    available_stock: 8, physical_stock: 10, incoming_stock: 0, open_order_demand_qty: 2,
    production_lead_days: 7, warehouse_logistics_days: 2,
    recent_7d_qty: 14, recent_15d_qty: 30, recent_30d_qty: 60, daily_sales_7d: 2,
    alert_quantity: 18, suggested_purchase_qty: 10, alert_type: 'low_stock',
    shops: [], skus: [], shop_count: 0, sku_count: 0
  };
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'inventory-alert-page-fixture',
      resolveId(id) { if (id === 'virtual:inventory-alert-page') return '\0inventory-alert-page'; },
      load(id) {
        if (id === '\0inventory-alert-page') return `import { createApp, h } from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import '/frontend/admin/styles/index.css'; import { createPinia } from 'pinia'; import { createRouter, createMemoryHistory } from 'vue-router'; import Page from '/frontend/admin/views/inventory/InventoryAlertsPage.vue'; import { useAuthStore } from '/frontend/admin/stores/auth.js'; const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inventory/alerts', component: Page }] }); const pinia = createPinia(); const auth = useAuthStore(pinia); auth.user = { roles: ['manager'] }; const app = createApp({ render: () => h('main', { class: 'fixture-shell' }, h(Page)) }); app.use(pinia).use(router).use(ElementPlus); router.push('/inventory/alerts').then(() => app.mount('#app'));`;
      }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:inventory-alert-page', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"><style>html,body,#app{height:100%;margin:0}.fixture-shell{width:calc(100vw - 220px);height:100%;margin-left:220px;overflow:hidden}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === '/api/stock-alerts') return route.fulfill({ json: { rows: [row], total: 1, meta: { low_stock: 1, out_of_stock: 0, in_transit: 0, healthy: 0 } } });
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
        view: box('.alert-view-switch'),
        viewButtons: box('.alert-view-buttons'),
        status: box('.alert-status-filters'),
        search: box('.inventory-toolbar-form .el-input'),
        searchAction: box('.erp-filter-bar__actions'),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        tableScrollable: [table, ...table.querySelectorAll('.el-scrollbar__wrap, .el-table__body-wrapper')]
          .some(element => element.scrollWidth > element.clientWidth)
      };
    });
    assert.ok(layout.viewButtons.x > layout.view.x + layout.view.width / 2, 'view tabs sit at the upper right');
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

    await page.getByRole('button', { name: '编辑' }).first().click();
    const selectors = page.locator('.inventory-alert-table .el-select');
    await selectors.nth(0).click();
    await page.getByRole('option', { name: '10 天' }).click();
    await selectors.nth(1).click();
    await page.getByRole('option', { name: '3 天' }).last().click();
    await page.getByRole('button', { name: '保存时长' }).click();
    assert.deepEqual(requests, [{
      product_id: 10, production_lead_days: 10, warehouse_logistics_days: 3,
      expected_production_lead_days: 7, expected_warehouse_logistics_days: 2
    }]);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(output, { recursive: true, force: true });
  }
});
