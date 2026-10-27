import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { currentAiTenantSession, needsAiTenantSession, withAiTenantSession } from "./ai-tenant-context.js";
import { assertBusinessTaskPermission, authorizeBusinessTaskSession, businessTaskTenantKey, restoreBusinessTaskSession } from "./business-task-tenant.js";
import { inventoryTenantSql } from "./inventory-tenant-scope.js";

const OZON_API_BASE = "https://api-seller.ozon.ru";
const ACTION_CLEANUP_SETTING_PREFIX = "ozon.actions.cleanup:";
const DEFAULT_CLEANUP_INTERVAL_MINUTES = 5;
const KNOWN_ACTION_RETENTION_DAYS = 14;
const UNAVAILABLE_ACTION_RETENTION_DAYS = 3;
const OZON_REQUEST_TIMEOUT_MS = 30000;
const ACTION_PRODUCTS_PAGE_LIMIT = 100;
const ACTION_DELETE_BATCH_LIMIT = 1000;
const ACTION_DELETE_VERIFY_DELAYS_MS = [2000, 5000];
const ACTION_PRODUCTS_MAX_PAGES = 200;
const cleanupRunningStores = new Set();
const cleanupQueuedStores = new Set();
const tenantCleanupRuns = new Map();
const tenantCleanupPreparing = new Set();
let enabledCleanupSweepRunning = false;
const ACTION_CLEANUP_DISCOVERY = Symbol("internal action cleanup discovery");

