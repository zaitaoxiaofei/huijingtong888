<script setup>
import { computed, nextTick, ref, useId } from "vue";
import { Brush, Check, MoonNight, Sunny } from "@element-plus/icons-vue";
import { useAppStore } from "../stores/app";
import { THEME_PRESETS } from "../utils/theme-presets.js";

const appStore = useAppStore();
const visible = ref(false);
const panel = ref(null);
const trigger = ref(null);
const id = useId();
const presets = computed(() => THEME_PRESETS[appStore.theme]);
const modes = [
  { id: "light", label: "亮色模式", icon: Sunny },
  { id: "dark", label: "暗夜模式", icon: MoonNight }
];

function focusMode() {
  nextTick(() => panel.value?.querySelector('input[name$="-mode"]:checked')?.focus());
}

function closeSettings() {
  visible.value = false;
  trigger.value?.$el?.focus();
}

function previewStyle(preset) {
  return {
    "--appearance-accent": preset.accent,
    "--appearance-soft": preset.soft,
    "--appearance-preview-bg": appStore.theme === "dark" ? "#08111f" : "#f5f7fb",
    "--appearance-preview-surface": appStore.theme === "dark" ? "#162235" : "#ffffff"
  };
}
</script>

<template>
  <el-popover v-model:visible="visible" trigger="click" placement="bottom-end" :width="336" popper-class="erp-appearance-popper" @show="focusMode">
    <template #reference>
      <el-button ref="trigger" circle class="erp-theme-toggle erp-header-icon" title="外观设置" aria-label="外观设置" aria-haspopup="dialog" :aria-expanded="visible" :aria-controls="`${id}-appearance`">
        <el-icon><Brush /></el-icon>
      </el-button>
    </template>
    <section :id="`${id}-appearance`" ref="panel" class="appearance-settings" role="dialog" :aria-labelledby="`${id}-title`" @keydown.esc.stop.prevent="closeSettings">
      <header class="appearance-header">
        <strong :id="`${id}-title`">外观设置</strong>
        <span>选择适合你的工作界面</span>
      </header>

      <fieldset class="appearance-fieldset">
        <legend>显示模式</legend>
        <div class="appearance-modes">
          <label v-for="mode in modes" :key="mode.id" class="appearance-mode" :class="{ 'is-active': appStore.theme === mode.id }">
            <input type="radio" :name="`${id}-mode`" :value="mode.id" :checked="appStore.theme === mode.id" @change="appStore.setThemeMode(mode.id)" />
            <el-icon><component :is="mode.icon" /></el-icon>
            <span>{{ mode.label }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="appearance-fieldset">
        <legend>{{ appStore.theme === 'dark' ? '暗夜' : '亮色' }}配色方案</legend>
        <div class="appearance-palettes">
          <label v-for="preset in presets" :key="preset.id" class="appearance-palette" :class="{ 'is-active': appStore.activePalette === preset.id }" :style="previewStyle(preset)">
            <input type="radio" :name="`${id}-palette`" :value="preset.id" :checked="appStore.activePalette === preset.id" @change="appStore.setThemePalette(preset.id)" />
            <span class="appearance-preview" aria-hidden="true">
              <span class="appearance-preview__sidebar"><i></i><i></i><i></i></span>
              <span class="appearance-preview__content"><i></i><i></i><i></i></span>
            </span>
            <span class="appearance-palette__name">{{ preset.label }}<el-icon v-if="appStore.activePalette === preset.id"><Check /></el-icon></span>
            <small>{{ preset.description }}</small>
          </label>
        </div>
      </fieldset>
      <p class="appearance-hint">亮色与暗夜配色分别保存，重新打开仍会保留。</p>
    </section>
  </el-popover>
</template>

<style scoped>
:global(.erp-appearance-popper) {
  --el-popover-padding: 16px;
  max-width: calc(100vw - 24px);
}

.appearance-settings { color: var(--erp-text-main); }
.appearance-header { display: grid; gap: 4px; margin-bottom: 18px; }
.appearance-header strong { font-size: 15px; font-weight: 600; }
.appearance-header > span { font-size: 12px; color: var(--erp-text-regular); }
.appearance-fieldset { min-width: 0; margin: 0 0 18px; padding: 0; border: 0; }
.appearance-fieldset legend { margin-bottom: 9px; padding: 0; font-size: 12px; font-weight: 600; color: var(--erp-text-regular); }
.appearance-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.appearance-mode { display: flex; align-items: center; justify-content: center; gap: 7px; position: relative; min-height: 38px; border: 1px solid var(--erp-border); border-radius: 8px; background: var(--erp-surface-alt); color: var(--erp-text-regular); cursor: pointer; }
.appearance-mode .el-icon { font-size: 16px; }
.appearance-mode.is-active { border-color: var(--erp-primary-border); background: var(--erp-primary-soft); color: var(--erp-primary); }
.appearance-mode:hover { border-color: var(--erp-primary-control-border); }
.appearance-mode input,
.appearance-palette input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.appearance-mode:has(input:focus-visible),
.appearance-palette:has(input:focus-visible) { outline: 2px solid var(--erp-primary); outline-offset: 3px; }
.appearance-palettes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.appearance-palette { position: relative; display: grid; gap: 5px; min-width: 0; padding: 5px 5px 8px; border: 1px solid var(--erp-border); border-radius: 8px; cursor: pointer; }
.appearance-palette:hover { border-color: var(--erp-primary-control-border); }
.appearance-palette.is-active { border-color: var(--erp-primary); box-shadow: 0 0 0 1px var(--erp-primary); }
.appearance-preview { display: grid; grid-template-columns: 17px 1fr; gap: 5px; height: 50px; padding: 5px; border-radius: 4px; background: var(--appearance-preview-bg); }
.appearance-preview__sidebar { display: grid; align-content: start; gap: 4px; padding-top: 3px; }
.appearance-preview__sidebar i { height: 4px; border-radius: 2px; background: var(--appearance-soft); }
.appearance-preview__sidebar i:first-child { background: var(--appearance-accent); }
.appearance-preview__content { display: grid; align-content: start; gap: 5px; padding: 5px; border-radius: 3px; background: var(--appearance-preview-surface); }
.appearance-preview__content i { height: 4px; border-radius: 2px; background: var(--appearance-soft); }
.appearance-preview__content i:first-child { width: 70%; background: var(--appearance-accent); }
.appearance-palette__name { display: flex; align-items: center; justify-content: center; gap: 3px; font-size: 12px; color: var(--erp-text-main); }
.appearance-palette__name .el-icon { color: var(--erp-primary); }
.appearance-palette small { text-align: center; font-size: 11px; color: var(--erp-text-regular); }
.appearance-hint { margin: 0; padding-top: 12px; border-top: 1px solid var(--erp-border-light); font-size: 11px; line-height: 1.6; color: var(--erp-text-regular); }
</style>
