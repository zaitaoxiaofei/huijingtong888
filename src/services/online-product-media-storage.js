import { archiveRemoteMediaObjectUrl, isManagedOssObjectUrl } from "./object-storage.js";

const MEDIA_FIELD_PATTERN = /(?:^|_)(?:image|images|picture|pictures|photo|photos|video|videos|media)(?:_|$)/i;
const SOURCE_ASSET_CACHE_LIMIT = 500;

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function uniqueUrls(value) {
  const parsed = parseJson(value, []);
  const list = Array.isArray(parsed) ? parsed : [];
  return [...new Set(list.map((item) => String(item?.url || item || "").trim()).filter(Boolean))];
}

function removeDuplicateMediaFields(value) {
  if (Array.isArray(value)) return value.map(removeDuplicateMediaFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !MEDIA_FIELD_PATTERN.test(key))
    .map(([key, child]) => [key, removeDuplicateMediaFields(child)]));
}

export function compactOnlineProductRawJson(value) {
  const parsed = parseJson(value, null);
  if (!parsed || typeof parsed !== "object") return "";
  return JSON.stringify(removeDuplicateMediaFields(parsed));
}

export async function prepareOnlineProductMediaForStorage(item = {}, options = {}) {
  const sourceUrls = uniqueUrls(item.images_json);
  const primarySource = String(item.primary_image || item.image_url || sourceUrls[0] || "").trim();
  const allSources = [...new Set([primarySource, ...sourceUrls].filter(Boolean))];
  const previousRaw = parseJson(options.previousItem?.raw_json, {});
  const previousAssets = new Map((Array.isArray(previousRaw?._erp_source_assets) ? previousRaw._erp_source_assets : [])
    .filter(asset => typeof asset?.source_url === "string" && typeof asset?.stored_url === "string"
      && isManagedOssObjectUrl(asset.stored_url, { env: options.env }))
    .map(asset => [asset.source_url, asset.stored_url]));
  const cache = options.cache instanceof Map ? options.cache : null;
  const archivedBySource = new Map();
  const archiveSource = async sourceUrl => {
    let accessError;
    const assertAccess = async () => {
      try {
        options.signal?.throwIfAborted();
        if (options.beforeRequest) await options.beforeRequest();
        options.signal?.throwIfAborted();
      } catch (error) { accessError = error; throw error; }
    };
    await assertAccess();
    const remember = value => {
      if (!cache) return;
      while (cache.size >= SOURCE_ASSET_CACHE_LIMIT && !cache.has(sourceUrl)) cache.delete(cache.keys().next().value);
      cache.set(sourceUrl, value);
    };
    try {
      let archivedUrl = previousAssets.get(sourceUrl);
      if (!archivedUrl) {
        const cached = cache?.get(sourceUrl);
        if (cached) archivedUrl = await cached;
        if (!isManagedOssObjectUrl(archivedUrl, { env: options.env })) {
          const pending = archiveRemoteMediaObjectUrl(sourceUrl, {
            ...options,
            beforeRequest: assertAccess,
            prefix: options.prefix || "product-media",
            maxBytes: options.maxBytes || 20 * 1024 * 1024
          });
          remember(pending);
          try { archivedUrl = await pending; }
          finally { if (cache?.get(sourceUrl) === pending) cache.delete(sourceUrl); }
        }
      }
      await assertAccess();
      if (isManagedOssObjectUrl(archivedUrl, { env: options.env })) remember(archivedUrl);
      archivedBySource.set(sourceUrl, archivedUrl || sourceUrl);
    } catch (error) {
      if (accessError || options.signal?.aborted) throw accessError || options.signal?.reason || error;
      await assertAccess();
      // Ozon's CDN can reject archival downloads even though the seller image URL
      // remains usable. Media archival must not abort the whole product sync.
      archivedBySource.set(sourceUrl, sourceUrl);
    }
  };
  let sourceIndex = 0;
  await Promise.all(Array.from({ length: Math.min(3, allSources.length) }, async () => {
    while (sourceIndex < allSources.length) await archiveSource(allSources[sourceIndex++]);
  }));
  const primaryImage = primarySource ? archivedBySource.get(primarySource) || "" : "";
  const images = allSources.map((sourceUrl) => archivedBySource.get(sourceUrl) || "").filter(Boolean);
  const sourceAssets = allSources.map(sourceUrl => ({ source_url: sourceUrl, stored_url: archivedBySource.get(sourceUrl) }))
    .filter(asset => asset.source_url !== asset.stored_url && isManagedOssObjectUrl(asset.stored_url, { env: options.env }));
  let rawJson = compactOnlineProductRawJson(item.raw_json);
  const raw = parseJson(rawJson, null);
  if (raw && !Array.isArray(raw)) {
    // Only the server's previousItem and successful archival may supply this
    // cache. Incoming seller/client metadata must never redirect image reuse.
    delete raw._erp_source_assets;
    if (sourceAssets.length) raw._erp_source_assets = sourceAssets;
    rawJson = JSON.stringify(raw);
  } else if (sourceAssets.length) rawJson = JSON.stringify({ _erp_source_assets: sourceAssets });
  return {
    ...item,
    image_url: primaryImage,
    primary_image: primaryImage,
    images_json: JSON.stringify(images),
    raw_json: rawJson
  };
}
