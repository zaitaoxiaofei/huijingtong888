import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { decryptSellerAuthSession } from "./seller-auth-session-crypto.js";

const AUTH_BINDING_PREFIX = "seller_analytics_auth_binding:";
const REQUEST_TIMEOUT_MS = 20_000;
const rateByStore = new Map();

function text(value) {
  return String(value ?? "").trim();
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function errorText(error) {
  const primary = text(error?.message || error);
  const cause = text(error?.cause?.message || error?.cause?.code);
  return cause && !primary.includes(cause) ? `${primary}: ${cause}` : primary;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function cookieMapFromHeader(value = "") {
  return new Map(text(value).split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    return index > 0 ? [item.slice(0, index).trim(), item.slice(index + 1).trim()] : ["", ""];
  }).filter(([name]) => name));
}

function applySetCookies(cookieMap, response) {
  const values = typeof response?.headers?.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response?.headers?.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const pair = text(value).split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const cookieValue = pair.slice(index + 1).trim();
    if (name) cookieMap.set(name, cookieValue);
  }
}

function publicBinding(binding) {
  return {
    shop_id: Number(binding.shop_id || 0) || null,
    shop_name: text(binding.shop_name),
    company_id: text(binding.company_id || binding.store_id),
    active: Boolean(binding.cookie),
    last_ok_at: text(binding.last_ok_at),
    last_status: Number(binding.last_status || 0) || 0
  };
}

function rateState(companyId) {
  const key = text(companyId);
  const state = rateByStore.get(key) || {
    delay_ms: 180,
    cooldown_until: 0,
    consecutive_success: 0,
    consecutive_errors: 0,
    last_status: 0
  };
  rateByStore.set(key, state);
  return state;
}

function tuneRate(companyId, status, ok) {
  const state = rateState(companyId);
  state.last_status = Number(status || 0);
  if (ok) {
    state.consecutive_success += 1;
    state.consecutive_errors = 0;
    state.delay_ms = Math.max(180, Math.round(state.delay_ms * 0.85));
    state.cooldown_until = 0;
    return;
  }
  state.consecutive_success = 0;
  state.consecutive_errors += 1;
  if (Number(status) === 429) {
    state.delay_ms = Math.min(20_000, Math.max(5_000, state.delay_ms * 2.5));
    state.cooldown_until = Date.now() + state.delay_ms;
  } else if ([401, 403].includes(Number(status))) {
    state.delay_ms = Math.max(3_000, state.delay_ms);
    state.cooldown_until = Date.now() + state.delay_ms;
  } else {
    state.delay_ms = Math.min(10_000, Math.max(1_000, state.delay_ms * 1.5));
    state.cooldown_until = Date.now() + state.delay_ms;
  }
}

