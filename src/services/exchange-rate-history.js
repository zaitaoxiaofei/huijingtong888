import { createHash } from "node:crypto";
import { archiveOrderProfitDailyFx, listOrderProfitDailyFx, orderProfitFxBusinessDate, ORDER_PROFIT_DAILY_FX_SOURCE_URL } from "./order-profit-daily-fx.js";

export const CBR_HISTORY_SOURCE_URL = "https://www.cbr.ru/scripts/XML_dynamic.asp";
export const CBR_CNY_ID = "R01375";
export const MAX_EXCHANGE_RATE_HISTORY_DAYS = 400;
const DAY = 86400000, SCALE = 10n ** 12n;
const fail = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
const invalid = message => fail("EXCHANGE_RATE_HISTORY_SOURCE_INVALID", message);
const flights = new WeakMap();
const apiDate = day => day.split("-").reverse().join("/");
const dayTime = day => Date.parse(day + "T00:00:00Z");
const addDays = (day, count) => new Date(dayTime(day) + count * DAY).toISOString().slice(0, 10);

function range({ from, to, now = Date.now() } = {}) {
  let first, last, today;
  try { first = orderProfitFxBusinessDate(from);last = orderProfitFxBusinessDate(to);today = orderProfitFxBusinessDate(new Date(now)); }
  catch { throw fail("EXCHANGE_RATE_HISTORY_DATE_INVALID", "汇率历史需要明确有效的北京开始、结束日期", 400); }
  const days = (dayTime(last) - dayTime(first)) / DAY + 1;
  if (days < 1 || days > MAX_EXCHANGE_RATE_HISTORY_DAYS || last > today) throw fail("EXCHANGE_RATE_HISTORY_DATE_INVALID", "汇率历史最多查询 400 个北京日期，结束日期不能晚于今天或早于开始日期", 400);
  return { from: first, to: last, now: new Date(now).toISOString(), dates: Array.from({ length: days }, (_, index) => addDays(first, index)) };
}
function attribute(tag, name) {
  const matches = [...tag.matchAll(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "gi"))];
  if (matches.length !== 1) throw invalid("央行 XML 缺少或重复必要的币种、日期属性");
  return matches[0][2];
}
function sourceDay(text) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!match) throw invalid("央行历史报价日期格式无效");
  const day = `${match[3]}-${match[2]}-${match[1]}`;
  try { if (orderProfitFxBusinessDate(day) === day) return day; } catch {}
  throw invalid("央行历史报价日期不是有效日历日期");
}
function decimal(text) {
  const value = String(text ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(value)) throw invalid("央行历史报价的名义数量或金额精度无效");
  const [integer, fraction = ""] = value.split(".");
  const scaled = BigInt(integer) * SCALE + BigInt(fraction.padEnd(12, "0"));
  if (scaled <= 0n) throw invalid("央行历史报价和名义数量必须大于零");
  return { value, scaled };
}
function quotation(body) {
  const nominals = [...body.matchAll(/<Nominal>\s*([^<]+)\s*<\/Nominal>/gi)];
  const values = [...body.matchAll(/<Value>\s*([^<]+)\s*<\/Value>/gi)];
  if (nominals.length !== 1 || values.length !== 1 || !/^\d+$/.test(nominals[0][1].trim())) throw invalid("央行历史记录缺少唯一有效的名义数量或金额");
  const nominal = decimal(nominals[0][1]), value = decimal(values[0][1]);
  const scaled = (value.scaled * SCALE + nominal.scaled / 2n) / nominal.scaled;
  if (scaled <= 0n || scaled >= 10n ** 24n) throw invalid("央行历史报价超出支持范围");
  return { rate: `${scaled / SCALE}.${String(scaled % SCALE).padStart(12, "0")}`, source_nominal: nominal.value, source_value: value.value };
}
function document(xml) {
  if (typeof xml !== "string" || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid("央行 XML 文档格式无效");
  const match = /^\s*(?:<\?xml\b[^?]*\?>\s*)?(<ValCurs\b[^>]*>)([\s\S]*)<\/ValCurs>\s*$/i.exec(xml);
  if (!match) throw invalid("央行 XML 文档不完整，停止补档");
  return { root: match[1], body: match[2] };
}

export function parseCbrHistoryAnchor(xml, { businessDate } = {}) {
  const { root, body } = document(xml);
  const rows = [...body.matchAll(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/gi)].map(match => match[0]);
  const cny = rows.filter(row => /<CharCode>\s*CNY\s*<\/CharCode>/i.test(row));
  if (!root || cny.length !== 1 || attribute(cny[0].split(">", 1)[0], "ID") !== CBR_CNY_ID) throw invalid("央行首日报价不能证明 CNY 与 R01375 的对应关系");
  const sourceDate = sourceDay(attribute(root, "Date"));
  if (sourceDate > businessDate) throw invalid("央行首日报价尚未在窗口首日生效，不能提前使用");
  return { source_date: sourceDate, ...quotation(cny[0]) };
}

export function parseCbrDynamicHistory(xml, { from, to } = {}) {
  const { root, body } = document(xml);
  if (!root || attribute(root, "ID") !== CBR_CNY_ID || sourceDay(attribute(root, "DateRange1")) !== from || sourceDay(attribute(root, "DateRange2")) !== to) throw invalid("央行历史响应的币种或请求范围不一致");
  const rows = new Map();
  const records = [...body.matchAll(/<Record\b([^>]*)>([\s\S]*?)<\/Record>/gi)];
  if (body.replace(/<Record\b[^>]*>[\s\S]*?<\/Record>/gi, "").trim()) throw invalid("央行历史响应含不完整记录，不能补画平线");
  for (const match of records) {
    if (attribute(match[1], "Id") !== CBR_CNY_ID) throw invalid("央行历史记录包含其他币种");
    const day = sourceDay(attribute(match[1], "Date"));
    if (day < from || day > to) throw invalid("央行历史记录超出请求日期范围");
    const quote = { source_date: day, ...quotation(match[2]) };
    if (match[2].replace(/<(?:Nominal|Value|VunitRate)>\s*[^<]+\s*<\/(?:Nominal|Value|VunitRate)>/gi, "").trim()) throw invalid("央行历史记录含未知或不完整字段");
    if (rows.has(day) && JSON.stringify(rows.get(day)) !== JSON.stringify(quote)) throw invalid("央行同日历史报价存在冲突，未选择任意一条覆盖");
    rows.set(day, quote);
  }
  if (!rows.size) throw invalid("央行历史响应没有可核实报价，不能生成平线");
  return [...rows.values()].sort((a, b) => a.source_date.localeCompare(b.source_date));
}

async function fetchXml(url, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(12000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, { signal: combined, redirect: "error" });
    if (!response.ok) throw Error("CBR_HTTP_FAILURE");
    let xml, digest;
    if (typeof response.arrayBuffer === "function") {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 2 * 1024 * 1024) throw invalid("央行历史响应体过大");
      const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      const encoding = declaredEncoding(bytes.subarray(bom ? 3 : 0).toString("latin1"));
      if (bom && encoding !== "utf-8") throw invalid("央行 XML 编码声明与字节标记冲突");
      try { xml = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { throw invalid("央行 XML 字节与声明编码不一致，未按其他编码猜测"); }
      digest = createHash("sha256").update(bytes).digest("hex");
    } else {
      // Lightweight test transports may expose only already-decoded text.
      // Real Fetch responses always use the original-byte path above.
      xml = await response.text();
      if (typeof xml !== "string" || Buffer.byteLength(xml, "utf8") > 2 * 1024 * 1024) throw invalid("央行历史响应体无效或过大");
      declaredEncoding(xml.replace(/^\uFEFF/, ""));
      digest = createHash("sha256").update(xml, "utf8").digest("hex");
    }
    combined.throwIfAborted();return { xml, source_sha256: digest };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code === "EXCHANGE_RATE_HISTORY_SOURCE_INVALID") throw error;
    throw fail("EXCHANGE_RATE_HISTORY_UNAVAILABLE", "央行历史参考汇率暂不可用，保留缺日等待重试；未生成假数据");
  }
}

