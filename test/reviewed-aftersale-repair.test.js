import assert from 'node:assert/strict';
import test from 'node:test';
import { planReviewedAftersaleRepair, readReviewedAftersaleSnapshot, applyReviewedAftersaleRepair } from '../src/services/reviewed-aftersale-repair.js';
import { ensureOrderProfitCalculationState, recordOrderProfitCalculation } from '../src/services/order-profit-calculation-versions.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

function snapshot(code = 686) {
  return { order: { id: 1, tenant_key: '2', posting_number: 'sample', status: 'cancelled', cancelled_after_ship: 1, cancel_reason_id: code },
    item: { id: 10, quantity: 2, frozen_purchase_cost: '20', estimated_profit: '-70', actual_profit: '-40', platform_fee_actual: '9' },
    profit: { net_profit_cny: '-40', other_fee_cny: '3', profit_status: 'accrued', is_locked: 1, lock_reason: 'finance_accrued' },
    state: { formula_version: 'V1' }, estimate: { inputs_json: JSON.stringify({ estimate: { paymentFee: 2 } }) },
    actual: { legacy_baseline: 1, source: 'legacy_baseline', input_completeness: 'legacy_unknown' } };
}

test('cancellation removes estimated fulfilment losses and invalidates unverified legacy actuals', () => {
  const row = planReviewedAftersaleRepair(snapshot());
  assert.equal(row.after_estimated_profit, 0);
  assert.equal(row.nextProfit.net_profit_cny, 0);
  assert.equal(row.nextProfit.is_locked, 0);
  assert.equal(row.nextProfit.profit_status, 'estimated');
  assert.equal(row.nextItem.settlement_state, 'pending');
  const billed = snapshot();
  billed.actual = { legacy_baseline: 0, source: 'ozon_finance', input_completeness: 'complete' };
  const actual = planReviewedAftersaleRepair(billed);
  assert.equal(actual.after_estimated_profit, 0);
  assert.equal(actual.nextProfit.net_profit_cny, -3, 'verified acquiring fee is retained once');
  assert.equal(actual.nextProfit.profit_status, 'accrued');
});

test('cargo loss counts quantity and acquiring once, excludes freight and commission, and blocks unknown fees', () => {
  const row = snapshot(809);
  const plan = planReviewedAftersaleRepair(row);
  assert.equal(plan.nextProfit.purchase_cost_cny, 40);
  assert.equal(plan.nextProfit.other_fee_cny, 2);
  assert.equal(plan.nextProfit.net_profit_cny, -42);
  for (const key of ['domestic_shipping_cny','international_shipping_cny','commission_fee_cny','return_loss_cny','ozon_service_fee_cny']) assert.equal(plan.nextProfit[key],0);
  row.estimate.inputs_json = '{}';
  const blocked = planReviewedAftersaleRepair(row);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.after_net_profit, null);
  row.state.formula_version = 'V2';
  assert.equal(planReviewedAftersaleRepair(row).formula_after, 'V4');
});

