import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import mysql from "mysql2/promise";
import { createOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";
import { ensureOrderProfitDailyFx } from "../src/services/order-profit-daily-fx.js";
import { ensureExchangeRateHistory, readExchangeRateHistory, parseCbrHistoryAnchor, parseCbrDynamicHistory } from "../src/services/exchange-rate-history.js";

const now = Date.parse("2026-10-28T06:00:00Z");
const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET, options = { skip: !socketPath };
const anchor = (date = "24.10.2026", value = "12,0557", id = "R01375", code = "CNY") => `<?xml version="1.0"?><ValCurs Date="${date}"><Valute ID="${id}"><NumCode>156</NumCode><CharCode>${code}</CharCode><Nominal>1</Nominal><Value>${value}</Value></Valute></ValCurs>`;
const record = (date, value, nominal = "1", id = "R01375") => `<Record Date="${date}" Id="${id}"><Nominal>${nominal}</Nominal><Value>${value}</Value></Record>`;
const dynamic = (body, from = "24.10.2026", to = "27.10.2026", id = "R01375") => `<ValCurs ID="${id}" DateRange1="${from}" DateRange2="${to}" name="Foreign Currency Market Dynamic">${body}</ValCurs>`;
const batch = dynamic(record("24.10.2026", "12,0557") + record("27.10.2026", "12,100000"));
const provider = async url => ({ ok: true, text: async () => url.includes("XML_dynamic") ? batch : anchor() });

test("official daily CNY identity plus dynamic nominal/date records preserve original precision", () => {
  assert.equal(parseCbrHistoryAnchor(anchor(), { businessDate: "2026-10-25" }).source_date, "2026-10-24");
  const rows = parseCbrDynamicHistory(dynamic(record("24.10.2026", "123,4567890", "10")), { from: "2026-10-24", to: "2026-10-27" });
  assert.deepEqual(rows, [{ source_date: "2026-10-24", rate: "12.345678900000", source_nominal: "10", source_value: "123.4567890" }]);
});

test("wrong currency, future/out-of-window dates, bad nominal and truncated XML cannot become a flat chart", () => {
  for (const xml of [anchor("24.10.2026", "12", "R01235"), anchor("24.10.2026", "12", "R01375", "USD"), anchor("28.10.2026"), anchor().replace("</ValCurs>", "")]) {
    assert.throws(() => parseCbrHistoryAnchor(xml, { businessDate: "2026-10-25" }), { code: "EXCHANGE_RATE_HISTORY_SOURCE_INVALID" });
  }
  for (const xml of [dynamic(""), dynamic(record("24.10.2026", "12", "0")), dynamic(record("24.10.2026", "12", "0.5")),
    dynamic(record("24.10.2026", "12", "1", "R01235")), dynamic(record("28.10.2026", "12")), dynamic(record("31.02.2026", "12")),
    dynamic(record("24.10.2026", "12") + record("24.10.2026", "13")), dynamic('<Record Date="24.10.2026" Id="R01375"><Nominal>1</Nominal>'),
    dynamic(record("24.10.2026", "12")).replace("</ValCurs>", ""), '<!DOCTYPE a>' + batch]) {
    assert.throws(() => parseCbrDynamicHistory(xml, { from: "2026-10-24", to: "2026-10-27" }), { code: "EXCHANGE_RATE_HISTORY_SOURCE_INVALID" });
  }
});

test("history scope is bounded to 400 valid Beijing days, refuses future dates and transaction networking", async () => {
  const db = { query: () => { throw Error("invalid ranges must not reach DB"); } };
  for (const query of [{ from: "2025-01-01", to: "2026-10-27" }, { from: "2026-10-28", to: "2026-10-25" }, { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-10-25", to: "2026-10-29" }]) {
    await assert.rejects(readExchangeRateHistory(db, { ...query, now }), { code: "EXCHANGE_RATE_HISTORY_DATE_INVALID" });
  }
  await assert.rejects(ensureExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now, inTransaction: true }), { code: "EXCHANGE_RATE_HISTORY_TRANSACTION" });
});

test("history CLI defaults to explicit read-only connection and refuses hidden apply or implicit targets", () => {
  for (const args of [[], ["--apply=false"], ["--apply", "--apply"], ["--database=test", "--mysql-admin-socket=remote:3306", "--from=2026-10-01", "--to=2026-10-26"]]) {
    const result = spawnSync(process.execPath, ["scripts/backfill-exchange-rate-history.mjs", ...args], { encoding: "utf8" });assert.equal(result.status, 1);assert.doesNotMatch(result.stderr, /password|DB_PASSWORD|ECONNREFUSED/);
  }
});

async function fixture(body) {
  const db = await mysql.createConnection({ socketPath, user: "root", timezone: "Z", dateStrings: true });
  const name = "ozon_fx_history_test_" + randomBytes(8).toString("hex");let created = false;
  try {
    const [[guard]] = await db.query("SELECT @@skip_networking disabled");assert.equal(Number(guard.disabled), 1);
    await db.query("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");created = true;
    await db.changeUser({ database: name });await db.query("SET SESSION time_zone='+00:00'");await createOrderProfitDailyFxSchema(db);
    await db.query("CREATE TABLE legacy_business(id INT PRIMARY KEY,profit DECIMAL(12,2),exchange_rate DECIMAL(12,4)) ENGINE=InnoDB");await db.query("INSERT INTO legacy_business VALUES(1,56.78,11.32)");
    await body(db);
    assert.deepEqual((await db.query("SELECT * FROM legacy_business"))[0], [{ id: 1, profit: "56.78", exchange_rate: "11.3200" }]);
  } finally { if (created) { assert.match(name, /^ozon_fx_history_test_[a-f0-9]{16}$/);await db.query("DROP DATABASE `" + name + "`"); }await db.end(); }
}

test("two official requests fill calendar days from real anchor, retain source dates and preserve existing immutable archives", options, () => fixture(async db => {
  const old = await ensureOrderProfitDailyFx(db, "2026-10-26", { now, fetchImpl: async () => ({ ok: true, text: async () => anchor("25.10.2026", "99,0000") }) });
  const calls = [];
  const result = await ensureExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now, fetchImpl: async (url, options) => { calls.push(url);assert.equal(options.redirect, "error");return provider(url); } });
  assert.equal(result.filled, 2);assert.equal(result.preserved, 1);assert.equal(calls.length, 2);assert.match(calls[0], /date_req=25\/10\/2026$/);assert.match(calls[1], /date_req1=24\/10\/2026&date_req2=27\/10\/2026&VAL_NM_RQ=R01375$/);
  await db.query("START TRANSACTION READ ONLY");
  const history = await readExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now });await db.rollback();
  assert.equal(history.complete, true);assert.deepEqual(history.rows.map(row => row.business_date), ["2026-10-25", "2026-10-26", "2026-10-27"]);
  assert.equal(history.rows[0].rate, "12.055700000000");assert.equal(history.rows[0].source_date, "2026-10-24");assert.equal(history.rows[0].carried_forward, true);
  assert.equal(history.rows[0].source_url, calls[1]);assert.equal(history.rows[0].source_sha256, createHash("sha256").update(batch).digest("hex"));
  assert.equal(history.rows[1].id, old.id);assert.equal(history.rows[1].rate, "99.000000000000");assert.equal(history.rows[1].source_url, old.source_url);assert.equal(history.rows[1].fetched_at, old.fetched_at);
  assert.equal(history.rows[2].source_date, "2026-10-27");assert.equal(history.rows[2].rate, "12.100000000000");
  assert.equal((await ensureExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now, fetchImpl: () => { throw Error("already archived must not fetch"); } })).requests, 0);
}));