async function sellerRequest(binding, url, body, language = "RU") {
  const companyId = text(binding.company_id || binding.store_id);
  const rate = rateState(companyId);
  const waitMs = Math.max(rate.delay_ms, rate.cooldown_until - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  const cookies = cookieMapFromHeader(binding.cookie);
  const requestOptions = {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-O3-Company-Id": companyId,
      "X-O3-Language": language,
      Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      ...Object.fromEntries(Object.entries(binding.headers || {}).filter(([key]) => [
        "accept-language", "x-o3-app-name", "x-o3-page-type", "user-agent"
      ].includes(String(key).toLowerCase())))
    },
    body: JSON.stringify(body || {}),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  };
  let requestUrl = url;
  let response = null;
  const visited = new Set();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    visited.add(requestUrl);
    requestOptions.headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    response = await fetch(requestUrl, requestOptions);
    applySetCookies(cookies, response);
    const location = text(response.headers.get("location"));
    if (![301, 302, 307, 308].includes(response.status) || !location) break;
    const nextUrl = new URL(location, requestUrl);
    if (nextUrl.hostname !== "seller.ozon.ru" || visited.has(nextUrl.href)) break;
    requestUrl = nextUrl.href;
  }
  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {}
  tuneRate(companyId, response.status, response.ok);
  if (!response.ok) {
    const location = text(response.headers.get("location"));
    const error = new Error(`Seller request failed: HTTP ${response.status}${location ? ` redirect=${location.slice(0, 160)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadBindings(tenantId = "admin") {
  const rows = await mysqlQuery(`
    SELECT s.id AS shop_id, s.name AS shop_name, s.ozon_client_id, st.value
    FROM shops s
    JOIN settings st
      ON st.tenant_id = ?
     AND BINARY st.key = BINARY CONCAT(?, s.ozon_client_id)
    WHERE s.status = 'active'
      AND COALESCE(NULLIF(TRIM(s.ozon_client_id), ''), '') <> ''
    ORDER BY s.id
  `, [tenantId, AUTH_BINDING_PREFIX]);
  return rows.map((row) => {
    const stored = parseJson(row.value);
    const lastActiveAt = stored.last_ok_at || stored.updated_at || stored.bound_at;
    const lastStatus = Number(stored.last_status || 0);
    return {
      ...stored,
      cookie: text(stored.cookie) || decryptSellerAuthSession(stored.cookie_encrypted),
      shop_id: Number(row.shop_id || 0),
      shop_name: text(row.shop_name),
      company_id: text(stored.company_id || stored.store_id || row.ozon_client_id),
      headers: parseJson(stored.headers),
      stale: [401, 403].includes(lastStatus) || !lastActiveAt
    };
  }).filter((binding) => binding.cookie && binding.company_id && !binding.stale);
}

async function collectSku(binding, sku) {
  const normalizedSku = text(sku);
  const raw = {};
  const warnings = [];
  let variantId = "";
  try {
    const sales = await sellerRequest(binding,
      "https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3",
      { limit: "50", offset: "0", filter: { stock: "any_stock", period: "monthly", categories: [], sku: normalizedSku }, sort: { key: "sum_gmv_desc" } },
      "zh-Hans");
    raw.sales = Array.isArray(sales?.items) ? sales.items[0] || null : null;
    raw.salesMeta = { totals: sales?.totals ?? "", updateDate: sales?.updateDate ?? "", benchmark: sales?.benchmark ?? null };
    variantId = text(raw.sales?.variantId || raw.sales?.variant_id);
  } catch (error) {
    warnings.push(errorText(error));
    if ([401, 403].includes(Number(error?.status || 0))) throw error;
    if (Number(error?.status || 0) === 429) throw error;
  }

  try {
    raw.baseInfo = await sellerRequest(binding,
      "https://seller.ozon.ru/api/v1/search",
      {
        company_id: binding.company_id,
        need_total: true,
        filter: { children_nodes: { children_nodes: [{ input_leaf: { sku: { values: [normalizedSku] } } }], operator: "AND" } },
        pagination: { limit: "50" },
        is_copy_allowed: false
      });
    if (!variantId) variantId = text(raw.baseInfo?.variants?.[0]?.variant_id);
  } catch (error) {
    warnings.push(errorText(error));
    if ([401, 403].includes(Number(error?.status || 0))) throw error;
    if (Number(error?.status || 0) === 429) throw error;
  }

  if (variantId) {
    try {
      raw.variant = await sellerRequest(binding,
        "https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id",
        { company_id: binding.company_id, variant_id: variantId, source: "SOURCE_UI_COPY_MERGED" });
      raw.variantApiType = "variant_v2";
    } catch (error) {
      warnings.push(errorText(error));
      if ([401, 403].includes(Number(error?.status || 0))) throw error;
      if (Number(error?.status || 0) === 429) throw error;
    }
  }
  if (!raw.variant) {
    try {
      const variant = await sellerRequest(binding,
        "https://seller.ozon.ru/api/v1/search-variant-model",
        { name: normalizedSku, limit: "50" });
      raw.variant = Array.isArray(variant?.items) ? variant.items[0] || null : null;
      raw.variantApiType = "variant";
    } catch (error) {
      warnings.push(errorText(error));
      if ([401, 403].includes(Number(error?.status || 0))) throw error;
    }
  }
  raw.variantId = variantId;
  return { sku: normalizedSku, success: Boolean(raw.sales || raw.baseInfo || raw.variant), status: 0, raw, warnings };
}

async function invalidateBinding(binding, tenantId, status, message = "") {
  const key = `${AUTH_BINDING_PREFIX}${binding.company_id}`;
  const rows = await mysqlQuery("SELECT value FROM settings WHERE `key` = ? AND tenant_id = ? LIMIT 1", [key, tenantId]);
  const stored = parseJson(rows[0]?.value);
  if (!stored.cookie && !stored.cookie_encrypted) return;
  const now = new Date().toISOString();
  await mysqlExecute("UPDATE settings SET value = ?, updated_at = ? WHERE `key` = ? AND tenant_id = ?", [JSON.stringify({
    ...stored,
    last_error: text(message) || `Seller authorization rejected with HTTP ${status}`,
    last_status: Number(status || 0),
    updated_at: now
  }), now.slice(0, 19).replace("T", " "), key, tenantId]);
}

async function touchBinding(binding, tenantId, status = 200) {
  const key = `${AUTH_BINDING_PREFIX}${binding.company_id}`;
  const rows = await mysqlQuery("SELECT value FROM settings WHERE `key` = ? AND tenant_id = ? LIMIT 1", [key, tenantId]);
  const stored = parseJson(rows[0]?.value);
  if (!stored.cookie && !stored.cookie_encrypted) return;
  const now = new Date().toISOString();
  await mysqlExecute("UPDATE settings SET value = ?, updated_at = ? WHERE `key` = ? AND tenant_id = ?", [JSON.stringify({
    ...stored,
    last_ok_at: now,
    last_error: "",
    last_status: Number(status || 200),
    updated_at: now
  }), now.slice(0, 19).replace("T", " "), key, tenantId]);
}

export async function collectorSellerPoolStatus(tenantId = "admin") {
  const bindings = await loadBindings(tenantId);
  return {
    enabled: bindings.length > 0,
    available_workers: bindings.length,
    workers: bindings.map((binding) => ({ ...publicBinding(binding), rate: { ...rateState(binding.company_id), cookie: undefined } }))
  };
}

export async function collectSkusWithSellerPool(skus = [], tenantId = "admin") {
  const normalized = [...new Set((Array.isArray(skus) ? skus : []).map(text).filter(Boolean))].slice(0, 48);
  const bindings = await loadBindings(tenantId);
  if (!bindings.length) {
    const error = new Error("No valid seller analytics auth bindings are available");
    error.status = 409;
    error.code = "SELLER_POOL_UNAVAILABLE";
    throw error;
  }
  const results = new Array(normalized.length);
  const disabledBindings = new Set();
  const bindingTails = new Map();
  async function withBindingLock(binding, task) {
    const key = binding.company_id;
    const previous = bindingTails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    bindingTails.set(key, previous.then(() => current));
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
  let cursor = 0;
  const concurrency = Math.min(6, Math.max(1, normalized.length));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < normalized.length) {
      const index = cursor++;
      const sku = normalized[index];
      let lastResult = null;
      for (let attempt = 0; attempt < bindings.length; attempt += 1) {
        const binding = bindings[(index + attempt) % bindings.length];
        if (disabledBindings.has(binding.company_id)) continue;
        const startedAt = Date.now();
        try {
          const collected = await withBindingLock(binding, () => collectSku(binding, sku));
          lastResult = {
            ...collected,
            source_shop_id: binding.shop_id,
            source_shop_name: binding.shop_name,
            source_company_id: binding.company_id,
            duration_ms: Date.now() - startedAt
          };
          if (collected.success) {
            results[index] = lastResult;
            await touchBinding(binding, tenantId).catch(() => {});
            break;
          }
        } catch (error) {
          const status = Number(error?.status || 0);
          lastResult = {
            sku,
            success: false,
            error: errorText(error),
            status,
            source_shop_id: binding.shop_id,
            source_shop_name: binding.shop_name,
            source_company_id: binding.company_id,
            duration_ms: Date.now() - startedAt
          };
          if ([401, 403].includes(status)) {
            disabledBindings.add(binding.company_id);
            await invalidateBinding(binding, tenantId, status, lastResult.error).catch(() => {});
          }
          if (status === 429) disabledBindings.add(binding.company_id);
        }
      }
      if (!results[index]) results[index] = lastResult || { sku, success: false, error: "No usable seller pool binding" };
    }
  }));
  return {
    success: results.some((item) => item?.success),
    total: normalized.length,
    success_count: results.filter((item) => item?.success).length,
    fail_count: results.filter((item) => !item?.success).length,
    worker_count: Math.min(6, bindings.length),
    results: results.filter(Boolean)
  };
}
