import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { applyAppearancePreferences, getThemePreset, normalizeAppearancePreferences, readAppearancePreferences, saveAppearancePreferences } from "../utils/theme-presets.js";

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
  const themePalettes = ref({ light: "blue", dark: "blue" });
  const activePalette = computed(() => themePalettes.value[theme.value]);
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

  function appearanceStorage() {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  }

  function applyThemePreferences(value) {
    const preferences = normalizeAppearancePreferences(value);
    theme.value = preferences.mode;
    themePalettes.value = preferences.palettes;
    applyAppearancePreferences(preferences, typeof document === "undefined" ? null : document);
    saveAppearancePreferences(appearanceStorage(), preferences);
  }

  function initTheme() {
    applyThemePreferences(readAppearancePreferences(appearanceStorage()));
  }

  function setThemeMode(mode) {
    applyThemePreferences({ version: 1, mode, palettes: themePalettes.value });
  }

  function setThemePalette(palette, mode = theme.value) {
    const targetMode = mode === "dark" ? "dark" : "light";
    applyThemePreferences({
      version: 1,
      mode: theme.value,
      palettes: { ...themePalettes.value, [targetMode]: getThemePreset(targetMode, palette).id }
    });
  }

  function toggleTheme() {
    setThemeMode(theme.value === "dark" ? "light" : "dark");
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
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, nextMode);
    } catch {
      // Keep the current layout usable when browser storage is unavailable.
    }
    applyLayoutState();
  }

  function initLayoutPreferences() {
    let savedDensity;
    try {
      savedDensity = localStorage.getItem(DENSITY_STORAGE_KEY);
    } catch {
      // Fall back to the existing automatic density.
    }
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
    themePalettes,
    activePalette,
    densityMode,
    effectiveDensity,
    viewportWidth,
    windowClass,
    tableSize,
    toggleSidebar,
    initTheme,
    setThemeMode,
    setThemePalette,
    toggleTheme,
    setDensityMode,
    initLayoutPreferences
  };
});
