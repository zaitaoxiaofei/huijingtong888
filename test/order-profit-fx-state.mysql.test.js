import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { createOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";
import { ORDER_PROFIT_FX_POLICY_KEY, ORDER_PROFIT_FX_STATE_SCHEMA, eligibleForDailyOrderFx, orderFxSalePrice, prepareOrderProfitFx, readOrderProfitFxState } from "../src/services/order-profit-fx-policy.js";
import { createOrderProfitCalculationTables } from "../src/services/order-profit-calculation-schema.js";
import { ensureOrderProfitCalculationState, recordOrderProfitCalculation } from "../src/services/order-profit-calculation-versions.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const now = Date.parse("2026-10-26T09:00:00Z");
const policy = { version: "V2", enabled_at: "2026-10-24T08:00:00Z", legacy_max_order_id: 10 };
const source = async url => ({ ok: true, text: async () => `<ValCurs Date="${url.includes("25/10") ? "25.10.2026" : "24.10.2026"}"><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>${url.includes("25/10") ? "12,5" : "10"}</Value></Valute></ValCurs>` });

test("activation requires both a newly placed order and ID above the immutable legacy boundary", () => {
  assert.equal(eligibleForDailyOrderFx(policy, { orderId: 10, orderedAt: "2026-10-25T00:00:00Z" }), false);
  assert.equal(eligibleForDailyOrderFx(policy, { orderId: 11, orderedAt: "2026-10-23T00:00:00Z" }), false);
  assert.equal(eligibleForDailyOrderFx(policy, { orderId: 11, orderedAt: "2026-10-25T00:00:00Z", verifiedOrderedAt: false }), false);
  assert.equal(eligibleForDailyOrderFx(policy, { orderId: 11, orderedAt: "2026-10-24T08:00:00Z" }), true);
});

test("new orders pin archived order and delivered days, preserve V1 and isolate enterprise ownership", { skip: !socketPath }, async () => {
  const name = "ozon_fx_state_test_" + randomBytes(8).toString("hex");
  const db = await mysql.createConnection({ socketPath, user: "root", timezone: "Z", dateStrings: true });
  let created = false;
  const tx = async callback => { await db.beginTransaction();try { const result = await callback(db);await db.commit();return result; } catch (error) { await db.rollback();throw error; } };
  const adapter = { query: db.query.bind(db), transaction: tx };
  try {
    assert.equal(Number((await db.query("SELECT @@skip_networking value"))[0][0].value), 1);
    await db.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);created = true;
    await db.changeUser({ database: name });await db.query("SET SESSION time_zone='+00:00'");
    await db.query("CREATE TABLE system_settings (`key` VARCHAR(128) PRIMARY KEY,value_json LONGTEXT)");
    await db.execute("INSERT INTO system_settings VALUES (?, ?)", [ORDER_PROFIT_FX_POLICY_KEY, JSON.stringify(policy)]);
    await db.query("CREATE TABLE shops (id INT PRIMARY KEY,tenant_id BIGINT)");
    await db.query("CREATE TABLE orders (id INT PRIMARY KEY,shop_id INT)");
    await db.query("CREATE TABLE order_items (id INT PRIMARY KEY,order_id INT)");
    await db.query("INSERT INTO shops VALUES (1,7),(2,8)");
    await db.query("INSERT INTO orders VALUES (10,1),(11,1),(12,2),(13,1),(14,1)");
    await createOrderProfitDailyFxSchema(db);await db.query(ORDER_PROFIT_FX_STATE_SCHEMA);await createOrderProfitCalculationTables(db);
    const input = { tenantId: 7, orderId: 11, orderedAt: "2026-10-24T08:00:00Z", items: [{ ozon_sku: "sku", sale_price: 1000, sale_currency: "RUB" }] };
    assert.equal(await prepareOrderProfitFx(adapter, { ...input, orderId: 10 }, { now, fetchImpl: source }), null);
    assert.equal(await prepareOrderProfitFx(adapter, { ...input, orderId: 14, orderedAt: "2026-10-23T08:00:00Z" }, { now, fetchImpl: source }), null);
    const initial = await prepareOrderProfitFx(adapter, input, { now, fetchImpl: source });
    assert.equal(initial.orderFx.rate, "10.000000000000");assert.equal(orderFxSalePrice(initial, "sku"), 100);
    assert.equal(initial.signedFx, null);
    const delivered = await prepareOrderProfitFx(adapter, { ...input, deliveredAt: "2026-10-25T06:00:00Z" }, { now, fetchImpl: source });
    assert.equal(delivered.signedFx.rate, "12.500000000000");assert.equal(delivered.signed_business_date, "2026-10-25");
    const repeated = await prepareOrderProfitFx(adapter, { ...input, deliveredAt: "2026-10-26T06:00:00Z", items: [{ ozon_sku: "sku", sale_price: 2000, sale_currency: "CNY" }] }, { now, fetchImpl: () => assert.fail("pinned quote cannot refetch") });
    assert.equal(repeated.orderFx.id, initial.orderFx.id);assert.equal(repeated.signedFx.id, delivered.signedFx.id);assert.equal(orderFxSalePrice(repeated, "sku"), 100);
    assert.equal(await readOrderProfitFxState(db, 8, 11), null);
    await assert.rejects(prepareOrderProfitFx(adapter, { ...input, tenantId: 8 }, { now, fetchImpl: source }), { code: "ORDER_PROFIT_FX_OWNERSHIP" });
    const missing = await prepareOrderProfitFx(adapter, { ...input, orderId: 13, items: [{ ozon_sku: "missing", sale_price: null, sale_currency: "" }] }, { now, fetchImpl: source });
    assert.equal(missing.state, "awaiting_sale_currency");assert.equal(orderFxSalePrice(missing, "missing"), null);
    const fixed = await prepareOrderProfitFx(adapter, { ...input, orderId: 13 }, { now, fetchImpl: source });
    assert.equal(fixed.state, "awaiting_sale_currency", "an unmatched missing SKU must not disappear from the audit");
    await tx(connection => ensureOrderProfitCalculationState(connection, { tenantId: 7, orderId: 10, orderItemId: 1, legacy: true, baselineEstimate: { estimated_profit: 123 } }));
    await tx(connection => ensureOrderProfitCalculationState(connection, { tenantId: 7, orderId: 11, orderItemId: 2, initialFormulaVersion: "V2", legacy: false }));
    await tx(connection => recordOrderProfitCalculation(connection, { tenantId: 7, orderId: 11, orderItemId: 2, layer: "estimate", formulaVersion: "V2", inputs: { fx: initial.orderFx }, outputs: { estimated_profit: 50 } }));
    const [versions] = await db.query("SELECT order_id,formula_version FROM order_profit_calc_state ORDER BY order_id");
    assert.deepEqual(versions.map(row => [Number(row.order_id), row.formula_version]), [[10, "V1"], [11, "V2"]]);
    await assert.rejects(tx(connection => recordOrderProfitCalculation(connection, { tenantId: 7, orderId: 10, orderItemId: 1, layer: "estimate", formulaVersion: "V2" })), /explicit supported version migration/);
    await db.execute("DELETE FROM order_profit_daily_fx_rates WHERE id = ?", [delivered.signedFx.id]);
    await assert.rejects(readOrderProfitFxState(db, 7, 11), { code: "ORDER_PROFIT_FX_PIN_MISMATCH" });
  } finally {
    if (created) { assert.match(name, /^ozon_fx_state_test_[a-f0-9]{16}$/);await db.query(`DROP DATABASE \`${name}\``); }
    await db.end();
  }
});
