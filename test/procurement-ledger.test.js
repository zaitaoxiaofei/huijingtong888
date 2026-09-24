import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';
import { planLedgerAction, planReceiptCorrection, summarizeLedger, createProcurementLedgerService, planAllocationCorrection } from '../src/services/procurement-ledger.js';

const historical = (id, quantity, extra = {}) => ({ order_id: id, order_item_id: id, product_id: 10, quantity,
  entered_transport: 1, needs_fulfillment: 0, stock_location: 'LOCAL', ordered_at: '2026-09-01T00:00:00Z', ...extra });
const demand = (id, quantity) => historical(id, quantity, { entered_transport: 0, needs_fulfillment: 1, ordered_at: '2026-09-16T00:00:00Z' });

test('100 shipped, 2 historic receipts, 2 new purchases: historical 98 survives and new demand is covered', () => {
  const input = { demands: [historical(1, 100), demand(2, 2)], stocks: [{ product_id: 10, ledger: -98 }],
    requests: [{ id: 20, product_id: 10, quantity: 2, source_order_item_id: 2, purchase_order_id: 20, status: 'purchased' }],
    inbounds: [{ id: 1, product_id: 10, quantity: 2, amount: 20, status: 'approved', purchased_at: '2026-08-01T00:00:00Z' },
      { id: 2, product_id: 10, quantity: 2, amount: 20, status: 'pending_arrival', purchase_order_id: 20, purchased_at: '2026-09-16T00:00:00Z' }] };
  let result = calculateOrderProcurementCoverage(input);
  assert.equal(result.get(1).missing_purchase_quantity, 98);
  assert.equal(result.get(2).shortage_quantity, 0);
  assert.equal(result.get(2).incoming_quantity, 2);
  input.inbounds[1].status = 'approved';
  result = calculateOrderProcurementCoverage(input);
  assert.equal(result.get(1).missing_purchase_quantity, 98);
  assert.equal(result.get(2).stock_quantity, 2);
});

test('102 recorded purchases, 50 shipped, 100 pending receipt: 48 needs receipt verification, not new purchasing', () => {
  const result = calculateOrderProcurementCoverage({ demands: [historical(1, 50)], inbounds: [
    { id: 1, product_id: 10, quantity: 2, amount: 20, status: 'approved', purchased_at: '2026-08-01T00:00:00Z' },
    { id: 2, product_id: 10, quantity: 100, amount: 1000, status: 'pending_arrival', purchased_at: '2026-08-02T00:00:00Z' }
  ] });
  assert.equal(result.get(1).missing_record_quantity, 48);
  assert.equal(result.get(1).missing_receipt_quantity, 48);
  assert.equal(result.get(1).missing_purchase_quantity, 0);
  assert.equal(result.available_batches[1].unallocated_quantity, 52);
});

test('later unrelated receipts do not silently cover historical missing purchases', () => {
  const result = calculateOrderProcurementCoverage({ demands: [historical(1, 100)], inbounds: [
    { id: 1, product_id: 10, quantity: 100, amount: 1000, status: 'approved', purchased_at: '2026-09-16T00:00:00Z' }
  ] });
  assert.equal(result.get(1).missing_purchase_quantity, 100);
});

test('explicit history source uses one receipt once; source-only correction creates no current stock', () => {
  const result = calculateOrderProcurementCoverage({ demands: [historical(1, 2), historical(2, 2), demand(3, 1)],
    sources: [{ order_item_id: 1, product_id: 10, quantity: 2, inbound_record_id: 1 }],
    inbounds: [{ id: 1, product_id: 10, quantity: 2, amount: 0, status: 'approved' }] });
  assert.equal(result.get(1).missing_record_quantity, 0);
  assert.equal(result.get(1).missing_amount, true);
  assert.equal(result.get(2).missing_record_quantity, 2);
  assert.equal(result.get(3).shortage_quantity, 1);
});

const snapshot = (extra = {}) => ({ product: { id: 10 }, revision: 'version', local_stock: 0, purchases: [], batches: [],
  orders: [{ order_item_id: 1, order_id: 1, quantity: 100, entered_transport: true, missing_record_quantity: 98, missing_purchase_quantity: 98, outbound_quantity: 100 }], ...extra });
