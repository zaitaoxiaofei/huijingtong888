import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const OZON_API_BASE = "https://api-seller.ozon.ru";
const ACTION_CLEANUP_SETTING_PREFIX = "ozon.actions.cleanup:";
const DEFAULT_CLEANUP_ACTION_IDS = [3684628, 3702380];
const DEFAULT_CLEANUP_INTERVAL_MINUTES = 10;
const OZON_REQUEST_TIMEOUT_MS = 30000;
const ACTION_PRODUCTS_PAGE_LIMIT = 100;
const ACTION_DELETE_BATCH_LIMIT = 1000;
const cleanupRunningStores = new Set();
let enabledCleanupSweepRunning = false;

function statusError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeMode(mode) {
  return String(mode || "official").trim() === "seller" ? "seller" : "official";
}

function normalizeLimit(value, fallback = 100, max = 100) {
  const limit = Number(value || fallback);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

async function readShop(storeId) {
  const id = Number(storeId || 0);
  if (!Number.isFinite(id) || id <= 0) throw statusError("请选择店铺");
  const rows = await mysqlQuery(`
    SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS ozon_api_key, api_key_hint, status
    FROM shops
    WHERE id = ? AND status <> 'deleted'
    LIMIT 1
  `, [id]);
  const shop = rows[0];
  if (!shop) throw statusError("店铺不存在");
  const clientId = String(shop.ozon_client_id || "").trim();
  const apiKey = String(shop.ozon_api_key || shop.api_key_hint || "").trim();
  if (!clientId || !apiKey) throw statusError("店铺缺少 Ozon Client ID 或 API Key");
  return { ...shop, clientId, apiKey };
}

function ozonHeaders(shop) {
  return {
    "Client-Id": shop.clientId,
    "Api-Key": shop.apiKey,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

async function ozonRequest(path, { method = "POST", payload = null, shop, signal } = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason || new Error("请求已取消"));
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), OZON_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${OZON_API_BASE}${path}`, {
      method,
      headers: ozonHeaders(shop),
      body: payload == null || method === "GET" ? undefined : JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const message = data?.message || data?.error || data?.raw || `Ozon API ${path} HTTP ${response.status}`;
      throw statusError(message, response.status);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw statusError(`Ozon API ${path} 请求超时`, 504);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function normalizeProductsForOfficialAdd(products = []) {
  return products
    .map((item) => ({
      product_id: Number(item.product_id ?? item.id),
      action_price: Number(item.action_price),
      ...(item.stock != null && item.stock !== "" ? { stock: Number(item.stock) } : {})
    }))
    .filter((item) => Number.isFinite(item.product_id) && item.product_id > 0 && Number.isFinite(item.action_price) && item.action_price > 0)
    .slice(0, 1000);
}

function normalizeProductsForSellerAdd(products = []) {
  return products
    .map((item) => ({
      sku: Number(Array.isArray(item.sku) ? item.sku[0] : item.sku),
      ...(item.discount_percent != null && item.discount_percent !== "" ? { discount_percent: Number(item.discount_percent) } : {}),
      ...(item.currency ? { currency: String(item.currency) } : {})
    }))
    .filter((item) => Number.isFinite(item.sku) && item.sku > 0)
    .slice(0, 100);
}

function uniqueProductIds(products = []) {
  return Array.from(new Set(products.map((item) => Number(item?.product_id ?? item?.id)).filter((value) => Number.isFinite(value) && value > 0))).slice(0, 1000);
}

function uniqueSkus(products = []) {
  return Array.from(new Set(products.map((item) => String(Array.isArray(item?.sku) ? item.sku[0] : item?.sku || "").trim()).filter(Boolean))).slice(0, 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstImage(item) {
  if (!item) return "";
  if (typeof item.primary_image === "string") return item.primary_image;
  if (Array.isArray(item.primary_image) && item.primary_image[0]) return item.primary_image[0];
  if (typeof item.image === "string") return item.image;
  if (Array.isArray(item.images) && item.images[0]) return item.images[0];
  return "";
}

async function enrichActionProductsWithImages(shop, products, signal) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return list;
  const productIds = Array.from(new Set(
    list
      .map((product) => product?.product_id ?? product?.id)
      .filter((value) => value != null && value !== "")
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0)
  )).slice(0, 1000);
  const skus = Array.from(new Set(
    list
      .flatMap((product) => Array.isArray(product?.sku) ? product.sku : [product?.sku])
      .filter((value) => value != null && value !== "")
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0)
  )).slice(0, 1000);
  const payload = productIds.length ? { product_id: productIds } : skus.length ? { sku: skus } : null;
  if (!payload) return list;

  try {
    const data = await ozonRequest("/v3/product/info/list", { payload, shop, signal });
    const infoItems = Array.isArray(data?.items) ? data.items : Array.isArray(data?.result?.items) ? data.result.items : [];
    const byProductId = new Map(
      infoItems
        .map((item) => [String(item?.id ?? item?.product_id ?? ""), item])
        .filter(([key]) => key)
    );
    const bySku = new Map(
      infoItems
        .map((item) => [String(item?.sku ?? ""), item])
        .filter(([key]) => key)
    );
    return list.map((product) => {
      const productId = product?.product_id ?? product?.id;
      const sku = Array.isArray(product?.sku) ? product.sku[0] : product?.sku;
      const info = byProductId.get(String(productId ?? "")) || bySku.get(String(sku ?? ""));
      if (!info) return product;
      const image = firstImage(info);
      return {
        ...product,
        name: product?.name || info.name || "",
        offer_id: product?.offer_id || info.offer_id || "",
        product_id: product?.product_id ?? info.id ?? info.product_id,
        sku: product?.sku || info.sku,
        currency: product?.currency || info.currency_code,
        image_url: product?.image_url || image,
        primary_image: product?.primary_image || info.primary_image,
        images: product?.images || info.images || [],
        _image_from_info: Boolean(image)
      };
    });
  } catch {
    return list;
  }
}

export async function listOzonActionsMysql(body = {}, options = {}) {
  const mode = normalizeMode(body.mode);
  const shop = await readShop(body.storeId);
  if (mode === "seller") {
    const payload = {
      limit: normalizeLimit(body.limit, 100, 100),
      offset: Math.max(0, Number(body.offset || 0))
    };
    const status = Array.isArray(body.status) ? body.status.filter(Boolean) : (body.status ? [body.status] : []);
    const actionType = Array.isArray(body.action_type) ? body.action_type.filter(Boolean) : (body.action_type ? [body.action_type] : []);
    if (status.length) payload.status = status;
    if (actionType.length) payload.action_type = actionType;
    if (body.search && String(body.search).trim().length >= 3) payload.search = String(body.search).trim();
    return ozonRequest("/v1/seller-actions/list", { payload, shop, signal: options.signal });
  }
  return ozonRequest("/v1/actions", { method: "GET", shop, signal: options.signal });
}

export async function listOzonActionCandidatesMysql(body = {}, options = {}) {
  const mode = normalizeMode(body.mode);
  if (!body.actionId) throw statusError("Missing actionId");
  const shop = await readShop(body.storeId);
  const limit = normalizeLimit(body.limit, 100, 100);
  if (mode === "seller") {
    const payload = { action_id: Number(body.actionId), limit };
    if (body.cursor) payload.cursor = Number(body.cursor);
    const data = await ozonRequest("/v1/seller-actions/products/candidates", { payload, shop, signal: options.signal });
    if (Array.isArray(data.products)) data.products = await enrichActionProductsWithImages(shop, data.products, options.signal);
    return data;
  }
  const payload = { action_id: Number(body.actionId), limit };
  if (body.lastId !== undefined && body.lastId !== null && String(body.lastId) !== "") payload.last_id = String(body.lastId);
  const data = await ozonRequest("/v1/actions/candidates", { payload, shop, signal: options.signal });
  if (Array.isArray(data?.result?.products)) data.result.products = await enrichActionProductsWithImages(shop, data.result.products, options.signal);
  return data;
}

export async function listOzonActionProductsMysql(body = {}, options = {}) {
  const mode = normalizeMode(body.mode);
  if (!body.actionId) throw statusError("Missing actionId");
  const shop = await readShop(body.storeId);
  const limit = normalizeLimit(body.limit, 100, 100);
  if (mode === "seller") {
    const payload = { action_id: Number(body.actionId), limit };
    if (body.cursor) payload.cursor = Number(body.cursor);
    const data = await ozonRequest("/v1/seller-actions/products/list", { payload, shop, signal: options.signal });
    if (Array.isArray(data.products)) data.products = await enrichActionProductsWithImages(shop, data.products, options.signal);
    return data;
  }
  const payload = { action_id: Number(body.actionId), limit };
  if (body.lastId !== undefined && body.lastId !== null && String(body.lastId) !== "") payload.last_id = String(body.lastId);
  const data = await ozonRequest("/v1/actions/products", { payload, shop, signal: options.signal });
  if (Array.isArray(data?.result?.products)) data.result.products = await enrichActionProductsWithImages(shop, data.result.products, options.signal);
  return data;
}

export async function addOzonActionProductsMysql(body = {}, options = {}) {
  const mode = normalizeMode(body.mode);
  if (!body.actionId) throw statusError("Missing actionId");
  const products = Array.isArray(body.products) ? body.products : [];
  if (!products.length) throw statusError("Missing products");
  const shop = await readShop(body.storeId);
  if (mode === "seller") {
    const normalized = normalizeProductsForSellerAdd(products);
    if (!normalized.length) throw statusError("No valid sku products");
    return ozonRequest("/v1/seller-actions/products/add", {
      payload: { action_id: Number(body.actionId), products: normalized },
      shop,
      signal: options.signal
    });
  }
  const normalized = normalizeProductsForOfficialAdd(products);
  if (!normalized.length) throw statusError("No valid product/action_price rows");
  return ozonRequest("/v1/actions/products/activate", {
    payload: { action_id: Number(body.actionId), products: normalized },
    shop,
    signal: options.signal
  });
}

export async function removeOzonActionProductsMysql(body = {}, options = {}) {
  const mode = normalizeMode(body.mode);
  if (!body.actionId) throw statusError("Missing actionId");
  const products = Array.isArray(body.products) ? body.products : [];
  if (!products.length) throw statusError("Missing products");
  const shop = await readShop(body.storeId);
  if (mode === "seller") {
    const skus = uniqueSkus(products);
    if (!skus.length) throw statusError("No valid skus");
    return ozonRequest("/v1/seller-actions/products/delete", {
      payload: { action_id: Number(body.actionId), skus },
      shop,
      signal: options.signal
    });
  }
  const productIds = uniqueProductIds(products);
  if (!productIds.length) throw statusError("No valid product_ids");
  return ozonRequest("/v1/actions/products/deactivate", {
    payload: { action_id: Number(body.actionId), product_ids: productIds },
    shop,
    signal: options.signal
  });
}

export async function toggleOzonSellerActionMysql(body = {}, options = {}) {
  if (!body.actionId) throw statusError("Missing actionId");
  const shop = await readShop(body.storeId);
  return ozonRequest("/v1/seller-actions/change-activity", {
    payload: { action_id: Number(body.actionId), is_turn_on: Boolean(body.enabled) },
    shop,
    signal: options.signal
  });
}

export async function archiveOzonSellerActionMysql(body = {}, options = {}) {
  if (!body.actionId) throw statusError("Missing actionId");
  const shop = await readShop(body.storeId);
  return ozonRequest("/v1/seller-actions/archive", {
    payload: { action_id: Number(body.actionId) },
    shop,
    signal: options.signal
  });
}

function settingKey(storeId) {
  return `${ACTION_CLEANUP_SETTING_PREFIX}${String(storeId || "").trim()}`;
}

function normalizeCleanupActionIds(value) {
  const raw = Array.isArray(value) ? value : DEFAULT_CLEANUP_ACTION_IDS;
  const ids = raw
    .map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);
  return ids.length ? Array.from(new Set(ids)) : DEFAULT_CLEANUP_ACTION_IDS.slice();
}

export function extractOfficialActionCleanupProductIds(products = []) {
  const seen = new Set();
  const result = [];
  for (const row of Array.isArray(products) ? products : []) {
    const addMode = String(row?.add_mode || "").trim().toUpperCase();
    if (addMode !== "AUTO") continue;
    const productId = Number(row?.product_id ?? row?.id);
    if (!Number.isFinite(productId) || productId <= 0 || seen.has(productId)) continue;
    seen.add(productId);
    result.push(productId);
  }
  return result;
}

function normalizeCleanupConfig(storeId, rawValue = null) {
  let parsed = {};
  if (rawValue) {
    try {
      parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    } catch {
      parsed = {};
    }
  }
  const normalizedStoreId = String(storeId || "").trim();
  const actionIds = normalizeCleanupActionIds(parsed.actionIds);
  return {
    storeId: normalizedStoreId,
    storeName: "",
    enabled: parsed.enabled === true,
    actionIds,
    intervalMinutes: DEFAULT_CLEANUP_INTERVAL_MINUTES,
    lastRunAt: parsed.lastRunAt || "",
    lastError: parsed.lastError || "",
    lastResult: parsed.lastResult || null,
    taskEnabled: parsed.enabled === true,
    taskRunning: cleanupRunningStores.has(normalizedStoreId)
  };
}

async function ensureSettingsTables() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS system_settings (
      \`key\` VARCHAR(191) PRIMARY KEY,
      value_json LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

export async function getOzonActionCleanupConfigMysql(query = {}) {
  const storeId = String(query.storeId || query.store_id || "").trim();
  if (!storeId) throw statusError("Missing storeId");
  const shop = await readShop(storeId);
  await ensureSettingsTables();
  const rows = await mysqlQuery("SELECT value_json FROM system_settings WHERE `key` = ? LIMIT 1", [settingKey(storeId)]);
  return {
    ...normalizeCleanupConfig(storeId, rows[0]?.value_json),
    storeName: shop.name || ""
  };
}

async function persistCleanupConfig(storeId, config) {
  await ensureSettingsTables();
  const next = {
    ...normalizeCleanupConfig(storeId, config),
    ...config,
    storeId: String(storeId || "").trim(),
    intervalMinutes: DEFAULT_CLEANUP_INTERVAL_MINUTES,
    actionIds: normalizeCleanupActionIds(config?.actionIds),
    updatedAt: new Date().toISOString()
  };
  await mysqlExecute(`
    INSERT INTO system_settings (\`key\`, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = CURRENT_TIMESTAMP
  `, [settingKey(storeId), JSON.stringify(next)]);
  return next;
}

async function fetchAllJoinedActionProductIds(shop, actionId, signal) {
  let lastId = "";
  const productIds = [];
  while (true) {
    const payload = {
      action_id: Number(actionId),
      limit: ACTION_PRODUCTS_PAGE_LIMIT
    };
    if (lastId) payload.last_id = String(lastId);
    const response = await ozonRequest("/v1/actions/products", { payload, shop, signal });
    const result = response?.result || {};
    const rows = Array.isArray(result.products) ? result.products : [];
    productIds.push(...extractOfficialActionCleanupProductIds(rows));
    if (!rows.length || result.last_id === undefined || result.last_id === null || result.last_id === "") break;
    lastId = result.last_id;
    await sleep(180);
  }
  return Array.from(new Set(productIds));
}

async function deleteOfficialActionProducts(shop, actionId, productIds, signal) {
  const rows = Array.isArray(productIds)
    ? productIds.map(Number).filter((item) => Number.isFinite(item) && item > 0)
    : [];
  let removedCount = 0;
  for (let index = 0; index < rows.length; index += ACTION_DELETE_BATCH_LIMIT) {
    const batch = rows.slice(index, index + ACTION_DELETE_BATCH_LIMIT);
    if (!batch.length) continue;
    await ozonRequest("/v1/actions/products/deactivate", {
      payload: {
        action_id: Number(actionId),
        product_ids: batch
      },
      shop,
      signal
    });
    removedCount += batch.length;
    await sleep(180);
  }
  return removedCount;
}

export async function listOzonActionCleanupConfigsMysql() {
  await ensureSettingsTables();
  const rows = await mysqlQuery(
    "SELECT `key`, value_json FROM system_settings WHERE `key` LIKE ?",
    [`${ACTION_CLEANUP_SETTING_PREFIX}%`]
  );
  return rows
    .map((row) => {
      const key = String(row?.key || "");
      const storeId = key.startsWith(ACTION_CLEANUP_SETTING_PREFIX) ? key.slice(ACTION_CLEANUP_SETTING_PREFIX.length) : "";
      return normalizeCleanupConfig(storeId, row?.value_json);
    })
    .filter((item) => item.storeId);
}

export async function runOzonActionCleanupForStoreMysql(storeId, config = null, options = {}) {
  const normalizedStoreId = String(storeId || "").trim();
  if (!normalizedStoreId) throw statusError("Missing storeId");
  if (cleanupRunningStores.has(normalizedStoreId)) {
    return {
      success: false,
      storeId: normalizedStoreId,
      count: 0,
      error: "自动删除任务正在执行中"
    };
  }

  cleanupRunningStores.add(normalizedStoreId);
  const now = new Date().toISOString();
  let current = config && typeof config === "object"
    ? normalizeCleanupConfig(normalizedStoreId, config)
    : await getOzonActionCleanupConfigMysql({ storeId: normalizedStoreId });
  try {
    if (current.enabled !== true && options.force !== true) {
      return { success: true, storeId: normalizedStoreId, count: 0, skippedDisabled: true };
    }

    const shop = await readShop(normalizedStoreId);
    current = { ...current, storeName: shop.name || "" };
    const actionSummaries = [];
    const errors = [];
    let removedCount = 0;

    for (const actionId of current.actionIds || DEFAULT_CLEANUP_ACTION_IDS) {
      try {
        const productIds = await fetchAllJoinedActionProductIds(shop, actionId, options.signal);
        if (!productIds.length) {
          actionSummaries.push({ actionId, removedCount: 0, skippedManualOnly: true });
          continue;
        }
        const actionRemovedCount = await deleteOfficialActionProducts(shop, actionId, productIds, options.signal);
        removedCount += actionRemovedCount;
        actionSummaries.push({ actionId, removedCount: actionRemovedCount });
      } catch (error) {
        const message = error?.message || "unknown";
        errors.push(`活动 ${actionId}: ${message}`);
        actionSummaries.push({ actionId, removedCount: 0, error: message });
      }
    }

    const lastError = errors.join("；");
    const saved = await persistCleanupConfig(normalizedStoreId, {
      ...current,
      enabled: current.enabled,
      actionIds: current.actionIds,
      lastRunAt: now,
      lastResult: { removedCount, actionSummaries },
      lastError
    });
    return {
      success: errors.length === 0,
      storeId: normalizedStoreId,
      storeName: shop.name || normalizedStoreId,
      count: removedCount,
      actionSummaries,
      config: { ...saved, taskRunning: false },
      ...(lastError ? { error: lastError } : {})
    };
  } catch (error) {
    await persistCleanupConfig(normalizedStoreId, {
      ...current,
      lastRunAt: now,
      lastResult: { removedCount: 0, actionSummaries: [] },
      lastError: error?.message || "自动删除任务执行失败"
    }).catch(() => {});
    return {
      success: false,
      storeId: normalizedStoreId,
      count: 0,
      error: error?.message || "自动删除任务执行失败"
    };
  } finally {
    cleanupRunningStores.delete(normalizedStoreId);
  }
}

export async function runEnabledOzonActionCleanupMysql(options = {}) {
  if (enabledCleanupSweepRunning) return [];
  enabledCleanupSweepRunning = true;
  try {
    const configs = await listOzonActionCleanupConfigsMysql();
    const enabledConfigs = configs.filter((item) => item.enabled === true);
    const results = [];
    for (const config of enabledConfigs) {
      results.push(await runOzonActionCleanupForStoreMysql(config.storeId, config, options));
    }
    return results;
  } finally {
    enabledCleanupSweepRunning = false;
  }
}

export async function saveOzonActionCleanupConfigMysql(body = {}) {
  const storeId = String(body.storeId || body.store_id || "").trim();
  if (!storeId) throw statusError("Missing storeId");
  const shop = await readShop(storeId);
  await ensureSettingsTables();
  const previous = await getOzonActionCleanupConfigMysql({ storeId }).catch(() => normalizeCleanupConfig(storeId));
  const enabled = body.enabled === true;
  const next = {
    ...previous,
    enabled,
    intervalMinutes: DEFAULT_CLEANUP_INTERVAL_MINUTES,
    actionIds: Array.isArray(body.actionIds) && body.actionIds.length ? normalizeCleanupActionIds(body.actionIds) : previous.actionIds,
    storeName: shop.name || ""
  };
  const saved = await persistCleanupConfig(storeId, next);
  if (!enabled) return { success: true, config: saved, immediateRun: null };

  const immediateRun = await runOzonActionCleanupForStoreMysql(storeId, saved, { force: true });
  return {
    success: immediateRun.success !== false,
    config: immediateRun.config || await getOzonActionCleanupConfigMysql({ storeId }),
    immediateRun
  };
}