test("history failures leave missing dates explicit; no inserts occur before complete source validation", options, () => fixture(async db => {
  const requested = { from: "2026-10-25", to: "2026-10-27", now };
  const initial = await readExchangeRateHistory(db, requested);assert.equal(initial.complete, false);assert.equal(initial.rows.length, 0);assert.equal(initial.missing_dates.length, 3);
  for (const fetchImpl of [async () => { throw Error("network"); }, async url => ({ ok: true, text: async () => url.includes("XML_dynamic") ? batch.replace("12,0557", "13,0000") : anchor() })]) {
    await assert.rejects(ensureExchangeRateHistory(db, { ...requested, fetchImpl }));
    assert.equal(Number((await db.query("SELECT COUNT(*) n FROM order_profit_daily_fx_rates"))[0][0].n), 0);
  }
}));

test("concurrent same-window preparation uses one two-request pull and never duplicates rows", options, () => fixture(async db => {
  let calls = 0;
  const fetchImpl = async url => { calls++;await new Promise(resolve => setTimeout(resolve, 10));return provider(url); };
  const results = await Promise.all(Array.from({ length: 5 }, () => ensureExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now, fetchImpl })));
  assert.equal(calls, 2);for (const result of results) assert.equal(result.complete, true);
  assert.equal(Number((await db.query("SELECT COUNT(*) n FROM order_profit_daily_fx_rates"))[0][0].n), 3);
}));

