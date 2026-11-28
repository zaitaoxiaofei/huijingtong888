import assert from 'node:assert/strict';
import test from 'node:test';
import { createWbOrderProfitRecalculation, readWbOrderProfitSnapshots } from '../src/services/wb-order-profit-recalculation.js';
import { assertProfitFormulaSupported, getProfitFormula } from '../src/services/profit-formulas/registry.js';
import { WB_ORDER_ESTIMATE_MODEL_VERSION } from '../src/shared/wb-order-profit.js';
import { wbRoutePermission } from '../src/server/wb-paths.js';
import { createWbRoutes } from '../src/server/routes/wb.js';

function fixture() {
  const context = { id: 101, order_id: 17, shop_id: 20, tenant_id: 2, platform: 'wb', active: true,
    ordered_at: '2026-11-27 06:45:37', quantity: 1, purchase_cost: 4.3, domestic_shipping: 0.5, handling_fee: 0.5,
    package_weight_g: 200, length_cm: 15, width_cm: 15, height_cm: 5, product_id: 30, sku_mapping_id: 40,
    raw_json: { nmId: 50, convertedCurrencyCode: 156, convertedPrice: 5655, createdAt: '2026-11-27T06:45:37Z' },
    card_json: { subjectID: 3373 }, estimated_profit: 999, actual_profit: 77, settlement_state: 'accrued',
    profit_item_id: 501, is_locked: 1, locked_at: '2026-11-27 07:00:00', lock_reason: 'existing_finance', net_profit_cny: 77 };
  const db = { contexts: [context], states: [], revisions: [], log: [], transactions: 0, invalidations: 0,
    preference: { warehouseId: 382855, paymentRates: {} }, failProjection: false, beforeLockedRead: null };
  const savedRows = (tenant, ids) => db.states.filter(state => state.tenant_key === String(tenant) && state.formula_version === WB_ORDER_ESTIMATE_MODEL_VERSION)
    .flatMap(state => {
      const item = db.contexts.find(row => row.id === state.order_item_id && row.tenant_id === Number(tenant) && row.platform === 'wb');
      const revision = db.revisions.find(row => row.id === state.current_estimate_revision_id);
      return item && ids.includes(item.order_id) && revision ? [{ ...revision, order_id: item.order_id, revision_id: revision.id, calculated_at: revision.created_at }] : [];
    });
  async function query(sql, params = []) {
    db.log.push({ sql, params });
    if (sql.includes('SELECT i.*,o.id AS order_id')) {
      if (sql.includes('FOR UPDATE') && db.beforeLockedRead) { const work = db.beforeLockedRead; db.beforeLockedRead = null; work(); }
      return structuredClone(db.contexts.filter(row => row.tenant_id === Number(params[0]) && row.platform === 'wb' && row.active && params.slice(1).includes(row.order_id)));
    }
    if (sql.includes('SELECT state.order_id,revision.id')) {
      assert.equal(params[1], WB_ORDER_ESTIMATE_MODEL_VERSION);
      assert.equal(params[2], String(params[0]));
      assert.match(sql, /w\.tenant_id=s\.tenant_id/);
      return structuredClone(savedRows(params[0], params.slice(4)));
    }
    if (sql.includes('FROM system_settings')) { assert.equal(params[0], 'user_preferences:5:wb.profit.warehouse.2'); return [{ value_json: structuredClone(db.preference) }]; }
    if (sql.startsWith('SELECT id FROM order_items')) return db.contexts.filter(row => row.id === params[0]).map(row => ({ id: row.id }));
    if (sql.includes('FROM order_profit_calc_state')) return structuredClone(db.states.filter(row => row.tenant_key === params[0] && row.order_item_id === params[1]));
    if (sql.includes('incompatible_revisions')) return [{ incompatible_revisions: db.revisions.filter(row => row.tenant_key === params[0] && row.order_item_id === params[1] && !row.legacy_baseline).length }];
    if (sql.includes('FROM order_profit_calc_revisions')) {
      let found = db.revisions.filter(row => row.tenant_key === params[0] && row.order_item_id === params[1]);
      if (sql.includes('idempotency_key')) found = found.filter(row => row.layer === params[2] && row.idempotency_key === params[3]);
      else if (/\bid\s*=\s*\?/.test(sql)) found = found.filter(row => row.id === params[2]);
      return structuredClone(found);
    }
    assert.fail('Unexpected query: ' + sql);
  }
  async function execute(sql, params) {
    db.log.push({ sql, params });
    if (sql.includes('INSERT INTO order_profit_calc_state')) {
      if (!db.states.some(row => row.tenant_key === params[0] && row.order_item_id === params[1])) db.states.push({ tenant_key: params[0], order_item_id: params[1], order_id: params[2], formula_version: 'V1', legacy_baseline: params[3], revision_count: 0, current_estimate_revision_id: null, current_actual_revision_id: null });
      return { affectedRows: 1 };
    }
    if (sql.includes('SET legacy_baseline = 1')) { db.states.find(row => row.tenant_key === params[0] && row.order_item_id === params[1]).legacy_baseline = 1; return { affectedRows: 1 }; }
    if (sql.includes('SET formula_version=?')) { db.states.find(row => row.tenant_key === params[1] && row.order_item_id === params[2]).formula_version = params[0]; return { affectedRows: 1 }; }
    if (sql.includes('INSERT INTO order_profit_calc_revisions')) {
      const columns = ['tenant_key', 'order_item_id', 'order_id', 'revision_no', 'layer', 'formula_version', 'legacy_baseline', 'input_completeness', 'input_hash', 'output_hash', 'idempotency_key', 'rate_version_json', 'cost_version_json', 'inputs_json', 'outputs_json', 'parent_revision_id', 'source', 'reason', 'actor_id', 'command_id'];
      const id = db.revisions.length + 1;
      db.revisions.push({ ...Object.fromEntries(columns.map((column, index) => [column, params[index]])), id, created_at: '2026-11-28 01:00:00' });
      return { insertId: id };
    }
    if (sql.includes('SET current_')) {
      const state = db.states.find(row => row.tenant_key === params[2] && row.order_item_id === params[3]);
      state[sql.includes('SET current_actual') ? 'current_actual_revision_id' : 'current_estimate_revision_id'] = params[0];
      state.revision_count = params[1];
      return { affectedRows: 1 };
    }
    if (sql.includes('UPDATE order_items i')) {
      if (db.failProjection) throw new Error('injected projection failure');
      assert.match(sql, /s\.platform='wb' AND s\.tenant_id=\?/);
      const row = db.contexts.find(row => row.tenant_id === params[0] && row.id === params[2] && row.order_id === params[3]);
      if (row) row.estimated_profit = params[1];
      return { affectedRows: row ? 1 : 0 };
    }
    assert.fail('Unexpected execute: ' + sql);
  }
  const connection = { query: async (...args) => [await query(...args)], execute: async (...args) => [await execute(...args)] };
  const transaction = async work => {
    if (db.beforeTransaction) { const before = db.beforeTransaction; db.beforeTransaction = null; await before(); }
    db.transactions++;
    const before = structuredClone({ contexts: db.contexts, states: db.states, revisions: db.revisions });
    try { return await work(connection); }
    catch (error) { Object.assign(db, before); throw error; }
  };
  const recalculate = createWbOrderProfitRecalculation({ actorId: 5, query, transaction,
    pricingCommissions: async (tenant, { shop_id }) => { assert.equal(tenant, 2); assert.equal(shop_id, 20); return { rows: [{ id: 3373, rate: 20 }] }; },
    invalidate: () => db.invalidations++ });
  return { db, query, recalculate };
}

