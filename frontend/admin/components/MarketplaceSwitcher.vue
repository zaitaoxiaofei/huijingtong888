<script setup>
import MarketplaceBadge from './MarketplaceBadge.vue';
const props = defineProps({ modelValue: { type: String, default: 'ozon' }, label: { type: String, default: '销售平台' }, ozonLabel: { type: String, default: 'Ozon' }, wbLabel: { type: String, default: 'WB' } });
const emit = defineEmits(['update:modelValue']);
function navigate(event) {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'ozon' : event.key === 'End' ? 'wb' : props.modelValue === 'ozon' ? 'wb' : 'ozon';
  emit('update:modelValue', next);
  event.currentTarget.querySelector(`[data-platform="${next}"]`)?.focus();
}
</script>
<template>
  <div class="marketplace-switcher" role="tablist" :aria-label="label" @keydown="navigate">
    <button v-for="key in ['ozon','wb']" :key="key" type="button" role="tab" :data-platform="key" :aria-selected="modelValue === key" :tabindex="modelValue === key ? 0 : -1" :class="{ active: modelValue === key }" @click="emit('update:modelValue',key)">
      <MarketplaceBadge :platform="key" :size="30" /><span>{{ key === 'ozon' ? ozonLabel : wbLabel }}</span>
    </button>
  </div>
</template>
<style scoped>
.marketplace-switcher{display:inline-flex;align-items:center;gap:5px;padding:5px;border:1px solid var(--erp-border-light,var(--el-border-color));border-radius:12px;background:var(--erp-surface-alt,var(--el-fill-color-light));width:fit-content;max-width:100%}
.marketplace-switcher button{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:44px;min-width:112px;padding:6px 18px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--el-text-color-secondary);font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s}
.marketplace-switcher button:hover{background:var(--el-fill-color)}
.marketplace-switcher button.active{background:var(--erp-surface,var(--el-bg-color));border-color:var(--el-border-color);color:var(--el-text-color-primary);box-shadow:0 2px 6px #00000008}
.marketplace-switcher button:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}
@media(max-width:480px){.marketplace-switcher button{min-width:96px;padding:6px 12px}}
</style>
