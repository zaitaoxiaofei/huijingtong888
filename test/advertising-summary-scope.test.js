import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { computed, reactive, ref } from 'vue';
import * as rules from '../frontend/admin/views/advertising/ad-rules.js';

const source = readFileSync(new URL('../frontend/admin/views/advertising/AdvertisingDailyView.vue', import.meta.url), 'utf8');
function fixture(get = async () => ({})) {
  const context = vm.createContext({ computed, reactive, ref, ...rules, onMounted() {}, watch() {}, URLSearchParams,
    apiClient: { get }, ElMessage: { error(message) { throw new Error(message); } }, console });
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  vm.runInContext(script + '\nglobalThis.view = {state, summary, periodSummary, storeSpendRank, loading, loadRows};', context);
  return context.view;
}

test('period spend, revenue and ROAS stay unchanged across pages and local list filters', () => {
  const v = fixture();
  v.summary.value = { from: '2026-10-01', to: '2026-10-31', spend_rub: 25000, revenue_rub: 150000, roas: 6,
    shops: [{shop_id: 4, shop_name: 'Shop A', spend_rub: 20000, revenue_rub: 120000}, {shop_id: 5, shop_name: 'Shop B', spend_rub: 5000, revenue_rub: 30000}] };
  for (const page of [1, 2, 3]) {
    v.state.page = page;
    v.state.rows = [{shop_id: 4, ozon_sku: `sku-${page}`, spend_rub: page * 100, revenue_rub: page * 200}];
    v.state.filters.adStatus = page === 1 ? 'active' : 'all';
    assert.equal(v.periodSummary.value.spend_rub, 25000);
    assert.equal(v.periodSummary.value.revenue_rub, 150000);
    assert.equal(v.periodSummary.value.roas, 6);
    assert.equal(v.storeSpendRank.value.length, 2);
    assert.equal(v.storeSpendRank.value[0].spend, 20000);
  }
});

test('a slower previous query cannot overwrite the latest date/shop totals or clear its loading state', async () => {
  const pending = [];
  const v = fixture(path => path.includes('/quality?') ? Promise.resolve({}) : new Promise(resolve => pending.push({path, resolve})));
  const old = v.loadRows();
  v.state.filters.shopId = '5';
  const latest = v.loadRows();
  assert.match(pending[3].path, /shopId=5/);
  pending[0].resolve({rows: [{ozon_sku: 'old'}]});
  pending[1].resolve({spend_rub: 20000});
  await old;
  assert.equal(v.loading.value, true);
  assert.equal(v.summary.value.spend_rub, undefined);
  pending[2].resolve({rows: [{ozon_sku: 'new'}], total: 1});
  pending[3].resolve({spend_rub: 10000, from: '2026-10-01', to: '2026-10-31'});
  await latest;
  assert.equal(v.loading.value, false);
  assert.equal(v.summary.value.spend_rub, 10000);
  assert.equal(v.state.rows[0].ozon_sku, 'new');
});
