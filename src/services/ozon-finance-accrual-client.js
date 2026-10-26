import { orderProfitFxBusinessDate } from "./order-profit-daily-fx.js";

export const OZON_FINANCE_ACCRUAL_TYPES_ENDPOINT = "/v1/finance/accrual/types";
export const OZON_FINANCE_ACCRUAL_DAY_ENDPOINT = "/v1/finance/accrual/by-day";
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
const record = value => value && typeof value === "object" && !Array.isArray(value);

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw Object.assign(new Error("Ozon 财务读取已取消"), { name: "AbortError", code: "ABORT_ERR" });
}
function idKey(value) {
  if (!["string", "number"].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))
    || (typeof value === "number" && !Number.isSafeInteger(value))) throw fail("OZON_FINANCE_ACCRUAL_SCHEMA_INVALID", "Ozon 财务编号缺失或超出可验证精度，停止读取");
  return String(value);
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function dateRange(from, to) {
  let first, last;
  try { first = orderProfitFxBusinessDate(from);last = orderProfitFxBusinessDate(to); }
  catch { throw fail("OZON_FINANCE_ACCRUAL_DATE_INVALID", "财务读取需要明确有效的开始、结束日期，按北京日期查询", 400); }
  const start = Date.parse(first + "T00:00:00Z"), end = Date.parse(last + "T00:00:00Z");
  const count = (end - start) / 86400000 + 1;
  if (count < 1 || count > 31) throw fail("OZON_FINANCE_ACCRUAL_DATE_INVALID", "财务按日读取范围最多 31 个北京日期，开始日期不能晚于结束日期", 400);
  return Array.from({ length: count }, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10));
}
function validatedTypes(body) {
  if (!record(body) || !Array.isArray(body.accrual_types)) throw fail("OZON_FINANCE_ACCRUAL_SCHEMA_INVALID", "Ozon 财务类型响应缺少 accrual_types 数组");
  const ids = new Set();
  for (const type of body.accrual_types) {
    if (!record(type) || typeof type.name !== "string" || !type.name.trim()) throw fail("OZON_FINANCE_ACCRUAL_SCHEMA_INVALID", "Ozon 财务类型缺少主键 id 或正式名称 name");
    const key = idKey(type.id);
    if (ids.has(key)) throw fail("OZON_FINANCE_ACCRUAL_TYPE_CONFLICT", "Ozon 财务类型响应有重复主键，停止读取");
    ids.add(key);
  }
  if (!ids.size) throw fail("OZON_FINANCE_ACCRUAL_SCHEMA_INVALID", "Ozon 财务类型字典为空，不能假定已完整同步");
  return body.accrual_types;
}

/**
 * Network read orchestration only. The injected requester owns HTTP errors,
 * 429/backoff and per-attempt authorization; it must honor opts.beforeRequest
 * on internal retries. This client additionally gates every logical request.
 * No credentials, production configuration, DB writes or partial facts escape.
 */
export async function fetchOzonDailyAccruals(shop, { from, to, signal, request, beforeRequest,
  normalizeAccrual, maxPagesPerDay = 100 } = {}) {
  if (typeof request !== "function") throw fail("OZON_FINANCE_ACCRUAL_REQUEST_REQUIRED", "财务按日读取必须提供已授权的请求器", 400);
  if (beforeRequest !== undefined && typeof beforeRequest !== "function") throw fail("OZON_FINANCE_ACCRUAL_REQUEST_REQUIRED", "财务请求授权回调无效", 400);
  if (normalizeAccrual !== undefined && typeof normalizeAccrual !== "function") throw fail("OZON_FINANCE_ACCRUAL_NORMALIZE_INVALID", "财务归一化回调无效", 400);
  if (!Number.isInteger(maxPagesPerDay) || maxPagesPerDay < 1 || maxPagesPerDay > 100) throw fail("OZON_FINANCE_ACCRUAL_PAGE_LIMIT", "财务单日分页上限须为 1–100", 400);
  const dates = dateRange(from, to);
  let requests = 0;
  const guard = async () => { throwIfAborted(signal);const current = await beforeRequest?.(shop);throwIfAborted(signal);return current || shop; };
  const read = async (endpoint, payload) => {
    const authorizedShop = await guard();
    requests++;
    const body = await request(endpoint, payload, { method: "POST", signal, shop: authorizedShop, beforeRequest: guard });
    throwIfAborted(signal);
    return body;
  };
  const types = validatedTypes(await read(OZON_FINANCE_ACCRUAL_TYPES_ENDPOINT, {}));
  const typeById = new Map(types.map(type => [String(type.id), type]));
  const raw = [], fingerprints = new Map();
  for (const date of dates) {
    let cursor = "";
    const seenCursors = new Set();
    for (let page = 0; page < maxPagesPerDay; page++) {
      const body = await read(OZON_FINANCE_ACCRUAL_DAY_ENDPOINT, { date, last_id: cursor });
      if (!record(body) || !Array.isArray(body.accruals) || typeof body.last_id !== "string") throw fail("OZON_FINANCE_ACCRUAL_SCHEMA_INVALID", `Ozon ${date} 财务响应必须包含 accruals 数组和 last_id 字符串`);
      const next = body.last_id;
      if (next && seenCursors.has(next)) throw fail("OZON_FINANCE_ACCRUAL_CURSOR_LOOP", `Ozon ${date} 财务游标重复，未把不完整结果当作成功`);
      if (next) seenCursors.add(next);
      for (const accrual of body.accruals) {
        if (!record(accrual)) throw fail("OZON_FINANCE_ACCRUAL_SCHEMA_INVALID", `Ozon ${date} 财务记录结构无效`);
        const key = idKey(accrual.accrual_id), fingerprint = stableJson(accrual);
        if (fingerprints.has(key)) {
          if (fingerprints.get(key) !== fingerprint) throw fail("OZON_FINANCE_ACCRUAL_ID_CONFLICT", `Ozon ${date} 同一财务编号内容冲突，停止读取`);
          continue;
        }
        fingerprints.set(key, fingerprint);raw.push({ value: accrual, date });
      }
      if (!next) break;
      if (page + 1 >= maxPagesPerDay) throw fail("OZON_FINANCE_ACCRUAL_PAGE_LIMIT", `Ozon ${date} 财务分页超过上限，请缩小范围或核对接口`);
      cursor = next;
    }
  }
  // All pages have passed validation before any optional pure normalization.
  const accruals = [];
  for (const item of raw) {
    throwIfAborted(signal);
    const value = normalizeAccrual ? await normalizeAccrual(item.value, { types, typeById, date: item.date, shop,
      sourceEndpoint: OZON_FINANCE_ACCRUAL_DAY_ENDPOINT, source_endpoint: OZON_FINANCE_ACCRUAL_DAY_ENDPOINT }) : item.value;
    if (!record(value)) throw fail("OZON_FINANCE_ACCRUAL_NORMALIZE_INVALID", "财务归一化必须保留每条事实，不能静默丢弃记录");
    throwIfAborted(signal);accruals.push(value);
  }
  return { accruals, types, fetched: raw.length, requests, days: dates.length, source_endpoint: OZON_FINANCE_ACCRUAL_DAY_ENDPOINT };
}
