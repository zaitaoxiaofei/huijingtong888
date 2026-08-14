import { reactive } from "vue";
import { apiClient } from "./api";

const SHOP_DICTIONARY_TTL_MS = 5 * 60 * 1000;

const state = reactive({
  rows: [],
  loading: false,
  loadedAt: 0
});

let inflight = null;
let listenerInstalled = false;

function normalizeShop(row = {}) {
  return {
    ...row,
    id: row.id,
    name: String(row.name || `店铺 ${row.id}`),
    status: String(row.status || "active")
  };
}

function isFresh() {
  return state.rows.length > 0 && Date.now() - state.loadedAt < SHOP_DICTIONARY_TTL_MS;
}

function installShopChangeListener() {
  if (listenerInstalled || typeof window === "undefined") return;
  listenerInstalled = true;
  const markStale = () => {
    state.loadedAt = 0;
    inflight = null;
  };
  window.addEventListener("erp:shops-changed", markStale);
  window.addEventListener("storage", (event) => {
    if (event.key === "erp:shops-changed") markStale();
  });
}

export async function loadShopDictionary(options = {}) {
  installShopChangeListener();
  const force = Boolean(options.force);
  if (!force && isFresh()) return state.rows;
  if (!force && inflight) return inflight;
  state.loading = true;
  inflight = apiClient.get("/api/shops", force ? { noCache: true, cache: "no-store" } : {}).then((rows) => {
    state.rows = Array.isArray(rows) ? rows.map(normalizeShop) : [];
    state.loadedAt = Date.now();
    return state.rows;
  }).finally(() => {
    state.loading = false;
    inflight = null;
  });
  return inflight;
}

export function invalidateShopDictionary() {
  state.loadedAt = 0;
  inflight = null;
}

export function useShopDictionary() {
  installShopChangeListener();
  return {
    state,
    load: loadShopDictionary,
    invalidate: invalidateShopDictionary
  };
}
