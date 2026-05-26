const DEFAULT_MASTER_DATA_CACHE_TTL_MS = 30_000;
const masterDataCache = new Map();

export function invalidateMasterDataCache(key = "") {
  if (key) {
    masterDataCache.delete(key);
    return;
  }
  masterDataCache.clear();
}

export function invalidateMasterDataCachePrefix(prefix = "") {
  const text = String(prefix || "");
  if (!text) return;
  for (const key of masterDataCache.keys()) {
    if (String(key).startsWith(text)) masterDataCache.delete(key);
  }
}

export function invalidateExceptionWorkbenchCache() {
  invalidateMasterDataCachePrefix("exception-workbench:");
}

export async function getCachedMasterData(key, loader, ttlMs = DEFAULT_MASTER_DATA_CACHE_TTL_MS) {
  const cached = masterDataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await loader();
  masterDataCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
  return value;
}
