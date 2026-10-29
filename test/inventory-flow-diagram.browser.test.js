import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const orders = [
  { order_id: 11, posting_number: 'ORDER-A', shop_name: '店铺A', quantity: 6, stock_quantity: 6, incoming_quantity: 0, ordered_at: '2026-10-29T00:00:00Z' },
  { order_id: 12, posting_number: 'ORDER-B', shop_name: '店铺B', quantity: 4, stock_quantity: 4, incoming_quantity: 0, ordered_at: '2026-10-29T01:00:00Z' }
];
const ledger = { product: { id: 1 }, physical_estimate: 200, open_order_demand: 10, fbp_reserved: 90,
  incoming_quantity: 300, current_incoming: 0, available_estimate: 100,
  last_stocktake_at: '2026-10-28T09:32:00Z', fbp_inventory: { incomplete: true },
  flow_summary: { safety: 100, free: 0, requested: 150, local_days: 10, fbp_days: 17,
    safety_status: '未来需求，不含实际订单', orders,
    applications: [{ order_id: 31, order_no: 'FBP-A', shop_name: '店铺A', ozon_sku: 'SKU-A', applicant_name: '运营小李', requested_quantity: 150, locked_quantity: 90, status: 'approved' }],
    purchases: [{ id: 2, order_no: 'PO-A', person_name: '采购小陈', pending_quantity: 300 }] } };

test('flow graph previews real node metadata, navigates exact documents, and fits light/dark desktop/mobile', {
  skip: process.env.RUN_TASK_BROWSER_TESTS !== '1', timeout: 120000
}, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-flow-browser-'));
  let browser;
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'inventory-flow-fixture', resolveId(id) { if (id === 'virtual:flow') return '\0flow'; },
      load(id) { if (id === '\0flow') return `import { createApp, ref, h } from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import 'element-plus/theme-chalk/dark/css-vars.css'; import {createRouter,createMemoryHistory} from 'vue-router'; import Flow from '/frontend/admin/components/procurement/InventoryFlowDiagram.vue'; const router=createRouter({history:createMemoryHistory(),routes:[{path:'/:pathMatch(.*)*',component:{template:'<div />'}}]}); const ledger=ref(${JSON.stringify(ledger)});window.testLedger=ledger;router.afterEach(to=>window.lastFlowNavigation=to.fullPath);const app=createApp({setup(){return ()=>h(Flow,{ledger:ledger.value})}});app.use(ElementPlus).use(router).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:flow', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Flow fixture error:', error.message); });
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:var(--el-bg-color)}#app{padding:20px;max-width:1360px;margin:auto}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    try { await page.locator('[data-node="orders"]').waitFor({ timeout: 7000 }); }
    catch (error) { console.error('fixture diagnostics', JSON.stringify(await page.evaluate(() => ({ html: document.body.innerHTML.slice(0, 1600), scripts: [...document.scripts].map(s => s.src), state: Boolean(window.testLedger) })))); throw error; }
    await page.locator('[data-node="orders"]').hover();
    await page.locator('.inventory-flow-popover:visible').getByText('店铺A · ORDER-A', { exact: true }).waitFor();
    await page.locator('[data-node="orders"]').click();
    await page.locator('.flow-node-detail').getByText('ORDER-B', { exact: true }).waitFor();
    await page.locator('.flow-node-detail').getByRole('button', { name: '打开订单' }).first().click();
    assert.equal(await page.evaluate(() => window.lastFlowNavigation), '/orders?orderId=11');
    await page.locator('[data-node="application"]').hover();
    await page.locator('.inventory-flow-popover:visible').getByText('申请人 运营小李 · 已审核待发', { exact: true }).waitFor();
    await page.locator('[data-node="application"]').click();
    assert.equal(await page.evaluate(() => window.lastFlowNavigation), '/inventory/fbp-replenishment?orderId=31');
    await page.locator('[data-node="safety"]').click();
    await fs.mkdir('.verification', { recursive: true });
    for (const [width, height, dark] of [[1920,1080,false],[1920,1080,true],[1366,900,false],[1366,900,true],[390,844,false]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
      await page.mouse.move(0, 0);
      await page.locator('.inventory-flow-popover:visible').first().waitFor({ state: 'hidden' });
      await page.locator('.flow-canvas').screenshot({ path: `.verification/inventory-flow-${width}-${dark ? 'dark' : 'light'}.png`, animations: 'disabled' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}`);
      assert.equal(await page.locator('.flow-node').count(), 11);
      if (width >= 1366) {
        const centers = await page.locator('[data-node="incoming"], [data-node="physical"], [data-node="free"]').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return r.top + r.height / 2; }));
        assert.ok(Math.max(...centers) - Math.min(...centers) < 1, 'purchase, physical and available stock share one horizontal line');
        await page.locator('[data-node="free"]').getByText('可用库存', { exact: true }).waitFor();
      }
      const fits = await page.locator('.flow-node').evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth + 1));
      assert.equal(fits, true, `node labels fit at ${width}`);
    }
    await page.evaluate(() => { window.testLedger.value = { ...window.testLedger.value, flow_summary: { unavailable: true, message: '预测暂不可用' } }; });
    await page.locator('[data-node="free"]').getByText('待核对', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
