import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import mysql from "mysql2/promise";
import { fetchOzonDailyAccruals } from "../src/services/ozon-finance-accrual-client.js";
import { normalizeOzonFinanceAccrual } from "../src/services/ozon-finance-accruals.js";
import { writeOrderFinanceAccrual } from "../src/services/order-finance-accrual-write.js";
import { createOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";
import { ensureOrderProfitDailyFx, getOrderProfitDailyFx } from "../src/services/order-profit-daily-fx.js";
import { ORDER_PROFIT_FX_STATE_SCHEMA, readOrderProfitFxState } from "../src/services/order-profit-fx-policy.js";
import { readOrderFxFinanceRows } from "../src/services/order-profit-fx-finance.js";
import { planOrderFxSettlement } from "../src/services/order-profit-fx-settlement.js";
import { createOrderProfitCalculationTables } from "../src/services/order-profit-calculation-schema.js";
import { recordOrderProfitCalculation } from "../src/services/order-profit-calculation-versions.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET, options = { skip: !socketPath };
const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const classify = runInNewContext(`(${source.match(/function ozonFinanceCategoryMysql\(row = \{\}\) \{[\s\S]*?\n\}/)[0]})`);
const day = "2026-10-26", lateDay = "2026-10-27", posting = "123456-1001-1", parent = "123456-1001";
const shop = { id: 1, tenant_id: 10 }, money = amount => ({ amount, currency: "RUB" });
const types = [{ id: 1, name: "Acquiring" }, { id: 2, name: "Logistic" }, { id: 3, name: "RfbsGlobalDelivery" }, { id: 4, name: "PremiumSubscription" }];
const mainReceipt = () => ({ accrual_id: "501", date: day, accrued_category: "POSTING", unit_number: posting,
  total_amount: money(800), posting: { products: [{ sku: "700", quantity: 1, commission: { sale_amount: money(1000), sale_commission: money(-100) } }] },
  non_item_fee: [{ type_id: 1, accrued: money(-10) }, { type_id: 2, accrued: money(-90) }] });
const lateReceipt = () => ({ accrual_id: "502", date: lateDay, accrued_category: "POSTING", unit_number: posting,
  total_amount: money(-25), non_item_fee: [{ type_id: 4, accrued: money(-25) }] });

async function fixture(body) {
  const db = await mysql.createConnection({ socketPath, user: "root", timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const name = "ozon_accrual_pipeline_test_" + randomBytes(8).toString("hex");let created = false;
  try {
    const [[guard]] = await db.query("SELECT @@skip_networking disabled");assert.equal(Number(guard.disabled), 1);
    await db.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);created = true;
    await db.changeUser({ database: name });await db.query("SET SESSION time_zone='+00:00'");
    const schema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
    for (const table of ["shops", "orders", "order_items", "order_profit_items", "ozon_orders_raw", "ozon_finance_items"]) {
      const statement = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) ENGINE=InnoDB[^;]*;`))?.[0];
      assert.ok(statement);await db.query(statement);
    }
    await createOrderProfitDailyFxSchema(db);await createOrderProfitCalculationTables(db);await db.query(ORDER_PROFIT_FX_STATE_SCHEMA);
    const query = async (sql, params = []) => (await db.query(sql, params))[0];
    const transaction = async callback => {
      await db.beginTransaction();
      try { const result = await callback(db);await db.commit();return result; }
      catch (error) { await db.rollback();throw error; }
    };
    await query("INSERT INTO shops(id,tenant_id,name,status) VALUES(1,10,'Fixture A','active'),(2,20,'Fixture B','active')");
    await query(`INSERT INTO orders(id,shop_id,posting_number,order_number,status,tracking_stage,ordered_at,delivered_at)
      VALUES(101,1,?,?,'delivered','posting_received','2026-10-25 00:00:00','2026-10-26 00:00:00'),
      (102,1,'123456-0999-1','123456-0999','delivered','posting_received','2026-10-01 00:00:00','2026-10-20 00:00:00'),
      (201,2,?,?,'delivered','posting_received','2026-10-01 00:00:00','2026-10-20 00:00:00')`, [posting, parent, posting, parent]);
    await query(`INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,frozen_purchase_cost,frozen_domestic_shipping,estimated_profit,actual_profit,settlement_state)
      VALUES(1011,101,'700',1,100,20,3,50,0,'pending'),(1021,102,'old',1,123,12,2,88,88,'accrued'),(2011,201,'B',1,99,11,1,77,77,'accrued')`);
    await query(`INSERT INTO order_profit_items(order_item_id,sale_amount_cny,purchase_cost_cny,domestic_shipping_cny,packaging_cost_cny,commission_fee_cny,international_shipping_cny,other_fee_cny,net_profit_cny,profit_status)
      VALUES(1011,100,20,3,2,15,9,1,50,'estimated'),(1021,123,12,2,0,10,11,0,88,'accrued'),(2011,99,11,1,0,5,5,0,77,'accrued')`);
    await query(`INSERT INTO ozon_finance_items(shop_id,operation_id,posting_number,service_type,amount,amount_cny,operation_date,raw_json)
      VALUES(1,'legacy-902','123456-0999-1','sale_commission',-100,-8.83,'2026-10-20 00:00:00','legacy-preserved'),
      (2,'legacy-B',?,'sale_commission',-99,-8.75,'2026-10-20 00:00:00','tenant-B-preserved')`, [posting]);
    const quotes = new Map();
    for (const [date, rate] of [["2026-10-25", 10], [day, 12.5], [lateDay, 20]]) {
      const [year, month, dateOfMonth] = date.split("-");
      quotes.set(date, await ensureOrderProfitDailyFx(db, date, { now: Date.parse(`${lateDay}T06:00:00Z`), fetchImpl: async () => ({ ok: true,
        text: async () => `<ValCurs Date="${dateOfMonth}.${month}.${year}"><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>${rate}</Value></Valute></ValCurs>` }) }));
    }
    await query(`INSERT INTO order_profit_fx_state(tenant_key,order_id,ordered_business_date,signed_business_date,order_fx_id,signed_fx_id,signed_at,prices_json,state)
      VALUES('10',101,'2026-10-25',?,?,?,'2026-10-26 00:00:00',?,'ready')`,
    [day, quotes.get("2026-10-25").id, quotes.get(day).id, JSON.stringify([{ ozon_sku: "700", amount: 1000, currency: "RUB" }])]);
    for (const [tenantId, orderId, orderItemId, formulaVersion, profit] of [[10,101,1011,"V2",50],[10,102,1021,"V1",88],[20,201,2011,"V1",77]]) {
      await transaction(connection => recordOrderProfitCalculation(connection, { tenantId, orderId, orderItemId,
        initialFormulaVersion: formulaVersion, formulaVersion, legacy: false, layer: "estimate", inputs: { estimate: { fxPending: false } },
        outputs: { estimated_profit: profit }, source: "fixture_initial_estimate" }));
    }
    const protectedState = async () => ({
      finance: await query("SELECT * FROM ozon_finance_items WHERE shop_id=2 OR operation_id='legacy-902' ORDER BY id"),
      items: await query("SELECT * FROM order_items WHERE id IN(1021,2011) ORDER BY id"),
      profits: await query("SELECT * FROM order_profit_items WHERE order_item_id IN(1021,2011) ORDER BY id"),
      states: await query("SELECT * FROM order_profit_calc_state WHERE order_item_id IN(1021,2011) ORDER BY order_item_id"),
      revisions: await query("SELECT * FROM order_profit_calc_revisions WHERE order_item_id IN(1021,2011) ORDER BY id")
    });
    const write = async op => writeOrderFinanceAccrual({ transaction, shop, operation: op,
      fx: await getOrderProfitDailyFx(db, op.operation_date), assertAuthorized: async ({ shop: owner }) => assert.equal(Number(owner.tenant_id), 10) });
    const sync = async ({ late = false } = {}) => {
      const calls = [];let authorizationChecks = 0;
      const result = await fetchOzonDailyAccruals(shop, { from: day, to: lateDay, normalizeAccrual: normalizeOzonFinanceAccrual,
        beforeRequest: async () => { authorizationChecks++;return shop; }, request: async (path, payload, requestOptions) => {
          calls.push({ path, payload });assert.equal(requestOptions.shop.tenant_id, 10);assert.equal(requestOptions.method, "POST");
          if (path === "/v1/finance/accrual/types") return { accrual_types: types };
          assert.equal(path, "/v1/finance/accrual/by-day");
          if (payload.date === day) return payload.last_id === "" ? { accruals: [mainReceipt()], last_id: "opaque-next" }
            : { accruals: [mainReceipt()], last_id: "" };
          assert.deepEqual(payload, { date: lateDay, last_id: "" });return { accruals: late ? [lateReceipt()] : [], last_id: "" };
        } });
      assert.equal(authorizationChecks, calls.length);assert.equal(result.requests, 4);assert.equal(result.fetched, late ? 2 : 1);
      const writes = [];
      for (const op of result.accruals) writes.push(await write(op));
      return { calls, writes };
    };
    const readPlan = async () => {
      const [order] = await query("SELECT *,id AS order_id,status AS order_status FROM orders WHERE id=101");
      const items = await query(`SELECT oi.*,opi.purchase_cost_cny,opi.domestic_shipping_cny,opi.advertising_cost_cny FROM order_items oi
        JOIN order_profit_items opi ON opi.order_item_id=oi.id WHERE oi.order_id=101`);
      const fxState = await readOrderProfitFxState(db, 10, 101);
      const finance = await readOrderFxFinanceRows({ query, order, items: fxState.prices.map(row => ({ ozon_sku: row.ozon_sku,
        sale_price: row.amount, sale_currency_code: row.currency })), rateRubPerCny: fxState.signedFx.rate,
      allocationRateRubPerCny: fxState.orderFx.rate, classifyCategory: classify });
      assert.equal(finance.ok, true);
      const plan = await planOrderFxSettlement({ order, items, fxState, finance, initialEstimates: new Map([[1011, 50]]),
        classifyCategory: classify, packagingFeeForSaleAmount: async () => 2, accounting: { outcome_type: "delivered_signed", loss_profile_code: "none" } });
      assert.equal(plan.ok, true);return { plan, finance, fxState };
    };
    const settle = async ({ rejectProjection = false } = {}) => {
      const { plan, finance, fxState } = await readPlan(), projection = plan.items[0];
      const result = await transaction(connection => recordOrderProfitCalculation(connection, {
        tenantId: 10, orderId: 101, orderItemId: 1011, layer: "actual", formulaVersion: "V2", source: "ozon_finance_daily_fx",
        inputs: { finance_rows: finance.source_rows, fx_attribution: projection.attribution },
        outputs: { actual_profit: projection.actualProfit, net_profit_cny: projection.actualProfit, settlement_state: "accrued", profit_status: "accrued" },
        rateVersion: { order_fx: plan.orderFx, signed_fx: plan.finalFx, settlement_basis: plan.settlementBasis },
        project: async () => {
          await connection.query("UPDATE order_items SET actual_profit=?,settlement_state='accrued' WHERE id=1011", [projection.actualProfit]);
          await connection.query(`UPDATE order_profit_items SET sale_amount_cny=?,commission_fee_cny=?,other_fee_cny=?,international_shipping_cny=?,
            ozon_service_fee_cny=?,net_profit_cny=?,profit_status='accrued',is_locked=1,lock_reason='finance_accrued_signed_day_fx' WHERE order_item_id=1011`,
          [projection.itemSale,projection.commissionFeeCny,projection.otherFee,projection.actualInternationalShipping,projection.actualServiceFeeCny,projection.actualProfit]);
          if (rejectProjection) throw Error("injected-projection-failure");
        }
      }));
      return { ...result, projection, fxState };
    };
    await body({ db, query, transaction, write, sync, settle, readPlan, protectedState, quotes });
  } finally {
    if (created) { assert.match(name, /^ozon_accrual_pipeline_test_[a-f0-9]{16}$/);await db.query(`DROP DATABASE \`${name}\``); }
    await db.end();
  }
}

