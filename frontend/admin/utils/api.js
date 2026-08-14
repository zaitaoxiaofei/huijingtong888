import { beginApiPerf, endApiPerf } from "./performance-monitor.js";

const AUTH_TOKEN_KEY = "authToken";
const GET_CACHE_TTL_MS = 30000;
const PERSISTED_GET_CACHE_TTL_MS = 5 * 60 * 1000;
const PERSISTED_GET_CACHE_PREFIX = "erp:get-cache:";
const cachedGetPrefixes = [
  "/api/shops",
  "/api/people",
  "/api/suppliers",
  "/api/logistics-rules",
  "/api/db/seller-analytics/plugin-status",
  "/api/system/update-status"
];
let authRedirecting = false;
const getCache = new Map();
const getInflightCache = new Map();
const getInflightRequests = new Map();
let getCacheRevision = 0;
const routeScopedControllers = new Set();
const routeAbortedSignals = new WeakSet();
const GET_NETWORK_RETRY_DELAY_MS = 350;

function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function fetchWithSafeGetRetry(url, options = {}) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const isSafeGet = String(options.method || "GET").toUpperCase() === "GET";
    const isNetworkFailure = error?.name === "TypeError";
    if (!isSafeGet || !isNetworkFailure || options.signal?.aborted) throw error;
    await waitForRetry(GET_NETWORK_RETRY_DELAY_MS, options.signal);
    return await fetch(url, options);
  }
}

function currentRedirectPath() {
  const hash = String(window.location.hash || "");
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path.startsWith("/") && !path.startsWith("/login")) return path;
  return "/dashboard";
}

function notifyAuthExpired(message, url = "") {
  if (authRedirecting) return;
  authRedirecting = true;
  clearAuthToken();
  window.dispatchEvent(new CustomEvent("app:auth-expired", {
    detail: {
      message: message || "登录状态已失效，请重新登录",
      redirect: currentRedirectPath(),
      url: String(url || "")
    }
  }));
  window.setTimeout(() => {
    authRedirecting = false;
  }, 1500);
}

function abortRouteScopedRequests() {
  for (const controller of routeScopedControllers) {
    routeAbortedSignals.add(controller.signal);
    controller.abort();
  }
  routeScopedControllers.clear();
}

window.addEventListener("admin:route-changing", abortRouteScopedRequests);

function isCacheableGet(url, options = {}) {
  if (options.signal || options.noCache || options.cache === "no-store") return false;
  const path = String(url || "").split("?")[0];
  return cachedGetPrefixes.some((prefix) => path === prefix);
}

function readPersistedGetCache(key) {
  try {
    const cached = JSON.parse(window.sessionStorage?.getItem(`${PERSISTED_GET_CACHE_PREFIX}${key}`) || "null");
    if (!cached || cached.expiresAt <= Date.now()) return null;
    return cached.data;
  } catch {
    return null;
  }
}

function writePersistedGetCache(key, data) {
  try {
    window.sessionStorage?.setItem(`${PERSISTED_GET_CACHE_PREFIX}${key}`, JSON.stringify({
      data,
      expiresAt: Date.now() + PERSISTED_GET_CACHE_TTL_MS
    }));
  } catch {
    // Ignore storage quota or privacy-mode failures.
  }
}

function clearPersistedGetCacheForPrefix(prefix) {
  try {
    const storage = window.sessionStorage;
    if (!storage) return;
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(PERSISTED_GET_CACHE_PREFIX)) continue;
      const cachedUrl = key.slice(PERSISTED_GET_CACHE_PREFIX.length);
      const cachedPath = String(cachedUrl || "").split("?")[0];
      if (cachedPath === prefix || cachedPath.startsWith(`${prefix}/`)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // Ignore storage access failures.
  }
}

function clearGetCacheForMutation(url = "") {
  const path = String(url || "").split("?")[0];
  for (const prefix of cachedGetPrefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      getCacheRevision += 1;
      getCache.clear();
      getInflightCache.clear();
      clearPersistedGetCacheForPrefix(prefix);
      return;
    }
  }
}

function notifyGetCacheMutation(url = "") {
  const path = String(url || "").split("?")[0];
  if (path === "/api/shops" || path.startsWith("/api/shops/")) {
    window.dispatchEvent(new CustomEvent("erp:shops-changed"));
    try {
      window.localStorage?.setItem("erp:shops-changed", String(Date.now()));
    } catch {
      // Cross-tab refresh is best effort only.
    }
  }
}

function buildHeaders(customHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...customHeaders
  };
  const token = getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function recordForbiddenApi(url = "", error = null) {
  if (typeof window === "undefined") return;
  const item = {
    url: String(url || ""),
    status: 403,
    message: String(error?.message || error?.payload?.error || "Forbidden"),
    at: new Date().toISOString()
  };
  try {
    const list = Array.isArray(window.__ERP_FORBIDDEN__) ? window.__ERP_FORBIDDEN__ : [];
    list.push(item);
    window.__ERP_FORBIDDEN__ = list.slice(-50);
  } catch {
    window.__ERP_FORBIDDEN__ = [item];
  }
  console.warn("[erp-forbidden]", item);
}

async function request(url, options = {}) {
  const trace = beginApiPerf(url, options);
  let response;
  try {
    response = await fetchWithSafeGetRetry(url, {
      ...options,
      headers: buildHeaders(options.headers)
    });
  } catch (error) {
    if (error?.name === "AbortError" && routeAbortedSignals.has(options.signal)) {
      endApiPerf(trace, { error: "route_aborted" });
      return new Promise(() => {});
    }
    endApiPerf(trace, { error: error?.name || "fetch_error" });
    if (error?.name === "AbortError") throw error;
    throw error;
  }

  const contentType = String(response.headers.get("content-type") || "");
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error(data?.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.payload = data;
    endApiPerf(trace, { status: response.status, error: error.message });
    if (response.status === 403) recordForbiddenApi(url, error);
    if (response.status === 401 && options.authExpiredRedirect !== false) notifyAuthExpired(data?.error, url);
    throw error;
  }

  endApiPerf(trace, { status: response.status });
  return data;
}