test('WB formula registration is independent and rejects finance and historical repair', () => {
  assert.equal(getProfitFormula(WB_ORDER_ESTIMATE_MODEL_VERSION).version, WB_ORDER_ESTIMATE_MODEL_VERSION);
  for (const operation of ['finance', 'historical_repair']) assert.throws(() => assertProfitFormulaSupported(WB_ORDER_ESTIMATE_MODEL_VERSION, { operation }), { code: 'UNSUPPORTED_PROFIT_FORMULA_VERSION' });
  assert.equal(wbRoutePermission(['api', 'wb', 'orders', 'recalculate-profit'], 'POST'), 'orders.manage');
  assert.equal(wbRoutePermission(['api', 'wb', 'orders', 'recalculate-profit', 'extra'], 'POST'), null);
});

test('WB recalculation saves a canonical estimate atomically and preserves actual locks and legacy values', async () => {
  const { db, query, recalculate } = fixture();
  const result = await recalculate(2, { order_ids: [17], command_id: 'first' });
  assert.equal(result.updated_count, 1);
  assert.equal(result.results[0].estimated_profit_cny, 24.57);
  assert.equal(result.results[0].provisional, true);
  assert.equal(db.contexts[0].estimated_profit, 24.57);
  assert.equal(db.contexts[0].actual_profit, 77);
  assert.equal(db.contexts[0].is_locked, 1);
  assert.equal(db.contexts[0].lock_reason, 'existing_finance');
  assert.equal(db.states[0].formula_version, WB_ORDER_ESTIMATE_MODEL_VERSION);
  assert.equal(db.revisions.length, 3);
  for (const baseline of db.revisions.slice(0, 2)) {
    assert.equal(baseline.input_completeness, 'legacy_unknown');
    assert.equal(JSON.parse(baseline.outputs_json).estimated_profit, 999);
    assert.equal(JSON.parse(baseline.outputs_json).actual_profit, 77);
  }
  const [saved] = (await readWbOrderProfitSnapshots({ query, tenantId: 2, orderIds: [17] })).values();
  assert.equal(saved.outputs.delivery, 13.6);
  assert.equal(saved.inputs.warehouseId, 382855);
  assert.deepEqual(saved.manual_overrides, {});
  assert.equal(db.revisions.at(-1).actor_id, 5);
  assert.ok(!db.log.some(row => /UPDATE order_profit_items|SET[^;]*actual_profit|SET[^;]*settlement_state/.test(row.sql)));
});

