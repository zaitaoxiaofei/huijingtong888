import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import * as versions from "../src/services/order-profit-calculation-versions.js";
import { ORDER_PROFIT_CALCULATION_SCHEMA } from "../src/services/order-profit-calculation-schema.js";
import { createOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";
import { ensureOrderProfitDailyFx, orderProfitFxBusinessDate } from "../src/services/order-profit-daily-fx.js";
import * as policy from "../src/services/order-profit-fx-policy.js";
import { getProfitFormula, assertProfitFormulaSupported } from "../src/services/profit-formulas/registry.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const writer = readFileSync(new URL("../src/services/mysql-order-profit-version-write.js", import.meta.url), "utf8")
  .replace(/^import [\s\S]*? from "[^\n]+";\r?\n/gm, "").replaceAll("export ", "");
const upsert = service.match(/async function upsertPostingMysql\([\s\S]*?\n}\n\nfunction throwIfAbortedMysql/)[0].replace(/\n\nfunction throwIfAbortedMysql$/, "");
const initSchema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
const day = orderProfitFxBusinessDate(new Date());
const orderedAt = new Date(Date.now() - 60000).toISOString();
const yday = orderProfitFxBusinessDate(new Date(Date.now() - 86400000));
const posting = (number, verified = true) => ({ posting_number: number, order_number: number.replace(/-1$/, ""),
  status: "awaiting_packaging", logistics_status: "created", tracking_stage: "pending_stock", ordered_at: orderedAt,
  ordered_at_verified: verified, delivered_at: null, buyer_region: "", tracking_number: "", external_tracking_url: "",
  items: [{ ozon_sku: "fixture-sku", name: "Fixture", quantity: 1, sale_price: 1200, sale_price_verified: true,
    sale_currency: "RUB", sale_currency_source: "posting.products.currency_code" }] });

async function fixture(body) {
  const connection = await mysql.createConnection({ socketPath, user: "root", timezone: "Z", dateStrings: true });
  const name = "ozon_fx_ingest_test_" + randomBytes(8).toString("hex");let created = false;
  try {
    const [[guard]] = await connection.query("SELECT @@skip_networking disabled");assert.equal(Number(guard.disabled), 1);
    await connection.query("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");created = true;
    await connection.changeUser({ database: name });await connection.query("SET SESSION time_zone='+00:00'");
    await connection.query("CREATE TABLE shops(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED) ENGINE=InnoDB");
    await connection.query("INSERT INTO shops VALUES(1,1),(2,2)");
    for (const table of ["orders", "order_items", "order_profit_items"]) {
      const sql = initSchema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?ENGINE=InnoDB[^;]+;`))[0];
      await connection.query(sql.replace(/\\`/g, "`"));
    }
    await connection.query("ALTER TABLE order_items ADD COLUMN frozen_logistics_rule_id BIGINT UNSIGNED NULL");
    await connection.query("CREATE TABLE system_settings (`key` VARCHAR(191) PRIMARY KEY,value_json LONGTEXT NOT NULL,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB");
    await connection.query("INSERT INTO system_settings (`key`,value_json) VALUES(?,?)", [policy.ORDER_PROFIT_FX_POLICY_KEY,
      JSON.stringify({ version: "V2", enabled_at: yday + " 00:00:00", legacy_max_order_id: 100 })]);
    await connection.query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(100,1,'legacy-1','awaiting_packaging',?)", [yday + " 00:00:00"]);
    await connection.query(policy.ORDER_PROFIT_FX_STATE_SCHEMA);
    for (const sql of ORDER_PROFIT_CALCULATION_SCHEMA) await connection.query(sql);
    const mysqlQuery = async (sql, params = []) => (await connection.query(sql, params))[0];
    const mysqlExecute = async (sql, params = []) => (await connection.execute(sql, params))[0];
    let beforeCommit = null;
    const withMysqlTransaction = async callback => {
      await connection.beginTransaction();
      try { const result = await callback(connection);const hook = beforeCommit;beforeCommit = null;if (hook) await hook();await connection.commit();return result; }
      catch (error) { await connection.rollback();throw error; }
    };
    await createOrderProfitDailyFxSchema(connection);
    await ensureOrderProfitDailyFx({ query: mysqlQuery }, day, { fetchImpl: async () => ({ ok: true,
      text: async () => `<ValCurs Date="${day.split("-").reverse().join(".")}"><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>12</Value></Valute></ValCurs>` }) });
    const dependencies = { ...versions, ...policy, getProfitFormula, assertProfitFormulaSupported,
      mysqlQuery, mysqlExecute, withMysqlTransaction, mysqlQueryOne: async (sql, params) => /FROM sku_mappings/.test(sql) ? null : (await mysqlQuery(sql, params))[0] || null,
      orderListTenantScopeMysql: async tenant => ({ id: Number(tenant) }), assertOrderTaskAccessMysql: async () => {},
      activeShopForTenantMysql: async id => ({ id, tenant_id: 1 }), markInventoryAlertSkuDailyDirtyMysql: async () => {},
      saveRawPostingMysql: async (shop, input) => input, orderLifecycleMysql: () => ({ syncState: "active", finalizedAt: null, note: "" }),
      orderCancelLossAppliesMysql: async () => false, recordOrderStatusHistoryMysql: async () => {},
      normalizeMysqlNullableDateTime: value => value ? new Date(value).toISOString().slice(0, 19).replace("T", " ") : null,
      roundMoneyMysql: value => Math.round((Number(value) + Number.EPSILON) * 100) / 100,
      resolveOrderStockLocationMysql: () => ({ stockLocation: "local", stockLocationSource: "fixture" }),
      upsertOnlineProductFromOrderItemMysql: async () => ({ image_url: "" }), orderTenantPredicateMysql: () => "1=1",
      resolveProfitSettlementStatusMysql: () => "pending", accrueDeliveredItemsMysql: async () => {},
      isOrderInTransportMysql: () => false, invalidateOrderProcurementCoverage: () => {},
      recordOrderExceptionMysql: async () => {}, AbortSignal, Date, Number, Math, String, Map, Set, JSON, console };
    const context = vm.createContext(dependencies);vm.runInContext(writer + "\n" + upsert, context);
    const createRunner = (dbConnection, { afterItemLookup } = {}) => {
      const query = async (sql, params = []) => (await dbConnection.query(sql, params))[0];
      const execute = async (sql, params = []) => (await dbConnection.execute(sql, params))[0];
      const transaction = async callback => {
        await dbConnection.beginTransaction();
        try { const result = await callback(dbConnection);await dbConnection.commit();return result; }
        catch (error) { await dbConnection.rollback();throw error; }
      };
      const queryOne = async (sql, params) => {
        const row = /FROM sku_mappings/.test(sql) ? null : (await query(sql, params))[0] || null;
        if (/SELECT id, quantity FROM order_items WHERE order_id/.test(sql) && afterItemLookup) await afterItemLookup(row);
        return row;
      };
      const next = vm.createContext({ ...dependencies, mysqlQuery: query, mysqlExecute: execute, mysqlQueryOne: queryOne, withMysqlTransaction: transaction });
      vm.runInContext(writer + "\n" + upsert, next);
      return input => next.upsertPostingMysql({ id: 1, tenant_id: 1 }, input, "fx_parallel_test", { tenantId: 1, salesDatesMarked: true });
    };
    await body({ connection, name, query: mysqlQuery, createRunner, setBeforeCommit: hook => { beforeCommit = hook; },
      run: input => context.upsertPostingMysql({ id: 1, tenant_id: 1 }, input, "fx_test", { tenantId: 1, salesDatesMarked: true }) });
  } finally {
    if (created) { assert.match(name, /^ozon_fx_ingest_test_[a-f0-9]{16}$/);await connection.query("DROP DATABASE `" + name + "`"); }
    await connection.end();
  }
}

