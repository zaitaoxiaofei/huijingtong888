import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { apiClient, clearAuthToken, getAuthToken, setAuthToken } from "../utils/api";

const BOOTSTRAP_TIMEOUT_MS = 5000;

export const useAuthStore = defineStore("auth", () => {
  const user = ref(null);
  const bootstrapped = ref(false);
  const loading = ref(false);

  const isAuthenticated = computed(() => Boolean(user.value));

  async function bootstrap() {
    if (bootstrapped.value) return;
    if (!getAuthToken()) {
      bootstrapped.value = true;
      return;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
    try {
      user.value = await apiClient.get("/api/auth/me", {
        routeScoped: false,
        noCache: true,
        signal: controller.signal
      });
    } catch {
      clearSession();
    } finally {
      window.clearTimeout(timeoutId);
      bootstrapped.value = true;
    }
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
    bindWechat,
    logout,
    clearSession
  };
});