test('automatic recalculation refreshes inventory and preferences while explicit saved scenarios persist separately', async () => {
  const { db, recalculate } = fixture();
  await recalculate(2, { order_ids: [17] });
  db.contexts[0].purchase_cost = 8.3;
  db.preference.paymentRates['20'] = 1;
  const refreshed = await recalculate(2, { order_ids: [17] });
  assert.equal(refreshed.results[0].estimated_profit_cny, 20);
  assert.equal(refreshed.results[0].provisional, false);
  await recalculate(2, { order_ids: [17], overrides: { 17: { purchaseCost: 6 } } });
  db.contexts[0].purchase_cost = 10;
  const manual = await recalculate(2, { order_ids: [17] });
  assert.equal(manual.results[0].estimated_profit_cny, 22.3);
  assert.deepEqual(JSON.parse(db.revisions.at(-1).inputs_json).manual_overrides, { purchaseCost: 6 });
});

test('missing inputs persist explicit unknowns without writing numeric zero and can later be repaired from inventory', async () => {
  const { db, query, recalculate } = fixture();
  db.contexts[0].purchase_cost = null;
  const missing = await recalculate(2, { order_ids: [17] });
  assert.equal(missing.updated_count, 0);
  assert.equal(missing.results[0].status, 'needs_inputs');
  assert.equal(db.contexts[0].estimated_profit, 999);
  assert.equal((await readWbOrderProfitSnapshots({ query, tenantId: 2, orderIds: [17] })).get(17).outputs.profit, null);
  db.contexts[0].purchase_cost = 4.3;
  assert.equal((await recalculate(2, { order_ids: [17] })).results[0].estimated_profit_cny, 24.57);
  db.contexts[0].quantity = 2;
  const multi = await recalculate(2, { order_ids: [17] });
  assert.equal(multi.results[0].estimated_profit_cny, null);
  assert.ok(multi.results[0].missing_inputs.some(row => row.field === 'weight'));
});

test('waiting recalculations merge the latest committed manual scenario under the item lock', async () => {
  for (const override of [undefined, { returnRate: 10 }]) {
    const { db, query, recalculate } = fixture();
    await recalculate(2, { order_ids: [17] });
    db.beforeTransaction = () => recalculate(2, { order_ids: [17], overrides: { 17: { purchaseCost: 6 } } });
    await recalculate(2, { order_ids: [17], ...(override ? { overrides: { 17: override } } : {}) });
    const current = (await readWbOrderProfitSnapshots({ query, tenantId: 2, orderIds: [17] })).get(17);
    assert.equal(current.inputs.purchaseCost, 6);
    assert.equal(current.manual_overrides.purchaseCost, 6);
    if (override) assert.equal(current.manual_overrides.returnRate, 10);
    else assert.equal(current.outputs.profit, 22.87);
  }
});