test("real ingestion pins first V2 item and estimate revision atomically while legacy imports remain V1", { skip: !socketPath }, () => fixture(async ({ query, run }) => {
  await run(posting("new-v2-1"));
  const [fresh] = await query("SELECT oi.sale_price,s.formula_version,s.current_estimate_revision_id FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN order_profit_calc_state s ON s.order_item_id=oi.id WHERE o.posting_number='new-v2-1'");
  assert.equal(fresh.formula_version, "V2");assert.equal(Number(fresh.sale_price), 100);assert.ok(fresh.current_estimate_revision_id);
  await run({ ...posting("old-import-1"), ordered_at: "2026-01-01T00:00:00Z" });
  const [old] = await query("SELECT oi.sale_price,s.formula_version FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN order_profit_calc_state s ON s.order_item_id=oi.id WHERE o.posting_number='old-import-1'");
  assert.equal(old.formula_version, "V1");assert.equal(Number(old.sale_price), 1200);
}));

test("a failed revision write rolls back the newly inserted item and its version state together", { skip: !socketPath }, () => fixture(async ({ connection, query, run }) => {
  await connection.query("CREATE TRIGGER fail_fx_revision BEFORE INSERT ON order_profit_calc_revisions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture revision write failure'");
  await assert.rejects(run(posting("rollback-v2-1")), /fixture revision write failure/);
  assert.equal(Number((await query("SELECT COUNT(*) n FROM order_items"))[0].n), 0);
  assert.equal(Number((await query("SELECT COUNT(*) n FROM order_profit_calc_state"))[0].n), 0);
}));

test("a previously pinned V1 item cannot silently acquire a converted price after missing order-time evidence is repaired", { skip: !socketPath }, () => fixture(async ({ query, run }) => {
  await run(posting("repaired-evidence-1", false));
  const [before] = await query("SELECT oi.sale_price,s.formula_version FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN order_profit_calc_state s ON s.order_item_id=oi.id WHERE o.posting_number='repaired-evidence-1'");
  assert.equal(before.formula_version, "V1");assert.equal(Number(before.sale_price), 1200);
  await run(posting("repaired-evidence-1", true));
  const [after] = await query("SELECT oi.sale_price,s.formula_version FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN order_profit_calc_state s ON s.order_item_id=oi.id WHERE o.posting_number='repaired-evidence-1'");
  assert.equal(after.formula_version, "V1");assert.equal(Number(after.sale_price), 1200, "V1 price basis must not be changed by creating a later V2 FX state");
}));