test("equivalent daily/batch decimal formatting keeps the batch's original precision", options, () => fixture(async db => {
  const precise = dynamic(record("24.10.2026", "12,05570000") + record("27.10.2026", "12,1000"));
  await ensureExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now,
    fetchImpl: async url => ({ ok: true, text: async () => url.includes("XML_dynamic") ? precise : anchor() }) });
  const result = await readExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now });
  assert.equal(result.rows[0].source_value, "12.05570000");assert.equal(result.rows[0].rate, "12.055700000000");
}));

test("real windows-1251 XML bytes decode by declaration and archive their exact original digest", options, () => fixture(async db => {
  const russianName = "Рынок валют";
  const xml = '<?xml version="1.0" encoding="windows-1251"?>' + batch.replace("Foreign Currency Market Dynamic", russianName);
  // This fixture is a genuine CP1251 byte sequence, including Cyrillic bytes
  // that are invalid UTF-8; it is not UTF-8 text carrying a CP1251 label.
  const bytes = Buffer.from([...xml].map(char => char.charCodeAt(0) < 128 ? char.charCodeAt(0) : char.charCodeAt(0) - 0x350));
  assert.equal(new TextDecoder("windows-1251", { fatal: true }).decode(bytes), xml);
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  await ensureExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now, fetchImpl: async url => url.includes("XML_dynamic")
    ? { ok: true, arrayBuffer: async () => bytes, text: () => { throw Error("real fetch must use original bytes"); } }
    : { ok: true, text: async () => anchor() } });
  const history = await readExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now });
  assert.equal(history.rows[0].source_sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(history.rows[0].source_sha256, createHash("sha256").update(xml, "utf8").digest("hex"));
  assert.equal(history.rows[0].rate, "12.055700000000");assert.equal(history.rows[2].source_value, "12.100000");
}));

test("unsupported encodings and invalid UTF-8 refuse without guessing or writing any dates", options, () => fixture(async db => {
  for (const response of [
    { ok: true, text: async () => '<?xml version="1.0" encoding="iso-8859-1"?>' + batch },
    { ok: true, text: async () => '<?xml version="1.0" encoding=""?>' + batch },
    { ok: true, text: async () => '<?xml version="1.0" encoding=koi8-r?>' + batch },
    { ok: true, arrayBuffer: async () => Buffer.from('<?xml version="1.0" encoding="koi8-r"?>' + batch) },
    { ok: true, arrayBuffer: async () => Buffer.from('<?xml version="1.0" ' + " ".repeat(300) + 'encoding="koi8-r"?>' + batch) },
    { ok: true, arrayBuffer: async () => Buffer.concat([Buffer.from('<?xml version="1.0" encoding="utf-8"?>'), Buffer.from([0xff]), Buffer.from(batch)]) }
  ]) {
    await assert.rejects(ensureExchangeRateHistory(db, { from: "2026-10-25", to: "2026-10-27", now,
      fetchImpl: async url => url.includes("XML_dynamic") ? response : { ok: true, text: async () => anchor() } }), { code: "EXCHANGE_RATE_HISTORY_SOURCE_INVALID" });
    assert.equal(Number((await db.query("SELECT COUNT(*) n FROM order_profit_daily_fx_rates"))[0][0].n), 0);
  }
}));

test("a full year uses two batch requests and archives all calendar days without per-day fetching", options, () => fixture(async db => {
  const from = "2025-10-28", to = "2026-10-27", firstSource = "2025-10-27";
  const start = Date.parse(firstSource + "T00:00:00Z"), end = Date.parse(to + "T00:00:00Z");
  const records = [];
  for (let cursor = start; cursor <= end; cursor += 86400000) records.push(record(new Date(cursor).toISOString().slice(0, 10).split("-").reverse().join("."), "12,0557"));
  const xml = dynamic(records.join(""), "27.10.2025", "27.10.2026");let calls = 0;
  const result = await ensureExchangeRateHistory(db, { from, to, now, fetchImpl: async url => { calls++;return { ok: true, text: async () => url.includes("XML_dynamic") ? xml : anchor("27.10.2025") }; } });
  assert.equal(result.filled, 365);assert.equal(calls, 2);
  const history = await readExchangeRateHistory(db, { from, to, now });assert.equal(history.rows.length, 365);assert.equal(history.complete, true);
}));
