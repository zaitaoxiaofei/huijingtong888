import { requestPublicMedia } from "../http/public-image-request.js";
import { isManagedOssObjectUrl, readManagedOssObject } from "./object-storage.js";

const MAX_BYTES = 30 * 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isManagedListingSourceImage(url, { env = process.env } = {}) {
  if (!isManagedOssObjectUrl(url, { prefix: "listing-media", env })) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port
    && /^\/listing-media\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(parsed.pathname);
}

export function isTransientImageDownloadError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status >= 100) return [408, 425, 429, 500, 502, 503, 504].includes(status);
  return /abort|timeout|timed out|econnreset|econnrefused|etimedout|eai_again|enotfound|epipe|socket|incomplete|premature|requesterror/i.test(
    `${error?.name || ""} ${error?.code || ""} ${error?.message || ""}`
  );
}

// Only known bucket URLs reach the authenticated SDK. Arbitrary external URLs
// always retain the public DNS, redirect and size checks.
export async function downloadListingSourceImage(url, {
  beforeRequest,
  internal = process.env.OSS_INTERNAL_READ === "true",
  isManaged = isManagedListingSourceImage,
  readManaged = readManagedOssObject,
  request = requestPublicMedia,
  waitImpl = wait,
  onRetry = (event) => console.warn("[listing-image-download]", JSON.stringify(event))
} = {}) {
  const managed = isManaged(url);
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    await beforeRequest?.();
    const startedAt = Date.now();
    try {
      const timeoutMs = managed && internal && attempt === 1 ? 15000 : 45000;
      const response = managed
        ? await readManaged(url, { maxBytes: MAX_BYTES, timeoutMs, internal: internal && attempt === 1 })
        : await request(url, { maxBytes: MAX_BYTES, signal: AbortSignal.timeout(timeoutMs), beforeRequest });
      await beforeRequest?.();
      if (response?.ok === false) throw Object.assign(new Error(`Image HTTP ${response.status}`), { status: response.status });
      if (!response?.buffer?.length || !String(response.contentType || "").startsWith("image/")) {
        throw new Error("Image is empty, exceeds 30MB, or has an invalid content type");
      }
      const declared = Number(response.headers?.get?.("content-length") || 0);
      if (declared && declared !== response.buffer.length) throw new Error("Image download has an incomplete body");
      return { buffer: response.buffer, source: url };
    } catch (error) {
      // Recheck outside retry classification: revoked authority is never retried.
      await beforeRequest?.();
      lastError = error;
      const transient = isTransientImageDownloadError(error);
      if (!transient || attempt === 3) break;
      onRetry({ attempt, route: managed ? (internal && attempt === 1 ? "oss_internal" : "oss_public") : "public",
        elapsed_ms: Date.now() - startedAt, code: error.code || error.status || error.name });
      await waitImpl(attempt * 1000);
    }
  }
  const parsed = new URL(url);
  const source = `${parsed.origin}${parsed.pathname}`;
  throw Object.assign(new Error(`商品原图读取失败：${source}；${lastError?.message || "下载失败"}。尚未提交 Ozon，请在草稿图片中检查该图后重试。`), {
    code: "LISTING_SOURCE_IMAGE_DOWNLOAD_FAILED", status: 422, attempts, cause: lastError
  });
}
