import test from 'node:test';
import assert from 'node:assert/strict';
import { productProfitParameterChanges, recommendProfitRecalculation } from '../src/shared/product-profit-parameters.js';
import { normalizeProductProfitRecalculation, productProfitRecalculationSkipReason, scopedProductProfitRecalculation, preserveOrderEstimateParameters } from '../src/services/product-profit-recalculation.js';
import { oglRuleFreightCny } from '../src/services/profit-formulas/v1/ogl-rates.js';
const round = n => Math.round(n * 100) / 100;
const rule = { id: 70, name: 'OGL 陆运 Extra Small', min_weight_g: 1, max_weight_g: 500, min_price_rub: 1, max_price_rub: 1500, base_fee_cny: 0, per_gram_cny: .0242, per_ticket_cny: 2.8 };
function fixture() {
  const product = { id: 1041, package_weight_g: 300, logistics_rule_id: 71, purchase_cost: 27 };
  const item = { id: 35793, order_id: 35440, sku_mapping_id: 2682, quantity: 1, sale_price: 100,
    posting_number: '0112339342-0272-1', frozen_logistics_rule_id: 70, frozen_international_shipping: 5.04,
    estimated_profit: 50.70, order_status: 'awaiting_packaging', settlement_state: 'pending' };
  const writes = [], queries = [], reads = [], invalidations = [];
  const deps = {
    readProfitFxState: async () => null, refreshProfitSnapshots: async () => {},
    orderListTenantScopeMysql: async id => ({ id }), assertOrderTaskAccessMysql: async (_scope, _options, permissions) => assert.deepEqual(permissions, ['inventory.write']),
    orderTenantPredicateMysql: alias => `${alias}.tenant_id = 'tenant-a'`, chinaDateSqlMysql: column => `DATE(CONVERT_TZ(${column},'+00:00','+08:00'))`,
    mysqlQuery: async (sql, params) => { queries.push({ sql, params }); return [structuredClone(item)]; },
    mysqlQueryOne: async (sql, params) => {
      reads.push({ sql, params });
      if (sql.includes('FROM products')) return structuredClone(product);
      if (sql.includes('FROM sku_mappings')) return { id: 2682 };
      if (sql.includes('FROM logistics_fee_rules')) return { ...rule, id: params[0] };
      throw Error('Unexpected SQL');
    },
    productForProfitEstimateMysql: async () => structuredClone(product),
    readableLogisticsTenantScopeMysql: async () => ({ sql: "candidate.tenant_id = ? OR (candidate.tenant_id IS NULL AND candidate.carrier = 'OGL')", params: ['tenant-a'] }),
    productWithLogisticsRuleMysql: (product, rule) => ({ ...product, resolved_logistics_rule_id: rule.id, logistics_rule_name: rule.name }),
    productWithOglOrderRateMysql: async product => product,
    estimatePinnedOrderItemProfit: async (_id, { product }) => ({ freight: oglRuleFreightCny(rule, { weightG: product.package_weight_g,
      length: 30, width: 20, height: 10, parcelValueRub: 1240.09, exchangeRate: 12.4009 }).totalCny, formulaVersion: 'V4' }),
    estimateProfitBreakdownMysql: async ({ estimated }) => ({ netProfit: round(100 - 27 - estimated.freight - 1 - 12 - 4.17), internationalShipping: estimated.freight, returnLoss: 0 }),
    roundMoneyMysql: round, persistRecalculatedItemMysql: async value => writes.push(value), invalidateOrderReadCache: () => invalidations.push(true)
  };
  const options = { tenantId: 'tenant-a', recalculation_scope: 'pending', tariff_mode: 'original', date_from: '2026-11-01', date_to: '2026-11-13', preview: true };
  return { product, item, deps, options, writes, queries, reads, invalidations };
}

