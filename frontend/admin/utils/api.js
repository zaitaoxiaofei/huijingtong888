const AUTH_TOKEN_KEY = "authToken";
const GET_CACHE_TTL_MS = 30000;
const cachedGetPrefixes = [
  "/api/shops",
  "/api/people",
  "/api/suppliers"
];
let authRedirecting = false;
const getCache = new Map();
const routeScopedControllers = new Set();
const routeAbortedSignals = new WeakSet();

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

function clearGetCacheForMutation(url = "") {
  if (!getCache.size) return;
  const path = String(url || "").split("?")[0];
  for (const prefix of cachedGetPrefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      getCache.clear();
      return;
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

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: buildHeaders(options.headers)
    });
  } catch (error) {
    if (error?.name === "AbortError" && routeAbortedSignals.has(options.signal)) {
      return new Promise(() => {});
    }
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
    if (response.status === 401) {
      clearAuthToken();
      if (!authRedirecting) {
        authRedirecting = true;
        window.dispatchEvent(new CustomEvent("app:auth-expired", {
          detail: {
            message: data?.error || "登录已失效，请重新登录"
          }
        }));
        window.setTimeout(() => {
          authRedirecting = false;
          if (!String(window.location.hash || "").startsWith("#/login")) {
            window.location.hash = "#/login";
          }
        }, 0);
      }
    }
    throw error;
  }

  return data;
}

async function blobRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: buildHeaders(options.headers)
    });
  } catch (error) {
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
    if (response.status === 401) {
      clearAuthToken();
      if (!authRedirecting) {
        authRedirecting = true;
        window.dispatchEvent(new CustomEvent("app:auth-expired", {
          detail: { message: data?.error || "登录已失效，请重新登录" }
        }));
        window.setTimeout(() => {
          authRedirecting = false;
          if (!String(window.location.hash || "").startsWith("#/login")) {
            window.location.hash = "#/login";
          }
        }, 0);
      }
    }
    throw error;
  }

  return {
    blob: await response.blob(),
    headers: response.headers,
    status: response.status
  };
}

export const apiClient = {
  get(url, options = {}) {
    if (!isCacheableGet(url, options)) return routeScopedGet(url, options);
    const key = String(url);
    const cached = getCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    return routeScopedGet(url, options).then((data) => {
      getCache.set(key, { data, expiresAt: Date.now() + GET_CACHE_TTL_MS });
      return data;
    });
  },
  post(url, body, options = {}) {
    clearGetCacheForMutation(url);
    return request(url, {
      method: "POST",
      body: body == null ? undefined : JSON.stringify(body),
      ...options
    });
  },
  put(url, body, options = {}) {
    clearGetCacheForMutation(url);
    return request(url, {
      method: "PUT",
      body: body == null ? undefined : JSON.stringify(body),
      ...options
    });
  },
  delete(url, options = {}) {
    clearGetCacheForMutation(url);
    return request(url, {
      method: "DELETE",
      ...options
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
  if (options.signal || options.routeScoped === false) {
    const { routeScoped, ...requestOptions } = options;
    return request(url, { method: "GET", ...requestOptions });
  }
  const controller = new AbortController();
  routeScopedControllers.add(controller);
  return request(url, {
    method: "GET",
    ...options,
    signal: controller.signal
  }).finally(() => {
    routeScopedControllers.delete(controller);
  });
}

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(token) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}
