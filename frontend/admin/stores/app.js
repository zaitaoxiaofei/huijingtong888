import { computed, ref } from "vue";
import { defineStore } from "pinia";

const THEME_STORAGE_KEY = "ozon-admin-theme";
const DEFAULT_THEME = "light";
const DENSITY_STORAGE_KEY = "ozon-admin-density";
const DENSITY_MODES = new Set(["auto", "comfortable", "standard", "compact"]);

function resolveWindowClass(width) {
  if (width < 768) return "compact";
  if (width < 1101) return "medium";
  if (width < 1280) return "compact-desktop";
  if (width < 1600) return "standard";
  return "expanded";
}

export const useAppStore = defineStore("app", () => {
  const sidebarCollapsed = ref(false);
  const theme = ref("light");
  const densityMode = ref("auto");
  const viewportWidth = ref(typeof window === "undefined" ? 1440 : window.innerWidth);
  let viewportListenerInstalled = false;

  const windowClass = computed(() => resolveWindowClass(viewportWidth.value));
  const effectiveDensity = computed(() => {
    if (densityMode.value !== "auto") return densityMode.value;
    return windowClass.value === "compact-desktop" ? "compact" : "standard";
  });
  const tableSize = computed(() => (effectiveDensity.value === "compact" ? "small" : "default"));

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  function applyTheme(nextTheme) {
    theme.value = nextTheme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme.value;
    document.body.dataset.theme = theme.value;
  }

  function initTheme() {
    localStorage.removeItem(THEME_STORAGE_KEY);
    applyTheme(DEFAULT_THEME);
  }

  function toggleTheme() {
    applyTheme(theme.value === "dark" ? "light" : "dark");
  }

  function applyLayoutState() {
    document.documentElement.dataset.windowClass = windowClass.value;
    document.documentElement.dataset.density = effectiveDensity.value;
    document.documentElement.dataset.densityMode = densityMode.value;
  }

  function syncViewport() {
    viewportWidth.value = window.innerWidth;
    applyLayoutState();
  }

  function setDensityMode(mode) {
    const nextMode = DENSITY_MODES.has(mode) ? mode : "auto";
    densityMode.value = nextMode;
    localStorage.setItem(DENSITY_STORAGE_KEY, nextMode);
    applyLayoutState();
  }

  function initLayoutPreferences() {
    const savedDensity = localStorage.getItem(DENSITY_STORAGE_KEY);
    densityMode.value = DENSITY_MODES.has(savedDensity) ? savedDensity : "auto";
    syncViewport();
    if (!viewportListenerInstalled) {
      window.addEventListener("resize", syncViewport, { passive: true });
      viewportListenerInstalled = true;
    }
  }

  return {
    sidebarCollapsed,
    theme,
    densityMode,
    effectiveDensity,
    viewportWidth,
    windowClass,
    tableSize,
    toggleSidebar,
    initTheme,
    toggleTheme,
    setDensityMode,
    initLayoutPreferences
  };
});
