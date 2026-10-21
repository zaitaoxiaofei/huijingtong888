import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "../frontend/admin/stores/app.js";
import { APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, THEME_PRESETS, getThemePreset } from "../frontend/admin/utils/theme-presets.js";

function harness(t, initial = {}, blocked = false) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem(key) { if (blocked) throw new Error("Storage blocked"); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error("Storage blocked"); values.set(key, String(value)); },
    removeItem(key) { if (blocked) throw new Error("Storage blocked"); values.delete(key); }
  };
  const tokens = new Map();
  const document = {
    documentElement: { dataset: {}, style: { setProperty(name, value) { tokens.set(name, value); } } },
    body: { dataset: {} }
  };
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, innerWidth: 1440, addEventListener() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else delete globalThis.window;
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else delete globalThis.document;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else delete globalThis.localStorage;
  });
  function newStore() {
    setActivePinia(createPinia());
    return useAppStore();
  }
  return { store: newStore(), newStore, document, tokens, values };
}

test("fresh appearance defaults to light blue and applies it to shell and teleported overlays", (t) => {
  const h = harness(t);
  h.store.initTheme();
  assert.equal(h.store.theme, "light");
  assert.equal(h.store.activePalette, "blue");
  assert.deepEqual(h.document.documentElement.dataset, { theme: "light", themePalette: "blue" });
  assert.deepEqual(h.document.body.dataset, h.document.documentElement.dataset);
  assert.equal(h.tokens.get("--erp-palette-primary"), getThemePreset("light", "blue").accent);
  assert.deepEqual(JSON.parse(h.values.get(APPEARANCE_STORAGE_KEY)), { version: 1, mode: "light", palettes: { light: "blue", dark: "blue" } });
});

test("each mode keeps its palette across mode switches and a fresh store bootstrap", (t) => {
  const h = harness(t);
  h.store.initTheme();
  h.store.setThemePalette("teal");
  h.store.setThemeMode("dark");
  h.store.setThemePalette("violet");
  h.store.toggleTheme();
  assert.equal(h.store.theme, "light");
  assert.equal(h.store.activePalette, "teal");
  assert.equal(h.tokens.get("--erp-palette-primary-fill"), getThemePreset("light", "teal").tokens["primary-fill"]);
  h.store.toggleTheme();
  assert.equal(h.store.activePalette, "violet");
  assert.equal(h.tokens.get("--erp-palette-primary-contrast"), "#111827");
  const restored = h.newStore();
  restored.initTheme();
  assert.equal(restored.theme, "dark");
  assert.deepEqual({ ...restored.themePalettes }, { light: "teal", dark: "violet" });
  restored.initTheme();
  assert.equal(restored.activePalette, "violet");
});

test("editing the inactive mode palette preserves the current mode and displayed palette", (t) => {
  const h = harness(t);
  h.store.initTheme();
  h.store.setThemePalette("teal", "dark");
  assert.equal(h.store.theme, "light");
  assert.equal(h.store.activePalette, "blue");
  assert.equal(h.document.documentElement.dataset.themePalette, "blue");
  h.store.setThemeMode("dark");
  assert.equal(h.store.activePalette, "teal");
});

test("a valid legacy theme is migrated once without resetting it on startup", (t) => {
  const h = harness(t, { [LEGACY_THEME_STORAGE_KEY]: "dark" });
  h.store.initTheme();
  assert.equal(h.store.theme, "dark");
  assert.equal(h.values.has(LEGACY_THEME_STORAGE_KEY), false);
  assert.equal(JSON.parse(h.values.get(APPEARANCE_STORAGE_KEY)).mode, "dark");
});

test("malformed or unsupported saved data falls back to validated defaults", (t) => {
  const h = harness(t);
  for (const value of ["{", "null", '"dark"', '{"version":2,"mode":"dark"}', '{"version":1,"mode":"unknown","palettes":{"light":"constructor","dark":"injected"}}']) {
    h.values.set(APPEARANCE_STORAGE_KEY, value);
    h.store.initTheme();
    assert.equal(h.store.theme, "light");
    assert.deepEqual({ ...h.store.themePalettes }, { light: "blue", dark: "blue" });
    assert.equal(h.document.body.dataset.themePalette, "blue");
  }
  h.store.setThemeMode("invalid");
  h.store.setThemePalette("invalid");
  assert.equal(h.store.theme, "light");
  assert.equal(h.store.activePalette, "blue");
});

test("blocked local storage still allows an immediate mode and palette change", (t) => {
  const h = harness(t, {}, true);
  assert.doesNotThrow(() => h.store.initTheme());
  assert.doesNotThrow(() => h.store.setThemeMode("dark"));
  assert.doesNotThrow(() => h.store.setThemePalette("teal"));
  assert.equal(h.store.theme, "dark");
  assert.equal(h.document.body.dataset.themePalette, "teal");
  assert.doesNotThrow(() => h.store.initLayoutPreferences());
  assert.equal(h.document.documentElement.dataset.density, "standard");
  assert.doesNotThrow(() => h.store.setDensityMode("compact"));
  assert.equal(h.document.documentElement.dataset.density, "compact");
});

function contrast(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255).map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("all six palettes keep readable primary, hover and selected text contrast", () => {
  for (const [mode, presets] of Object.entries(THEME_PRESETS)) {
    assert.deepEqual(presets.map((preset) => preset.id), ["blue", "teal", "violet"]);
    for (const preset of presets) {
      const tokens = preset.tokens;
      for (const surface of [tokens["primary-fill"], tokens["primary-fill-hover"]]) {
        assert.ok(contrast(tokens["primary-contrast"], surface) >= 4.5, `${mode}/${preset.id}: button contrast`);
      }
      assert.ok(contrast(tokens.primary, tokens["primary-soft"]) >= 4.5, `${mode}/${preset.id}: selected text contrast`);
    }
  }
});
