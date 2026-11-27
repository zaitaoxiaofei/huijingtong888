import { isManagedPublicImageSource } from "./server-image-request.js";

const IMAGE_PATH_PATTERN = /\.(?:avif|jpe?g|png|webp)(?:$|[?#])/i;
const PUBLIC_IMAGE_READINESS_TTL_MS = 5 * 60 * 1000;
const PUBLIC_IMAGE_READINESS_MAX_ENTRIES = 500;
const publicImageReadinessCache = new Map();
const publicImageReadinessInflight = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency || 1), items.length || 1));
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

export function isLikelyRemoteImageUrl(url = "") {
  return IMAGE_PATH_PATTERN.test(String(url || "").trim());
}

// This limit is shared by all shops, rather than two new full downloads per
// publish worker competing for the same ECS public connection.
let activeReadinessDownloads = 0;
const pendingReadinessDownloads = [];
async function withReadinessDownloadSlot(worker) {
  if (activeReadinessDownloads >= 2) await new Promise((resolve) => pendingReadinessDownloads.push(resolve));
  else activeReadinessDownloads += 1;
  try {
    return await worker();
  } finally {
    const next = pendingReadinessDownloads.shift();
    if (next) next();
    else activeReadinessDownloads -= 1;
  }
}

export async function downloadRemoteImageForOzon(url, options = {}) {
  return withReadinessDownloadSlot(() => downloadRemoteImageForOzonOnce(url, options));
}

async function reusePublicImageReadiness(url, { env, now, policy }, verify) {
  // This shares only anonymous public-read evidence. Private, signed, transformed,
  // external and mutable URLs must perform their own complete public checks.
  if (!isManagedPublicImageSource(url, { env })) return verify();
  const key = JSON.stringify([url, ...policy]);
  const cached = publicImageReadinessCache.get(key);
  if (cached?.expiresAt > now()) {
    publicImageReadinessCache.delete(key);
    publicImageReadinessCache.set(key, cached);
    return { ...cached.result };
  }
  if (cached) publicImageReadinessCache.delete(key);
  const pending = publicImageReadinessInflight.get(key);
  if (pending) return { ...await pending };

  const verification = (async () => {
    const result = await verify();
    if (result.ok && result.status === 200 && result.contentType?.startsWith("image/") && result.downloadedBytes > 0
      && result.responseUrl === new URL(url).href) {
      while (publicImageReadinessCache.size >= PUBLIC_IMAGE_READINESS_MAX_ENTRIES) {
        publicImageReadinessCache.delete(publicImageReadinessCache.keys().next().value);
      }
      publicImageReadinessCache.set(key, {
        expiresAt: now() + PUBLIC_IMAGE_READINESS_TTL_MS,
        result: { ...result }
      });
    }
    return result;
  })();
  // Bound retained promises as well as completed entries during large batches.
  if (publicImageReadinessInflight.size < PUBLIC_IMAGE_READINESS_MAX_ENTRIES) {
    publicImageReadinessInflight.set(key, verification);
  }
  try {
    return { ...await verification };
  } finally {
    if (publicImageReadinessInflight.get(key) === verification) publicImageReadinessInflight.delete(key);
  }
}

async function downloadRemoteImageForOzonOnce(url, {
  fetchImpl = fetch,
  timeoutMs = 30000
} = {}) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
        "User-Agent": "OzonMediaReadiness/1.0"
      },
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs || 30000)))
    });
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => null);
      return {
        ok: false,
        url,
        status: response.status,
        error: `http_${response.status}`,
        elapsedMs: Date.now() - startedAt
      };
    }
    if (contentType && !contentType.startsWith("image/")) {
      await response.body?.cancel?.().catch(() => null);
      return {
        ok: false,
        url,
        status: response.status,
        error: "invalid_content_type",
        contentType,
        elapsedMs: Date.now() - startedAt
      };
    }
    const body = await response.arrayBuffer();
    const downloadedBytes = body.byteLength;
    if (!downloadedBytes || (declaredBytes > 0 && downloadedBytes !== declaredBytes)) {
      return {
        ok: false,
        url,
        status: response.status,
        error: downloadedBytes ? "incomplete_body" : "empty_body",
        declaredBytes,
        downloadedBytes,
        elapsedMs: Date.now() - startedAt
      };
    }
    return {
      ok: true,
      url,
      responseUrl: response.url || "",
      status: response.status,
      contentType,
      declaredBytes,
      downloadedBytes,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: 0,
      error: /TimeoutError|AbortError/.test(error?.name || "") || error?.code === "ABORT_ERR" ? "timeout" : (error?.message || String(error)),
      elapsedMs: Date.now() - startedAt
    };
  }
}

export async function verifyRemoteImagesReadyForOzon(urls = [], {
  attempts = 3,
  requiredConsecutiveSuccesses = 2,
  retryDelayMs = 750,
  timeoutMs = 30000,
  concurrency = 2,
  fetchImpl = fetch,
  waitImpl = wait,
  beforeRequest,
  env = process.env,
  now = Date.now
} = {}) {
  const uniqueUrls = [...new Set(urls.map((url) => String(url || "").trim()).filter(Boolean))];
  const maxAttempts = Math.max(1, Number(attempts || 1));
  const requiredSuccesses = Math.max(1, Math.min(Number(requiredConsecutiveSuccesses || 1), maxAttempts));
  const results = await mapWithConcurrency(uniqueUrls, concurrency, async (url) => {
    let consecutiveSuccesses = 0;
    let lastResult = { ok: false, url, error: "not_checked" };
    const verify = async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await beforeRequest?.();
        lastResult = await downloadRemoteImageForOzon(url, { fetchImpl, timeoutMs });
        await beforeRequest?.();
        if (lastResult.ok) consecutiveSuccesses += 1;
        else consecutiveSuccesses = 0;
        if (consecutiveSuccesses >= requiredSuccesses) {
          return { ...lastResult, attempts: attempt, consecutiveSuccesses };
        }
        if (attempt < maxAttempts) {
          await waitImpl(Math.max(0, Number(retryDelayMs || 0)) * attempt);
        }
      }
      return { ...lastResult, ok: false, attempts: maxAttempts, consecutiveSuccesses };
    };
    try {
      // Every caller retains its own access checks, including cache hits and
      // callers waiting for another enterprise's anonymous public verification.
      await beforeRequest?.();
      const result = await reusePublicImageReadiness(url, {
        env, now, policy: [maxAttempts, requiredSuccesses, retryDelayMs, timeoutMs]
      }, verify);
      await beforeRequest?.();
      return result;
    } catch (error) {
      return { ok: false, url, status: 0, error: error?.message || String(error), consecutiveSuccesses };
    }
  });
  const failedResults = results.filter((result) => !result.ok);
  return {
    total: results.length,
    ok: results.length - failedResults.length,
    failed: failedResults.length,
    failedUrls: failedResults.map((result) => result.url),
    results
  };
}