async function actionTenantScope() {
  const session = await authorizeBusinessTaskSession(currentAiTenantSession());
  assertBusinessTaskPermission(session, "operations");
  return { id: session.tenant.id, isDefault: session.tenant.slug === "default", session };
}

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
  const scope = await actionTenantScope();
  const id = Number(storeId || 0);
  if (!Number.isFinite(id) || id <= 0) throw statusError("请选择店铺");
  const rows = await mysqlQuery(`
    SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS ozon_api_key, api_key_hint, status
    FROM shops
    WHERE id = ? AND status <> 'deleted' AND ${inventoryTenantSql(scope, "shops")}
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
  shop = await readShop(shop?.id);
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
  if (needsAiTenantSession(options.session)) return withAiTenantSession(options.session, () => listOzonActionsMysql(body, options));
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
  if (needsAiTenantSession(options.session)) return withAiTenantSession(options.session, () => listOzonActionCandidatesMysql(body, options));
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
  const data = await officialProductPage(shop, "candidates", payload, options.signal);
  if (Array.isArray(data?.result?.products)) data.result.products = await enrichActionProductsWithImages(shop, data.result.products, options.signal);
  return data;
}

export async function listOzonActionProductsMysql(body = {}, options = {}) {
  if (needsAiTenantSession(options.session)) return withAiTenantSession(options.session, () => listOzonActionProductsMysql(body, options));
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
  const data = await officialProductPage(shop, "products", payload, options.signal);
  if (Array.isArray(data?.result?.products)) data.result.products = await enrichActionProductsWithImages(shop, data.result.products, options.signal);
  return data;
}

export async function addOzonActionProductsMysql(body = {}, options = {}) {
  if (needsAiTenantSession(options.session)) return withAiTenantSession(options.session, () => addOzonActionProductsMysql(body, options));
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
  if (needsAiTenantSession(options.session)) return withAiTenantSession(options.session, () => removeOzonActionProductsMysql(body, options));
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
  if (needsAiTenantSession(options.session)) return withAiTenantSession(options.session, () => toggleOzonSellerActionMysql(body, options));
  if (!body.actionId) throw statusError("Missing actionId");
  const shop = await readShop(body.storeId);
  return ozonRequest("/v1/seller-actions/change-activity", {
    payload: { action_id: Number(body.actionId), is_turn_on: Boolean(body.enabled) },
    shop,
    signal: options.signal
  });
}

export async function archiveOzonSellerActionMysql(body = {}, options = {}) {
  if (needsAiTenantSession(options.session)) return withAiTenantSession(options.session, () => archiveOzonSellerActionMysql(body, options));
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
  const raw = Array.isArray(value) ? value : [];
  const ids = raw
    .map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);
  return Array.from(new Set(ids));
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

function normalizeOfficialActionSummary(action = {}) {
  const actionId = Number(action?.actionId ?? action?.id ?? action?.action_id);
  if (!Number.isFinite(actionId) || actionId <= 0) return null;
  return {
    actionId,
    title: String(action?.title ?? action?.name ?? ""),
    actionType: String(action?.action_type ?? action?.type ?? ""),
    status: String(action?.status ?? ""),
    isParticipating: Boolean(action?.is_participating),
    dateStart: String(action?.date_start ?? action?.start_at ?? ""),
    dateEnd: String(action?.date_end ?? action?.end_at ?? ""),
    isVoucher: action?.isVoucher === true || action?.is_voucher_action === true,
    autoAddDates: Array.from(new Set((action?.autoAddDates || action?.auto_add_dates || []).filter(value => typeof value === "string" && Number.isFinite(Date.parse(value)))))
  };
}

export function extractOfficialActionSummaries(data = {}) {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.result)
      ? data.result
      : Array.isArray(data?.result?.actions)
        ? data.result.actions
        : Array.isArray(data?.actions)
          ? data.actions
          : [];
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const summary = normalizeOfficialActionSummary(row);
    if (!summary || seen.has(summary.actionId)) continue;
    seen.add(summary.actionId);
    result.push(summary);
  }
  return result.sort((a, b) => a.actionId - b.actionId);
}

function snapshotActionSummaries(actions = []) {
  return extractOfficialActionSummaries(actions).map((item) => ({
    actionId: item.actionId,
    title: item.title,
    actionType: item.actionType,
    status: item.status,
    isParticipating: item.isParticipating,
    dateStart: item.dateStart,
    dateEnd: item.dateEnd,
    isVoucher: item.isVoucher,
    autoAddDates: item.autoAddDates
  }));
}

export function officialActionCatalogChanged(previous = [], next = []) {
  return JSON.stringify(snapshotActionSummaries(previous)) !== JSON.stringify(snapshotActionSummaries(next));
}

function daysAgoIso(days, now = new Date()) {
  return new Date(now.getTime() - Math.max(0, Number(days || 0)) * 24 * 60 * 60 * 1000).toISOString();
}

function isIsoBefore(value, threshold) {
  if (!value || !threshold) return false;
  const time = new Date(value).getTime();
  const thresholdTime = new Date(threshold).getTime();
  return Number.isFinite(time) && Number.isFinite(thresholdTime) && time < thresholdTime;
}

export function normalizeKnownActionCatalog(value = []) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const summary = normalizeOfficialActionSummary(row);
    if (!summary || seen.has(summary.actionId)) continue;
    seen.add(summary.actionId);
    result.push({
      ...summary,
      firstSeenAt: String(row?.firstSeenAt || row?.first_seen_at || ""),
      lastSeenAt: String(row?.lastSeenAt || row?.last_seen_at || ""),
      lastCheckedAt: String(row?.lastCheckedAt || row?.last_checked_at || ""),
      unavailableSince: String(row?.unavailableSince || row?.unavailable_since || ""),
      lastUnavailableAt: String(row?.lastUnavailableAt || row?.last_unavailable_at || ""),
      unavailableCount: Math.max(0, Number(row?.unavailableCount || row?.unavailable_count || 0)),
      source: String(row?.source || "ozon")
    });
  }
  return result.sort((a, b) => a.actionId - b.actionId);
}

export function mergeKnownActionCatalog(previous = [], currentActions = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const retentionThreshold = daysAgoIso(options.retentionDays ?? KNOWN_ACTION_RETENTION_DAYS, new Date(now));
  const unavailableThreshold = daysAgoIso(options.unavailableRetentionDays ?? UNAVAILABLE_ACTION_RETENTION_DAYS, new Date(now));
  const previousRows = normalizeKnownActionCatalog(previous);
  const byId = new Map(previousRows.map((item) => [item.actionId, item]));
  const currentRows = extractOfficialActionSummaries(currentActions);

  for (const item of currentRows) {
    const previousItem = byId.get(item.actionId) || {};
    byId.set(item.actionId, {
      ...previousItem,
      ...item,
      firstSeenAt: previousItem.firstSeenAt || now,
      lastSeenAt: now,
      unavailableSince: "",
      lastUnavailableAt: "",
      unavailableCount: 0,
      source: previousItem.source || "ozon"
    });
  }

  const seedActionIds = Object.prototype.hasOwnProperty.call(options, "seedActionIds")
    ? options.seedActionIds
    : [];
  for (const actionId of normalizeCleanupActionIds(seedActionIds)) {
    if (byId.has(actionId)) continue;
    byId.set(actionId, {
      actionId,
      title: "",
      actionType: "",
      status: "",
      isParticipating: false,
      dateStart: "",
      dateEnd: "",
      firstSeenAt: now,
      lastSeenAt: now,
      lastCheckedAt: "",
      unavailableSince: "",
      lastUnavailableAt: "",
      unavailableCount: 0,
      source: "legacy_seed"
    });
  }

  return Array.from(byId.values())
    .filter((item) => {
      if (item.unavailableSince && isIsoBefore(item.unavailableSince, unavailableThreshold)) return false;
      if (item.lastSeenAt && isIsoBefore(item.lastSeenAt, retentionThreshold)) return false;
      return true;
    })
    .sort((a, b) => a.actionId - b.actionId);
}

export function recordKnownActionCheck(catalog = [], actionId, patch = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const rows = normalizeKnownActionCatalog(catalog);
  const targetId = Number(actionId);
  if (!Number.isFinite(targetId) || targetId <= 0) return rows;
  const index = rows.findIndex((item) => item.actionId === targetId);
  const current = index >= 0 ? rows[index] : {
    actionId: targetId,
    title: "",
    actionType: "",
    status: "",
    isParticipating: false,
    dateStart: "",
    dateEnd: "",
    firstSeenAt: now,
    lastSeenAt: "",
    lastCheckedAt: "",
    unavailableSince: "",
    lastUnavailableAt: "",
    unavailableCount: 0,
    source: "checked"
  };
  const next = {
    ...current,
    lastCheckedAt: now,
    ...(patch.unavailable
      ? {
          unavailableSince: current.unavailableSince || now,
          lastUnavailableAt: now,
          unavailableCount: Math.max(0, Number(current.unavailableCount || 0)) + 1
        }
      : {
          unavailableSince: "",
          lastUnavailableAt: "",
          unavailableCount: 0
        })
  };
  if (index >= 0) rows[index] = next;
  else rows.push(next);
  return mergeKnownActionCatalog(rows, [], {
    now,
    seedActionIds: [],
    retentionDays: options.retentionDays,
    unavailableRetentionDays: options.unavailableRetentionDays
  });
}

export function buildOfficialActionCleanupIds(currentActions = [], knownCatalog = []) {
  const currentIds = extractOfficialActionSummaries(currentActions).map((item) => item.actionId);
  const knownRows = Array.isArray(knownCatalog) && knownCatalog.some((item) => item && typeof item === "object")
    ? normalizeKnownActionCatalog(knownCatalog).map((item) => item.actionId)
    : normalizeCleanupActionIds(knownCatalog);
  return Array.from(new Set([
    ...currentIds,
    ...knownRows
  ]));
}

function normalizeCleanupConfig(storeId, rawValue = null, options = {}) {
  const hasStoredValue = rawValue !== null && rawValue !== undefined && rawValue !== "";
  let parsed = {};
  if (hasStoredValue) {
    try {
      parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    } catch {
      parsed = {};
    }
  }
  const normalizedStoreId = String(storeId || "").trim();
  const actionIds = normalizeCleanupActionIds(parsed.actionIds);
  const knownActions = mergeKnownActionCatalog(parsed.knownActions || parsed.knownActionCatalog || [], parsed.lastSyncedActions || [], {
    seedActionIds: actionIds
  });
  const enabled = hasStoredValue ? parsed.enabled === true : false;
  const identitySaved = Boolean(parsed.tenant_key && Number(parsed.created_by_person_id) > 0);
  return {
    storeId: normalizedStoreId,
    tenant_key: parsed.tenant_key || "",
    created_by_person_id: Number(parsed.created_by_person_id || 0) || null,
    storeName: "",
    enabled,
    actionIds,
    knownActions,
    lastSyncedActions: snapshotActionSummaries(parsed.lastSyncedActions || []),
    lastActionListSyncedAt: parsed.lastActionListSyncedAt || "",
    lastActionListChangedAt: parsed.lastActionListChangedAt || "",
    intervalMinutes: DEFAULT_CLEANUP_INTERVAL_MINUTES,
    lastRunAt: parsed.lastRunAt || "",
    lastAttemptAt: parsed.lastAttemptAt || "",
    lastError: parsed.lastError || "",
    lastResult: parsed.lastResult || null,
    authorizationReady: identitySaved,
    authorizationError: enabled && !identitySaved ? "旧配置缺少执行企业或操作人，请点击本店立即扫描或扫描全部店铺重新授权" : "",
    taskEnabled: enabled && identitySaved,
    taskRunning: cleanupRunningStores.has(normalizedStoreId) || cleanupQueuedStores.has(normalizedStoreId)
  };
}

async function cleanupConfigStatus(config, scope) {
  let authorizationReady = false;
  let authorizationError = config.authorizationError || "";
  if (config.tenant_key && config.created_by_person_id) {
    try {
      const actor = await restoreBusinessTaskSession(config.tenant_key, config.created_by_person_id);
      assertBusinessTaskPermission(actor, "operations");
      if (Number(actor.tenant.id) !== Number(scope.id)) throw statusError("执行账号所属企业与店铺不一致，请重新保存配置", 403);
      authorizationReady = true;
      authorizationError = "";
    } catch (error) {
      authorizationError = error.message;
    }
  }
  let schedulerEnabled = true;
  let intervalMinutes = DEFAULT_CLEANUP_INTERVAL_MINUTES;
  try {
    const jobs = await mysqlQuery("SELECT enabled, interval_minutes FROM scheduled_jobs WHERE job_key = 'ozon_action_cleanup' LIMIT 1");
    if (jobs.length) {
      schedulerEnabled = Boolean(Number(jobs[0].enabled));
      intervalMinutes = Number(jobs[0].interval_minutes) || intervalMinutes;
    }
  } catch (error) { if (error.code !== "ER_NO_SUCH_TABLE") throw error; }
  return { ...config, authorizationReady, authorizationError, schedulerEnabled, intervalMinutes, taskEnabled: config.enabled && authorizationReady && schedulerEnabled };
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

export async function getOzonActionCleanupConfigMysql(query = {}, session = null) {
  if (needsAiTenantSession(session)) return withAiTenantSession(session, () => getOzonActionCleanupConfigMysql(query, session));
  const storeId = String(query.storeId || query.store_id || "").trim();
  if (!storeId) throw statusError("Missing storeId");
  const shop = await readShop(storeId);
  await ensureSettingsTables();
  const rows = await mysqlQuery("SELECT value_json FROM system_settings WHERE `key` = ? LIMIT 1", [settingKey(storeId)]);
  return cleanupConfigStatus({
    ...normalizeCleanupConfig(storeId, rows[0]?.value_json),
    storeName: shop.name || ""
  }, await actionTenantScope());
}

async function persistCleanupConfig(storeId, config, { runResultOnly = false } = {}) {
  const scope = await actionTenantScope();
  await readShop(storeId);
  await ensureSettingsTables();
  const next = {
    storeId: String(storeId || "").trim(),
    intervalMinutes: DEFAULT_CLEANUP_INTERVAL_MINUTES,
    updatedAt: new Date().toISOString()
  };
  if (runResultOnly) {
    for (const key of ["lastAttemptAt", "lastRunAt", "lastResult", "lastError", "lastSyncedActions", "lastActionListSyncedAt", "lastActionListChangedAt"]) {
      if (Object.prototype.hasOwnProperty.call(config, key)) next[key] = config[key];
    }
    if (config.knownActions) next.knownActions = normalizeKnownActionCatalog(config.knownActions);
  } else {
    next.enabled = config.enabled === true;
    next.actionIds = normalizeCleanupActionIds(config.actionIds);
    next.tenant_key = businessTaskTenantKey(scope.session);
    next.created_by_person_id = scope.session.personId;
  }
  await mysqlExecute(`
    INSERT INTO system_settings (\`key\`, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE value_json = JSON_MERGE_PATCH(value_json, VALUES(value_json)), updated_at = CURRENT_TIMESTAMP
  `, [settingKey(storeId), JSON.stringify(next)]);
  return getOzonActionCleanupConfigMysql({ storeId });
}