test("real daily API-to-ledger-to-V2 settlement pipeline is idempotent, late-fee aware and isolated from B and V1", options, () => fixture(async ({ query, sync, settle, protectedState, quotes }) => {
  const untouched = await protectedState();const first = await sync();assert.equal(first.writes[0].inserted, 4);
  const financeBefore = await query("SELECT * FROM ozon_finance_items WHERE shop_id=1 AND LEFT(operation_id,15)='accrual_by_day:' ORDER BY id");
  const actual = await settle();assert.equal(actual.changed, true);assert.equal(actual.projection.actualProfit, 39);
  assert.equal(actual.projection.attribution.fx_gain_loss_cny, -16);assert.equal(actual.projection.attribution.business_variance_cny, 5);
  assert.equal(actual.projection.attribution.total_variance_cny, -11);
  const beforeRevisions = await query("SELECT * FROM order_profit_calc_revisions WHERE order_item_id=1011 ORDER BY revision_no");
  assert.equal(beforeRevisions.length, 2);
  const repeated = await sync();assert.ok(repeated.writes.every(row => row.inserted === 0 && row.updated === 0 && row.deleted === 0));
  assert.deepEqual(await query("SELECT * FROM ozon_finance_items WHERE shop_id=1 AND LEFT(operation_id,15)='accrual_by_day:' ORDER BY id"), financeBefore);
  assert.equal((await settle()).changed, false);
  assert.deepEqual(await query("SELECT * FROM order_profit_calc_revisions WHERE order_item_id=1011 ORDER BY revision_no"), beforeRevisions);
  await sync({ late: true });const after = await settle();assert.equal(after.changed, true);assert.equal(after.projection.actualProfit, 37);
  assert.equal(after.projection.attribution.initial_estimated_profit_cny, 50);assert.equal(after.projection.attribution.fx_gain_loss_cny, -15.5);
  assert.equal(after.projection.attribution.business_variance_cny, 2.5);assert.equal(after.projection.attribution.total_variance_cny, -13);
  assert.equal(after.fxState.signedFx.id, quotes.get(day).id);assert.equal(after.fxState.orderFx.id, quotes.get("2026-10-25").id);
  const [late] = await query("SELECT amount_cny,raw_json FROM ozon_finance_items WHERE operation_id='accrual_by_day:502'");
  assert.equal(late.amount_cny, "-1.2500");assert.equal(JSON.parse(late.raw_json)._erp_fx_archive.id, quotes.get(lateDay).id);
  assert.equal(Number((await query("SELECT COUNT(*) n FROM order_profit_calc_revisions WHERE order_item_id=1011"))[0].n), 3);
  assert.deepEqual(await protectedState(), untouched);
}));

