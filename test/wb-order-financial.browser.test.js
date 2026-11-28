import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';
import { estimateWbOrderProfit } from '../src/shared/wb-order-profit.js';
import { currentWbTariff } from '../src/shared/wb-logistics-catalog.js';

test('WB order profit configures scoped warehouses, quotes parcels and keeps fee evidence usable on phones', {
  skip: process.env.RUN_TASK_BROWSER_TESTS !== '1', timeout: 180000
}, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-order-financial-browser-'));
  const preferences = new Map(), requests = [], errors = [];
  const evidence = {
    order_id: 17, wb_order_id: 6339198672, revenue_cny: 56.55, posted_inventory_cost_cny: null,
    estimate_inputs: {
      shop_id: 20, subject_id: 3373, ordered_at: '2026-11-27T06:45:37Z',
      purchaseCost: 4.3, domesticCost: 1, weight: 200, length: 15, width: 15, height: 5
    },
    settlement: { state: 'pending', lines: [], amounts: [], amounts_cny: {}, net_settlement_cny: null, actual_profit_cny: null }
  };
  let browser, failPreferenceRead = false, failRecalculation = false, holdEvidence = false, heldEvidence, evidenceHeld;
  try {
    await build({
      configFile: false, root: process.cwd(), publicDir: false, logLevel: 'error',
      plugins: [vue(), {
        name: 'wb-order-financial-fixture',
        resolveId(id) { if (id === 'virtual:wb-order-financial') return '\0wb-order-financial'; },
        load(id) {
          if (id === '\0wb-order-financial') return `
            import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';
            import ElementPlus from 'element-plus';import zhCn from 'element-plus/es/locale/lang/zh-cn';
            import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';
            import Dialog from '/frontend/orders/components/WbOrderFinancialDialog.vue';
            import {useAuthStore} from '/frontend/admin/stores/auth.js';
            import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';
            const tenant=Number(new URL(location.href).searchParams.get('tenant')||2);
            const readOnly=new URL(location.href).searchParams.has('readonly');
            const user={id:1,personId:1,roles:readOnly?['packing']:['admin'],tenant:{id:tenant,slug:'wb-profit-'+tenant,role:readOnly?'member':'owner'}};
            localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('wb-profit-browser-only');currentApiCacheScope();
            const app=createApp({setup(){const opened=ref(true),refreshes=ref(0);return()=>h('main',[
              h('button',{id:'reopen',onClick:()=>opened.value=true},'重新查看利润'),
              h('output',{id:'refresh-count'},String(refreshes.value)),
              opened.value?h(Dialog,{row:{id:17,posting_number:'WB-6339198672'},onClose:()=>opened.value=false,onRecalculated:()=>refreshes.value++}):null
            ]);}});app.use(createPinia());const auth=useAuthStore();auth.user=user;
            window.switchProfitTestTenant=id=>{const next={...user,tenant:{...user.tenant,id}};auth.user=next;localStorage.setItem('baodanAuthUser',JSON.stringify(next));currentApiCacheScope();};
            app.use(ElementPlus,{locale:zhCn});app.mount('#app');
          `;
        }
      }],
      build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: 'virtual:wb-order-financial', output: { entryFileNames: 'entry.js' } } }
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== 'http://localhost:8788') return route.abort();
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body{margin:0;background:var(--erp-bg);font-family:Arial,"Microsoft YaHei",sans-serif}#app{padding:20px}*,*:before,*:after{box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname.startsWith('/api/')) {
        const body = request.method() === 'POST' ? request.postDataJSON() : null;
        requests.push({ method: request.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), body });
        if (url.pathname === '/api/wb/orders/financial-evidence') {
          if (holdEvidence) { heldEvidence = route; evidenceHeld(); return; }
          return route.fulfill({ json: evidence });
        }
        if (url.pathname === '/api/wb/pricing-commissions') return route.fulfill({ json: { rows: [{ id: 3373, category: '汽车钥匙保护套', rate: 20 }] } });
        if (url.pathname === '/api/user-preferences') {
          if (body) { preferences.set(body.key, body.value); return route.fulfill({ json: { ok: true, ...body } }); }
          if (failPreferenceRead) return route.fulfill({ status: 500, json: { error: '测试：仓库配置读取失败' } });
          const key = url.searchParams.get('key');
          return route.fulfill({ json: { key, value: preferences.get(key) ?? null } });
        }
        if (url.pathname === '/api/wb/orders/sync-settlement') return route.fulfill({ json: { fetched: 0, next_cursor: null } });
        if (url.pathname === '/api/wb/orders/recalculate-profit') {
          if (failRecalculation) return route.fulfill({ json: { ok: false, updated_count: 0, results: [{ order_id: 17, status: 'needs_inputs', error: '测试：当前采购成本需要核对' }] } });
          const inputs = { ...body.overrides['17'], sale: evidence.revenue_cny };
          const tariff = currentWbTariff(evidence.estimate_inputs.ordered_at);
          const outputs = estimateWbOrderProfit(inputs, tariff.rows.find(row => row.id === inputs.warehouseId));
          evidence.saved_profit = { inputs, outputs, manual_overrides: { ...body.overrides['17'] }, calculated_at: '2026-11-28T02:30:00Z', revision_id: 7 };
          return route.fulfill({ json: { ok: true, updated_count: 1, results: [{ order_id: 17, status: 'saved', estimated_profit_cny: outputs.profit, provisional: outputs.provisional }] } });
        }
        throw new Error('Unexpected fixture API: ' + request.method() + ' ' + url.pathname);
      }
      const asset = url.pathname === '/style.css'
        ? path.join('assets', (await fs.readdir(path.join(output, 'assets'))).find(name => name.endsWith('.css')))
        : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto('http://localhost:8788/admin.html?tenant=2#/orders');
    const dialog = () => page.getByRole('dialog', { name: 'WB 订单利润明细', exact: true });
    const feeRow = label => dialog().locator('.wb-settlement-rows .el-table__body-wrapper tbody tr').filter({ has: page.getByText(label, { exact: true }) });
    const enterNumber = async (label, value) => {
      const input = page.getByRole('spinbutton', { name: label, exact: true });
      await input.fill(String(value)); await input.press('Tab');
    };
    await dialog().getByRole('button', { name: '配置仓库', exact: true }).click();
    const warehouse = dialog().getByRole('combobox', { name: 'WB 默认揽收仓', exact: true });
    await warehouse.waitFor();
    assert.match(await dialog().locator('.wb-configuration .el-select').innerText(), /合肥/);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0, 'recommended warehouse is not saved before explicit configuration');
    await dialog().getByRole('button', { name: '保存并使用', exact: true }).click();
    await feeRow('跨境物流费').getByText('¥ 13.60', { exact: true }).waitFor();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 24.57', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.path === '/api/wb/orders/recalculate-profit').length, 0, 'preview and warehouse preferences do not silently persist order profit');
    for (const name of ['预估金额', '真实金额', '差异', '说明']) {
      assert.equal(await dialog().locator('.wb-settlement-rows').getByRole('columnheader', { name, exact: true }).count(), 1);
    }
    assert.match(await dialog().innerText(), /支付手续费/);
    const saved = requests.find(request => request.path === '/api/user-preferences' && request.method === 'POST');
    assert.equal(saved.body.key, 'wb.profit.warehouse.2');
    assert.equal(saved.body.value.warehouseId, 382855);
    assert.equal(await feeRow('罚款').count(), 0, 'unavailable penalties stay out of the estimate comparison');
    await fs.mkdir('.verification', { recursive: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark'); });
    await page.locator('.el-message').waitFor({ state: 'hidden' });
    const previewBounds = await page.locator('.el-dialog.wb-profit-dialog').boundingBox();
    await page.screenshot({ path: '.verification/wb-order-financial-preview.png', animations: 'disabled', clip: {
      x: previewBounds.x, y: previewBounds.y, width: previewBounds.width,
      height: Math.min(previewBounds.height, page.viewportSize().height - previewBounds.y)
    } });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.documentElement.classList.remove('dark'); });

    await dialog().locator('.wb-optional-inputs > summary').click();
    await enterNumber('退货率', 10);
    await feeRow('预期退货损失').getByText('¥ 3.16', { exact: true }).waitFor();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 21.41', { exact: true }).waitFor();
    assert.match(await dialog().innerText(), /31\.62/, 'return loss automatically includes goods, domestic and cross-border freight, commission and delegated delivery');
    const manualReturn = dialog().getByRole('checkbox', { name: '手动填写单次退货损失', exact: true });
    const manualReturnLabel = dialog().locator('label.el-checkbox').filter({ hasText: '手动填写单次退货损失' });
    await manualReturnLabel.click();
    assert.equal(await manualReturn.isChecked(), true);
    await enterNumber('单次退货损失', 50);
    await feeRow('预期退货损失').getByText('¥ 5.00', { exact: true }).waitFor();
    await manualReturnLabel.click();
    assert.equal(await manualReturn.isChecked(), false);
    await feeRow('预期退货损失').getByText('¥ 3.16', { exact: true }).waitFor();
    await enterNumber('长', 116);
    await dialog().getByText(/包裹超出该仓限制/).waitFor();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('—', { exact: true }).waitFor();
    assert.equal(await dialog().getByRole('button', { name: '重算并保存利润', exact: true }).isDisabled(), true, 'unquotable packages cannot be saved as a completed profit');
    await enterNumber('长', 15);
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 21.41', { exact: true }).waitFor();

    await dialog().getByRole('button', { name: /配置仓库|修改配置|更换仓库|调整配置|修改仓库与费率/ }).click();
    await enterNumber('支付手续费率', 1);
    await dialog().getByRole('button', { name: '保存并使用', exact: true }).click();
    await feeRow('支付手续费').getByText('¥ 0.57', { exact: true }).waitFor();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 20.84', { exact: true }).waitFor();
    assert.equal(preferences.get('wb.profit.warehouse.2').paymentRates['20'], 1);

    await dialog().getByRole('button', { name: '拉取 WB 正式账单', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.el-message')?.textContent.includes('没有更多'));
    const synced = requests.find(request => request.path === '/api/wb/orders/sync-settlement');
    assert.equal(synced.body.order_id, 17);
    assert.match(synced.body.date_from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(synced.body.date_to, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(synced.body.cursor, null);

    await page.reload();
    await feeRow('跨境物流费').getByText('¥ 13.60', { exact: true }).waitFor();
    await feeRow('支付手续费').getByText('¥ 0.57', { exact: true }).waitFor();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 24.00', { exact: true }).waitFor();
    assert.equal(await dialog().getByRole('button', { name: '保存并使用', exact: true }).count(), 0, 'saved configuration is automatically reused on reopen');
    await enterNumber('采购成本', 5.3);
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 23.00', { exact: true }).waitFor();
    failRecalculation = true;
    await dialog().getByRole('button', { name: '重算并保存利润', exact: true }).click();
    await page.getByText('测试：当前采购成本需要核对', { exact: true }).waitFor();
    assert.equal(await page.locator('#refresh-count').textContent(), '1', 'an incomplete canonical result refreshes the list so a previous known profit cannot remain stale');
    assert.equal(await page.getByText('已重算并保存利润。', { exact: true }).count(), 0, 'an incomplete calculation is not reported as successful');
    assert.equal(evidence.saved_profit, undefined);
    failRecalculation = false;
    await dialog().getByRole('button', { name: '重算并保存利润', exact: true }).click();
    await dialog().getByText(/上次保存/).waitFor();
    assert.equal(await page.locator('#refresh-count').textContent(), '2', 'a successful persisted recalculation requests an order-list refresh');
    const recalculated = requests.filter(request => request.path === '/api/wb/orders/recalculate-profit').at(-1);
    assert.deepEqual(recalculated.body.order_ids, [17]);
    assert.match(recalculated.body.command_id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    assert.equal(new Set(requests.filter(request => request.path === '/api/wb/orders/recalculate-profit').map(request => request.body.command_id)).size, 2, 'each explicit save action starts a distinct retry-safe command');
    assert.equal(recalculated.body.overrides['17'].purchaseCost, 5.3);
    assert.equal(recalculated.body.overrides['17'].warehouseId, 382855);
    assert.equal(recalculated.body.overrides['17'].paymentRate, 1);
    assert.equal(recalculated.body.overrides['17'].returnLoss, null);
    await page.reload();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 23.00', { exact: true }).waitFor();
    assert.equal(await page.getByRole('spinbutton', { name: '采购成本', exact: true }).inputValue(), '5.30', 'saved order inputs win over current product defaults on reopen');
    evidence.saved_profit.manual_overrides.purchaseCost = null;
    evidence.saved_profit.manual_overrides.paymentRate = null;
    evidence.saved_profit.manual_overrides.weight = null;
    await page.reload();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 24.00', { exact: true }).waitFor();
    assert.equal(await page.getByRole('spinbutton', { name: '采购成本', exact: true }).inputValue(), '4.30', 'missing scenario fields fall back to available product data');
    assert.equal(await page.getByRole('spinbutton', { name: '包裹实重', exact: true }).inputValue(), '200');
    await feeRow('支付手续费').getByText('¥ 0.57', { exact: true }).waitFor();
    evidence.saved_profit.manual_overrides.paymentRate = 0;
    await page.reload();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 24.57', { exact: true }).waitFor();
    await feeRow('支付手续费').getByText('¥ 0.00', { exact: true }).waitFor();
    evidence.saved_profit.manual_overrides = {};
    evidence.saved_profit.inputs.warehouseId = null;
    evidence.saved_profit.inputs.paymentRate = null;
    evidence.saved_profit.inputs.weight = null;
    await page.reload();
    await dialog().locator('.wb-profit-summary .wb-profit-value').first().getByText('¥ 24.00', { exact: true }).waitFor();
    assert.equal(await page.getByRole('spinbutton', { name: '采购成本', exact: true }).inputValue(), '4.30', 'automatic audit inputs never become manual overrides');
    await fs.mkdir('.verification', { recursive: true });
    await page.screenshot({ path: '.verification/wb-order-financial-light.png', fullPage: true, animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark'); });
    await page.screenshot({ path: '.verification/wb-order-financial-dark.png', fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'dialog stays within the phone viewport');
    const bounds = await dialog().boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, 'dialog shell fits phone width');
    await page.screenshot({ path: '.verification/wb-order-financial-mobile.png', fullPage: true, animations: 'disabled' });

    evidence.posted_inventory_cost_cny = 4.3;
    evidence.settlement = {
      state: 'reported', amounts: [], amounts_cny: { retailAmount: 56.55, ppvzSalesCommission: 11.31, acquiringFee: 0.57, deliveryService: 13.6, forPay: 44.67 },
      net_settlement_cny: 31.07, actual_profit_cny: 26.77,
      lines: [{ report_id: '900', row_id: '901', currency: 'CNY', date: '2026-11-27T16:30:00Z', operation: '销售', forPay: 44.67 }]
    };
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.reload();
    await dialog().locator('.wb-profit-summary .wb-profit-value').nth(1).getByText('¥ 26.77', { exact: true }).waitFor();
    await feeRow('利润').getByText('¥ 26.77', { exact: true }).waitFor();
    assert.equal(await feeRow('支付手续费').getByText('¥ 0.57', { exact: true }).count(), 2, 'payment evidence remains visible without being deducted again from reported profit');
    await dialog().locator('.wb-appendix > summary').filter({ hasText: '其他账单项目' }).click();
    await dialog().locator('.wb-appendix').first().getByText('¥ 44.67', { exact: true }).waitFor();
    await dialog().locator('.wb-ledger-collapse .el-collapse-item__header').click();
    await dialog().getByText('2026-11-28', { exact: true }).waitFor();
    await page.screenshot({ path: '.verification/wb-order-financial-settlement.png', fullPage: true, animations: 'disabled' });

    await page.goto('http://localhost:8788/admin.html?tenant=2&readonly=1#/orders');
    await dialog().locator('.wb-profit-summary').waitFor();
    assert.equal(await dialog().getByRole('button', { name: '重算并保存利润', exact: true }).count(), 0, 'read-only order permissions cannot invoke recalculation');

    delete evidence.saved_profit;
    await page.goto('http://localhost:8788/admin.html?tenant=3#/orders');
    await dialog().getByRole('button', { name: '配置仓库', exact: true }).waitFor();
    assert.ok(requests.some(request => request.path === '/api/user-preferences' && request.query.key === 'wb.profit.warehouse.3'));
    assert.equal(preferences.has('wb.profit.warehouse.3'), false, 'a second enterprise does not inherit the first warehouse configuration');
    const postsBeforeFailure = requests.filter(request => request.method === 'POST').length;
    failPreferenceRead = true;
    await page.goto('http://localhost:8788/admin.html?tenant=4#/orders');
    await dialog().getByText(/仓库配置读取失败/).waitFor();
    assert.equal(requests.filter(request => request.method === 'POST').length, postsBeforeFailure, 'a failed preference read does not overwrite the saved configuration');
    assert.equal(await dialog().getByRole('button', { name: '配置仓库', exact: true }).isDisabled(), true);
    failPreferenceRead = false;
    await dialog().getByRole('button', { name: '重试读取', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '配置仓库' && !button.disabled));
    assert.equal(requests.filter(request => request.method === 'POST').length, postsBeforeFailure, 'retrying a read never saves a default warehouse');

    holdEvidence = true;
    const held = new Promise(resolve => { evidenceHeld = resolve; });
    await page.goto('http://localhost:8788/admin.html?tenant=2#/orders');
    await held;
    await page.evaluate(() => window.switchProfitTestTenant(5));
    await heldEvidence.fulfill({ json: evidence });
    await dialog().waitFor({ state: 'hidden' });
    assert.equal(requests.filter(request => request.method === 'POST').length, postsBeforeFailure, 'a stale enterprise response cannot save configuration or remain visible');
    assert.ok(requests.filter(request => request.method === 'POST').every(request => ['/api/user-preferences', '/api/wb/orders/sync-settlement', '/api/wb/orders/recalculate-profit'].includes(request.path)), 'inspection never invokes WB product or fulfillment writes');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(path.resolve(output)), path.resolve(os.tmpdir()));
    await fs.rm(output, { recursive: true, force: true });
  }
});