async function fetchAllJoinedActionProductIds(shop, actionId, signal) {
  let lastId = "";
  const productIds = [];
  const seenCursors = new Set();
  let pageCount = 0;
  let scannedCount = 0;
  let totalMismatch = false;
  const products = new Map();
  const manualProductIds = new Set();
  const seenProductIds = new Set();
  while (pageCount < ACTION_PRODUCTS_MAX_PAGES) {
    const payload = {
      action_id: Number(actionId),
      limit: ACTION_PRODUCTS_PAGE_LIMIT
    };
    if (lastId) payload.last_id = String(lastId);
    let response;
    if (shop.promotionApiMode === "unified") response = await ozonRequest("/v2/actions/products", { payload, shop, signal });
    else {
      try { response = await ozonRequest("/v1/actions/products", { payload, shop, signal }); }
      catch (error) {
        if (!isUnifiedPriceError(error)) throw error;
        shop.promotionApiMode = "unified";
        response = await ozonRequest("/v2/actions/products", { payload, shop, signal });
      }
    }
    const result = shop.promotionApiMode === "unified" ? response : response?.result;
    if (shop.promotionApiMode === "unified" && (result?.total === undefined || result.total === null || result.total === "" || !Number.isSafeInteger(Number(result.total)) || Number(result.total) < 0)) {
      throw statusError(`活动 ${actionId} 商品分页数量异常，已停止以避免漏删`, 502);
    }
    if (!Array.isArray(result.products)) throw statusError(`活动 ${actionId} 商品响应缺少有效商品列表，已停止以避免误报清理成功`, 502);
    const rows = result.products;
    pageCount += 1;
    scannedCount += rows.length;
    productIds.push(...extractOfficialActionCleanupProductIds(rows));
    for (const row of rows) {
      const id = Number(row.product_id ?? row.id);
      if (!Number.isSafeInteger(id) || id <= 0 || seenProductIds.has(id)) throw statusError(`活动 ${actionId} 商品标识或分页重复异常，已停止以避免误退出`, 502);
      seenProductIds.add(id);
      if (String(row.add_mode || "").toUpperCase() === "AUTO") products.set(id, row);
      else manualProductIds.add(id);
    }
    const nextCursor = String(result.last_id ?? "").trim();
    if ((!rows.length || !nextCursor) && Number(result.total) > scannedCount) {
      // Ozon v2 can report a larger total than its cursor can enumerate. Only
      // accept an explicit, stable terminal cursor after re-reading that exact
      // empty page. A missing cursor or a first empty page is still incomplete.
      if (shop.promotionApiMode !== "unified" || rows.length || !lastId || !scannedCount || nextCursor !== lastId) {
        throw statusError(`活动 ${actionId} 商品分页提前结束，已停止以避免漏删`, 502);
      }
      const terminal = await ozonRequest("/v2/actions/products", { payload, shop, signal });
      pageCount += 1;
      if (!Array.isArray(terminal.products) || terminal.products.length || String(terminal.last_id ?? "").trim() !== lastId || Number(terminal.total) !== Number(result.total)) {
        throw statusError(`活动 ${actionId} 商品分页终点未能复核，已停止以避免漏删`, 502);
      }
      totalMismatch = true;
    }
    if (!rows.length || !nextCursor) {
      return {
        productIds: Array.from(new Set(productIds)),
        pageCount,
        scannedCount,
        products: [...products.values()],
        manualProductIds: [...manualProductIds],
        reportedTotal: Number(result.total),
        totalMismatch,
        paginationWarning: totalMismatch ? `Ozon 统计 ${Number(result.total)} 件、游标实际返回 ${scannedCount} 件；已再次读取同一空页确认分页终点` : "",
        apiVersion: shop.promotionApiMode === "unified" ? "v2" : "v1"
      };
    }
    if (seenCursors.has(nextCursor)) {
      throw statusError(`活动 ${actionId} 商品分页游标重复，已停止以避免漏删`, 502);
    }
    seenCursors.add(nextCursor);
    lastId = nextCursor;
    await sleep(180);
  }
  throw statusError(`活动 ${actionId} 商品分页超过 ${ACTION_PRODUCTS_MAX_PAGES} 页，已停止以避免漏删`, 502);
}

