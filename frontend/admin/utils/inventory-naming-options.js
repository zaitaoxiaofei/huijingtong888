import { apiClient } from "./api.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const responseCache = new Map();
const inflightRequests = new Map();

function cachedRequest(key, loader, { force = false } = {}) {
  const cached = responseCache.get(key);
  if (!force && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return Promise.resolve(cached.value);
  if (!force && inflightRequests.has(key)) return inflightRequests.get(key);
  const request = Promise.resolve().then(loader).then((value) => {
    responseCache.set(key, { timestamp: Date.now(), value });
    return value;
  }).finally(() => {
    if (inflightRequests.get(key) === request) inflightRequests.delete(key);
  });
  inflightRequests.set(key, request);
  return request;
}

export function loadInventoryNamingOptions(params, options = {}) {
  const query = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params || {}).toString();
  return cachedRequest(`naming:${query}`, async () => {
    const result = await apiClient.get(`/api/inventory-product-naming/options?${query}`, {
      noCache: true,
      routeScoped: false
    });
    return Array.isArray(result?.rows) ? result.rows : [];
  }, options);
}

export function loadInventoryVehicleCatalog(options = {}) {
  return cachedRequest("vehicle-catalog", async () => {
    const result = await apiClient.get("/api/ai-variant-lab/vehicle-catalog", {
      noCache: true,
      routeScoped: false
    });
    return Array.isArray(result?.brands) ? result.brands : [];
  }, options);
}

export function invalidateInventoryNamingOptions() {
  for (const key of responseCache.keys()) {
    if (key.startsWith("naming:")) responseCache.delete(key);
  }
}