test("real V2 estimate writer preserves converted unit precision until the quantity total is rounded", async () => {
  const context = vm.createContext({ ...versions, ...policy, getProfitFormula, assertProfitFormulaSupported, Number, Math, String });
  vm.runInContext(writer, context);
  const fx = { id: "1", business_date: day, source_date: day, rate: "3.000000000000", currency_from: "CNY", currency_to: "RUB", source: "cbr" };
  const input = { ozonSku: "precision-sku", quantity: 300,
    fxState: { ordered_business_date: day, orderFx: fx, prices: [{ ozon_sku: "precision-sku", amount: 1, currency: "RUB" }] },
    product: { purchase_cost: 0, domestic_shipping: 0, international_shipping: 0, handling_fee: 0, return_rate: 0, withdrawal_fee_rate: 0, advertising_rate: 0 },
    mapping: { commission_low: 0.17, commission_high: 0.17 } };
  const result = await context.estimatePinnedOrderItemProfit(null, input);
  const expected = getProfitFormula("V2").estimateItemProfit({ ...input, salePrice: 1 / 3, salePriceCurrency: "CNY", fx,
    orderBusinessDate: day, pricingAmountRub: 1 });
  assert.equal(result.profit, expected.profit, "The adapter must preserve the formula's outcome, without rounding converted 1/3 CNY unit prices to .33 first");
});

test("uncommitted real V1 ingestion and a concurrent V2 prepare serialize on the parent order without mixed state", { skip: !socketPath }, () => fixture(async ({ connection, name, query, run, setBeforeCommit }) => {
  const other = await mysql.createConnection({ socketPath, user: "root", database: name, timezone: "Z", dateStrings: true });
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  setBeforeCommit(async () => { entered();await hold; });
  const ingest = run(posting("concurrent-v1-1", false));let preparing;
  try {
    await reached;
    const [[order]] = await other.query("SELECT id FROM orders WHERE posting_number='concurrent-v1-1'");
    const db = { query: async (sql, params) => (await other.query(sql, params))[0], transaction: async callback => {
      await other.beginTransaction();
      try { const result = await callback({ query: async (sql, params) => (await other.query(sql, params))[0] });await other.commit();return result; }
      catch (error) { await other.rollback();throw error; }
    } };
    let finished = false;
    preparing = policy.prepareOrderProfitFx(db, { tenantId: 1, orderId: order.id, orderedAt, verifiedOrderedAt: true,
      items: posting("concurrent-v1-1").items }).finally(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(finished, false, "V2 preparation must wait for the uncommitted parent-order-protected V1 item");
    release();await ingest;
    assert.equal(await preparing, null);
    assert.equal(Number((await query("SELECT COUNT(*) n FROM order_profit_fx_state"))[0].n), 0);
    assert.deepEqual((await query("SELECT formula_version FROM order_profit_calc_state")).map(row => row.formula_version), ["V1"]);
    assert.equal(Number((await query("SELECT COUNT(*) n FROM order_items"))[0].n), 1);
  } finally { release();await Promise.allSettled([ingest, preparing]);await other.end(); }
}));

test("two real same-SKU ingestions that read missing items concurrently cannot create duplicate V2 items", { skip: !socketPath }, () => fixture(async ({ connection, name, query, createRunner }) => {
  await connection.query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(101,1,'same-sku-v2-1','awaiting_packaging',?)", [orderedAt.slice(0, 19).replace("T", " ")]);
  const db = { query, transaction: async callback => {
    await connection.beginTransaction();
    try { const result = await callback({ query });await connection.commit();return result; }
    catch (error) { await connection.rollback();throw error; }
  } };
  await policy.prepareOrderProfitFx(db, { tenantId: 1, orderId: 101, orderedAt, verifiedOrderedAt: true, items: posting("same-sku-v2-1").items });
  const other = await mysql.createConnection({ socketPath, user: "root", database: name, timezone: "Z", dateStrings: true });
  let reached, release, count = 0;
  const bothReadMissing = new Promise(resolve => { reached = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const afterItemLookup = async row => { assert.equal(row, null);if (++count === 2) reached();await hold; };
  const a = createRunner(connection, { afterItemLookup })(posting("same-sku-v2-1"));
  const b = createRunner(other, { afterItemLookup })(posting("same-sku-v2-1"));
  try {
    await bothReadMissing;release();
    const results = await Promise.allSettled([a, b]);
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason.code), /RETRY_REQUIRED/);
    assert.equal(Number((await query("SELECT COUNT(*) n FROM order_items WHERE order_id=101 AND ozon_sku='fixture-sku'"))[0].n), 1);
    assert.equal(Number((await query("SELECT COUNT(*) n FROM order_profit_calc_state WHERE order_id=101"))[0].n), 1);
  } finally { release();await Promise.allSettled([a, b]);await other.end(); }
}));