const body = (action_type, extra = {}) => ({ action_type, revision: 'version', reason: '盘点凭证 001', quantity: 2, ...extra });

test('purchase reduction at zero stock reduces only pending quantity unless incorrect receipt explicitly confirmed', () => {
  const pending = snapshot({ purchases: [{ id: 1, actual_quantity: 10, received_quantity: 0 }] });
  assert.equal(planLedgerAction(pending, body('revise_purchase', { purchase_item_id: 1, quantity: 8, amount: 80 })).local_delta, 0);
  const received = snapshot({ purchases: [{ id: 1, actual_quantity: 10, received_quantity: 10 }],
    batches: [{ id: 1, purchase_order_item_id: 1, quantity: 10, local_posted_quantity: 10, status: 'approved' }] });
  assert.throws(() => planLedgerAction(received, body('revise_purchase', { purchase_item_id: 1, quantity: 8, amount: 80 })), /入库也录多了/);
  const plan = planLedgerAction(received, body('revise_purchase', { purchase_item_id: 1, quantity: 8, amount: 80, correct_received: true }));
  assert.equal(plan.local_delta, -2);
  assert.equal(plan.pending_quantity, 0);
});

test('correcting a source-only historical receipt never removes physical local stock', () => {
  assert.equal(planReceiptCorrection([{ id: 1, quantity: 10, local_posted_quantity: 0, status: 'approved' }], 10, 8)[0].delta, 0);
});

test('history backfill declares ledger impact and rejects already-recorded purchases', () => {
  const input = body('historical_purchase', { order_item_id: 1, amount: 20, purchased_at: '2026-08-01T12:00:00+08:00', inventory_effect: 'already_accounted' });
  assert.equal(planLedgerAction(snapshot(), input).local_delta, 0);
  const transported = snapshot({ orders: [{ ...snapshot().orders[0], transport_at: '2026-07-01T00:00:00Z' }] });
  assert.equal(planLedgerAction(transported, input).local_delta, 0, 'single backfill also accepts a date after shipment');
  assert.throws(() => planLedgerAction(snapshot(), { ...input, inventory_effect: 'missing_inbound' }), /仅解释历史来源/);
  assert.throws(() => planLedgerAction(snapshot({ orders: [{ ...snapshot().orders[0], missing_purchase_quantity: 0 }] }), input), /已有采购/);
  assert.throws(() => planLedgerAction(snapshot(), { ...input, quantity: 99 }), /尚未解释/);
});

test('conversion balances both products, and counts never borrow incoming or FBP stock', () => {
  const plan = planLedgerAction(snapshot({ local_stock: 10 }), body('convert', { quantity: 10, target_product_id: 11, target_quantity: 5 }));
  assert.equal(plan.local_delta, -10);
  assert.equal(plan.target_delta, 5);
  assert.throws(() => planLedgerAction(snapshot(), body('convert', { target_product_id: 11, target_quantity: 2 })), /本地库存不足/);
  const count = planLedgerAction(snapshot({ local_stock: 10 }), body('stocktake', { counted_quantity: 0 }));
  assert.equal(count.local_delta, -10);
  assert.throws(() => planLedgerAction(snapshot(), body('loss', { quantity: 1 })), /超过本地/);
  assert.throws(() => planLedgerAction(snapshot(), body('stocktake', { revision: 'old', counted_quantity: 1 })), /已变化/);
});

test('ledger uses physical returns and FBP transfer, not order cancellation counts', () => {
  const result = summarizeLedger({ id: 10 }, [
    { source_type: 'purchase_inbound', quantity_delta: 175, stock_location: 'LOCAL' },
    { source_type: 'order_outbound', quantity_delta: -95, stock_location: 'LOCAL' },
    { source_type: 'return_in', quantity_delta: 10, stock_location: 'LOCAL' },
    { source_type: 'fbp_transfer_out', quantity_delta: -30, stock_location: 'LOCAL' },
    { source_type: 'fbp_in', quantity_delta: 30, stock_location: 'FBP' }
  ], [], []);
  assert.equal(result.local_stock, 60);
});