test('numeric string equivalence, weight corrections and tariff changes produce appropriate recommendations', () => {
  assert.deepEqual(productProfitParameterChanges({ package_weight_g: '300.0000' }, { package_weight_g: 300 }), []);
  const changes = productProfitParameterChanges({ package_weight_g: 0, purchase_cost: 27 }, { package_weight_g: 300, purchase_cost: 28 });
  assert.equal(changes.length, 2); assert.equal(recommendProfitRecalculation(changes), 'existing');
  assert.equal(recommendProfitRecalculation([{ key: 'logistics_rule_id' }]), 'future');
  assert.equal(productProfitParameterChanges({}, { name: 'renamed' }).length, 0);
});
test('range validation rejects invalid dates, reversed ranges and unsupported tariff modes', () => {
  for (const bad of [{ date_from: '2026-02-30' }, { date_from: '2026-99-01' }, { date_from: '2026-11-14', date_to: '2026-11-13' }, { tariff_mode: 'latest' }, { tariff_mode: 'specified', logistics_rule_id: -1 }]) {
    assert.throws(() => normalizeProductProfitRecalculation({ recalculation_scope: 'pending', ...bad }), { statusCode: 400 });
  }
});
test('300 gram reproduction previews 12.06 freight and 43.77 profit without writing', async () => {
  const f = fixture(); const result = await scopedProductProfitRecalculation(f.deps, 1041, f.options);
  assert.equal(result.rows[0].old_freight, 5.04); assert.equal(result.rows[0].new_freight, 12.06);
  assert.equal(result.rows[0].new_profit, 43.77); assert.equal(result.rows[0].profit_difference, -6.93);
  assert.equal(f.writes.length, 0); assert.equal(f.invalidations.length, 0);
  assert.match(f.queries[0].sql, /sm.tenant_id = 'tenant-a'/); assert.match(f.queries[0].sql, /owned_shop.tenant_id = 'tenant-a'/);
  assert.match(f.queries[0].sql, /CONVERT_TZ/); assert.deepEqual(f.queries[0].params, [1041, '2026-11-01', '2026-11-13']);
});
test('original, current product and specified tariff versions resolve separately', async () => {
  for (const [mode, expected] of [['original', 70], ['product', 71], ['specified', 72]]) {
    const f = fixture(); const result = await scopedProductProfitRecalculation(f.deps, 1041, { ...f.options, tariff_mode: mode, logistics_rule_id: 72 });
    assert.equal(result.rows[0].logistics_rule_id, expected);
  }
});
test('settled, locked, final, aftersale and shipped-only exclusions never write', async () => {
  for (const override of [{ is_locked: 1 }, { profit_status: 'accrued' }, { settlement_state: 'accrued' }, { sync_state: 'final' }, { order_status: 'cancelled' }]) {
    const f = fixture(); Object.assign(f.item, override); const result = await scopedProductProfitRecalculation(f.deps, 1041, f.options);
    assert.equal(result.selected_items, 0); assert.equal(result.skipped_items, 1); assert.equal(f.writes.length, 0);
  }
  assert.equal(productProfitRecalculationSkipReason({ order_status: 'delivering' }, 'unfulfilled'), '不属于未发货订单');
});
test('only a matching preview permits writes; changed product, order or rule invalidates approval', async () => {
  const f = fixture(); const preview = await scopedProductProfitRecalculation(f.deps, 1041, f.options);
  await assert.rejects(scopedProductProfitRecalculation(f.deps, 1041, { ...f.options, preview: false }), { statusCode: 409 });
  f.product.package_weight_g = 400;
  await assert.rejects(scopedProductProfitRecalculation(f.deps, 1041, { ...f.options, preview: false, preview_token: preview.preview_token }), { statusCode: 409 });
  assert.equal(f.writes.length, 0); f.product.package_weight_g = 300;
  const result = await scopedProductProfitRecalculation(f.deps, 1041, { ...f.options, preview: false, preview_token: preview.preview_token });
  assert.equal(result.updated, 1); assert.equal(f.writes[0].pendingOnly, true); assert.equal(f.writes[0].product.package_weight_g, 300);
  assert.equal(f.invalidations.length, 1);
});
test('an invalid original tariff is skipped with a reason, never silently replaced', async () => {
  const f = fixture(); f.item.frozen_logistics_rule_id = null;
  const result = await scopedProductProfitRecalculation(f.deps, 1041, f.options);
  assert.equal(result.selected_items, 0); assert.match(result.skipped_rows[0].reason, /指定运价/);
});
test('existing order status sync keeps its confirmed weight while newly bound products use new inputs', async () => {
  const input = { product: { id: 1041, package_weight_g: 300 }, mapping: { id: 2682 } };
  const query = async (_sql, params) => { assert.deepEqual(params, ['tenant-a', 35793]); return [{ inputs_json: JSON.stringify({ product: { id: 1041, package_weight_g: 0 }, estimate: { freight: 5.04 } }) }]; };
  const preserved = await preserveOrderEstimateParameters({ query, tenantKey: 'tenant-a' }, 35793, input);
  assert.equal(preserved.product.package_weight_g, 0); assert.equal(input.product.package_weight_g, 300);
  const rebound = { ...input, product: { id: 2000, package_weight_g: 500 } };
  assert.equal(await preserveOrderEstimateParameters({ query, tenantKey: 'tenant-a' }, 35793, rebound), rebound);
});
