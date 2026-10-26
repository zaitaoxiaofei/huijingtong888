import { createHash } from "node:crypto";
import { parseCbrCnyRate } from "./pricing-reference-rate.js";
import { assertOrderProfitDailyFxSchema, dailyFxQuery } from "./order-profit-daily-fx-schema.js";

export const ORDER_PROFIT_DAILY_FX_SOURCE = "cbr";
export const ORDER_PROFIT_DAILY_FX_SOURCE_URL = "https://www.cbr.ru/scripts/XML_daily_eng.asp";
const flights = new WeakMap();
const SCALE = 10n ** 12n;
const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 503 });

function checkedDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw fail("ORDER_PROFIT_DAILY_FX_DATE_INVALID", "每日汇率需要有效的北京业务日期");
  const date = new Date(text + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw fail("ORDER_PROFIT_DAILY_FX_DATE_INVALID", "每日汇率业务日期无效");
  return text;
}

export function orderProfitFxBusinessDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return checkedDay(value.trim());
  const text = typeof value === "string" ? value.trim() : "";
  if (typeof value === "string") {
    if (!/^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(text)) {
      throw fail("ORDER_PROFIT_DAILY_FX_DATE_INVALID", "订单时间格式无效，不能选用今日汇率冒充历史");
    }
    checkedDay(text.slice(0, 10));
  }
  const date = value instanceof Date ? value : new Date(text && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text.replace(" ", "T") + "Z" : value);
  if (!value || !Number.isFinite(date.getTime())) throw fail("ORDER_PROFIT_DAILY_FX_DATE_INVALID", "订单时间缺失或无效，不能选用今日汇率冒充历史");
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function decimal(text) {
  const value = String(text ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(value)) throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "央行每日汇率的数值或精度无效");
  const [whole, fraction = ""] = value.split(".");
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, "0"));
  if (scaled <= 0n) throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "央行每日汇率必须大于零");
  return { text: value, scaled };
}
const fixed = value => String(value / SCALE) + "." + String(value % SCALE).padStart(12, "0");
function divided(value, nominal) {
  const result = (value.scaled * SCALE + nominal.scaled / 2n) / nominal.scaled;
  if (result <= 0n || result >= 10n ** 24n) throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "央行每日汇率超出支持范围");
  return fixed(result);
}
function utcIso(value) {
  const text = String(value || "");
  const date = value instanceof Date ? value : new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(text) ? text : text.replace(" ", "T") + "Z");
  if (!Number.isFinite(date.getTime())) throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "每日汇率抓取时间无效");
  return date.toISOString();
}
function sourceUrl(day) {
  const [year, month, date] = checkedDay(day).split("-");
  return `${ORDER_PROFIT_DAILY_FX_SOURCE_URL}?date_req=${date}/${month}/${year}`;
}
function officialSourceUrl(value, businessDate, sourceDate) {
  if (value === sourceUrl(businessDate)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.cbr.ru" || url.port || url.username || url.password || url.hash
      || url.pathname !== "/scripts/XML_dynamic.asp" || url.searchParams.size !== 3
      || url.searchParams.get("VAL_NM_RQ") !== "R01375") return false;
    const parse = key => {
      const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(url.searchParams.get(key) || "");
      return match ? checkedDay(`${match[3]}-${match[2]}-${match[1]}`) : null;
    };
    const from = parse("date_req1"), to = parse("date_req2");
    return Boolean(from && to && from <= sourceDate && sourceDate <= businessDate && businessDate <= to);
  } catch { return false; }
}
function validateQuote(value) {
  const businessDate = checkedDay(String(value.business_date || "")), sourceDate = checkedDay(String(value.source_date || ""));
  const nominal = decimal(value.source_nominal), quoted = decimal(value.source_value), rate = divided(quoted, nominal);
  const fetchedAt = utcIso(value.fetched_at);
  if (value.currency_from !== "CNY" || value.currency_to !== "RUB" || value.source !== ORDER_PROFIT_DAILY_FX_SOURCE
    || sourceDate > businessDate || orderProfitFxBusinessDate(new Date(fetchedAt)) < businessDate || !officialSourceUrl(value.source_url, businessDate, sourceDate)
    || !/^[a-f0-9]{64}$/.test(String(value.source_sha256 || "")) || decimal(value.rate).scaled !== decimal(rate).scaled) {
    throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "每日汇率的币种、来源、生效日期或原始数值不一致");
  }
  return { business_date: businessDate, currency_from: "CNY", currency_to: "RUB", rate,
    source: ORDER_PROFIT_DAILY_FX_SOURCE, source_date: sourceDate, source_nominal: nominal.text, source_value: quoted.text,
    source_url: value.source_url, source_sha256: value.source_sha256, fetched_at: fetchedAt };
}