function fixture(failSecond = false, overrides = {}) {
  let state = { movements: structuredClone(overrides.movements || [{ id: 1, product_id: 10, quantity_delta: 10, source_type: 'purchase_inbound', stock_location: 'LOCAL' }]), actions: [] };
  let writes = 0;
  const executed = [];
  const recordedCosts = [];
  const coverageProducts = [];
  const run = async (sql, args = []) => {
    if (sql.includes('FOR UPDATE')) {
      if (sql.includes('procurement_ledger_actions')) return state.actions.filter(row => row.request_key === args[0]);
      return [];
    }
    if (sql.includes('FROM purchase_order_items poi')) return overrides.purchases || [];
    if (sql.includes('FROM products WHERE')) return [{ id: args[0], name: `商品${args[0]}` }];
    if (sql.includes('GROUP BY source_type, stock_location')) return state.movements.filter(row => row.product_id === args[0]);
    if (sql.includes('GROUP BY related_order_item_id')) return overrides.outbound || [];
    return [];
  };
  const connection = { query: async (...args) => [await run(...args)], execute: async (sql, args) => {
    executed.push({ sql, args });
    if (overrides.failSecondSource && sql.includes('INSERT INTO procurement_history_sources')
      && executed.filter(row => row.sql.includes('INSERT INTO procurement_history_sources')).length === 2) throw new Error('模拟第二个历史订单关联失败');
    if (sql.includes('INSERT INTO procurement_ledger_actions')) state.actions.push({ id: 1, request_key: args[0], product_id: args[1], person_id: args[3], before_json: args[5] });
    if (sql.includes('UPDATE procurement_ledger_actions SET result_json')) state.actions[0].result_json = args[0];
    return [{ insertId: 1 }];
  } };
  const service = createProcurementLedgerService({ prepare: async () => {}, query: run, coverage: async (_, productId) => { coverageProducts.push(productId); return overrides.coverage || new Map(); },
    recordCost: async (_, row) => { recordedCosts.push(row); }, refreshPurchase: async () => {},
    receive: async (_, id, payload) => { state.movements.push({ product_id: 10, quantity_delta: payload.receive_quantity, stock_location: 'LOCAL', source_type: 'purchase_inbound', source_ref: `inbound_${id}` }); },
    requirePerson: async () => 1, invalidate: () => {},
    transaction: async callback => { const saved = structuredClone(state); try { return await callback(connection); } catch (e) { state = saved; throw e; } },
    postMovement: async (_, row) => { writes++; if (failSecond && writes === 2) throw new Error('模拟第二条库存流水失败'); state.movements.push({ ...row, id: writes + 1 }); }
  });
  return { service, state: () => state, executed, coverageProducts, recordedCosts };
}

test('bulk history fill allocates only missing purchases in transport order and conserves both amounts', () => {
  const state = snapshot({ orders: [
    { order_id: 2, order_item_id: 2, entered_transport: true, transport_at: '2026-08-03T00:00:00Z', missing_purchase_quantity: 3 },
    { order_id: 1, order_item_id: 1, entered_transport: true, transport_at: '2026-08-02T00:00:00Z', missing_purchase_quantity: 2 },
    { order_id: 3, order_item_id: 3, entered_transport: true, missing_purchase_quantity: 0, missing_receipt_quantity: 5 },
    { order_id: 4, order_item_id: 4, entered_transport: false, missing_purchase_quantity: 10 }
  ] });
  const input = body('historical_purchase_bulk', { quantity: 4, amount: 0.01, shipping_amount: 1.01, purchased_at: '2026-08-01T12:00:00+08:00', inventory_effect: 'already_accounted' });
  const plan = planLedgerAction(state, input);
  assert.deepEqual(plan.allocations.map(row => [row.order_item_id, row.quantity]), [[1, 2], [2, 2]]);
  assert.equal(plan.allocations.reduce((sum, row) => sum + Math.round(row.amount * 10000), 0), 100);
  assert.equal(plan.allocations.reduce((sum, row) => sum + Math.round(row.shipping_amount * 10000), 0), 10100);
  assert.equal(plan.local_delta, 0);
  const later = planLedgerAction(state, { ...input, purchased_at: '2026-08-04T12:00:00+08:00' });
  assert.deepEqual(later.allocations, plan.allocations);
  assert.equal(later.local_delta, 0);
  for (const change of [{ quantity: 6 }, { quantity: 0 }, { quantity: 1.5 }, { amount: 0 }, { inventory_effect: 'missing_inbound' }, { purchased_at: '2999-08-04T12:00:00+08:00' }, { revision: 'old' }]) {
    assert.throws(() => planLedgerAction(state, { ...input, ...change }));
  }
});