function isUnifiedPriceError(error) {
  return /unified price logic|switch to the new methods/i.test(String(error?.message || ""));
}

async function officialProductPage(shop, endpoint, payload, signal) {
  try { return await ozonRequest(`/v1/actions/${endpoint}`, { payload, shop, signal }); }
  catch (error) {
    if (!isUnifiedPriceError(error)) throw error;
    const data = await ozonRequest(`/v2/actions/${endpoint}`, { payload, shop, signal });
    if (!Array.isArray(data.products)) throw statusError("Ozon 新版活动商品响应格式异常，请稍后重试", 502);
    const moneyFields = ["price", "action_price", "max_action_price", "alert_max_action_price", "marketplace_seller_price", "price_min_elastic", "price_max_elastic", "min_seller_price"];
    return { result: { ...data, products: data.products.map(row => {
      const product = { ...row, currency: row.currency || row.action_price?.currency || row.price?.currency || "" };
      for (const key of moneyFields) if (row[key] && typeof row[key] === "object") product[key] = Number(row[key].amount);
      return product;
    }) }, apiVersion: "v2" };
  }
}

function unifiedExitPrice(row, previousPrice = null) {
  const threshold = row.max_action_price;
  const currency = String(threshold?.currency || "").trim();
  const amount = String(threshold?.amount ?? "");
  if (!/^[A-Z]{3}$/.test(currency) || !/^\d{1,12}(?:\.\d{1,2})?$/.test(amount)) {
    throw statusError("Ozon 未提供可核实的活动限价或币种，已停止自动调价退出，请在 Ozon 后台核对", 409);
  }
  if (!row.action_price || typeof row.action_price !== "object") throw statusError("Ozon 未提供当前活动限价，无法确认不会降低原限价，已停止自动退出", 409);
  const units = value => {
    const text = String(value?.amount ?? "");
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text) || value?.currency !== currency) throw statusError("Ozon 活动价格精度或币种不完整，已停止自动调价退出", 409);
    const [whole, decimal = ""] = text.split(".");
    return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0"));
  };
  let cents = units(threshold) + 1n;
  // Raising an exit threshold must never lower a previously set threshold.
  for (const value of [row.action_price, row.min_seller_price, previousPrice]) {
    if (value === null || value === undefined) continue;
    if (units(value) > cents) cents = units(value);
  }
  return { amount: `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`, currency };
}

async function assertCleanupStillEnabled(shop) {
  const config = await getOzonActionCleanupConfigMysql({ storeId: shop.id });
  if (!config.enabled) throw statusError("店铺自动退出已关闭，本次扫描已停止", 409);
}