// Network preparation only. Call outside any business transaction/row lock.
export async function fetchOrderProfitDailyFx(day, { fetchImpl = fetch, now = Date.now() } = {}) {
  const businessDate = orderProfitFxBusinessDate(day), nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime()) || businessDate > orderProfitFxBusinessDate(nowDate)) throw fail("ORDER_PROFIT_DAILY_FX_FUTURE_DATE", "不能获取未来日期作为已生效的订单汇率");
  let response, xml;
  try {
    response = await fetchImpl(sourceUrl(businessDate), { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) throw Error("CBR_HTTP_FAILURE");
    xml = await response.text();
  } catch {
    throw fail("ORDER_PROFIT_DAILY_FX_UNAVAILABLE", `央行 ${businessDate} 每日汇率暂不可用，等待补取；未使用固定或今日汇率`);
  }
  if (Buffer.byteLength(xml, "utf8") > 2 * 1024 * 1024) throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "央行汇率响应过大");
  // Reuse the calculator's supported CNY/Nominal parsing; retain full source
  // decimals separately rather than its display-oriented four-place rounding.
  try { parseCbrCnyRate(xml); } catch { throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "央行每日汇率响应缺少有效人民币报价"); }
  const cny = [...xml.matchAll(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/gi)].map(match => match[0]).find(row => /<CharCode>\s*CNY\s*<\/CharCode>/i.test(row));
  const nominal = decimal(cny?.match(/<Nominal>\s*([^<]+)\s*<\/Nominal>/i)?.[1]);
  const value = decimal(cny?.match(/<Value>\s*([^<]+)\s*<\/Value>/i)?.[1]);
  const sourceDateText = xml.match(/<ValCurs\b[^>]*\bDate="(\d{2})\.(\d{2})\.(\d{4})"/i);
  if (!sourceDateText) throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "央行汇率响应缺少实际生效日期");
  const sourceDate = checkedDay(`${sourceDateText[3]}-${sourceDateText[2]}-${sourceDateText[1]}`);
  if (sourceDate > businessDate) throw fail("ORDER_PROFIT_DAILY_FX_FUTURE_SOURCE", "央行返回的汇率尚未在订单业务日期生效，不能提前使用");
  return validateQuote({ business_date: businessDate, currency_from: "CNY", currency_to: "RUB", rate: divided(value, nominal),
    source: ORDER_PROFIT_DAILY_FX_SOURCE, source_date: sourceDate, source_nominal: nominal.text, source_value: value.text,
    source_url: sourceUrl(businessDate), source_sha256: createHash("sha256").update(xml).digest("hex"), fetched_at: nowDate.toISOString() });
}

const SNAPSHOT_SELECT = `SELECT CAST(id AS CHAR) id,DATE_FORMAT(business_date,'%Y-%m-%d') business_date,
  currency_from,currency_to,CAST(rate AS CHAR) rate,source,DATE_FORMAT(source_date,'%Y-%m-%d') source_date,
  source_nominal,source_value,source_url,source_sha256,
  DATE_FORMAT(fetched_at,'%Y-%m-%d %H:%i:%s.%f') fetched_at,
  DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') created_at FROM order_profit_daily_fx_rates`;
function snapshot(row) {
  if (!row) return null;
  const quote = validateQuote(row);
  if (!/^[1-9]\d*$/.test(String(row.id))) throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "每日汇率档案编号无效");
  return { id: String(row.id), ...quote, created_at: utcIso(row.created_at) };
}

// Pure DB reads. Missing archives stay null; no hidden fetching or DDL.
export async function getOrderProfitDailyFx(db, day) {
  const [row] = await dailyFxQuery(db, `${SNAPSHOT_SELECT} WHERE business_date=? AND currency_from='CNY' AND currency_to='RUB' AND source=? LIMIT 1`, [orderProfitFxBusinessDate(day), ORDER_PROFIT_DAILY_FX_SOURCE]);
  return snapshot(row);
}

export async function getOrderProfitDailyFxById(db, value) {
  if (!/^[1-9]\d{0,19}$/.test(String(value))) throw fail("ORDER_PROFIT_DAILY_FX_VALUE_INVALID", "每日汇率档案编号无效");
  const [row] = await dailyFxQuery(db, `${SNAPSHOT_SELECT} WHERE id=? LIMIT 1`, [String(value)]);
  return snapshot(row);
}