test('bulk backfill can atomically reconcile counted stock without treating purchased units as new stock', async () => {
  const coverage = new Map([1, 2, 3].map(id => [id, { order_id: id, posting_number: `OLD-${id}`, stock_location: 'LOCAL', entered_transport: true,
    items: [{ product_id: 10, order_item_id: id, quantity: 1, missing_purchase_quantity: 1, missing_record_quantity: 1 }] }]));
  coverage.set(4, { order_id: 4, stock_location: 'LOCAL', needs_fulfillment: true,
    items: [{ product_id: 10, order_item_id: 4, quantity: 1, shortage_quantity: 1, stock_quantity: 0 }] });
  const options = { coverage, movements: [{ product_id: 10, quantity_delta: -5, stock_location: 'LOCAL', source_type: 'order_outbound' }], outbound: [{ order_item_id: 4, quantity: 1 }] };
  const f = fixture(false, options);
  const before = await f.service.read({ product_id: 10 });
  assert.equal(before.physical_estimate, -4);
  const input = body('historical_purchase_bulk', { product_id: 10, revision: before.revision, quantity: 3, amount: 63,
    inventory_effect: 'already_accounted', purchased_at: '2026-04-16T00:00:00+08:00', reconcile_stock: true,
    counted_quantity: 0, request_key: 'count-and-fill-12345678' });
  for (const counted_quantity of [null, undefined, '', -1, 1.5]) {
    assert.throws(() => planLedgerAction(before, { ...input, counted_quantity }), /盘点数量/);
  }
  assert.equal(planLedgerAction(before, { ...input, reconcile_stock: false }).local_delta, 0);
  const preview = await f.service.preview(input);
  assert.equal(preview.local_after, -1);
  assert.equal(preview.physical_after, 0);
  const result = await f.service.apply(input, 1);
  assert.equal(result.stocktake_delta, 4, 'difference is four, not the three purchased units or ledger debt five');
  assert.equal(result.physical_after, 0);
  assert.equal(result.local_after, -1);
  assert.deepEqual(await f.service.apply(input, 1), result, 'retry is idempotent');
  assert.equal(f.state().movements.length, 2);
  assert.equal(f.state().movements[1].source_type, 'reconciliation_stocktake');
  assert.equal(f.recordedCosts.length, 1);
  assert.equal(f.recordedCosts[0].amount, 63);
  assert.equal((await f.service.read({ product_id: 10 })).physical_estimate, 0);
  const failed = fixture(false, { ...options, failSecondSource: true });
  const failedBefore = await failed.service.read({ product_id: 10 });
  await assert.rejects(failed.service.apply({ ...input, revision: failedBefore.revision }, 1), /关联失败/);
  assert.equal(failed.state().movements.length, 1, 'failed purchase rolls back the simultaneous stock correction');
  assert.equal(failed.state().actions.length, 0);
});

