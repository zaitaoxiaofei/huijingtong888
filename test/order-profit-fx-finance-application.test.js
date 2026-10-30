import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { getProfitFormula, usesDailyProfitFx } from "../src/services/profit-formulas/registry.js";
import { readOrderFxFinanceRows } from "../src/services/order-profit-fx-finance.js";
import { fxSettlementInputFingerprint, planOrderFxSettlement } from "../src/services/order-profit-fx-settlement.js";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const start = source.indexOf("async function applyOzonFinanceToOrdersMysql(");
const end = source.indexOf("export async function syncOzonFinanceMysql(", start);
const applySource = source.slice(start, end);
const daily = (id, day, rate) => ({ id, business_date: day, source_date: day, source: "cbr", rate, currency_from: "CNY", currency_to: "RUB" });

function harness({ currency = "RUB", status = "delivered", versions = ["V2"], concurrentChange = null, newSourceForLegacy = false, cancelReasonId = 0 } = {}) {
  const writes = [], projections = [], refreshes = [], sqlReads = [];
  const order = { order_id: 42, shop_id: 9, posting_number: "123-1", order_number: "123", order_status: status,
    ordered_at: "2026-10-26T00:00:00Z", delivered_at: status === "delivered" ? "2026-10-28T00:00:00Z" : null,
    ...(cancelReasonId ? { cancel_reason_id: cancelReasonId, cancelled_after_ship: 1 } : {}) };
  const items = versions.map((formula_version, index) => ({ id: 7 + index, formula_version, profit_tenant_key: "81", ozon_sku: String(100 + index),
    quantity: 1, purchase_cost_cny: 20, domestic_shipping_cny: 2, advertising_cost_cny: 0 }));
  const finance = [
    { id: 1, shop_id: 9, operation_id: "sale", posting_number: "123-1", service_type: "commission", amount: -100, accruals_for_sale: 1000, currency_code: currency },
    { id: 2, shop_id: 9, operation_id: "collect", posting_number: "123-1", service_type: "collecting_fee", amount: -10, accruals_for_sale: 0, currency_code: currency },
    { id: 3, shop_id: 9, operation_id: "delivery", posting_number: "123-1", service_type: "platform_delivery", amount: -90, accruals_for_sale: 0, currency_code: currency }
  ];
  const fxState = { orderFx: daily(1, "2026-10-26", 10), signedFx: daily(2, "2026-10-28", 12.5),
    ordered_business_date: "2026-10-26", signed_business_date: "2026-10-28",
    prices: items.map(item => ({ ozon_sku: item.ozon_sku, amount: 1000, currency: "RUB" })) };
  let financeReads = 0;
  const context = {
    orderOwnershipTenantScopeMysql: async () => ({ id: 81 }), assertOrderTaskAccessMysql: async () => {},
    normalizeSyncDateMysql: value => value,
    orderTenantPredicateMysql: alias => `${alias}.tenant_id = 81`,
    getProfitFormula, usesDailyProfitFx, readOrderFxFinanceRows, planOrderFxSettlement, fxSettlementInputFingerprint,
    parentOrderNumberMysql: () => "123", mysqlQueryOne: async () => newSourceForLegacy ? { id: 91 } : null,
    readOrderProfitFxState: async (_db, tenantId, orderId) => { assert.equal(tenantId, "81"); assert.equal(orderId, 42); return fxState; },
    mysqlQuery: async (sql, params) => {
      sqlReads.push({ sql, params });
      if (sql.includes("FROM ozon_finance_items WHERE")) {
        assert.equal(params[0], 9);
        financeReads += 1;
        if (financeReads > 1) assert.match(sql, /FOR SHARE/);
        return concurrentChange === "fee" && financeReads > 1 ? finance.map(row => ({ ...row, amount: row.amount - 1 })) : finance;
      }
      if (sql.includes("FROM order_profit_calc_revisions")) {
        assert.deepEqual(Array.from(params), ["81", 42]);
        // A pending placeholder precedes the valid initial estimate; later
        // estimate changes must not replace the original comparison baseline.
        return [
          { order_item_id: 7, inputs_json: '{"estimate":{"fxPending":true}}', outputs_json: '{"estimated_profit":0}' },
          { order_item_id: 7, inputs_json: '{}', outputs_json: '{"estimated_profit":50}' },
          { order_item_id: 7, inputs_json: '{}', outputs_json: '{"estimated_profit":99}' }
        ];
      }
      if (sql.includes("current_calc.current_actual_revision_id")) {
        assert.match(sql, /FOR UPDATE/);
        assert.deepEqual(Array.from(params), [42, 9, "81"]);
        return items.map(item => ({ ...item, ...order,
          ...(concurrentChange === "cost" ? { purchase_cost_cny: 22 } : {}),
          ...(concurrentChange === "quantity" ? { quantity: 2 } : {}),
          ...(concurrentChange === "status" ? { order_status: "cancelled" } : {}),
          ...(concurrentChange === "revision" ? { current_actual_revision_id: 99 } : {}) }));
      }
      if (sql.includes("FROM order_items oi")) return items;
      if (sql.includes("FROM orders o")) return [order];
      throw new Error(`Unexpected SQL ${sql}`);
    },
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); return {}; },
    parseJsonOrNull: value => typeof value === "string" ? JSON.parse(value) : value,
    orderQualityPrefixesMysql: async () => [], ozonFinanceCategoryMysql: row => row.service_type,
    packagingFeeForSaleAmountMysql: async () => 3,
    withVersionedOrderProfitWrite: async (id, options, project) => {
      projections.push({ id, options });
      await project({ connection: {}, formulaVersion: items.find(item => item.id === id).formula_version, db: { query: context.mysqlQuery, execute: async (sql, params) => { writes.push({ sql, params }); return {}; } } });
    },
    lockProfitItemMysql: async (id, reason) => { writes.push({ lock: id, reason }); },
    refreshOrderProfitDetailSnapshotsMysql: async input => { refreshes.push(input); }
  };
  const execute = vm.runInNewContext(`(${applySource.trim()})`, context);
  return { writes, projections, refreshes, sqlReads, execute };
}

