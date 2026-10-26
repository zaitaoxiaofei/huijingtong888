import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { orderProfitFxBusinessDate, fetchOrderProfitDailyFx, ensureOrderProfitDailyFx, getOrderProfitDailyFx } from "../src/services/order-profit-daily-fx.js";

const now = Date.parse("2026-10-26T06:00:00Z");
const xml = (date = "24.10.2026", nominal = "1", value = "12,0557") => `<ValCurs Date="${date}"><Valute><CharCode>CNY</CharCode><Nominal>${nominal}</Nominal><Value>${value}</Value></Valute></ValCurs>`;
const response = body => async () => ({ ok: true, text: async () => body });

test("business dates use Beijing calendar while stored timezone-less timestamps mean UTC", () => {
  assert.equal(orderProfitFxBusinessDate("2026-10-25T16:00:00Z"), "2026-10-26");
  assert.equal(orderProfitFxBusinessDate("2026-10-25 16:00:00"), "2026-10-26");
  assert.equal(orderProfitFxBusinessDate("2026-10-26"), "2026-10-26");
  assert.throws(() => orderProfitFxBusinessDate("2026-02-30"), { code: "ORDER_PROFIT_DAILY_FX_DATE_INVALID" });
  for (const invalid of ["2026-02-30T08:00:00Z", "2026-10-26T24:00:00Z", "10/26/2026", "0", ""]) {
    assert.throws(() => orderProfitFxBusinessDate(invalid), { code: "ORDER_PROFIT_DAILY_FX_DATE_INVALID" });
  }
  assert.throws(() => orderProfitFxBusinessDate(null), { code: "ORDER_PROFIT_DAILY_FX_DATE_INVALID" });
});

test("official dated fetch preserves source day, nominal precision, raw digest and twelve-place rate", async () => {
  let request;
  const body = xml("24.10.2026", "3", "37,000001");
  const value = await fetchOrderProfitDailyFx("2026-10-26", { now, fetchImpl: async (url, options) => {
    request = { url, options };return { ok: true, text: async () => body };
  } });
  assert.match(request.url, /date_req=26\/10\/2026$/);
  assert.equal(request.options.redirect, "error");
  assert.equal(value.rate, "12.333333666667");
  assert.equal(value.source_nominal, "3");
  assert.equal(value.source_value, "37.000001");
  assert.equal(value.business_date, "2026-10-26");
  assert.equal(value.source_date, "2026-10-24");
  assert.equal(value.source_sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(value.fetched_at, "2026-10-26T06:00:00.000Z");
});

test("future quote/date, invalid calendar, zero quote and missing currency refuse without fallback", async () => {
  await assert.rejects(fetchOrderProfitDailyFx("2026-10-27", { now, fetchImpl: response(xml()) }), { code: "ORDER_PROFIT_DAILY_FX_FUTURE_DATE" });
  await assert.rejects(fetchOrderProfitDailyFx("2026-10-26", { now, fetchImpl: response(xml("27.10.2026")) }), { code: "ORDER_PROFIT_DAILY_FX_FUTURE_SOURCE" });
  await assert.rejects(fetchOrderProfitDailyFx("2026-10-26", { now, fetchImpl: response(xml("31.02.2026")) }), { code: "ORDER_PROFIT_DAILY_FX_DATE_INVALID" });
  await assert.rejects(fetchOrderProfitDailyFx("2026-10-26", { now, fetchImpl: response(xml("26.10.2026", "0", "12")) }), { code: "ORDER_PROFIT_DAILY_FX_VALUE_INVALID" });
  await assert.rejects(fetchOrderProfitDailyFx("2026-10-26", { now, fetchImpl: response("<ValCurs Date=\"26.10.2026\"></ValCurs>") }), { code: "ORDER_PROFIT_DAILY_FX_VALUE_INVALID" });
});

test("network/HTTP failures stay unavailable; no latest-date request or hardcoded rate is used", async () => {
  for (const fetchImpl of [async () => { throw Error("network"); }, async () => ({ ok: false })]) {
    await assert.rejects(fetchOrderProfitDailyFx("2026-10-26", { now, fetchImpl }), { code: "ORDER_PROFIT_DAILY_FX_UNAVAILABLE" });
  }
});

test("historical CNY archives retain an exact official batch source and reject foreign or inconsistent URLs", async () => {
  const quote = await fetchOrderProfitDailyFx("2026-10-26", { now, fetchImpl: response(xml()) });
  const url = "https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=24/10/2025&date_req2=26/10/2026&VAL_NM_RQ=R01375";
  const read = source_url => getOrderProfitDailyFx({ query: async () => [{ ...quote, id: "3", source_url, created_at: new Date(now).toISOString() }] }, "2026-10-26");
  assert.equal((await read(url)).source_url, url);
  for (const invalid of [
    url.replace("https:", "http:"), url.replace("www.cbr.ru", "www.cbr.ru.example.com"),
    url.replace("www.cbr.ru", "user:password@www.cbr.ru"), url.replace("R01375", "R01235"),
    url.replace("24/10/2025", "25/10/2026"), url.replace("26/10/2026", "25/10/2026"),
    url + "&extra=1", url + "#fragment", url.replace("24/10/2025", "31/02/2025")
  ]) await assert.rejects(read(invalid), { code: "ORDER_PROFIT_DAILY_FX_VALUE_INVALID" });
});

test("read path is DB-only, missing archives remain missing, transaction network preparation refuses", async () => {
  let calls = 0;
  const db = { query: async statement => { calls++;assert.match(statement, /^SELECT /);return []; } };
  assert.equal(await getOrderProfitDailyFx(db, "2026-10-26"), null);
  assert.equal(calls, 1);
  await assert.rejects(ensureOrderProfitDailyFx(db, "2026-10-26", { now, inTransaction: true, fetchImpl: () => { throw Error("must not fetch"); } }), { code: "ORDER_PROFIT_DAILY_FX_TRANSACTION" });
  assert.equal(calls, 1);
});

test("migration CLI refuses implicit/ambiguous connections and apply flags before loading app config", () => {
  for (const args of [[], ["--apply=false"], ["--apply", "--apply"], ["--unknown"], ["--database=test", "--mysql-admin-socket=remote:3306"]]) {
    const result = spawnSync(process.execPath, ["scripts/migrate-order-profit-daily-fx.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /password|ECONNREFUSED|DB_PASSWORD/);
  }
});