async function blobRequest(url, options = {}) {
  const trace = beginApiPerf(url, options);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: buildHeaders(options.headers)
    });
  } catch (error) {
    endApiPerf(trace, { error: error?.name || "fetch_error" });
    if (error?.name === "AbortError") throw error;
    throw error;
  }

  if (!response.ok) {
    const contentType = String(response.headers.get("content-type") || "");
    const data = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");
    const error = new Error(data?.error || data || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.payload = data;
    endApiPerf(trace, { status: response.status, error: error.message });
    if (response.status === 403) recordForbiddenApi(url, error);
    if (response.status === 401 && options.authExpiredRedirect !== false) notifyAuthExpired(data?.error, url);
    throw error;
  }

  endApiPerf(trace, { status: response.status });
  return {
    blob: await response.blob(),
    headers: response.headers,
    status: response.status
  };
}

export async function streamApiResponse(url, body, options = {}) {
  const controller = options.signal ? null : new AbortController();
  const signal = options.signal || controller.signal;
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: buildHeaders(options.headers),
    body: JSON.stringify(body == null ? {} : body)
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload?.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = null;
  const handleFrame = (frame) => {
    const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "message";
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (event === "delta") options.onDelta?.(payload?.delta || "");
    else if (event === "done") completed = payload;
    else if (event === "error") {
      const error = new Error(payload?.error || "AI 流式请求失败");
      error.status = payload?.status || 502;
      throw error;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() || "";
    frames.forEach(handleFrame);
    if (done) break;
  }
  if (pending.trim()) handleFrame(pending);
  if (!completed) throw new Error("AI 流式请求未返回完成结果");
  return completed;
}

export const apiClient = {
  get(url, options = {}) {
    if (!isCacheableGet(url, options)) return routeScopedGet(url, options);
    const key = String(url);
    const cached = getCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    const persisted = readPersistedGetCache(key);
    if (persisted !== null) {
      getCache.set(key, { data: persisted, expiresAt: Date.now() + GET_CACHE_TTL_MS });
      return Promise.resolve(persisted);
    }
    const inflight = getInflightCache.get(key);
    if (inflight) return inflight;
    const requestOptions = { ...options };
    delete requestOptions.routeScoped;
    const revision = getCacheRevision;
    const requestPromise = request(url, { method: "GET", ...requestOptions }).then((data) => {
      if (revision === getCacheRevision) {
        getCache.set(key, { data, expiresAt: Date.now() + GET_CACHE_TTL_MS });
        writePersistedGetCache(key, data);
      }
      return data;
    }).finally(() => {
      getInflightCache.delete(key);
    });
    getInflightCache.set(key, requestPromise);
    return requestPromise;
  },
  post(url, body, options = {}) {
    clearGetCacheForMutation(url);
    return request(url, {
      method: "POST",
      body: body == null ? undefined : JSON.stringify(body),
      ...options
    }).then((data) => {
      notifyGetCacheMutation(url);
      return data;
    });
  },
  put(url, body, options = {}) {
    clearGetCacheForMutation(url);
    return request(url, {
      method: "PUT",
      body: body == null ? undefined : JSON.stringify(body),
      ...options
    }).then((data) => {
      notifyGetCacheMutation(url);
      return data;
    });
  },
  delete(url, options = {}) {
    clearGetCacheForMutation(url);
    return request(url, {
      method: "DELETE",
      ...options
    }).then((data) => {
      notifyGetCacheMutation(url);
      return data;
    });
  },
  blob(url, options = {}) {
    return blobRequest(url, options).then((result) => result.blob);
  },
  blobResponse(url, options = {}) {
    return blobRequest(url, options);
  }
};

function routeScopedGet(url, options = {}) {
  if (options.signal || options.dedupe === false) {
    const { routeScoped, dedupe, ...requestOptions } = options;
    return request(url, { method: "GET", ...requestOptions });
  }
  const routeScoped = options.routeScoped !== false;
  const key = `${routeScoped ? "route" : "global"}:${String(url)}`;
  const inflight = getInflightRequests.get(key);
  if (inflight) return inflight;
  const controller = routeScoped ? new AbortController() : null;
  if (controller) routeScopedControllers.add(controller);
  const { routeScoped: _routeScoped, dedupe: _dedupe, ...requestOptions } = options;
  const requestPromise = request(url, {
    method: "GET",
    ...requestOptions,
    signal: controller?.signal
  }).finally(() => {
    if (getInflightRequests.get(key) === requestPromise) getInflightRequests.delete(key);
    if (controller) routeScopedControllers.delete(controller);
  });
  if (controller) {
    controller.signal.addEventListener("abort", () => {
      if (getInflightRequests.get(key) === requestPromise) getInflightRequests.delete(key);
      routeScopedControllers.delete(controller);
    }, { once: true });
  }
  getInflightRequests.set(key, requestPromise);
  return requestPromise;
}

export function getAuthToken() {
  try {
    return window.localStorage?.getItem(AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setAuthToken(token) {
  try {
    window.localStorage?.setItem(AUTH_TOKEN_KEY, token);
    authRedirecting = false;
  } catch {
    // Ignore storage failures; the next authenticated request will surface auth state.
  }
}

export function clearAuthToken() {
  try {
    window.localStorage?.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // Ignore storage failures; auth state is also enforced by the server.
  }
}
