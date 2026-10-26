import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { createOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";
import { createOrderProfitCalculationTables } from "../src/services/order-profit-calculation-schema.js";
import { ORDER_PROFIT_FX_STATE_SCHEMA } from "../src/services/order-profit-fx-policy.js";
import { getExchangeRateTool, getExchangeRateToday } from "../src/services/exchange-rate-tool.js";

// Explicit disposable local socket only. Never reads application .env/config.
const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
test("real MySQL scopes current revisions to A/B/default including legacy NULL shops and public reads use no business query", { skip: !socketPath }, async () => {
  const name = "ozon_fx_tool_test_" + randomBytes(8).toString("hex");
  const db = await mysql.createConnection({ socketPath, user: "root", timezone: "Z", dateStrings: true, multipleStatements: false });
  let created = false;
  try {
    assert.equal(Number((await db.query("SELECT @@skip_networking value"))[0][0].value), 1);
    await db.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);created = true;
    await db.changeUser({ database: name });await db.query("SET SESSION time_zone='+00:00'");
    await createOrderProfitDailyFxSchema(db);await createOrderProfitCalculationTables(db);await db.query(ORDER_PROFIT_FX_STATE_SCHEMA);
    await db.query("CREATE TABLE shops(id INT PRIMARY KEY,tenant_id BIGINT NULL)");
    await db.query(`CREATE TABLE orders(id INT PRIMARY KEY,shop_id INT,status VARCHAR(64),tracking_stage VARCHAR(64),logistics_status VARCHAR(64),
      ordered_at DATETIME,delivered_at DATETIME NULL,accrued_at DATETIME NULL,cancel_reason VARCHAR(255),cancel_type VARCHAR(64),cancel_initiator VARCHAR(64),cancelled_after_ship TINYINT)`);
    await db.query("CREATE TABLE order_items(id INT PRIMARY KEY,order_id INT,ozon_sku VARCHAR(64),quantity DECIMAL(18,6),settlement_state VARCHAR(32))");
    await db.query("CREATE TABLE order_profit_items(order_item_id INT PRIMARY KEY,profit_status VARCHAR(32),lock_reason VARCHAR(128))");
    for (const [id, day, rate] of [[1, "2026-09-25", "10"], [2, "2026-10-26", "12.5"]]) {
      await db.execute(`INSERT INTO order_profit_daily_fx_rates(id,business_date,currency_from,currency_to,rate,source,source_date,
        source_nominal,source_value,source_url,source_sha256,fetched_at) VALUES (?,?,'CNY','RUB',?,'cbr',?,'1',?,'https://www.cbr.ru/',?,?)`,
      [id, day, rate, day, rate, "a".repeat(64), day + " 00:00:00"]);
    }
    await db.query("INSERT INTO shops VALUES (1,1),(2,NULL),(7,7),(8,8)");
    const actualIds = new Map();
    const addOrder = async (id, shopId, tenantKey, gain, unsigned = false, saleCurrency = "RUB", saleAmount = 1000) => {
      await db.execute(`INSERT INTO orders VALUES (?,?,?,'','',?, ?, ?, '', '', '',0)`, [id, shopId, unsigned ? "delivering" : "delivered",
        "2026-09-25 00:00:00", unsigned ? null : "2026-10-25 18:00:00", unsigned ? null : "2026-10-26 01:00:00"]);
      await db.execute("INSERT INTO order_items VALUES (?,?,'sku',2,?)", [id, id, unsigned ? "estimated" : "accrued"]);
      await db.execute("INSERT INTO order_profit_items VALUES (?,?,?)", [id, unsigned ? "estimated" : "accrued", unsigned ? null : "finance_accrued_signed_day_fx"]);
      await db.execute(`INSERT INTO order_profit_fx_state(tenant_key,order_id,ordered_business_date,signed_business_date,order_fx_id,signed_fx_id,prices_json,state)
        VALUES (?,?,'2026-09-25',?,1,?,?,'ready')`, [tenantKey, id, unsigned ? null : "2026-10-26", unsigned ? null : 2,
        JSON.stringify([{ ozon_sku: "sku", amount: saleAmount, currency: saleCurrency }])]);
      await db.execute("INSERT INTO order_profit_calc_state(tenant_key,order_item_id,order_id,formula_version) VALUES (?,?,?,'V2')", [tenantKey, id, id]);
      const insertRevision = async (number, layer, inputs, outputs, rateVersion) => {
        const [result] = await db.execute(`INSERT INTO order_profit_calc_revisions(tenant_key,order_item_id,order_id,revision_no,layer,formula_version,
          input_hash,output_hash,idempotency_key,inputs_json,outputs_json,source,rate_version_json) VALUES (?,?,?,?,?,'V2',?,?,?,?,?,'test',?)`,
        [tenantKey, id, id, number, layer, "a".repeat(64), "b".repeat(64), "c".repeat(64), JSON.stringify(inputs), JSON.stringify(outputs), JSON.stringify(rateVersion)]);
        return result.insertId;
      };
      const estimateId = await insertRevision(1, "estimate", { quantity: 2, estimate: { formulaVersion: "V2", fx: { id: "1" }, orderBusinessDate: "2026-09-25" } },
        { quantity: 2, estimated_profit: 30 }, { order_fx: { id: "1" } });
      const actualId = unsigned ? null : await insertRevision(2, "actual", { fx_attribution: { fx_gain_loss_cny: gain, settlement_basis: "signed_day" } },
        { settlement_state: "accrued", profit_status: "accrued" }, { order_fx: { id: "1" }, signed_fx: { id: "2" } });
      actualIds.set(id, actualId);
      await db.execute("UPDATE order_profit_calc_state SET current_estimate_revision_id=?,current_actual_revision_id=? WHERE tenant_key=? AND order_item_id=?", [estimateId, actualId, tenantKey, id]);
    };
    await addOrder(1, 1, "1", 1);await addOrder(2, 2, "admin", 2);await addOrder(7, 7, "7", 7);await addOrder(8, 8, "8", 8);
    await addOrder(70, 7, "7", null, true);await addOrder(80, 8, "8", null, true);
    await addOrder(71, 7, "7", null, true, "CNY", 100);
    const originalCny = (await db.query("SELECT prices_json FROM order_profit_fx_state WHERE tenant_key='7' AND order_id=71"))[0][0].prices_json;
    const calls = [], adapter = { query: async (sql, params) => { calls.push(sql);assert.match(sql.trim(), /^SELECT /);return db.query(sql, params); } };
    const now = Date.parse("2026-10-26T09:00:00Z"), options = id => ({ now, query: { from: "2026-10-26" }, tenantScope: { id, isDefault: id === 1, financeAuthorized: true } });
    const a = await getExchangeRateTool(adapter, options(7)), b = await getExchangeRateTool(adapter, options(8)), defaultTenant = await getExchangeRateTool(adapter, options(1));
    assert.equal(a.month_impact.realized.amount_cny, 7);assert.equal(b.month_impact.realized.amount_cny, 8);
    assert.equal(defaultTenant.month_impact.realized.amount_cny, 3);assert.equal(defaultTenant.month_impact.realized.included_items, 2);
    assert.equal(a.month_impact.open.included_items, 2);assert.equal(a.month_impact.open.known_rub_revenue_impact_cny, -40);
    assert.equal(a.month_impact.open.confirmed_rub_items, 1);assert.equal(a.month_impact.open.reference_cny_items, 1);
    assert.equal(a.month_impact.open.reference_rub_revenue, 2000);assert.equal(a.month_impact.open.reference_cny_impact_cny, -40);
    assert.equal(a.month_impact.open.estimated_sales_income_fx_cny, -80);
    assert.equal(b.month_impact.open.reference_cny_items, 0);assert.equal(b.month_impact.open.estimated_sales_income_fx_cny, -40);
    assert.equal((await db.query("SELECT prices_json FROM order_profit_fx_state WHERE tenant_key='7' AND order_id=71"))[0][0].prices_json, originalCny);
    // Missing profit-cost inputs do not block gross sales exposure. A later
    // quantity decrease reduces exposure without changing frozen price facts.
    await db.query("DELETE FROM order_profit_calc_revisions WHERE tenant_key='7' AND order_item_id=71 AND layer='estimate'");
    assert.equal((await getExchangeRateTool(adapter, options(7))).month_impact.open.estimated_sales_income_fx_cny, -80);
    await db.query("UPDATE order_items SET quantity=1 WHERE id=71");
    const reduced = await getExchangeRateTool(adapter, options(7));
    assert.equal(reduced.month_impact.open.reference_rub_revenue, 1000);
    assert.equal(reduced.month_impact.open.estimated_sales_income_fx_cny, -60);
    assert.equal((await db.query("SELECT prices_json FROM order_profit_fx_state WHERE tenant_key='7' AND order_id=71"))[0][0].prices_json, originalCny);
    // A corrupt pointer into B's actual history must not import B's attribution.
    await db.execute("UPDATE order_profit_calc_state SET current_actual_revision_id=? WHERE tenant_key='7' AND order_item_id=7", [actualIds.get(8)]);
    const wrongPointer = await getExchangeRateTool(adapter, options(7));
    assert.equal(wrongPointer.month_impact.realized.amount_cny, null);assert.equal(wrongPointer.month_impact.realized.pending_items, 1);
    calls.length = 0;
    assert.equal((await getExchangeRateTool(adapter, { now, query: { from: "2026-10-26" } })).month_impact, null);
    await getExchangeRateToday(adapter, { now });
    assert.equal(calls.length, 3);assert.ok(calls.every(sql => !sql.includes("FROM orders")));
  } finally {
    if (created) { assert.match(name, /^ozon_fx_tool_test_[a-f0-9]{16}$/);await db.query(`DROP DATABASE \`${name}\``); }
    await db.end();
  }
});