// Public reference values only; querying history must never fetch or write.
export async function listOrderProfitDailyFx(db, query = {}) {
  const filterError = () => Object.assign(new Error("汇率查询日期需为北京日期 YYYY-MM-DD，开始日期不能晚于结束日期；page 为正整数，pageSize 为 1–100"), { code: "ORDER_PROFIT_DAILY_FX_FILTER_INVALID", statusCode: 400 });
  let from = null, to = null;
  try { from = query.from ? checkedDay(String(query.from)) : null;to = query.to ? checkedDay(String(query.to)) : null; }
  catch { throw filterError(); }
  const pageText = String(query.page ?? "1"), sizeText = String(query.pageSize ?? "30");
  if (!/^[1-9]\d*$/.test(pageText) || !/^[1-9]\d*$/.test(sizeText)) throw filterError();
  const page = Number(pageText), pageSize = Number(sizeText), offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(offset) || pageSize > 100 || (from && to && from > to)) throw filterError();
  await assertOrderProfitDailyFxSchema(db);
  const filters = ["currency_from='CNY'", "currency_to='RUB'", "source=?"], parameters = [ORDER_PROFIT_DAILY_FX_SOURCE];
  if (from) { filters.push("business_date>=?");parameters.push(from); }
  if (to) { filters.push("business_date<=?");parameters.push(to); }
  const where = filters.join(" AND ");
  const [counts] = await dailyFxQuery(db, `SELECT COUNT(*) total FROM order_profit_daily_fx_rates WHERE ${where}`, parameters);
  const rows = await dailyFxQuery(db, `${SNAPSHOT_SELECT} WHERE ${where} ORDER BY business_date DESC,id DESC LIMIT ? OFFSET ?`, [...parameters, pageSize, offset]);
  return { rows: rows.map(snapshot), total: Number(counts.total), page, pageSize, from, to, timezone: "Asia/Shanghai", currency_from: "CNY", currency_to: "RUB", source: ORDER_PROFIT_DAILY_FX_SOURCE };
}

// Immutable archive: a racing writer or a later provider correction must return
// the already accepted first snapshot, never UPDATE its values or timestamps.
export async function archiveOrderProfitDailyFx(db, input) {
  const value = validateQuote(input);
  try {
    await db.query(`INSERT INTO order_profit_daily_fx_rates
      (business_date,currency_from,currency_to,rate,source,source_date,source_nominal,source_value,source_url,source_sha256,fetched_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [value.business_date, value.currency_from, value.currency_to, value.rate, value.source,
      value.source_date, value.source_nominal, value.source_value, value.source_url, value.source_sha256,
      value.fetched_at.replace("T", " ").slice(0, -1)]);
  } catch (error) { if (error.code !== "ER_DUP_ENTRY") throw error; }
  const stored = await getOrderProfitDailyFx(db, value.business_date);
  if (!stored) throw fail("ORDER_PROFIT_DAILY_FX_ARCHIVE_CONFLICT", "每日汇率归档发生结构冲突，未覆盖已有记录");
  return stored;
}

// Convenience for a scheduler or pre-transaction preparation. Transactional
// profit writers use get/by-id only; no network is permitted under their locks.
export async function ensureOrderProfitDailyFx(db, day, options = {}) {
  if (options.inTransaction === true) throw fail("ORDER_PROFIT_DAILY_FX_TRANSACTION", "每日汇率必须在利润业务事务开始前获取");
  const businessDate = orderProfitFxBusinessDate(day);
  if (businessDate > orderProfitFxBusinessDate(new Date(options.now ?? Date.now()))) throw fail("ORDER_PROFIT_DAILY_FX_FUTURE_DATE", "不能提前采用未来日期的订单汇率");
  const stored = await getOrderProfitDailyFx(db, businessDate);
  if (stored) return stored;
  let pending = flights.get(db);
  if (!pending) { pending = new Map(); flights.set(db, pending); }
  if (!pending.has(businessDate)) {
    const task = (async () => archiveOrderProfitDailyFx(db, await fetchOrderProfitDailyFx(businessDate, options)))();
    pending.set(businessDate, task);
    task.finally(() => { if (pending.get(businessDate) === task) pending.delete(businessDate); }).catch(() => {});
  }
  return pending.get(businessDate);
}
