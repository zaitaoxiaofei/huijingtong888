import { archiveRemoteMediaObjectUrl } from "./object-storage.js";

const MEDIA_FIELD_PATTERN = /(?:^|_)(?:image|images|picture|pictures|photo|photos|video|videos|media)(?:_|$)/i;

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
  const archivedBySource = new Map();
  await Promise.all(allSources.map(async (sourceUrl) => {
    try {
      const archivedUrl = await archiveRemoteMediaObjectUrl(sourceUrl, {
        ...options,
        prefix: options.prefix || "product-media",
        maxBytes: options.maxBytes || 20 * 1024 * 1024
      });
      archivedBySource.set(sourceUrl, archivedUrl || sourceUrl);
    } catch {
      // Ozon's CDN can reject archival downloads even though the seller image URL
      // remains usable. Media archival must not abort the whole product sync.
      archivedBySource.set(sourceUrl, sourceUrl);
    }
  }));
  const primaryImage = primarySource ? archivedBySource.get(primarySource) || "" : "";
  const images = allSources.map((sourceUrl) => archivedBySource.get(sourceUrl) || "").filter(Boolean);
  return {
    ...item,
    image_url: primaryImage,
    primary_image: primaryImage,
    images_json: JSON.stringify(images),
    raw_json: compactOnlineProductRawJson(item.raw_json)
  };
}