test('real MySQL repair retains old revisions, scopes ownership, refuses stale input, is atomic and idempotent', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated local MySQL socket'
}, async () => {
  const f = await createTenantMysqlFixture('aftersale_repair');
  f.connection.connection.config.timezone = 'Z';
  const tx = async operation => {
    await f.connection.beginTransaction();
    try { const value = await operation(); await f.connection.commit(); return value; }
    catch (error) { await f.connection.rollback(); throw error; }
  };
  try {
    await f.query("INSERT INTO shops(id,tenant_id,name) VALUES(10,2,'A')");
    await f.query("INSERT INTO orders(id,shop_id,posting_number,status,cancel_reason_id,cancelled_after_ship,ordered_at) VALUES(1,10,'reviewed-sample','cancelled',686,1,'2026-10-30 01:00:00')");
    await f.query("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,frozen_purchase_cost,estimated_profit,actual_profit,settlement_state) VALUES(10,1,'sku',1,100,20,-35,-20,'accrued')");
    await f.query("INSERT INTO order_profit_items(order_item_id,purchase_cost_cny,net_profit_cny,profit_status,is_locked,lock_reason) VALUES(10,20,-20,'accrued',1,'finance_accrued')");
    await tx(() => ensureOrderProfitCalculationState(f.connection, { tenantId: '2', orderId: 1, orderItemId: 10,
      legacy: true, baselineEstimate: { estimated_profit: -35 }, baselineActual: { net_profit_cny: -20 } }));
    const before = await readReviewedAftersaleSnapshot(f.query, 10);
    const plan = planReviewedAftersaleRepair(before);
    const command = { commandId: 'fixture-review', actorId: 7, reason: 'reviewed reason correction' };
    await assert.rejects(tx(() => applyReviewedAftersaleRepair(f.connection, { ...plan, tenant_key: '3' }, command)), /归属/);
    await f.query('UPDATE order_items SET estimated_profit=-36 WHERE id=10');
    await assert.rejects(tx(() => applyReviewedAftersaleRepair(f.connection, plan, command)), /已变化/);
    await f.query('UPDATE order_items SET estimated_profit=-35 WHERE id=10');
    assert.equal((await tx(() => applyReviewedAftersaleRepair(f.connection, plan, command))).reused, false);
    const after = await readReviewedAftersaleSnapshot(f.query, 10);
    assert.equal(after.state.formula_version, 'V3');
    assert.equal(Number(after.profit.net_profit_cny), 0);
    assert.equal(after.profit.profit_status, 'estimated');
    assert.equal(Number(after.order.cancelled_after_ship), 1, 'raw platform evidence is preserved');
    const revisions = await f.query('SELECT * FROM order_profit_calc_revisions ORDER BY id');
    assert.equal(revisions.length, 6);
    assert.deepEqual(revisions.map(row => row.formula_version), ['V1','V1','V1','V1','V3','V3']);
    assert.equal(JSON.parse(revisions[3].outputs_json).profit.net_profit_cny, '-20.0000');
    assert.equal((await tx(() => applyReviewedAftersaleRepair(f.connection, plan, command))).reused, true);
    assert.equal((await f.query('SELECT * FROM order_profit_calc_revisions')).length, 6);
    const latestPlan = planReviewedAftersaleRepair(after);
    const execute = f.connection.execute.bind(f.connection);
    f.connection.execute = async (sql, args) => {
      if (sql.startsWith('UPDATE order_profit_items')) throw new Error('injected storage failure');
      return execute(sql, args);
    };
    await assert.rejects(tx(() => applyReviewedAftersaleRepair(f.connection, latestPlan, { ...command, commandId: 'rollback-test' })), /injected/);
    f.connection.execute = execute;
    assert.deepEqual(await readReviewedAftersaleSnapshot(f.query, 10), after);

    // A production manifest serializes Date values into ISO strings. Actual
    // finance retains its original lock, rather than invalidating that layer.
    await f.query("UPDATE order_profit_items SET profit_status='accrued',is_locked=1,locked_at='2026-06-29 12:45:12',lock_reason='finance_accrued',other_fee_cny=0.37,net_profit_cny=-0.37 WHERE order_item_id=10");
    await f.query("UPDATE order_items SET settlement_state='accrued',actual_profit=-0.37 WHERE id=10");
    await tx(() => recordOrderProfitCalculation(f.connection, { tenantId: '2', orderId: 1, orderItemId: 10,
      layer: 'actual', formulaVersion: 'V3', source: 'ozon_finance', inputCompleteness: 'complete',
      inputs: { acquiring: 0.37 }, outputs: { net_profit_cny: -0.37 } }));
    const serialized = JSON.parse(JSON.stringify(await readReviewedAftersaleSnapshot(f.query, 10)));
    const settledPlan = JSON.parse(JSON.stringify(planReviewedAftersaleRepair(serialized)));
    await tx(() => applyReviewedAftersaleRepair(f.connection, settledPlan, { ...command, commandId: 'iso-lock-test' }));
    const final = await readReviewedAftersaleSnapshot(f.query, 10);
    assert.equal(Number(final.profit.net_profit_cny), -0.37);
    assert.equal(final.profit.profit_status, 'accrued');
    assert.equal(new Date(final.profit.locked_at).toISOString(), '2026-06-29T12:45:12.000Z');
  } finally { await f.cleanup(); }
});