test("real finance application dispatches V2, preserves original estimate and records FX revisions with signed pins", async () => {
  const db = harness();
  const result = await db.execute({ tenantId: 81, orderIds: [42] });
  assert.equal(result.items, 1);
  assert.equal(result.fx_pending.length, 0);
  assert.equal(db.projections[0].options.inputs.fx_attribution.initial_estimated_profit_cny, 50);
  assert.equal(db.projections[0].options.inputs.fx_attribution.fx_gain_loss_cny, -16);
  assert.equal(db.projections[0].options.rateVersion.signed_fx.id, "2");
  const itemWrite = db.writes.find(write => write.sql?.startsWith("UPDATE order_items SET platform_fee_actual"));
  assert.equal(itemWrite.params[1], 39);
  assert.doesNotMatch(itemWrite.sql, /estimated_profit\s*=/);
  assert.equal(db.refreshes.length, 1);
});

test("V4 finance treats reviewed non-shipment as cancellation and retains only billed acquiring", async () => {
  const db = harness({ versions: ['V4'], status: 'cancelled', cancelReasonId: 686 });
  const result = await db.execute({ tenantId: 81, orderIds: [42] });
  assert.equal(result.items, 1);
  assert.equal(db.projections[0].options.inputs.outcome, 'cancelled_pre_fulfillment');
  const write = db.writes.find(row => row.sql?.includes('INSERT INTO order_profit_items'));
  assert.equal(write.params[1], 0);
  for (const index of [2,3,4,5,6,8,9,10]) assert.equal(write.params[index],0);
  assert.equal(write.params[11], 0.8);
  assert.equal(write.params[13], -0.8);
});

test("V4 cargo-loss finance counts goods and acquiring once, excluding commission and every freight", async () => {
  const db = harness({ versions: ['V4'], status: 'cancelled', cancelReasonId: 809 });
  await db.execute({ tenantId: 81, orderIds: [42] });
  assert.equal(db.projections[0].options.inputs.outcome, 'cargo_lost');
  const write = db.writes.find(row => row.sql?.includes('INSERT INTO order_profit_items'));
  assert.equal(write.params[1], 0);
  assert.equal(write.params[2], 20);
  for (const index of [3,4,5,6,7,8,9,10]) assert.equal(write.params[index],0);
  assert.equal(write.params[11],0.8);
  assert.equal(write.params[13],-20.8);
});

test("unknown actual finance currency keeps the current profit projection untouched and exposes a pending reason", async () => {
  const db = harness({ currency: "" });
  const result = await db.execute({ tenantId: 81 });
  assert.equal(result.items, 0);
  assert.equal(result.fx_pending[0].code, "FX_FINANCE_CURRENCY_UNKNOWN");
  assert.equal(db.projections.length, 0);
  assert.equal(db.writes.length, 1);
  assert.match(db.writes[0].sql, /order_profit_fx_state SET last_error_code/);
  assert.equal(db.writes[0].params[0], "FX_FINANCE_CURRENCY_UNKNOWN");
});

test("active V2 orders cannot be accrued merely because finance rows exist", async () => {
  const db = harness({ status: "awaiting_deliver" });
  const result = await db.execute({ tenantId: 81 });
  assert.equal(result.items, 0);
  assert.equal(result.fx_pending[0].code, "ORDER_PROFIT_TERMINAL_STATUS_PENDING");
  assert.equal(db.projections.length, 0);
});

test("mixed order pins fail before financial or revision writes", async () => {
  const db = harness({ versions: ["V1", "V2"] });
  await assert.rejects(db.execute({ tenantId: 81 }), { code: "ORDER_PROFIT_FORMULA_MIXED" });
  assert.equal(db.writes.length, 0);
  assert.equal(db.projections.length, 0);
});

test("restoring new accrual bills never recalculates a historical V1 order", async () => {
  const db = harness({ versions: ["V1"], newSourceForLegacy: true });
  const result = await db.execute({ tenantId: 81 });
  assert.equal(result.items, 0);
  assert.equal(db.projections.length, 0);
  assert.equal(db.writes.length, 0);
});

test("a concurrent cost, quantity, status, actual revision or bill change fails before any profit mutation", async () => {
  for (const concurrentChange of ["cost", "quantity", "status", "revision", "fee"]) {
    const db = harness({ concurrentChange });
    await assert.rejects(db.execute({ tenantId: 81 }), { code: "ORDER_PROFIT_FX_INPUT_CHANGED" });
    assert.equal(db.writes.length, 0, concurrentChange);
    assert.equal(db.refreshes.length, 0, concurrentChange);
  }
});
