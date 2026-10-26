import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { createOrderProfitDailyFxSchema, inspectOrderProfitDailyFxSchema, assertOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";
import { ensureOrderProfitDailyFx, getOrderProfitDailyFx, getOrderProfitDailyFxById, archiveOrderProfitDailyFx, fetchOrderProfitDailyFx, listOrderProfitDailyFx } from "../src/services/order-profit-daily-fx.js";
import { runOrderProfitDailyFxArchive } from "../src/services/order-profit-daily-fx-job.js";
import { migrateOrderProfitDailyFx } from "../scripts/migrate-order-profit-daily-fx.mjs";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET, options = { skip: !socketPath };
const now = Date.parse("2026-10-26T06:00:00Z");
const xml = (value = "12,0557", date = "24.10.2026") => `<ValCurs Date="${date}"><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>${value}</Value></Valute></ValCurs>`;
const provider = (value, date) => async () => ({ ok: true, text: async () => xml(value, date) });

async function fixture(body) {
  const db = await mysql.createConnection({ socketPath, user: "root", timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const name = "ozon_fx_test_" + randomBytes(8).toString("hex");let created = false;
  try {
    const [[guard]] = await db.query("SELECT @@skip_networking disabled");assert.equal(Number(guard.disabled), 1);
    await db.query("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");created = true;
    await db.changeUser({ database: name });await db.query("SET SESSION time_zone='+00:00'");
    await db.query("CREATE TABLE exchange_rates(id INT PRIMARY KEY,rate DECIMAL(12,4),effective_date DATE) ENGINE=InnoDB");
    await db.query("INSERT INTO exchange_rates VALUES(1,11.3200,'2026-05-05')");
    await body({ db, name });
  } finally { if (created) { assert.match(name, /^ozon_fx_test_[a-f0-9]{16}$/);await db.query("DROP DATABASE `" + name + "`"); }await db.end(); }
}

test("explicit narrow migration is idempotent and read-only audit never creates tables or changes legacy rate", options, () => fixture(async ({ db }) => {
  await db.query("START TRANSACTION READ ONLY");const missing = await migrateOrderProfitDailyFx(db);await db.rollback();assert.equal(missing.schema.available, false);
  assert.equal((await db.query("SHOW TABLES LIKE 'order_profit_daily_fx_rates'"))[0].length, 0);
  assert.equal((await migrateOrderProfitDailyFx(db, { apply: true })).schema.compatible, true);
  assert.equal((await migrateOrderProfitDailyFx(db, { apply: true })).archive_rows, 0);
  assert.deepEqual((await db.query("SELECT * FROM exchange_rates"))[0], [{ id: 1, rate: "11.3200", effective_date: "2026-05-05" }]);
}));

test("archive round-trips stable IDs, decimals and dates with immutable full original values", options, () => fixture(async ({ db }) => {
  await createOrderProfitDailyFxSchema(db);
  const first = await ensureOrderProfitDailyFx(db, "2026-10-26", { now, fetchImpl: provider("12,055700") });
  assert.equal(first.rate, "12.055700000000");assert.equal(first.source_value, "12.055700");assert.equal(typeof first.id, "string");
  assert.equal(first.source_date, "2026-10-24");assert.equal(first.business_date, "2026-10-26");assert.match(first.fetched_at, /Z$/);
  const changed = await fetchOrderProfitDailyFx("2026-10-26", { now: now + 10000, fetchImpl: provider("99,9999") });
  assert.deepEqual(await archiveOrderProfitDailyFx(db, changed), first);
  assert.deepEqual(await ensureOrderProfitDailyFx(db, "2026-10-26", { now, fetchImpl: () => { throw Error("archive is authoritative"); } }), first);
  assert.deepEqual(await getOrderProfitDailyFxById(db, first.id), first);
  await db.query("START TRANSACTION READ ONLY");assert.deepEqual(await getOrderProfitDailyFx(db, "2026-10-26"), first);await db.rollback();
}));

test("same-process and separate-connection races persist one day and never overwrite accepted rate", options, () => fixture(async ({ db, name }) => {
  await createOrderProfitDailyFxSchema(db);let calls = 0;
  const fetchImpl = async () => { calls++;await new Promise(resolve => setTimeout(resolve, 20));return { ok: true, text: async () => xml() }; };
  const values = await Promise.all(Array.from({ length: 8 }, () => ensureOrderProfitDailyFx(db, "2026-10-26", { now, fetchImpl })));
  assert.equal(calls, 1);for (const value of values) assert.deepEqual(value, values[0]);
  const other = await mysql.createConnection({ socketPath, user: "root", database: name, timezone: "Z", dateStrings: true });
  try {
    const a = await fetchOrderProfitDailyFx("2026-10-25", { now, fetchImpl: provider("12,0000") });
    const b = await fetchOrderProfitDailyFx("2026-10-25", { now, fetchImpl: provider("13,0000") });
    const raced = await Promise.all([archiveOrderProfitDailyFx(db, a), archiveOrderProfitDailyFx(other, b)]);
    assert.deepEqual(raced[0], raced[1]);assert.ok(["12.000000000000", "13.000000000000"].includes(raced[0].rate));
    assert.equal(Number((await db.query("SELECT COUNT(*) n FROM order_profit_daily_fx_rates"))[0][0].n), 2);
  } finally { await other.end(); }
}));

test("failed or future fetches leave no row and retry can fill an explicitly missing day", options, () => fixture(async ({ db }) => {
  await createOrderProfitDailyFxSchema(db);
  await assert.rejects(ensureOrderProfitDailyFx(db, "2026-10-26", { now, fetchImpl: async () => { throw Error("network"); } }), { code: "ORDER_PROFIT_DAILY_FX_UNAVAILABLE" });
  assert.equal(await getOrderProfitDailyFx(db, "2026-10-26"), null);
  await assert.rejects(ensureOrderProfitDailyFx(db, "2026-10-26", { now, fetchImpl: provider("12", "27.10.2026") }), { code: "ORDER_PROFIT_DAILY_FX_FUTURE_SOURCE" });
  assert.equal((await ensureOrderProfitDailyFx(db, "2026-10-26", { now, fetchImpl: provider("12,0557") })).rate, "12.055700000000");
}));

test("unexpected type/index/trigger/check changes refuse compatible readiness", options, () => fixture(async ({ db }) => {
  await createOrderProfitDailyFxSchema(db);
  await db.query("ALTER TABLE order_profit_daily_fx_rates DROP INDEX uq_order_profit_daily_fx,ADD KEY uq_order_profit_daily_fx(business_date,currency_from,currency_to,source)");
  assert.equal((await inspectOrderProfitDailyFxSchema(db)).compatible, false);await assert.rejects(assertOrderProfitDailyFxSchema(db), { code: "ORDER_PROFIT_DAILY_FX_SCHEMA_PENDING" });
  await db.query("ALTER TABLE order_profit_daily_fx_rates DROP INDEX uq_order_profit_daily_fx,ADD UNIQUE KEY uq_order_profit_daily_fx(business_date,currency_from,currency_to,source)");
  await db.query("ALTER TABLE order_profit_daily_fx_rates DROP CHECK chk_order_profit_daily_fx_positive");assert.equal((await inspectOrderProfitDailyFxSchema(db)).compatible, false);
  await db.query("ALTER TABLE order_profit_daily_fx_rates ADD CONSTRAINT chk_order_profit_daily_fx_positive CHECK(rate>0)");
  await db.query("CREATE TRIGGER fx_insert_guard BEFORE INSERT ON order_profit_daily_fx_rates FOR EACH ROW SET NEW.rate=NEW.rate");assert.equal((await inspectOrderProfitDailyFxSchema(db)).compatible, false);
}));

test("daily runner catches up only two Beijing days, continues after failure and retries only a missing archive", options, () => fixture(async ({ db }) => {
  await createOrderProfitDailyFxSchema(db);const called = [];
  const fetchImpl = async url => {
    const date = new URL(url).searchParams.get("date_req");called.push(date);
    if (date === "25/10/2026") throw Error("unavailable yesterday");
    return { ok: true, text: async () => xml() };
  };
  await assert.rejects(runOrderProfitDailyFxArchive(db, { now: Date.parse("2026-10-25T16:00:00Z"), fetchImpl }), error => {
    assert.equal(error.code, "ORDER_PROFIT_DAILY_FX_ARCHIVE_INCOMPLETE");assert.match(error.message, /2026-10-25.*2026-10-26/);return true;
  });
  assert.deepEqual(called, ["25/10/2026", "26/10/2026"]);
  assert.equal((await getOrderProfitDailyFx(db, "2026-10-26")).business_date, "2026-10-26");
  let retryCalls = 0;
  const result = await runOrderProfitDailyFxArchive(db, { now, fetchImpl: async url => {
    retryCalls++;assert.match(url, /date_req=25\/10\/2026$/);return { ok: true, text: async () => xml() };
  } });
  assert.equal(retryCalls, 1);assert.equal(result.days, 2);assert.equal(result.from, "2026-10-25");assert.equal(result.to, "2026-10-26");
  await runOrderProfitDailyFxArchive(db, { now, fetchImpl: () => { throw Error("stored days never refetch"); } });
  assert.equal(await getOrderProfitDailyFx(db, "2026-10-24"), null);
}));

test("history date filtering and pagination are read-only and keep public quote metadata", options, () => fixture(async ({ db }) => {
  await createOrderProfitDailyFxSchema(db);
  for (const day of ["2026-10-24", "2026-10-25", "2026-10-26"]) await ensureOrderProfitDailyFx(db, day, { now, fetchImpl: provider("12,055700") });
  await db.query("START TRANSACTION READ ONLY");
  try {
    const page = await listOrderProfitDailyFx(db, { from: "2026-10-25", to: "2026-10-26", page: "2", pageSize: "1" });
    assert.equal(page.total, 2);assert.equal(page.rows.length, 1);assert.equal(page.rows[0].business_date, "2026-10-25");
    assert.equal(page.rows[0].rate, "12.055700000000");assert.equal(page.rows[0].source_value, "12.055700");
    assert.equal(page.timezone, "Asia/Shanghai");assert.match(page.rows[0].fetched_at, /Z$/);
    const empty = await listOrderProfitDailyFx(db, { from: "2026-10-27" });assert.equal(empty.total, 0);assert.deepEqual(empty.rows, []);
  } finally { await db.rollback(); }
  assert.equal(Number((await db.query("SELECT COUNT(*) n FROM order_profit_daily_fx_rates"))[0][0].n), 3);
}));
