import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';

test('historical receipt requires a physical count, submits selected batches, and preserves normal receipt', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const source = await fs.readFile('frontend/orders/OrdersPage.vue', 'utf8');
  const state = source.slice(source.indexOf('const procurementReceiptDialog ='), source.indexOf('async function previewShippedReceipts'));
  const confirm = source.slice(source.indexOf('async function confirmProcurementReceipt()'), source.indexOf('function buildTableRow('));
  const start = source.indexOf('<el-dialog v-model="procurementReceiptDialog.visible"');
  const template = source.slice(start, source.indexOf('</el-dialog>', start) + '</el-dialog>'.length);
  const fixture = `<script setup>
    import { reactive, ref, computed } from 'vue'; import { ElMessage } from 'element-plus';
    const apiClient = { post: async (url, body) => { window.submission = body; } };
    const confirmingInboundRecordId = ref(0), loadOrders = async () => {}, formatDateTime = value => value;
    ${state}
    ${confirm}
    function open() { Object.assign(procurementReceiptDialog, { visible: true, mode: 'historical', counts: {}, requestKey: 'test-receipt-count-001',
      batches: [{ id: 1, product_name: '测试库存', stock_unit: '件', selected: true, quantity: 100, receive_quantity: 100 },
        { id: 2, product_name: '测试库存', stock_unit: '件', selected: false, quantity: 200, receive_quantity: 200 }],
      impacts: [1, 2].map(id => ({ id, product_id: 10, product_name: '测试库存', unit: '件', stock_before: 30, revision: 'v1', historical_outbound_quantity: 70 })) }); }
    open();
    </script><template><button @click="open">重新打开</button>${template}</template>`;
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-count-browser-'));
  let browser;
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'receipt-fixture', resolveId(id) { if (id === 'virtual:entry') return '\0entry'; if (id === '/Fixture.vue') return id; },
      load(id) { if (id === '/Fixture.vue') return fixture; if (id === '\0entry') return `import {createApp} from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import App from '/Fixture.vue'; createApp(App).use(ElementPlus).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:entry', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.route('http://localhost:8788/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<div id="app"></div><script type="module" src="/entry.js"></script><link rel="stylesheet" href="/style.css">' });
      const asset = pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByRole('button', { name: '确认实收入库' }).click();
    assert.equal(await page.evaluate(() => window.submission), undefined);
    await page.getByPlaceholder('无货填 0').fill('30');
    await page.screenshot({ path: '/tmp/historical-receipt-count.png', animations: 'disabled' });
    await page.getByRole('button', { name: '确认实收入库' }).click();
    const historical = await page.evaluate(() => window.submission);
    assert.equal(historical.historical_receipt_groups[0].counted_quantity, 30);
    assert.deepEqual(historical.historical_receipt_groups[0].receipts.map(row => row.id), [1]);
    await page.getByRole('button', { name: '重新打开' }).click();
    await page.getByText('本次新到货', { exact: true }).click();
    await page.getByRole('button', { name: '确认实收入库' }).click();
    const normal = await page.evaluate(() => window.submission);
    assert.equal(normal.historical_receipt_groups, undefined);
    assert.equal(normal.records[0].payload.receive_quantity, 100);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
