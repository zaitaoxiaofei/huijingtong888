const AUTH_TOKEN_KEY = "authToken";
let authRedirecting = false;

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

export const apiClient = {
  get(url, options = {}) {
    return request(url, { method: "GET", ...options });
  },
  post(url, body, options = {}) {
    return request(url, {
      method: "POST",
      body: body == null ? undefined : JSON.stringify(body),
      ...options
    });
  },
  put(url, body, options = {}) {
    return request(url, {
      method: "PUT",
      body: body == null ? undefined : JSON.stringify(body),
      ...options
    });
  },
  delete(url, options = {}) {
    return request(url, {
      method: "DELETE",
      ...options
    });
  }
};

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(token) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}
