import { reactive } from "vue";
import { apiClient, currentApiCacheScope } from "./api";

const SHOP_DICTIONARY_TTL_MS = 5 * 60 * 1000;

const state = reactive({
  rows: [],
  loading: false,
  loadedAt: 0
});

const cacheByTenant = new Map();
const inflightByTenant = new Map();
let listenerInstalled = false;
let activeScope = "";

function normalizeShop(row = {}) {
  return {
    ...row,
    id: row.id,
    name: String(row.name || `店铺 ${row.id}`),
    status: String(row.status || "active")
  };
}

function activeTenantCacheKey() {
  const scope = currentApiCacheScope();
  if (activeScope !== scope) {
    activeScope = scope;
    invalidateShopDictionary();
    state.rows = [];
    state.loading = false;
  }
  return scope;
}

function installShopChangeListener() {
  if (listenerInstalled || typeof window === "undefined") return;
  listenerInstalled = true;
  const markStale = () => {
    state.loadedAt = 0;
    cacheByTenant.clear();
    inflightByTenant.clear();
  };
  window.addEventListener("erp:shops-changed", markStale);
  window.addEventListener("erp:auth-scope-changed", activeTenantCacheKey);
  window.addEventListener("storage", (event) => {
    if (event.key === "erp:shops-changed") markStale();
    if (["authToken", "baodanAuthUser"].includes(event.key)) activeTenantCacheKey();
  });
}

export async function loadShopDictionary(options = {}) {
  installShopChangeListener();
  const force = Boolean(options.force);
  const tenantKey = activeTenantCacheKey();
  const cached = cacheByTenant.get(tenantKey);
  if (!force && cached && cached.rows.length > 0 && Date.now() - cached.loadedAt < SHOP_DICTIONARY_TTL_MS) {
    state.rows = cached.rows;
    state.loadedAt = cached.loadedAt;
    return cached.rows;
  }
  if (!force && inflightByTenant.has(tenantKey)) return inflightByTenant.get(tenantKey);
  state.loading = true;
  const inflight = apiClient.get("/api/shops", { noCache: true, cache: "no-store" }).then((rows) => {
    if (tenantKey !== activeTenantCacheKey() || inflightByTenant.get(tenantKey) !== inflight) {
      throw new DOMException("Authentication context changed", "AbortError");
    }
    const normalizedRows = Array.isArray(rows) ? rows.map(normalizeShop) : [];
    const loadedAt = Date.now();
    cacheByTenant.set(tenantKey, { rows: normalizedRows, loadedAt });
    state.rows = normalizedRows;
    state.loadedAt = loadedAt;
    return normalizedRows;
  }).finally(() => {
    if (inflightByTenant.get(tenantKey) === inflight) {
      inflightByTenant.delete(tenantKey);
      if (activeScope === tenantKey) state.loading = false;
    }
  });
  inflightByTenant.set(tenantKey, inflight);
  return inflight;
}

export function invalidateShopDictionary() {
  state.loadedAt = 0;
  cacheByTenant.clear();
  inflightByTenant.clear();
}

export function useShopDictionary() {
  installShopChangeListener();
  activeTenantCacheKey();
  return {
    state,
    load: loadShopDictionary,
    invalidate: invalidateShopDictionary
  };
}