test('bulk fill creates one purchase, links multiple historical orders atomically, records cost and retries once', async () => {
  const coverage = new Map([1, 2].map(id => [id, { order_id: id, posting_number: 'H-' + id, stock_location: 'LOCAL', entered_transport: true, transport_at: '2026-08-03T00:00:00Z',
    items: [{ product_id: 10, order_item_id: id, quantity: id, missing_purchase_quantity: id, missing_record_quantity: id }] }]));
  const f = fixture(false, { coverage });
  const before = await f.service.read({ product_id: 10 });
  const input = body('historical_purchase_bulk', { revision: before.revision, product_id: 10, quantity: 3, amount: 30, shipping_amount: 3,
    inventory_effect: 'already_accounted', purchased_at: '2026-09-01T12:00:00+08:00', request_key: 'bulk-history-fill-12345678' });
  const result = await f.service.apply(input, 1);
  assert.equal(result.allocations.length, 2);
  assert.equal(result.local_delta, 0);
  assert.equal(f.state().movements.length, 1);
  assert.equal(f.executed.filter(row => row.sql.includes('INSERT INTO purchase_orders')).length, 1);
  assert.deepEqual(f.executed.filter(row => row.sql.includes('INSERT INTO procurement_history_sources')).map(row => [row.args[1], row.args[3]]), [[1, 1], [2, 2]]);
  assert.equal(f.recordedCosts[0].amount, 30);
  assert.equal(f.recordedCosts[0].shipping_amount, 3);
  assert.deepEqual(await f.service.apply(input, 1), result);
  assert.equal(f.executed.filter(row => row.sql.includes('INSERT INTO purchase_orders')).length, 1);
  const failed = fixture(false, { coverage, failSecondSource: true });
  await assert.rejects(failed.service.apply(input, 1), /第二个历史订单/);
  assert.equal(failed.state().actions.length, 0);
  assert.equal(failed.state().movements.length, 1);
});

test('two-product conversion is atomic, retry is idempotent, changed payload cannot reuse key', async () => {
  const f = fixture();
  const first = await f.service.read({ product_id: 10 }), second = await f.service.read({ product_id: 11 });
  const input = body('convert', { product_id: 10, quantity: 10, target_product_id: 11, target_quantity: 5,
    revision: first.revision, target_revision: second.revision, request_key: '12345678-1234-1234' });
  const result = await f.service.apply(input, 1);
  assert.equal(result.local_after, 0);
  assert.equal(f.state().movements.length, 3);
  assert.deepEqual(await f.service.apply(input, 1), result);
  assert.equal(f.state().movements.length, 3);
  await assert.rejects(() => f.service.apply({ ...input, quantity: 9 }, 1), /不同内容/);
  const fail = fixture(true);
  await assert.rejects(() => fail.service.apply(input, 1), /第二条/);
  assert.equal(fail.state().movements.length, 1);
  assert.equal(fail.state().actions.length, 0);
});

test('already-counted historical receipt posts a balancing offset atomically and retry does not receive twice', async () => {
  const coverage = new Map([[1, { order_id: 1, stock_location: 'LOCAL', entered_transport: true,
    items: [{ product_id: 10, order_item_id: 1, missing_record_quantity: 2, missing_receipt_quantity: 2 }] }]]);
  coverage.available_batches = [{ id: 8, product_id: 10, quantity: 2, unallocated_quantity: 2, status: 'pending_arrival' }];
  const f = fixture(false, { coverage });
  const before = await f.service.read({ product_id: 10 });
  const input = body('receive', { revision: before.revision, product_id: 10, order_item_id: 1, inbound_id: 8,
    inventory_effect: 'already_accounted', request_key: 'historical-receipt-12345678' });
  const result = await f.service.apply(input, 1);
  assert.equal(result.local_delta, 0);
  assert.equal(result.local_before, result.local_after);
  const receiptMovements = f.state().movements.filter(row => row.source_ref === 'inbound_8');
  assert.equal(receiptMovements.reduce((sum, row) => sum + row.quantity_delta, 0), 0);
  assert.equal(receiptMovements.length, 2);
  await f.service.apply(input, 1);
  assert.equal(f.state().movements.filter(row => row.source_ref === 'inbound_8').length, 2);
});

test('actual local return can supply a later shipment once; return status alone cannot invent stock', () => {
  const demands = [historical(1, 2), historical(2, 2, { ordered_at: '2026-09-10T00:00:00Z' }), historical(3, 1, { ordered_at: '2026-09-11T00:00:00Z' })];
  const inbounds = [{ id: 1, product_id: 10, quantity: 2, amount: 20, status: 'approved', approved_at: '2026-08-01T00:00:00Z' }];
  const result = calculateOrderProcurementCoverage({ demands, inbounds, stockSources: [{ id: 100, product_id: 10, quantity: 2, approved_at: '2026-09-05T00:00:00Z' }] });
  assert.equal(result.get(2).missing_record_quantity, 0);
  assert.equal(result.get(2).missing_amount, false);
  assert.equal(result.get(3).missing_record_quantity, 1);
  assert.equal(result.available_batches.length, 1);
  assert.equal(calculateOrderProcurementCoverage({ demands, inbounds }).get(2).missing_record_quantity, 2);
});

