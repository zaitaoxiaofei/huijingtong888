import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { wbProfitView, wbProfitRecalculationTargets, wbProfitRecalculationMessage } from '../frontend/orders/utils/wb-profit-recalculation.js';

test('WB list distinguishes missing calculations, incomplete calculations, explicit zero and provisional loss', () => {
  assert.equal(wbProfitView(null).status, '未重算');
  assert.equal(wbProfitView({ estimated_profit_cny: null }).status, '待补齐参数');
  assert.equal(wbProfitView({ estimated_profit_cny: 0 }).amount, 0);
  assert.equal(wbProfitView({ estimated_profit_cny: 0 }).known, true);
  assert.deepEqual(wbProfitView({ estimated_profit_cny: -1.35, provisional: true }), { amount: -1.35, known: true, status: '', provisional: true });
  assert.equal(wbProfitView({ estimated_profit_cny: Infinity }).known, false);
});

test('WB explicit target selection rejects cross-platform mixes and bounds each batch', () => {
  assert.deepEqual(wbProfitRecalculationTargets([{ id: 2, platform: 'wb' }, { id: 1, platform: 'wb' }, { id: 2, platform: 'wb' }]), [2, 1]);
  assert.throws(() => wbProfitRecalculationTargets([]), /没有可重算/);
  assert.throws(() => wbProfitRecalculationTargets([{ id: 1, platform: 'wb' }, { id: 2, platform: 'ozon' }]), /不要混选/);
  assert.throws(() => wbProfitRecalculationTargets([{ id: NaN, platform: 'wb' }]), /编号无效/);
  assert.throws(() => wbProfitRecalculationTargets(Array.from({ length: 101 }, (_, index) => ({ id: index + 1, platform: 'wb' }))), /100/);
});

test('partial WB results state which orders need inputs and where to fix them', () => {
  const summary = wbProfitRecalculationMessage({ results: [
    { order_id: 1, status: 'saved' },
    { order_id: 2, status: 'needs_inputs', missing_inputs: [{ field: 'warehouseId', label: 'WB 揽收仓' }] }
  ] });
  assert.equal(summary.kind, 'warning');
  assert.match(summary.message, /已保存 1 单利润/);
  assert.match(summary.message, /订单 2：缺少WB 揽收仓/);
  assert.match(summary.message, /查看明细/);
  assert.equal(wbProfitRecalculationMessage({ results: [{ order_id: 1, status: 'saved' }] }).kind, 'success');
});

test('saved dialog events force fresh order rows instead of leaving frontend caches stale', async () => {
  const source = readFileSync(new URL('../frontend/orders/OrdersPage.vue', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handleWbProfitSaved('), source.indexOf('\nasync function handleWbRecalculate('));
  const cache = new Map([[17, 'stale detail']]), reads = [];
  const run = vm.runInNewContext(`${handler}; handleWbProfitSaved`, {
    orderDetailCache: cache, loadOrders: async options => reads.push(JSON.parse(JSON.stringify(options))),
    ElMessage: { warning: assert.fail }
  });
  await run({ order_id: 17 });
  assert.equal(cache.has(17), false);
  assert.deepEqual(reads, [{ forceRefresh: true }]);
});

test('unknown WB profits are not marked as low-profit orders by the shared page summary', () => {
  const source = readFileSync(new URL('../frontend/orders/OrdersPage.vue', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('function buildProfitSummary('), source.indexOf('\nfunction buildLogisticsSummary('));
  const summarize = vm.runInNewContext(`${block};buildProfitSummary`, { wbProfitView, splitCsv: value => String(value || '').split(',').filter(Boolean) });
  assert.equal(summarize({ platform: 'wb', estimated_profit: 0, wb_profit: null }).alertLevel, '');
  assert.equal(summarize({ platform: 'wb', wb_profit: { estimated_profit_cny: null } }).alertLevel, '');
  assert.equal(summarize({ platform: 'wb', wb_profit: { estimated_profit_cny: 0 } }).alertLevel, 'low');
  assert.equal(summarize({ platform: 'wb', wb_profit: { estimated_profit_cny: -1 } }).alertLevel, 'loss');
  assert.equal(summarize({ platform: 'ozon', estimated_profit: 0 }).alertLevel, 'low');
});
