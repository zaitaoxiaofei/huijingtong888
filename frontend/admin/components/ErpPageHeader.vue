<script setup>
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: "" },
  compact: { type: Boolean, default: false }
});
</script>

<template>
  <header class="erp-page-header" :class="{ 'is-compact': compact }">
    <div class="erp-page-header__copy">
      <h1>{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="erp-page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.erp-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 72px;
  padding: 11px 18px;
}
.erp-page-header__copy { min-width: 0; }
.erp-page-header h1 { margin: 0; color: var(--erp-text-main, #1f2937); font-size: 19px; line-height: 1.3; }
.erp-page-header p { margin: 4px 0 0; color: var(--erp-text-secondary, #7b8497); font-size: 12px; }
.erp-page-header__actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; margin-left: auto; }
.erp-page-header.is-compact { min-height: 54px; padding-top: 8px; padding-bottom: 8px; }
.erp-page-header.is-compact h1 { font-size: 17px; }
@media (max-width: 1280px) {
  .erp-page-header { align-items: flex-start; flex-direction: column; }
  .erp-page-header__actions { width: 100%; flex-wrap: wrap; margin-left: 0; }
}
@media (max-width: 780px) {
  .erp-page-header__actions { align-items: stretch; flex-direction: column; }
}
</style>
