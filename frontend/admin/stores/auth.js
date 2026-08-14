import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { apiClient, clearAuthToken, getAuthToken, setAuthToken } from "../utils/api";

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
  let verifyPromise = null;

  const isAuthenticated = computed(() => Boolean(user.value));

  async function bootstrap() {
    if (bootstrapped.value) return;
    if (!getAuthToken()) {
      bootstrapped.value = true;
      return;
    }
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
      user.value = currentUser;
      writeCachedUser(currentUser);
    } catch (error) {
      if (Number(error?.status || 0) === 401) clearSession();
    } finally {
      window.clearTimeout(timeoutId);
      bootstrapped.value = true;
    }
  }

  async function verifySession({ background = false } = {}) {
    if (verifyPromise) return verifyPromise;
    if (!getAuthToken()) {
      clearSession();
      return;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), BACKGROUND_VERIFY_TIMEOUT_MS);
    verifyPromise = apiClient.get("/api/auth/me", {
      routeScoped: false,
      noCache: true,
      signal: controller.signal
    }).then((currentUser) => {
      user.value = currentUser;
      writeCachedUser(currentUser);
      return currentUser;
    }).catch((error) => {
      if (Number(error?.status || 0) === 401 || !background) clearSession();
      return null;
    }).finally(() => {
      window.clearTimeout(timeoutId);
      verifyPromise = null;
    });
    return verifyPromise;
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

  function applyLoginResult(result) {
    if (result?.error || !result?.token || !result?.user) {
      throw new Error(result?.error || "Login failed");
    }
    setAuthToken(result.token);
    user.value = result.user;
    writeCachedUser(result.user);
    bootstrapped.value = true;
    return result;
  }

  async function bindWechat(ticket) {
    return await apiClient.post("/api/auth/wechat/bind", { ticket });
  }

  async function logout() {
    try {
      await apiClient.post("/api/auth/logout");
    } catch {
      // ignore logout errors and clear local session anyway
    }
    clearSession();
  }

  function clearSession() {
    clearAuthToken();
    clearCachedUser();
    user.value = null;
  }

  return {
    user,
    bootstrapped,
    loading,
    isAuthenticated,
    bootstrap,
    login,
    completeWechatLogin,
    applyLoginResult,
    verifySession,
    bindWechat,
    logout,
    clearSession
  };
});
