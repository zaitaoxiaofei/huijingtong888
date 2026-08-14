<template>
  <div class="erp-filter-bar">
    <div class="erp-filter-bar__filters"><slot /></div>
    <div v-if="$slots.actions" class="erp-filter-bar__actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.erp-filter-bar, .erp-filter-bar__filters, .erp-filter-bar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.erp-filter-bar { justify-content: flex-end; min-width: 0; }
.erp-filter-bar__filters { min-width: 0; }
.erp-filter-bar__actions { flex: 0 0 auto; }
@media (max-width: 1280px) {
  .erp-filter-bar, .erp-filter-bar__filters { flex-wrap: wrap; justify-content: flex-start; }
}
@media (max-width: 780px) {
  .erp-filter-bar, .erp-filter-bar__filters, .erp-filter-bar__actions { align-items: stretch; flex-direction: column; width: 100%; }
}
</style>