async function deleteOfficialActionProducts(shop, actionId, productIds, signal, { action = {}, scan, manualProductIds = new Set(), refreshBeforePriceWrite, writtenPrices = new Map() } = {}) {
  const rows = Array.isArray(productIds)
    ? productIds.map(Number).filter((item) => Number.isFinite(item) && item > 0)
    : [];
  const targetIds = new Set(rows);
  let remainingIds = rows;
  let submittedCount = 0;
  let pageCount = 0;
  let scannedCount = 0;
  let lateDetectedCount = 0;
  const blockedIds = new Set();
  let currentProducts = new Map((scan?.products || []).map(row => [Number(row.product_id ?? row.id), row]));
  for (const verifyDelayMs of ACTION_DELETE_VERIFY_DELAYS_MS) {
    for (let index = 0; index < remainingIds.length; index += ACTION_DELETE_BATCH_LIMIT) {
      let batch = remainingIds.slice(index, index + ACTION_DELETE_BATCH_LIMIT);
      if (!batch.length) continue;
      await assertCleanupStillEnabled(shop);
      if (shop.promotionApiMode !== "unified") {
        try {
          await ozonRequest("/v1/actions/products/deactivate", { payload: { action_id: Number(actionId), product_ids: batch }, shop, signal });
        } catch (error) {
          if (!isUnifiedPriceError(error)) throw error;
          // A rollout between scan and delete requires a fresh complete scan;
          // do not change a price using incomplete legacy price/identity data.
          throw statusError("Ozon 已切换新版活动规则，请重新扫描后执行退出", 409);
        }
      } else if (action.isVoucher) {
        const result = await ozonRequest("/v2/actions/products/deactivate", { payload: { action_id: Number(actionId), product_ids: batch.map(String) }, shop, signal });
        if (!Array.isArray(result.product_ids)) throw statusError("Ozon 退出活动回执格式异常，请重新扫描核对", 502);
      } else {
        if (!["ELASTIC_BOOSTING", "STOCK_DISCOUNT"].includes(action.actionType)) throw statusError("该活动类型不支持安全自动退出，请在 Ozon 后台核对", 409);
        const refreshed = await refreshBeforePriceWrite();
        manualProductIds = refreshed.manualProductIds;
        currentProducts = new Map((refreshed.scans.get(Number(actionId))?.products || []).map(row => [Number(row.product_id ?? row.id), row]));
        batch = batch.filter(id => currentProducts.has(id));
        if (!batch.length) continue;
        const blocked = batch.filter(id => manualProductIds.has(id));
        for (const id of blocked) blockedIds.add(id);
        batch = batch.filter(id => !manualProductIds.has(id));
        if (!batch.length) continue;
        const products = batch.map(product_id => {
          const row = currentProducts.get(product_id);
          if (!row || String(row.add_mode).toUpperCase() !== "AUTO") throw statusError("未能核实商品仍为自动加入，已停止调价退出", 409);
          return { product_id, action_price: unifiedExitPrice(row, writtenPrices.get(product_id)) };
        });
        await assertCleanupStillEnabled(shop);
        // Even an unknown response may already have applied the shared price.
        // Retain the attempted floor for every later activity in this sweep.
        for (const product of products) writtenPrices.set(product.product_id, product.action_price);
        const result = await ozonRequest("/v1/actions/products/update", { payload: { action_id: Number(actionId), products }, shop, signal });
        const deactivated = new Set((result.deactivated_product_ids || []).map(Number));
        if (batch.some(id => !deactivated.has(id))) throw statusError("Ozon 未确认全部商品已退出，已停止并等待重新扫描核对", 502);
      }
      submittedCount += batch.length;
      await sleep(180);
    }
    if (remainingIds.length && remainingIds.every(id => blockedIds.has(id))) break;
    await sleep(verifyDelayMs);
    const scan = await fetchAllJoinedActionProductIds(shop, actionId, signal);
    currentProducts = new Map(scan.products.map(row => [Number(row.product_id ?? row.id), row]));
    pageCount += scan.pageCount;
    scannedCount += scan.scannedCount;
    const newlyDetectedIds = scan.productIds.filter((productId) => !targetIds.has(productId));
    lateDetectedCount += newlyDetectedIds.length;
    newlyDetectedIds.forEach((productId) => targetIds.add(productId));
    remainingIds = scan.productIds;
    if (!remainingIds.length || remainingIds.every(id => blockedIds.has(id))) break;
  }
  return {
    submittedCount,
    removedCount: targetIds.size - remainingIds.length,
    remainingIds,
    pageCount,
    scannedCount,
    lateDetectedCount,
    blockedCount: blockedIds.size
  };
}

function autoAddedProductIds(rows) {
  return rows.filter(row => {
    const flags = [row.add_mode, row.is_manually_added].filter(value => value !== undefined);
    return flags.length > 0 && flags.every(value => value === false);
  }).map(row => Number(row.product_id ?? row.id)).filter(id => Number.isSafeInteger(id) && id > 0);
}

async function scanAutoAddProducts(shop, actionId, autoAddDate, signal) {
  const products = new Map();
  let offset = 0;
  let pageCount = 0;
  let scannedCount = 0;
  let total;
  const seenProductIds = new Set();
  while (pageCount < ACTION_PRODUCTS_MAX_PAGES) {
    const data = await ozonRequest("/v2/actions/auto-add/products/list", { payload: { action_id: Number(actionId), auto_add_date: autoAddDate, limit: ACTION_PRODUCTS_PAGE_LIMIT, offset }, shop, signal });
    if (!Array.isArray(data.products) || data.total === null || data.total === "" || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0) throw statusError("Ozon 自动加入名单或分页数量异常，未执行退出", 502);
    total = Number(data.total);
    pageCount += 1;
    scannedCount += data.products.length;
    const automatic = new Set(autoAddedProductIds(data.products));
    for (const row of data.products) {
      const id = Number(row.product_id ?? row.id);
      if (!Number.isSafeInteger(id) || id <= 0 || seenProductIds.has(id)) throw statusError("Ozon 自动加入名单商品标识或分页重复异常，未执行退出", 502);
      seenProductIds.add(id);
      if (automatic.has(id)) products.set(id, row);
    }
    offset += data.products.length;
    if (offset >= total) return { productIds: [...products.keys()], products: [...products.values()], pageCount, scannedCount };
    if (!data.products.length) throw statusError("Ozon 自动加入名单提前结束，未执行退出", 502);
    await sleep(180);
  }
  throw statusError(`活动 ${actionId} 自动加入名单分页超过 ${ACTION_PRODUCTS_MAX_PAGES} 页，未执行退出`, 502);
}