test('previous missing manual values do not prevent later live data or payment configuration repair', async () => {
  const { db, recalculate } = fixture();
  await recalculate(2, { order_ids: [17], overrides: { 17: { purchaseCost: null, paymentRate: null, warehouseId: null } } });
  db.preference.paymentRates['20'] = 1;
  const repaired = await recalculate(2, { order_ids: [17] });
  assert.equal(repaired.results[0].estimated_profit_cny, 24);
  assert.equal(repaired.results[0].provisional, false);
  assert.deepEqual(JSON.parse(db.revisions.at(-1).inputs_json).manual_overrides, {});
});

test('foreign or mixed-platform selections fail before transactions and request sale overrides are rejected', async () => {
  for (const edit of [db => {}, db => { db.contexts[0].platform = 'ozon'; }]) {
    const { db, recalculate } = fixture(); edit(db);
    await assert.rejects(recalculate(2, { order_ids: [17, 18] }), { statusCode: 404 });
    assert.equal(db.transactions, 0);
    assert.equal(db.revisions.length, 0);
  }
  const { db, recalculate } = fixture();
  await assert.rejects(recalculate(3, { order_ids: [17] }), { statusCode: 404 });
  await assert.rejects(recalculate(2, { order_ids: [17], overrides: { 17: { sale: 9999 } } }), { statusCode: 400 });
  assert.equal(db.transactions, 0);
});

test('a projection failure rolls back revision, pin transition and all monetary changes', async () => {
  const { db, recalculate } = fixture();
  db.failProjection = true;
  await assert.rejects(recalculate(2, { order_ids: [17] }), /injected projection failure/);
  assert.equal(db.contexts[0].estimated_profit, 999);
  assert.equal(db.states.length, 0);
  assert.equal(db.revisions.length, 0);
});

test('A then B then retry A never restores a stale projection or estimate pointer', async () => {
  const { db, recalculate } = fixture();
  const first = { order_ids: [17], command_id: 'A', overrides: { 17: { purchaseCost: 4.3 } } };
  await recalculate(2, first);
  await recalculate(2, { order_ids: [17], command_id: 'B', overrides: { 17: { purchaseCost: 6 } } });
  const pointer = db.states[0].current_estimate_revision_id, count = db.revisions.length;
  const duplicate = await recalculate(2, first);
  assert.equal(duplicate.results[0].estimated_profit_cny, 22.87);
  assert.equal(db.contexts[0].estimated_profit, 22.87);
  assert.equal(db.states[0].current_estimate_revision_id, pointer);
  assert.equal(db.revisions.length, count);
});

test('under-lock authoritative sale changes are used and another pinned formula cannot be overwritten', async () => {
  const { db, recalculate } = fixture();
  db.beforeLockedRead = () => { db.contexts[0].raw_json.convertedCurrencyCode = 643; };
  const missing = await recalculate(2, { order_ids: [17] });
  assert.equal(missing.results[0].estimated_profit_cny, null);
  assert.ok(missing.results[0].missing_inputs.some(row => row.field === 'sale'));
  db.states[0].formula_version = 'V2';
  await assert.rejects(recalculate(2, { order_ids: [17] }), { statusCode: 409 });
  assert.equal(db.states[0].formula_version, 'V2');
});

test('WB route takes tenant from the authorized session and keeps packing-only members read-only', async () => {
  let permission, called = false;
  const routes = createWbRoutes({ readJson: async () => ({ order_ids: [17], tenant_id: 99 }),
    authorize: async session => session,
    platform: async (_session, required) => { permission = required; return { recalculateOrderProfit: async (tenant, body) => { called = true; assert.equal(tenant, 2); return body; } }; } });
  const handler = routes['POST /api/wb/orders/recalculate-profit'];
  await assert.rejects(handler({ _session: { roles: ['packing'], tenant: { id: 2 } } }), { statusCode: 403 });
  assert.equal(called, false);
  await handler({ _session: { roles: ['operations'], tenant: { id: 2 } } });
  assert.equal(permission, 'orders.manage');
});
