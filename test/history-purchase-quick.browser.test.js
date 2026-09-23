import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { shanghaiDateKey } from '../frontend/admin/utils/shanghai-date.js';

test('order row opens one grouped history purchase entry', async () => {
  const source = await fs.readFile('frontend/orders/components/OrdersTable.vue', 'utf8');
  assert.match(source, /v-if="historyPurchaseProducts\(row\).length"[^>]+emit\('quick-history-purchase', historyPurchaseProducts\(row\)\)/);
  assert.doesNotMatch(source, /v-for="product in historyPurchaseProducts/);
});

test('history table defaults dates, removes rows, validates and retries only unsaved rows', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'history-purchase-table-'));
  let browser;
  const requests = [], errors = [];
  let failSecond = true;
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [vue(), {
      name: 'quick-fixture', resolveId(id) { if (id === 'virtual:quick') return '\0quick'; },
      load(id) { if (id === '\0quick') return `import {createApp,ref,h} from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Dialog from '/frontend/admin/components/procurement/HistoricalPurchaseQuickDialog.vue'; createApp({setup(){const open=ref(true);return ()=>open.value?h(Dialog,{products:[{id:10},{id:11},{id:12},{id:10}],onClose:()=>open.value=false}):h('p','closed')}}).use(ElementPlus).mount('#app');`; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:quick', output: { entryFileNames: 'entry.js' } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:8788/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === '/api/procurement/ledger' && route.request().method() === 'GET') {
        const id = Number(url.searchParams.get('product_id'));
        return route.fulfill({ json: { product: { id, name: `库存 ${id}`, code: `P-${id}`, inventory_number: `2-${id}`, image_url: id === 10 ? '/photo.svg' : '' }, revision: `v${id}`, missing_purchase: 5, missing_receipt: 0,
          orders: [{ order_item_id: id, posting_number: `OLD-${id}`, entered_transport: true, transport_at: '2026-08-02T00:00:00Z', missing_purchase_quantity: 5 }] } });
      }
      if (url.pathname === '/photo.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#4366cc"/></svg>' });
      if (url.pathname.startsWith('/api/procurement/ledger') && route.request().method() === 'POST') {
        const payload = route.request().postDataJSON();
        requests.push({ path: url.pathname, payload });
        if (url.pathname === '/api/procurement/ledger' && payload.product_id === 11 && failSecond) {
          failSecond = false;
          return route.fulfill({ status: 503, json: { error: '模拟响应中断' } });
        }
        return route.fulfill({ json: { ok: true, local_delta: payload.reconcile_stock ? 4 : 0, local_before: -5, local_after: payload.reconcile_stock ? -1 : -5 } });
      }
      const asset = url.pathname === '/style.css' ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css'))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html');
    const dialog = page.getByRole('dialog', { name: '补齐历史采购记录' });
    await dialog.getByText('库存 12', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '删除子记录' }).count(), 3);
    assert.equal(await dialog.getByPlaceholder('请选择实际采购时间').first().inputValue(), `${shanghaiDateKey()} 00:00:00`);
    assert.match(await dialog.innerText(), /库存 ID：2-10/);
    await dialog.locator('.el-image').click();
    await page.locator('.el-image-viewer__wrapper').waitFor();
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: '删除子记录' }).last().click();
    assert.equal(await dialog.getByRole('button', { name: '删除子记录' }).count(), 2);
    const inputs = dialog.getByRole('spinbutton');
    await inputs.nth(1).fill('50');
    await inputs.nth(4).fill('30');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('请处理表格中标红的行，已填内容不会丢失。', { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    assert.equal(await inputs.nth(1).inputValue(), '50.00');
    for (const input of await dialog.getByPlaceholder('请选择实际采购时间').all()) {
      await input.fill('2026-08-01 12:00:00'); await input.press('Tab');
    }
    assert.equal(await dialog.locator('.history-error').count(), 0, 'date correction clears stale validation messages');
    if (process.env.HISTORY_TABLE_SCREENSHOT) await page.screenshot({ path: process.env.HISTORY_TABLE_SCREENSHOT });
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.getByText('已保存', { exact: true }).waitFor();
    await dialog.getByRole('alert').filter({ hasText: '模拟响应中断' }).waitFor();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('closed', { exact: true }).waitFor();
    const writes = requests.filter(row => row.path === '/api/procurement/ledger').map(row => row.payload);
    assert.deepEqual(writes.map(row => row.product_id), [10, 11, 11]);
    assert.deepEqual(writes[1], writes[2], 'uncertain response retries with identical payload/key');
    assert.equal(writes[0].amount, 50);
    assert.equal(writes[1].amount, 30);
    assert.equal(writes[0].inventory_effect, 'already_accounted');
    assert.equal(writes[0].purchased_at, '2026-08-01T12:00:00+08:00');
    assert.deepEqual(errors, []);
    requests.length = 0;
    await page.reload();
    await dialog.getByText('库存 12', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('closed', { exact: true }).waitFor();
    assert.equal(requests.length, 0, 'cancel makes no writes');
    await page.reload();
    await dialog.getByText('库存 12', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '删除子记录' }).last().click();
    await dialog.getByRole('button', { name: '删除子记录' }).last().click();
    await dialog.getByRole('spinbutton').nth(1).fill('63');
    const date = dialog.getByPlaceholder('请选择实际采购时间');
    await date.fill('2026-08-01 12:00:00'); await date.press('Tab');
    await dialog.getByText('同时核对现货', { exact: true }).click();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '请填写仓库当前实物数量' }).waitFor();
    assert.equal(requests.length, 0, 'checking stock never defaults an unknown count to zero');
    await dialog.getByPlaceholder('实物数量').fill('0');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认现货核对' });
    await confirmation.getByRole('button', { name: '返回修改' }).click();
    assert.equal(requests.filter(row => row.path === '/api/procurement/ledger').length, 0);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认并保存' }).click();
    await page.getByText('closed', { exact: true }).waitFor();
    const countWrites = requests.filter(row => row.path === '/api/procurement/ledger');
    assert.equal(countWrites.length, 1);
    assert.equal(countWrites[0].payload.reconcile_stock, true);
    assert.equal(countWrites[0].payload.counted_quantity, 0);
  } finally { await browser?.close(); await fs.rm(output, { recursive: true, force: true }); }
});