async function cleanupScheduledAutoAdd(shop, action, autoAddDate, signal) {
  const scan = await scanAutoAddProducts(shop, action.actionId, autoAddDate, signal);
  let remaining = scan.productIds;
  const targets = new Set(remaining);
  let pageCount = scan.pageCount;
  let scannedCount = scan.scannedCount;
  for (const delay of ACTION_DELETE_VERIFY_DELAYS_MS) {
    if (!remaining.length) break;
    for (let offset = 0; offset < remaining.length; offset += ACTION_DELETE_BATCH_LIMIT) {
      await assertCleanupStillEnabled(shop);
      const batch = remaining.slice(offset, offset + ACTION_DELETE_BATCH_LIMIT);
      const result = await ozonRequest("/v2/actions/auto-add/products/delete", { payload: { action_id: action.actionId, auto_add_date: autoAddDate, product_ids: batch.map(String) }, shop, signal });
      if (!Array.isArray(result.product_ids)) throw statusError("Ozon 自动加入退出回执格式异常，请重新扫描核对", 502);
    }
    await sleep(delay);
    const verified = await scanAutoAddProducts(shop, action.actionId, autoAddDate, signal);
    pageCount += verified.pageCount;
    scannedCount += verified.scannedCount;
    remaining = verified.productIds;
    for (const id of remaining) targets.add(id);
  }
  const error = remaining.length ? `复查仍有 ${remaining.length} 个商品将自动加入活动` : "";
  return { actionId: action.actionId, autoAddDate, scope: "scheduled_auto_add", detectedCount: scan.productIds.length, removedCount: targets.size - remaining.length, remainingCount: remaining.length, pageCount, scannedCount, verified: !error, ...(error ? { error } : {}) };
}

async function fetchCurrentOfficialActionSummaries(shop, signal) {
  const data = await ozonRequest("/v1/actions", { method: "GET", shop, signal });
  if (![data, data?.result, data?.result?.actions, data?.actions].some(Array.isArray)) {
    throw statusError("Ozon 活动目录响应缺少有效活动列表，未能完成扫描", 502);
  }
  return extractOfficialActionSummaries(data);
}

function isOzonActionNotFoundError(error) {
  return /resource not found/i.test(String(error?.message || error || ""));
}

export async function listOzonActionCleanupConfigsMysql(options = {}) {
  const scope = options.discovery === ACTION_CLEANUP_DISCOVERY ? null : await actionTenantScope();
  await ensureSettingsTables();
  const settingRows = await mysqlQuery(
    "SELECT `key`, value_json FROM system_settings WHERE `key` LIKE ?",
    [`${ACTION_CLEANUP_SETTING_PREFIX}%`]
  );
  const settingsByStore = new Map();
  for (const row of settingRows) {
    const key = String(row?.key || "");
    const storeId = key.startsWith(ACTION_CLEANUP_SETTING_PREFIX) ? key.slice(ACTION_CLEANUP_SETTING_PREFIX.length) : "";
    if (storeId) settingsByStore.set(storeId, row?.value_json);
  }

  const shopRows = await mysqlQuery(`
    SELECT id, name
    FROM shops
    WHERE status = 'active'
      ${scope ? `AND ${inventoryTenantSql(scope, "shops")}` : ""}
      AND COALESCE(NULLIF(TRIM(ozon_client_id), ''), '') <> ''
      AND COALESCE(NULLIF(TRIM(ozon_api_key), ''), NULLIF(TRIM(api_key_hint), ''), '') <> ''
    ORDER BY id
  `);
  return Promise.all(shopRows.map(async (shop) => {
    const storeId = String(shop.id || "").trim();
    const config = {
      ...normalizeCleanupConfig(storeId, settingsByStore.get(storeId)),
      storeName: shop.name || ""
    };
    return scope ? cleanupConfigStatus(config, scope) : config;
  }));
}