test('current order substitution is earmarked despite historical debt and is not shared twice', () => {
  const result = calculateOrderProcurementCoverage({ demands: [historical(1, 98), demand(2, 2), demand(3, 1)],
    stocks: [{ product_id: 10, ledger: -96 }], sources: [{ order_item_id: 2, product_id: 10, quantity: 2 }] });
  assert.equal(result.get(1).missing_record_quantity, 98);
  assert.equal(result.get(2).shortage_quantity, 0);
  assert.equal(result.get(2).stock_quantity, 2);
  assert.equal(result.get(3).shortage_quantity, 1);
});


test('purchase allocation correction preserves current orders and reports historical reductions', () => {
  const result = planAllocationCorrection({ orders: [{ order_item_id: 2, needs_fulfillment: true }],
    requests: [{ id: 1, purchase_order_id: 10, quantity: 98, source_order_item_id: 1 }, { id: 2, purchase_order_id: 10, quantity: 2, source_order_item_id: 2 }],
    allocations: [{ id: 1, procurement_request_id: 1, order_item_id: 1, allocated_quantity: 98 }, { id: 2, procurement_request_id: 2, order_item_id: 2, allocated_quantity: 2 }] }, 10, 2);
  assert.equal(result.find(row => row.id === 2).quantity, 2);
  assert.equal(result.find(row => row.id === 1).quantity, 0);
  assert.equal(result.find(row => row.id === 1).allocations[0].quantity, 0);
});

test('pending-batch quantity correction writes only the remaining six units after two were received', async () => {
  const projection = new Map();
  projection.available_batches = [{ id: 5, product_id: 10, purchase_order_item_id: 1, status: 'approved', quantity: 2 },
    { id: 6, product_id: 10, purchase_order_item_id: 1, status: 'pending_arrival', quantity: 8 }];
  const f = fixture(false, { coverage: projection, purchases: [{ id: 1, product_id: 10, purchase_order_id: 7, actual_quantity: 10, received_quantity: 2, pending_quantity: 8 }] });
  const before = await f.service.read({ product_id: 10 });
  const result = await f.service.apply(body('revise_purchase', { product_id: 10, revision: before.revision,
    purchase_item_id: 1, quantity: 8, amount: 80, request_key: '12345678-quantity' }), 1);
  assert.equal(result.local_delta, 0);
  const update = f.executed.find(row => row.sql.includes('UPDATE inbound_records SET quantity') && row.args.at(-1) === 6);
  assert.equal(update.args[0], 6);
  assert.equal(f.state().movements.length, 1);
});

test('history backfill creates one dated purchase and explicit source without a new pending batch', async () => {
  const projection = calculateOrderProcurementCoverage({ demands: [historical(1, 100)] });
  const f = fixture(false, { coverage: projection });
  const before = await f.service.read({ product_id: 10 });
  const input = body('historical_purchase', { product_id: 10, order_item_id: 1, quantity: 98, amount: 980,
    purchased_at: '2026-08-01T12:00:00+08:00', inventory_effect: 'already_accounted', revision: before.revision, request_key: '12345678-backfill' });
  const result = await f.service.apply(input, 1);
  assert.equal(result.local_delta, 0);
  assert.equal(f.state().movements.length, 1);
  assert.equal(f.executed.filter(row => row.sql.includes('INSERT INTO purchase_orders')).length, 1);
  const inbound = f.executed.find(row => row.sql.includes('INSERT INTO inbound_records'));
  assert.equal(inbound.args[6], 'approved');
  assert.doesNotMatch(inbound.sql, /pending_arrival/);
  assert.ok(f.executed.some(row => row.sql.includes('INSERT INTO procurement_history_sources')));
});

