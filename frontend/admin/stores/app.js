import { computed, ref } from "vue";
import { defineStore } from "pinia";

const THEME_STORAGE_KEY = "ozon-admin-theme";

export const useAppStore = defineStore("app", () => {
  const sidebarCollapsed = ref(false);
  const theme = ref("light");

  const tableSize = computed(() => "default");

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  function applyTheme(nextTheme) {
    theme.value = nextTheme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme.value;
    document.body.dataset.theme = theme.value;
    localStorage.setItem(THEME_STORAGE_KEY, theme.value);
  }

  function initTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    applyTheme(savedTheme || "light");
  }

  function toggleTheme() {
    applyTheme(theme.value === "dark" ? "light" : "dark");
  }

  return {
    sidebarCollapsed,
    theme,
    tableSize,
    toggleSidebar,
    initTheme,
    toggleTheme
  };
});