export async function runOzonActionCleanupForStoreMysql(storeId, config = null, options = {}) {
  if (needsAiTenantSession(options.session)) {
    let session = options.session;
    if (!session) {
      await ensureSettingsTables();
      const stored = await mysqlQuery("SELECT value_json FROM system_settings WHERE `key` = ? LIMIT 1", [settingKey(storeId)]);
      const principal = normalizeCleanupConfig(storeId, stored[0]?.value_json);
      try {
        session = await restoreBusinessTaskSession(principal.tenant_key, principal.created_by_person_id);
        assertBusinessTaskPermission(session, "operations");
      } catch (error) {
        // Preserve the original identity; recording a failure must never grant one.
        if (stored[0]?.value_json) await mysqlExecute(`
          UPDATE system_settings SET value_json = JSON_MERGE_PATCH(value_json, CAST(? AS JSON)), updated_at = CURRENT_TIMESTAMP
          WHERE \`key\` = ? AND value_json = ?
        `, [JSON.stringify({ lastAttemptAt: new Date().toISOString(), lastError: error.message }), settingKey(storeId), stored[0].value_json]).catch(() => {});
        throw error;
      }
    }
    return withAiTenantSession(session, () => runOzonActionCleanupForStoreMysql(storeId, config, { ...options, session }));
  }
  await readShop(storeId);
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
  let current = normalizeCleanupConfig(normalizedStoreId, config);
  try {
    current = await getOzonActionCleanupConfigMysql({ storeId: normalizedStoreId });
    if (current.enabled !== true && options.force !== true) {
      return { success: true, storeId: normalizedStoreId, count: 0, skippedDisabled: true };
    }

    const shop = await readShop(normalizedStoreId);
    current = { ...current, storeName: shop.name || "" };
    const actionSummaries = [];
    const errors = [];
    let removedCount = 0;
    let currentActions = [];
    let actionListSync = {
      syncedAt: now,
      actionCount: 0,
      actionIds: [],
      changed: false,
      error: ""
    };

    try {
      currentActions = await fetchCurrentOfficialActionSummaries(shop, options.signal);
      actionListSync = {
        ...actionListSync,
        actionCount: currentActions.length,
        actionIds: currentActions.map((item) => item.actionId),
        changed: officialActionCatalogChanged(current.lastSyncedActions || [], currentActions)
      };
      current.knownActions = mergeKnownActionCatalog(current.knownActions || [], currentActions, {
        now,
        seedActionIds: current.actionIds || []
      });
    } catch (error) {
      actionListSync = {
        ...actionListSync,
        error: error?.message || "action list sync failed"
      };
      errors.push(`actions list: ${actionListSync.error}`);
    }
    actionListSync.knownActionCount = normalizeKnownActionCatalog(current.knownActions || []).length;

    const cleanupActionIds = buildOfficialActionCleanupIds(currentActions, current.knownActions || current.actionIds || []);
    const scans = new Map();
    const scanErrors = new Map();
    const manualProductIds = new Set();
    const writtenPrices = new Map();
    const refreshBeforePriceWrite = async () => {
      const actions = await fetchCurrentOfficialActionSummaries(shop, options.signal);
      const refreshed = { scans: new Map(), manualProductIds: new Set() };
      for (const id of buildOfficialActionCleanupIds(actions, current.knownActions || [])) {
        try {
          const scan = await fetchAllJoinedActionProductIds(shop, id, options.signal);
          refreshed.scans.set(id, scan);
          for (const productId of scan.manualProductIds) refreshed.manualProductIds.add(productId);
        } catch (error) { if (!isOzonActionNotFoundError(error)) throw error; }
      }
      return refreshed;
    };
    // Complete the read phase before a shared-price write, so products manually
    // enrolled in another promotion can be protected across the whole shop.
    for (const actionId of cleanupActionIds) {
      try {
        const scan = await fetchAllJoinedActionProductIds(shop, actionId, options.signal);
        scans.set(actionId, scan);
        for (const id of scan.manualProductIds) manualProductIds.add(id);
      } catch (error) { scanErrors.set(actionId, error); }
    }
    for (const actionId of cleanupActionIds) {
      try {
        if (scanErrors.has(actionId)) throw scanErrors.get(actionId);
        const scan = scans.get(actionId);
        const productIds = scan.productIds;
        current.knownActions = recordKnownActionCheck(current.knownActions || [], actionId, { unavailable: false }, { now });
        if (!productIds.length) {
          actionSummaries.push({ actionId, detectedCount: 0, removedCount: 0, skippedManualOnly: true, pageCount: scan.pageCount, scannedCount: scan.scannedCount, ...(scan.totalMismatch ? { reportedTotal: scan.reportedTotal, totalMismatch: true, paginationWarning: scan.paginationWarning } : {}) });
          continue;
        }
        const action = currentActions.find(item => item.actionId === actionId) || current.knownActions.find(item => item.actionId === actionId) || {};
        if (shop.promotionApiMode === "unified" && !action.isVoucher && (actionListSync.error || [...scanErrors.values()].some(error => !isOzonActionNotFoundError(error)))) {
          throw statusError("尚未完整核实本店所有手动活动，已停止统一限价退出，避免影响手动报名", 409);
        }
        const deletion = await deleteOfficialActionProducts(shop, actionId, productIds, options.signal, { action, scan, manualProductIds, refreshBeforePriceWrite, writtenPrices });
        removedCount += deletion.removedCount;
        if (deletion.remainingIds.length) {
          const message = deletion.blockedCount
            ? `${deletion.blockedCount} 个商品同时参加其他手动活动，已保留；复查仍有 ${deletion.remainingIds.length} 个自动加入商品未退出`
            : `删除后复查仍有 ${deletion.remainingIds.length} 个自动加入商品留在活动中`;
          errors.push(`活动 ${actionId}: ${message}`);
          actionSummaries.push({
            actionId,
            detectedCount: productIds.length,
            removedCount: deletion.removedCount,
            remainingCount: deletion.remainingIds.length,
            blockedCount: deletion.blockedCount,
            ...(scan.totalMismatch ? { reportedTotal: scan.reportedTotal, totalMismatch: true, paginationWarning: scan.paginationWarning } : {}),
            pageCount: scan.pageCount + deletion.pageCount,
            scannedCount: scan.scannedCount + deletion.scannedCount,
            lateDetectedCount: deletion.lateDetectedCount,
            error: message
          });
          continue;
        }
        actionSummaries.push({
          actionId,
          detectedCount: productIds.length,
          removedCount: deletion.removedCount,
          remainingCount: 0,
          pageCount: scan.pageCount + deletion.pageCount,
          scannedCount: scan.scannedCount + deletion.scannedCount,
          lateDetectedCount: deletion.lateDetectedCount,
          verified: true,
          ...(scan.totalMismatch ? { reportedTotal: scan.reportedTotal, totalMismatch: true, paginationWarning: scan.paginationWarning } : {})
        });
      } catch (error) {
        const message = error?.message || "unknown";
        if (isOzonActionNotFoundError(error)) {
          current.knownActions = recordKnownActionCheck(current.knownActions || [], actionId, { unavailable: true }, { now });
          actionSummaries.push({ actionId, detectedCount: 0, removedCount: 0, skippedUnavailable: true, error: message });
          continue;
        }
        errors.push(`活动 ${actionId}: ${message}`);
        const detectedCount = scans.get(actionId)?.productIds.length || 0;
        actionSummaries.push({ actionId, detectedCount, removedCount: 0, remainingCount: detectedCount, ...(error.blockedCount ? { blockedCount: error.blockedCount } : {}), error: message });
      }
    }

    for (const action of currentActions) {
      for (const date of action.autoAddDates) {
        if (Date.parse(date) <= Date.now()) continue;
        try {
          const summary = await cleanupScheduledAutoAdd(shop, action, date, options.signal);
          actionSummaries.push(summary);
          removedCount += summary.removedCount;
          if (summary.error) errors.push(`活动 ${action.actionId} 自动加入: ${summary.error}`);
        } catch (error) {
          const message = error.message || "自动加入清理失败";
          errors.push(`活动 ${action.actionId} 自动加入: ${message}`);
          actionSummaries.push({ actionId: action.actionId, autoAddDate: date, scope: "scheduled_auto_add", detectedCount: 0, removedCount: 0, error: message });
        }
      }
    }

    const lastError = errors.join("；");
    const knownActions = normalizeKnownActionCatalog(current.knownActions || []);
    actionListSync.knownActionCount = knownActions.length;
    actionListSync.knownActionIds = knownActions.map((item) => item.actionId);
    const saved = await persistCleanupConfig(normalizedStoreId, {
      ...current,
      enabled: current.enabled,
      actionIds: current.actionIds,
      knownActions: current.knownActions,
      lastSyncedActions: currentActions.length ? currentActions : current.lastSyncedActions,
      lastActionListSyncedAt: actionListSync.error ? current.lastActionListSyncedAt : now,
      lastActionListChangedAt: actionListSync.changed ? now : current.lastActionListChangedAt,
      lastRunAt: now,
      lastAttemptAt: now,
      lastResult: { removedCount, actionSummaries, actionListSync },
      lastError
    }, { runResultOnly: true });
    return {
      success: errors.length === 0,
      storeId: normalizedStoreId,
      storeName: shop.name || normalizedStoreId,
      count: removedCount,
      actionSummaries,
      actionListSync,
      config: { ...saved, taskRunning: false },
      ...(lastError ? { error: lastError } : {})
    };
  } catch (error) {
    await persistCleanupConfig(normalizedStoreId, {
      ...current,
      lastRunAt: now,
      lastAttemptAt: now,
      lastResult: { removedCount: 0, actionSummaries: [] },
      lastError: error?.message || "自动删除任务执行失败"
    }, { runResultOnly: true }).catch(() => {});
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
  if (options.session && needsAiTenantSession(options.session)) return withAiTenantSession(options.session, () => runEnabledOzonActionCleanupMysql(options));
  if (enabledCleanupSweepRunning) return [];
  enabledCleanupSweepRunning = true;
  try {
    const configs = await listOzonActionCleanupConfigsMysql(currentAiTenantSession() ? {} : { discovery: ACTION_CLEANUP_DISCOVERY });
    const enabledConfigs = configs.filter((item) => item.enabled === true);
    const results = [];
    for (const config of enabledConfigs) {
      try { results.push(await runOzonActionCleanupForStoreMysql(config.storeId, config, options)); }
      catch (error) { results.push({ success: false, storeId: config.storeId, storeName: config.storeName, count: 0, error: error.message }); }
    }
    return results;
  } finally {
    enabledCleanupSweepRunning = false;
  }
}

// An explicit enterprise request may renew execution identity; the unattended
// scheduler must only restore identities that were saved by an authorized user.
export async function runOzonActionCleanupForTenantMysql(body = {}, session = null, { waitForCompletion = false } = {}) {
  if (needsAiTenantSession(session)) return withAiTenantSession(session, () => runOzonActionCleanupForTenantMysql(body, session, { waitForCompletion }));
  const scope = await actionTenantScope();
  const tenantKey = businessTaskTenantKey(scope.session);
  if (tenantCleanupRuns.has(tenantKey)) {
    if (waitForCompletion) return tenantCleanupRuns.get(tenantKey);
    return { success: true, status: "running", configs: await listOzonActionCleanupConfigsMysql(), results: [], failed: 0, count: 0 };
  }
  if (tenantCleanupPreparing.has(tenantKey)) throw statusError("本企业正在保存扫描授权，请稍后刷新查看", 409);
  tenantCleanupPreparing.add(tenantKey);
  try {
  const configs = (await listOzonActionCleanupConfigsMysql()).filter(config => config.enabled);
  for (const config of configs) await persistCleanupConfig(config.storeId, config);
  if (!configs.length) return { success: true, status: "completed", configs: await listOzonActionCleanupConfigsMysql(), results: [], failed: 0, count: 0 };
  for (const config of configs) cleanupQueuedStores.add(config.storeId);
  const execution = (async () => {
    const results = [];
    try {
      for (const config of configs) {
        try {
          results.push(await runOzonActionCleanupForStoreMysql(config.storeId, null, { session: scope.session }));
        } catch (error) {
          results.push({ success: false, storeId: config.storeId, storeName: config.storeName, count: 0, error: error.message });
        } finally {
          cleanupQueuedStores.delete(config.storeId);
        }
      }
      const failed = results.filter(result => result.success === false).length;
      return { success: failed === 0, status: "completed", results, failed, count: results.reduce((sum, result) => sum + Number(result.count || 0), 0), configs: await listOzonActionCleanupConfigsMysql() };
    } finally {
      for (const config of configs) cleanupQueuedStores.delete(config.storeId);
      tenantCleanupRuns.delete(tenantKey);
    }
  })();
  tenantCleanupRuns.set(tenantKey, execution);
  if (waitForCompletion) return execution;
  execution.catch(error => console.error("Ozon enterprise cleanup failed:", error.message));
  return { success: true, status: "running", configs: await listOzonActionCleanupConfigsMysql(), results: [], failed: 0, count: 0 };
  } finally { tenantCleanupPreparing.delete(tenantKey); }
}

export async function saveOzonActionCleanupConfigMysql(body = {}, session = null) {
  if (needsAiTenantSession(session)) return withAiTenantSession(session, () => saveOzonActionCleanupConfigMysql(body, session));
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
