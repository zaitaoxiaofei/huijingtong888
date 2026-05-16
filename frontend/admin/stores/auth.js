import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { apiClient, clearAuthToken, getAuthToken, setAuthToken } from "../utils/api";

export const useAuthStore = defineStore("auth", () => {
  const user = ref(null);
  const bootstrapped = ref(false);
  const loading = ref(false);

  const isAuthenticated = computed(() => Boolean(user.value && getAuthToken()));

  async function bootstrap() {
    if (bootstrapped.value) return;
    if (!getAuthToken()) {
      bootstrapped.value = true;
      return;
    }
    try {
      user.value = await apiClient.get("/api/auth/me");
      if (!user.value) clearSession();
    } catch {
      clearSession();
    } finally {
      bootstrapped.value = true;
    }
  }

  async function login(payload) {
    loading.value = true;
    try {
      const result = await apiClient.post("/api/auth/login", payload);
      setAuthToken(result.token);
      user.value = result.user;
      bootstrapped.value = true;
      return result.user;
    } finally {
      loading.value = false;
    }
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
    logout,
    clearSession
  };
});
