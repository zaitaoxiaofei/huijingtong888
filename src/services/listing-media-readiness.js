const IMAGE_PATH_PATTERN = /\.(?:avif|jpe?g|png|webp)(?:$|[?#])/i;

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

export async function downloadRemoteImageForOzon(url, {
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
      error: error?.name === "TimeoutError" ? "timeout" : (error?.message || String(error)),
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
  waitImpl = wait
} = {}) {
  const uniqueUrls = [...new Set(urls.map((url) => String(url || "").trim()).filter(Boolean))];
  const maxAttempts = Math.max(1, Number(attempts || 1));
  const requiredSuccesses = Math.max(1, Math.min(Number(requiredConsecutiveSuccesses || 1), maxAttempts));
  const results = await mapWithConcurrency(uniqueUrls, concurrency, async (url) => {
    let consecutiveSuccesses = 0;
    let lastResult = { ok: false, url, error: "not_checked" };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      lastResult = await downloadRemoteImageForOzon(url, { fetchImpl, timeoutMs });
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
