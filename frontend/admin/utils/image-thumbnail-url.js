const PUBLIC_IMAGE_PATH = /^\/(?:listing-media|product-media|collector-media|ai-unused|video-source)\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/i;
const OSS_PUBLIC_HOST = /^[a-z0-9][a-z0-9-]*\.oss-[a-z0-9-]+\.aliyuncs\.com$/i;
const thumbnailWidths = new Set([128, 180, 256, 360]);
const browserOrigin = () => globalThis.window?.location?.origin || globalThis.location?.origin || "http://localhost";

// Display-only derivatives. These URLs must never replace saved or published media.
export function publicImageThumbnailUrl(value, { width = 180, origin = browserOrigin() } = {}) {
  try {
    let url = new URL(String(value || ""), origin);
    if (url.origin === origin && url.pathname === "/api/image-proxy" && url.searchParams.get("require_original") !== "1") {
      url = new URL(url.searchParams.get("url") || "");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
      || !OSS_PUBLIC_HOST.test(url.hostname) || url.hostname.includes("-internal.") || !PUBLIC_IMAGE_PATH.test(url.pathname)
      || !thumbnailWidths.has(width)) return "";
    return `/api/image-thumbnail?${new URLSearchParams({ url: url.href, w: String(width) })}`;
  } catch { return ""; }
}

export function productThumbnailUrl(value, { origin = browserOrigin() } = {}) {
  try {
    const url = new URL(String(value || ""), origin);
    if (url.origin === origin && /^\/api\/products\/\d+\/image$/.test(url.pathname) && url.searchParams.get("thumb") === "1") {
      url.searchParams.delete("token");
      return url.pathname + url.search;
    }
    return publicImageThumbnailUrl(value, { origin });
  } catch { return ""; }
}

export function originalProductImageUrl(value, { origin = browserOrigin() } = {}) {
  try {
    const url = new URL(String(value || ""), origin);
    if (url.origin === origin && /^\/api\/products\/\d+\/image$/.test(url.pathname) && url.searchParams.get("thumb") === "1") {
      url.searchParams.delete("thumb");
      url.searchParams.delete("w");
      return url.pathname + url.search;
    }
  } catch { /* Keep the original preview input's existing normalizer behavior. */ }
  return value;
}
