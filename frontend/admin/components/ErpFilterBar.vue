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
@media (max-width: 1100px), (max-width: 1366px) and (any-pointer: coarse) {
  .erp-filter-bar, .erp-filter-bar__filters { flex-wrap: wrap; justify-content: flex-start; }
}
@media (max-width: 767px) {
  .erp-filter-bar, .erp-filter-bar__filters, .erp-filter-bar__actions { align-items: stretch; flex-direction: column; width: 100%; }
  .erp-filter-bar :deep(.el-input),
  .erp-filter-bar :deep(.el-select),
  .erp-filter-bar :deep(.el-date-editor),
  .erp-filter-bar :deep(.el-button) { width: 100%; margin-left: 0; }
}
</style>