function declaredEncoding(header) {
  const declaration = /^\s*<\?xml\b([^?]*)\?>/i.exec(header)?.[1] || "";
  const encodings = [...declaration.matchAll(/\bencoding\s*=\s*(["'])(.*?)\1/gi)];
  if (encodings.length > 1 || (/\bencoding\b/i.test(declaration) && encodings.length !== 1)) throw invalid("央行 XML 编码声明无效或重复");
  const encoding = (encodings[0] ? encodings[0][2] : "utf-8").toLowerCase();
  if (!["utf-8", "windows-1251"].includes(encoding)) throw invalid("央行 XML 声明了不支持的编码，未启用猜测兜底");
  return encoding;
}

// HTTP/chart consumers call this DB-only projection; no external fetch or DDL.
export async function readExchangeRateHistory(db, options = {}) {
  const selected = range(options), found = new Map();
  let page = 1, total;
  do {
    const result = await listOrderProfitDailyFx(db, { from: selected.from, to: selected.to, page, pageSize: 100 });
    for (const row of result.rows) found.set(row.business_date, row);
    total = result.total;page++;
  } while (found.size < total && page <= Math.ceil(selected.dates.length / 100));
  const rows = [...found.values()];
  rows.sort((a, b) => a.business_date.localeCompare(b.business_date));
  const present = new Set(rows.map(row => row.business_date)), missing = selected.dates.filter(day => !present.has(day));
  return { from: selected.from, to: selected.to, days: selected.dates.length, timezone: "Asia/Shanghai", currency_from: "CNY", currency_to: "RUB", source: "cbr",
    rows: rows.map(row => ({ ...row, carried_forward: row.source_date < row.business_date })), missing_dates: missing, complete: missing.length === 0 };
}

async function fill(db, selected, { fetchImpl = fetch, signal } = {}) {
  const existing = await readExchangeRateHistory(db, { ...selected, now: selected.now });
  if (existing.complete) return { from: selected.from, to: selected.to, days: selected.dates.length, filled: 0, preserved: existing.rows.length, requests: 0, complete: true };
  const first = existing.missing_dates[0], last = existing.missing_dates.at(-1);
  const anchorSource = await fetchXml(`${ORDER_PROFIT_DAILY_FX_SOURCE_URL}?date_req=${apiDate(first)}`, fetchImpl, signal);
  const anchor = parseCbrHistoryAnchor(anchorSource.xml, { businessDate: first });
  if (dayTime(first) - dayTime(anchor.source_date) > 31 * DAY) throw invalid("窗口首日缺少近期前序官方报价，停止补档而不猜测沿用");
  const url = `${CBR_HISTORY_SOURCE_URL}?date_req1=${apiDate(anchor.source_date)}&date_req2=${apiDate(last)}&VAL_NM_RQ=${CBR_CNY_ID}`;
  const source = await fetchXml(url, fetchImpl, signal);
  const quotes = parseCbrDynamicHistory(source.xml, { from: anchor.source_date, to: last });
  if (quotes[0].source_date !== anchor.source_date || quotes[0].rate !== anchor.rate) throw invalid("首日前序报价与批量历史响应不一致，未写入任何补档记录");
  const fingerprint = source.source_sha256, planned = [];
  let index = 0;
  for (const day of existing.missing_dates) {
    while (index + 1 < quotes.length && quotes[index + 1].source_date <= day) index++;
    const quote = quotes[index];
    if (!quote || quote.source_date > day) throw invalid("该日期之前没有可核实报价，不能补画汇率");
    planned.push({ ...quote, business_date: day, currency_from: "CNY", currency_to: "RUB", source: "cbr", source_url: url,
      source_sha256: fingerprint, fetched_at: selected.now });
  }
  // All network and source validation is complete before immutable inserts.
  // A concurrent daily job wins normally; archive() returns its existing row.
  for (const quote of planned) { signal?.throwIfAborted();await archiveOrderProfitDailyFx(db, quote); }
  return { from: selected.from, to: selected.to, days: selected.dates.length, filled: planned.length, preserved: existing.rows.length, requests: 2, complete: true, source_url: url };
}

// Explicit/background preparation only. Never call this from a chart GET or
// while holding an order/finance transaction. Existing daily archives stay fixed.
export async function ensureExchangeRateHistory(db, { from, to, now = Date.now(), fetchImpl = fetch, signal, inTransaction = false } = {}) {
  if (inTransaction) throw fail("EXCHANGE_RATE_HISTORY_TRANSACTION", "历史参考汇率补档必须在订单和财务事务之外执行", 409);
  const selected = range({ from, to, now }), key = `${selected.from}/${selected.to}`;
  let pending = flights.get(db);if (!pending) { pending = new Map();flights.set(db, pending); }
  if (!pending.has(key)) {
    const task = fill(db, selected, { fetchImpl, signal });pending.set(key, task);
    task.finally(() => { if (pending.get(key) === task) pending.delete(key); }).catch(() => {});
  }
  return pending.get(key);
}
