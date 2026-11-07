import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { apiClient, clearAuthToken, currentApiCacheScope, getAuthToken, setAuthToken } from "../utils/api";

const AUTH_USER_CACHE_KEY = "baodanAuthUser";
const BOOTSTRAP_TIMEOUT_MS = 8000;
const BACKGROUND_VERIFY_TIMEOUT_MS = 5000;

function readCachedUser() {
  try {
    return JSON.parse(window.localStorage?.getItem(AUTH_USER_CACHE_KEY) || "null");
  } catch {
    return null;
  }
}

function writeCachedUser(user) {
  try {
    window.localStorage?.setItem(AUTH_USER_CACHE_KEY, JSON.stringify(user));
  } catch {
    // Local cache is only a startup optimization.
  }
}

function clearCachedUser() {
  try {
    window.localStorage?.removeItem(AUTH_USER_CACHE_KEY);
  } catch {
    // Ignore storage failures; server-side auth still controls access.
  }
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref(null);
  const bootstrapped = ref(false);
  const loading = ref(false);
  let verification = null;

  const isAuthenticated = computed(() => Boolean(user.value));

  function applyUser(currentUser) {
    user.value = currentUser;
    writeCachedUser(currentUser);
    currentApiCacheScope();
  }

  async function bootstrap() {
    if (bootstrapped.value) return;
    if (!getAuthToken()) {
      bootstrapped.value = true;
      return;
    }
    const scope = currentApiCacheScope();
    const cachedUser = readCachedUser();
    if (cachedUser) {
      user.value = cachedUser;
      bootstrapped.value = true;
      verifySession({ background: true });
      return;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
    try {
      const currentUser = await apiClient.get("/api/auth/me", {
        routeScoped: false,
        noCache: true,
        signal: controller.signal
      });
      if (scope !== currentApiCacheScope()) return;
      applyUser(currentUser);
      bootstrapped.value = true;
    } catch (error) {
      if (scope !== currentApiCacheScope()) return;
      if (Number(error?.status || 0) === 401) clearSession();
      bootstrapped.value = true;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function verifySession({ background = false } = {}) {
    const scope = currentApiCacheScope();
    if (verification?.scope === scope) return verification.promise;
    if (!getAuthToken()) {
      clearSession();
      return;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), BACKGROUND_VERIFY_TIMEOUT_MS);
    const currentVerification = { scope, promise: null };
    currentVerification.promise = apiClient.get("/api/auth/me", {
      routeScoped: false,
      noCache: true,
      signal: controller.signal
    }).then((currentUser) => {
      if (scope !== currentApiCacheScope()) return null;
      applyUser(currentUser);
      return currentUser;
    }).catch((error) => {
      if (scope !== currentApiCacheScope() || error?.name === "AbortError") return null;
      if (Number(error?.status || 0) === 401 || !background) clearSession();
      return null;
    }).finally(() => {
      window.clearTimeout(timeoutId);
      if (verification === currentVerification) verification = null;
    });
    verification = currentVerification;
    return currentVerification.promise;
  }

  async function login(payload) {
    loading.value = true;
    try {
      const result = await apiClient.post("/api/auth/login", payload);
      return applyLoginResult(result).user;
    } finally {
      loading.value = false;
    }
  }

  async function completeWechatLogin(ticket) {
    loading.value = true;
    try {
      const result = await apiClient.post("/api/auth/wechat/complete", { ticket });
      return applyLoginResult(result);
    } finally {
      loading.value = false;
    }
  }

  async function register(payload) {
    const scope = currentApiCacheScope();
    loading.value = true;
    try {
      const result = await apiClient.post("/api/auth/register", payload);
      if (scope !== currentApiCacheScope()) throw new DOMException("注册期间登录状态已改变，请使用新账号重新登录", "AbortError");
      return applyLoginResult(result).user;
    } finally {
      loading.value = false;
    }
  }

  function applyLoginResult(result) {
    if (result?.error || !result?.token || !result?.user) {
      throw new Error(result?.error || "Login failed");
    }
    setAuthToken(result.token);
    applyUser(result.user);
    bootstrapped.value = true;
    return result;
  }

  async function bindWechat(ticket) {
    return await apiClient.post("/api/auth/wechat/bind", { ticket });
  }

  async function logout() {
    const scope = currentApiCacheScope();
    try {
      await apiClient.post("/api/auth/logout");
    } catch {
      // ignore logout errors and clear local session anyway
    }
    if (scope === currentApiCacheScope()) clearSession();
  }

  function clearSession() {
    clearAuthToken();
    clearCachedUser();
    user.value = null;
    currentApiCacheScope();
  }

  return {
    user,
    bootstrapped,
    loading,
    isAuthenticated,
    bootstrap,
    login,
    register,
    completeWechatLogin,
    applyLoginResult,
    verifySession,
    bindWechat,
    logout,
    clearSession
  };
});