test('recording one dated purchase validates calendar, positive totals and explicit inventory effect', () => {
  const input = body('record_purchase', { quantity: 5, amount: 20, purchased_at: '2026-08-01T00:15:00+08:00', inventory_effect: 'already_accounted' });
  const plan = planLedgerAction(snapshot(), input);
  assert.equal(plan.purchased_at, '2026-07-31 16:15:00');
  assert.equal(plan.local_delta, 0);
  assert.equal(plan.order_item_id, undefined);
  assert.equal(planLedgerAction(snapshot(), { ...input, inventory_effect: 'missing_inbound' }).local_delta, 5);
  assert.equal(planLedgerAction(snapshot(), { ...input, inventory_effect: 'in_transit' }).local_delta, 0);
  for (const date of ['2026-02-30T12:00:00+08:00', '2099-01-01T12:00:00+08:00', '2026-08-01T12:00:00Z', '']) {
    assert.throws(() => planLedgerAction(snapshot(), { ...input, purchased_at: date }), /采购|日期|北京时间/);
  }
  for (const fields of [{ quantity: 0 }, { quantity: 1.5 }, { amount: 0 }, { amount: -1 }, { inventory_effect: '' }]) {
    assert.throws(() => planLedgerAction(snapshot(), { ...input, ...fields }));
  }
});

test('inline correction obtains one product-scoped preview and retains stale-write protection on apply', async () => {
  const f = fixture(false, { purchases: [{ id: 1, product_id: 10, purchase_order_id: 7, actual_quantity: 10, received_quantity: 0, pending_quantity: 10, amount: 100, shipping_amount: 0 }] });
  const input = body('revise_purchase', { revision: undefined, product_id: 10, purchase_item_id: 1, quantity: 8, amount: 80,
    expected_purchase: { quantity: 10, amount: 100, shipping_amount: 0 }, request_key: '12345678-inline-edit' });
  const preview = await f.service.preview(input);
  assert.deepEqual(f.coverageProducts, [10]);
  assert.ok(preview.revision);
  assert.equal(preview.quantity, 8);
  await assert.rejects(f.service.preview({ ...input, expected_purchase: { quantity: 9, amount: 100 } }), /已发生变化/);
  await assert.rejects(f.service.apply({ ...input, revision: 'old' }, 1), /已变化/);
  await f.service.apply({ ...input, revision: preview.revision }, 1);
  assert.ok(f.coverageProducts.every(id => id === 10));
});

test('dated purchase backfill is idempotent and distinguishes transit, missing receipt and already-accounted stock', async () => {
  for (const effect of ['in_transit', 'missing_inbound', 'already_accounted']) {
    const f = fixture();
    const input = body('record_purchase', { revision: undefined, product_id: 10, quantity: 5, amount: 25, shipping_amount: 5,
      purchased_at: '2026-08-01T00:15:00+08:00', inventory_effect: effect, request_key: `backfill-${effect.replace('_', '-')}-12345678` });
    const preview = await f.service.preview(input);
    const payload = { ...input, revision: preview.revision };
    const result = await f.service.apply(payload, 1);
    assert.equal(result.local_delta, effect === 'missing_inbound' ? 5 : 0);
    assert.equal(f.state().movements.length, effect === 'missing_inbound' ? 2 : 1);
    const order = f.executed.find(row => row.sql.includes('INSERT INTO purchase_orders'));
    assert.equal(order.args[2], effect === 'in_transit' ? 'purchased' : 'inbound_done');
    assert.equal(order.args[6], '2026-07-31 16:15:00');
    const receipt = f.executed.find(row => row.sql.includes('INSERT INTO inbound_records'));
    assert.equal(receipt.args[6], effect === 'in_transit' ? 'pending_arrival' : 'approved');
    assert.equal(receipt.args[10], effect === 'in_transit' ? null : '2026-07-31 16:15:00');
    assert.equal(f.executed.filter(row => /INSERT INTO procurement_(requests|history_sources)/.test(row.sql)).length, 0);
    assert.deepEqual(await f.service.apply(payload, 1), result);
    assert.equal(f.executed.filter(row => row.sql.includes('INSERT INTO purchase_orders')).length, 1);
  }
});
