export const APPEARANCE_STORAGE_KEY = "ozon-admin-appearance-v1";
export const LEGACY_THEME_STORAGE_KEY = "ozon-admin-theme";
export const THEME_MODES = ["light", "dark"];

function preset(id, label, description, accent, hover, soft, faint, border, controlBorder, fill, fillHover, contrast, steps) {
  return {
    id,
    label,
    description,
    accent,
    soft,
    tokens: {
      primary: accent,
      "primary-hover": hover,
      "primary-soft": soft,
      "primary-faint": faint,
      "primary-border": border,
      "primary-control-border": controlBorder,
      "primary-fill": fill,
      "primary-fill-hover": fillHover,
      "primary-contrast": contrast,
      link: accent,
      "link-hover": hover,
      ...Object.fromEntries([3, 5, 7, 8, 9].map((step, index) => [`primary-light-${step}`, steps[index]]))
    }
  };
}

// Accent ramps are paired with each mode's neutral surfaces. Status colors remain semantic.
export const THEME_PRESETS = {
  light: [
    preset("blue", "商务蓝", "沉稳清晰", "#315faa", "#254c8d", "#edf3fc", "#f5f8fd", "#cddcf1", "#9eb9df", "#315faa", "#254c8d", "#ffffff", ["#6687bf", "#98afd5", "#c3d2e9", "#d8e2f1", "#edf3fc"]),
    preset("teal", "松石青", "柔和舒适", "#247769", "#1a5f54", "#eaf5f2", "#f4f9f7", "#c2ded5", "#94c2b4", "#247769", "#1a5f54", "#ffffff", ["#65a095", "#91bdb4", "#bfdad2", "#d7e9e3", "#eaf5f2"]),
    preset("violet", "雾感紫", "克制雅致", "#6752a3", "#514081", "#f1eef8", "#f8f6fb", "#dad0ec", "#b9aad8", "#6752a3", "#514081", "#ffffff", ["#9484bf", "#b4a8d3", "#d3cce7", "#e2ddf0", "#f1eef8"])
  ],
  dark: [
    preset("blue", "深海蓝", "冷静专注", "#9dc6ff", "#c3ddff", "#203450", "#17273d", "#476d9d", "#6289b7", "#8ab8fa", "#a7ccff", "#101827", ["#749acb", "#55749d", "#3c567a", "#2c425f", "#203450"]),
    preset("teal", "夜松青", "温润耐看", "#8bdbc9", "#b3eadc", "#183a36", "#142d2b", "#3d786d", "#5b978b", "#77cdbc", "#9bdfd0", "#102823", ["#66aa9d", "#4b8278", "#345f57", "#254b44", "#183a36"]),
    preset("violet", "暮光紫", "安静细腻", "#b1a8ff", "#c6c0ff", "#2c294d", "#1e223b", "#615a99", "#7770b0", "#9d91ff", "#b7adff", "#111827", ["#8b80d2", "#6b609f", "#49416f", "#393257", "#2c294d"])
  ]
};

export function getThemePreset(mode, palette) {
  const presets = THEME_PRESETS[mode === "dark" ? "dark" : "light"];
  return presets.find((item) => item.id === palette) || presets[0];
}

export function normalizeAppearancePreferences(value) {
  const valid = value && typeof value === "object" && value.version === 1;
  return {
    version: 1,
    mode: valid && value.mode === "dark" ? "dark" : "light",
    palettes: {
      light: getThemePreset("light", valid ? value.palettes?.light : null).id,
      dark: getThemePreset("dark", valid ? value.palettes?.dark : null).id
    }
  };
}

export function readAppearancePreferences(storage) {
  try {
    const saved = storage?.getItem(APPEARANCE_STORAGE_KEY);
    if (saved != null) return normalizeAppearancePreferences(JSON.parse(saved));
    const legacy = storage?.getItem(LEGACY_THEME_STORAGE_KEY);
    return normalizeAppearancePreferences({ version: 1, mode: legacy });
  } catch {
    return normalizeAppearancePreferences(null);
  }
}

export function saveAppearancePreferences(storage, value) {
  try {
    storage?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalizeAppearancePreferences(value)));
    storage?.removeItem(LEGACY_THEME_STORAGE_KEY);
  } catch {
    // A blocked browser storage must not prevent changing the current appearance.
  }
}

export function applyAppearancePreferences(value, targetDocument) {
  const preferences = normalizeAppearancePreferences(value);
  const selected = getThemePreset(preferences.mode, preferences.palettes[preferences.mode]);
  for (const element of [targetDocument?.documentElement, targetDocument?.body]) {
    if (!element) continue;
    element.dataset.theme = preferences.mode;
    element.dataset.themePalette = selected.id;
  }
  for (const [name, color] of Object.entries(selected.tokens)) {
    targetDocument?.documentElement?.style.setProperty(`--erp-palette-${name}`, color);
  }
}
