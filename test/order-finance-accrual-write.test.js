import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import mysql from "mysql2/promise";
import { normalizeOzonFinanceAccrual } from "../src/services/ozon-finance-accruals.js";
import { writeOrderFinanceAccrual } from "../src/services/order-finance-accrual-write.js";
import { createOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";
import { ensureOrderProfitDailyFx } from "../src/services/order-profit-daily-fx.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const realMysql = { skip: !socketPath };
const day = "2026-10-26", now = Date.parse(`${day}T06:00:00Z`);
const types = [{ id: 1, name: "Acquiring" }, { id: 2, name: "Logistic" }, { id: 3, name: "RfbsGlobalDelivery" }];
const monetary = (amount, currency = "RUB") => ({ amount, currency });
function operation({ id = "17", currency = "RUB", fees = [{ type_id: 1, accrued: monetary(-50, currency) }], total = 900, raw = {} } = {}) {
  return normalizeOzonFinanceAccrual({ accrual_id: id, date: day, accrued_category: "POSTING", unit_number: "123-456-1",
    total_amount: monetary(total, currency), posting: { products: [{ sku: "700", quantity: 1,
      commission: { sale_amount: monetary(1000, currency), sale_commission: monetary(-50, currency) } }] },
    non_item_fee: fees, ...raw }, { types });
}
const auth = async () => {};
const quote = { id: "1", rate: 10, business_date: day, source_date: day, currency_from: "CNY", currency_to: "RUB", source: "cbr" };

test("invalid source, unknown currency, duplicate gross and wrong FX stop before any transaction", async () => {
  const transaction = () => { throw Error("must not start"); };
  const call = extra => writeOrderFinanceAccrual({ transaction, shop: { id: 1, tenant_id: 10 }, operation: operation(), fx: quote, assertAuthorized: auth, ...extra });
  await assert.rejects(call({ operation: { ...operation(), operation_id: "17" } }), { code: "ORDER_FINANCE_ACCRUAL_ID_INVALID" });
  await assert.rejects(call({ fx: { ...quote, currency_from: "RUB", currency_to: "CNY" } }), { code: "ORDER_PROFIT_FX_INVALID" });
  await assert.rejects(call({ fx: { ...quote, business_date: "2026-10-25", source_date: "2026-10-25" } }), { code: "ORDER_PROFIT_FX_INVALID" });
  const unsupported = operation();unsupported.rows[0].currency_code = "USD";
  await assert.rejects(call({ operation: unsupported }), { code: "ORDER_FINANCE_ACCRUAL_CURRENCY_UNKNOWN" });
  const repeated = operation();repeated.rows[1].accruals_for_sale = 1000;
  await assert.rejects(call({ operation: repeated }), { code: "ORDER_FINANCE_ACCRUAL_GROSS_REPEATED" });
  const tooPrecise = operation();tooPrecise.rows[1].amount = -0.00001;
  await assert.rejects(call({ operation: tooPrecise }), { code: "ORDER_FINANCE_ACCRUAL_PRECISION_UNSUPPORTED" });
  await assert.rejects(call({ operation: { ...operation(), source_endpoint: "/v3/finance/transaction/list" } }), { code: "ORDER_FINANCE_ACCRUAL_SOURCE_INVALID" });
});

async function fixture(body) {
  const db = await mysql.createConnection({ socketPath, user: "root", timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const name = "ozon_accrual_write_test_" + randomBytes(8).toString("hex");
  let created = false;
  try {
    const [[guard]] = await db.query("SELECT @@skip_networking disabled");assert.equal(Number(guard.disabled), 1);
    await db.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);created = true;
    await db.changeUser({ database: name });await db.query("SET SESSION time_zone='+00:00'");
    await db.query("CREATE TABLE shops(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL,status VARCHAR(32) NOT NULL) ENGINE=InnoDB");
    await db.query("INSERT INTO shops VALUES(1,10,'active'),(2,20,'active'),(3,NULL,'active')");
    const schema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
    const sql = schema.match(/CREATE TABLE IF NOT EXISTS ozon_finance_items \([\s\S]*?\) ENGINE=InnoDB[^;]*;/)?.[0];
    assert.ok(sql);await db.query(sql);
    await createOrderProfitDailyFxSchema(db);
    const fx = await ensureOrderProfitDailyFx(db, day, { now, fetchImpl: async () => ({ ok: true,
      text: async () => `<ValCurs Date="26.10.2026"><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>10,0000</Value></Valute></ValCurs>` }) });
    const transaction = async callback => {
      await db.beginTransaction();
      try { const result = await callback(db);await db.commit();return result; }
      catch (error) { await db.rollback();throw error; }
    };
    const write = (op = operation(), extra = {}) => writeOrderFinanceAccrual({ transaction, shop: { id: 1, tenant_id: 10 },
      operation: op, fx, assertAuthorized: auth, ...extra });
    const rows = async () => (await db.query("SELECT * FROM ozon_finance_items ORDER BY shop_id,operation_id,service_type"))[0];
    const vouchers = () => db.query("CREATE TABLE finance_vouchers(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,finance_item_id BIGINT UNSIGNED NULL,KEY idx_finance_voucher_item(finance_item_id)) ENGINE=InnoDB");
    await body({ db, fx, transaction, write, rows, vouchers });
  } finally {
    if (created) { assert.match(name, /^ozon_accrual_write_test_[a-f0-9]{16}$/);await db.query(`DROP DATABASE \`${name}\``); }
    await db.end();
  }
}

test("real MySQL writes one gross anchor, per-category fees, operation-day CNY and complete archive evidence", realMysql, () => fixture(async ({ write, rows }) => {
  const result = await write();assert.equal(result.inserted, 3);assert.equal(result.reconciled, true);
  const stored = await rows();assert.equal(stored.length, 3);
  assert.equal(stored.reduce((sum, row) => sum + Number(row.amount), 0), 900);
  assert.equal(stored.reduce((sum, row) => sum + Number(row.amount_cny), 0), 90);
  assert.equal(stored.reduce((sum, row) => sum + Number(row.accruals_for_sale), 0), 1000);
  assert.equal(stored.reduce((sum, row) => sum + Number(row.sale_commission), 0), -50);
  assert.equal(stored.filter(row => Number(row.accruals_for_sale) !== 0).length, 1);
  for (const row of stored) {
    assert.equal(row.exchange_rate, "10.0000");
    const raw = JSON.parse(row.raw_json);assert.equal(raw._erp_source_endpoint, "/v1/finance/accrual/by-day");
    assert.equal(raw._erp_fx_archive.business_date, day);assert.equal(raw._erp_fx_archive.rate, "10.000000000000");
    assert.equal(raw.raw.accrual_id, "17");assert.equal(raw._normalization.reconciliation.ok, true);
  }
}));

test("real MySQL identity CNY and international per-row delivery totals do not reuse RUB conversion", realMysql, () => fixture(async ({ write, rows }) => {
  await write(operation({ currency: "CNY", total: 920, fees: [{ type_id: 3, accrued: monetary(-30, "CNY") }] }));
  const stored = await rows();assert.equal(stored.reduce((sum, row) => sum + Number(row.amount_cny), 0), 920);
  assert.equal(stored.reduce((sum, row) => sum + Number(row.delivery_charge), 0), -30);
  assert.equal(stored.reduce((sum, row) => sum + Number(row.delivery_charge_cny), 0), -30);
  assert.ok(stored.every(row => row.exchange_rate === "1.0000"));
}));

test("real MySQL identical snapshots preserve IDs and timestamps without lazy voucher schema", realMysql, () => fixture(async ({ db, write, rows }) => {
  await write();await db.query("UPDATE ozon_finance_items SET synced_at='2020-01-01 00:00:00'");const before = await rows();
  const result = await write();assert.equal(result.updated, 0);assert.equal(result.inserted, 0);assert.equal(result.deleted, 0);assert.equal(result.unchanged, 3);
  assert.deepEqual(await rows(), before);
}));

test("real MySQL corrections replace obsolete rows, retain stable IDs and preserve other shops and legacy v3 facts", realMysql, () => fixture(async ({ db, write, rows }) => {
  await write();await write(operation(), { shop: { id: 2, tenant_id: 20 } });
  await db.query("INSERT INTO ozon_finance_items(shop_id,operation_id,service_type,amount,raw_json) VALUES(1,'17','sale_commission',-11,'legacy-v3')");
  const before = await rows(), protectedRows = before.filter(row => row.shop_id === "2" || row.operation_id === "17");
  const retained = before.find(row => row.shop_id === "1" && row.service_name === "SaleCommission").id;
  const result = await write(operation({ fees: [], total: 950 }));
  assert.equal(result.deleted, 1);assert.equal(result.inserted, 0);
  const after = await rows();assert.equal(after.find(row => row.shop_id === "1" && row.service_name === "SaleCommission").id, retained);
  assert.deepEqual(after.filter(row => row.shop_id === "2" || row.operation_id === "17"), protectedRows);
  assert.equal(after.filter(row => row.shop_id === "1" && row.operation_id.startsWith("accrual_by_day:")).length, 2);
}));

test("real MySQL reordered fees and amount corrections keep their semantic primary keys", realMysql, () => fixture(async ({ write, rows }) => {
  const first = operation({ total: 870, fees: [{ type_id: 1, accrued: monetary(-50) }, { type_id: 2, accrued: monetary(-30) }] });
  await write(first);const ids = new Map((await rows()).map(row => [row.service_type, row.id]));
  await write(operation({ total: 860, fees: [{ type_id: 2, accrued: monetary(-40) }, { type_id: 1, accrued: monetary(-50) }] }));
  for (const row of await rows()) assert.equal(row.id, ids.get(row.service_type));
  assert.equal((await rows()).reduce((sum, row) => sum + Number(row.amount), 0), 860);
}));

test("real MySQL failure after replacement writes rolls back deletes, updates and inserts", realMysql, () => fixture(async ({ write, rows, transaction }) => {
  await write();const before = await rows();
  const failing = callback => transaction(connection => callback({ query: async (sql, params) => {
    const result = await connection.query(sql, params);
    if (sql.includes("INSERT INTO ozon_finance_items")) throw Error("injected-after-insert");
    return result;
  } }));
  await assert.rejects(write(operation({ total: 890, fees: [{ type_id: 2, accrued: monetary(-60) }] }), { transaction: failing }), /injected-after-insert/);
  assert.deepEqual(await rows(), before);
}));

test("real MySQL authoritative shop owner and second authorization reject cross-tenant and revoked writes", realMysql, () => fixture(async ({ write, rows }) => {
  await write();const before = await rows();
  await assert.rejects(write(operation({ fees: [], total: 950 }), { shop: { id: 1, tenant_id: 20 } }), { code: "ORDER_FINANCE_SHOP_SCOPE_INVALID" });
  let checks = 0;
  await assert.rejects(write(operation({ fees: [], total: 950 }), { assertAuthorized: async () => {
    checks++;if (checks === 2) throw Object.assign(Error("revoked"), { code: "REVOKED" });
  } }), { code: "REVOKED" });
  assert.equal(checks, 2);assert.deepEqual(await rows(), before);
}));

test("real MySQL forged quote cannot override an accepted immutable archive", realMysql, () => fixture(async ({ fx, write, rows }) => {
  await assert.rejects(write(operation(), { fx: { ...fx, rate: 99 } }), { code: "ORDER_FINANCE_FX_ARCHIVE_MISMATCH" });
  assert.deepEqual(await rows(), []);
}));

test("real MySQL same-day legacy source blocks a second API representation without touching either shop", realMysql, () => fixture(async ({ db, write, rows }) => {
  await db.query("INSERT INTO ozon_finance_items(shop_id,operation_id,service_type,amount,operation_date,raw_json) VALUES(1,'legacy-17','sale_commission',-11,'2026-10-26 01:00:00','legacy-v3')");
  const before = await rows();
  await assert.rejects(write(), { code: "ORDER_FINANCE_ACCRUAL_LEGACY_DAY_CONFLICT" });
  assert.deepEqual(await rows(), before);
  await write(operation(), { shop: { id: 2, tenant_id: 20 } });
  assert.equal((await rows()).filter(row => row.shop_id === "2").length, 3);
  assert.deepEqual((await rows()).filter(row => row.shop_id === "1"), before);
}));

test("real MySQL referenced obsolete or corrected finance rows refuse changes and keep vouchers valid", realMysql, () => fixture(async ({ db, write, rows, vouchers }) => {
  await write();await vouchers();const before = await rows();
  const fee = before.find(row => row.service_name === "Acquiring");
  await db.query("INSERT INTO finance_vouchers(finance_item_id) VALUES(?)", [fee.id]);
  await assert.rejects(write(operation({ total: 950, fees: [] })), { code: "ORDER_FINANCE_VOUCHER_REVIEW_REQUIRED" });
  await assert.rejects(write(operation({ total: 890, fees: [{ type_id: 1, accrued: monetary(-60) }] })), { code: "ORDER_FINANCE_VOUCHER_REVIEW_REQUIRED" });
  assert.deepEqual(await rows(), before);
  assert.equal((await db.query("SELECT finance_item_id FROM finance_vouchers"))[0][0].finance_item_id, fee.id);
}));

test("real MySQL existing broken voucher schema is not silently ignored", realMysql, () => fixture(async ({ db, write, rows }) => {
  await write();const before = await rows();await db.query("CREATE TABLE finance_vouchers(id INT PRIMARY KEY) ENGINE=InnoDB");
  await assert.rejects(write(operation({ total: 950, fees: [] })), { code: "ER_BAD_FIELD_ERROR" });
  assert.deepEqual(await rows(), before);
}));

test("real MySQL unreconciled source remains complete for review but never becomes a reconciled receipt", realMysql, () => fixture(async ({ write, rows }) => {
  const op = operation({ total: 901 });assert.equal(op.reconciliation.ok, false);
  const result = await write(op);assert.equal(result.reconciled, false);
  for (const row of await rows()) assert.equal(JSON.parse(row.raw_json)._normalization.reconciliation.ok, false);
}));