test("real pipeline parent allocation uses fixed order-day weights across FX and excludes the other enterprise", options, () => fixture(async ({ query, write, sync, readPlan, quotes, protectedState }) => {
  const untouched = await protectedState();await sync();
  await query(`INSERT INTO orders(id,shop_id,posting_number,order_number,status,ordered_at,delivered_at) VALUES(103,1,'123456-1001-2',?,'delivered','2026-10-25','2026-10-26')`, [parent]);
  await query("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES(1031,103,'701',1,300)");
  await query(`INSERT INTO order_profit_fx_state(tenant_key,order_id,ordered_business_date,signed_business_date,order_fx_id,signed_fx_id,prices_json,state)
    VALUES('10',103,'2026-10-25',?,?,?,?,'ready')`, [day, quotes.get("2026-10-25").id, quotes.get(day).id, JSON.stringify([{ ozon_sku: "701", amount: 3000, currency: "RUB" }])]);
  await write(normalizeOzonFinanceAccrual({ accrual_id: "503", date: day, accrued_category: "ITEM", unit_number: parent,
    total_amount: money(-40), non_item_fee: [{ type_id: 3, accrued: money(-40) }] }, { types }));
  const { finance, plan } = await readPlan();assert.equal(finance.allocation.share, 0.25);
  assert.equal(finance.allocation.allocation_rate_rub_per_cny, 10);assert.equal(finance.sale_accrual_cny, 80);
  assert.equal(plan.items[0].actualProfit, 38.2);assert.equal(plan.items[0].attribution.fx_gain_loss_cny, -15.8);
  assert.deepEqual(await protectedState(), untouched);
}));

test("real pipeline profit projection failure rolls back the revision and projection together", options, () => fixture(async ({ query, sync, settle }) => {
  await sync();await settle();const before = await query("SELECT * FROM order_profit_calc_revisions WHERE order_item_id=1011 ORDER BY id");
  await sync({ late: true });await assert.rejects(settle({ rejectProjection: true }), /injected-projection-failure/);
  assert.deepEqual(await query("SELECT * FROM order_profit_calc_revisions WHERE order_item_id=1011 ORDER BY id"), before);
  assert.equal((await query("SELECT actual_profit FROM order_items WHERE id=1011"))[0].actual_profit, "39.0000");
  assert.equal((await query("SELECT net_profit_cny FROM order_profit_items WHERE order_item_id=1011"))[0].net_profit_cny, "39.0000");
}));
