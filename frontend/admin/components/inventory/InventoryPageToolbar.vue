<script setup>
import { computed } from "vue";
import InventoryStructuredSearch from "./InventoryStructuredSearch.vue";
const props = defineProps({
  filters: { type: Object, required: true }, shops: { type: Array, default: () => [] },
  showShop: { type: Boolean, default: true }, showDateRange: { type: Boolean, default: true },
  showQuery: { type: Boolean, default: true }, productSearch: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  dateLabel: { type: String, default: "商品创建时间" },
  queryLabel: { type: String, default: "搜索内容" },
  queryPlaceholder: { type: String, default: "库存编号 / SKU / 货号 / 名称关键词" }
});
const emit = defineEmits(["search", "reset"]);
const searchPlaceholder = computed(() => ({ inventory_id: '完整库存编号，如 1-23', sku: '完整 Ozon SKU 或货号', name: '名称关键词，多个词用空格分隔' }[props.filters.searchMode] || props.queryPlaceholder));
const dateRange = computed({
  get: () => props.filters.dateFrom || props.filters.dateTo ? [props.filters.dateFrom, props.filters.dateTo] : [],
  set: value => { props.filters.dateFrom = value?.[0] || ''; props.filters.dateTo = value?.[1] || ''; }
});
</script>
<template>
  <section class="inventory-toolbar inventory-search-toolbar" aria-label="库存搜索">
    <el-form label-position="top" class="inventory-search-form" @submit.prevent="emit('search')">
      <div class="inventory-search-fields">
        <el-form-item v-if="productSearch && showQuery" label="搜索方式" class="search-mode">
          <el-select v-model="filters.searchMode" aria-label="搜索方式">
            <el-option label="综合搜索" value="auto" /><el-option label="库存编号精确" value="inventory_id" />
            <el-option label="SKU／货号精确" value="sku" /><el-option label="产品名称模糊" value="name" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="showQuery" :label="queryLabel" class="search-keyword">
          <el-input v-model="filters.query" :placeholder="searchPlaceholder" clearable aria-label="搜索内容" @keyup.enter.prevent.stop="emit('search')" />
        </el-form-item>
        <el-form-item v-if="showShop" label="店铺" class="search-shop">
          <el-select v-model="filters.shopId" filterable aria-label="店铺"><el-option label="全部店铺" value="all" /><el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" /></el-select>
        </el-form-item>
        <el-form-item v-if="showDateRange" :label="dateLabel" class="search-dates">
          <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" />
        </el-form-item>
        <slot />
        <InventoryStructuredSearch v-if="productSearch" compact simple class="inventory-search-attributes" :model-value="filters" @update:model-value="Object.assign(filters, $event)" @keyup.enter.prevent.stop="emit('search')" />
      </div>
      <div class="inventory-search-actions">
        <el-button type="primary" :loading="loading" @click="emit('search')">查询</el-button>
        <el-button @click="emit('reset')">重置</el-button>
        <slot name="actions" />
      </div>

    </el-form>
  </section>
</template>
<style scoped>
.inventory-search-toolbar { position: static; min-width: 0; padding: 12px; border: 1px solid var(--erp-detail-border-light, #e8edf5); border-radius: 12px; background: var(--erp-detail-surface-alt, #f8fafc); }
.inventory-search-form { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.inventory-search-fields { display: flex; flex: 1 1 650px; flex-wrap: wrap; gap: 8px; min-width: 0; align-items: flex-end; }
.inventory-search-fields :deep(.el-form-item) { margin: 0; width: 112px; min-width: 0; }
.inventory-search-fields :deep(.el-form-item__label) { margin-bottom: 5px; font-size: 12px; }
.inventory-search-fields :deep(.search-keyword) { flex: 1 1 160px; max-width: 250px; }
.inventory-search-fields :deep(.search-dates) { width: 250px; }
.inventory-search-fields :deep(.el-select), .inventory-search-fields :deep(.el-date-editor) { width: 100%; min-width: 0; }
.inventory-search-actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.inventory-search-actions :deep(.el-button) { margin: 0; }
.inventory-search-fields :deep(.search-mode) { width: 132px; }
.inventory-search-fields :deep(.search-shop) { width: 140px; }
.inventory-search-fields :deep(.inventory-search-attributes) { display: contents; }
.inventory-search-fields :deep(.inventory-search-attributes .search-group) { display: contents; }
@media (max-width: 760px) {
  .inventory-search-fields { flex-basis: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .inventory-search-fields :deep(.el-form-item) { width: 100%; }
  .inventory-search-fields :deep(.search-keyword), .inventory-search-fields :deep(.search-dates) { grid-column: 1 / -1; width: 100%; max-width: none; }
  .inventory-search-actions { width: 100%; }
}
</style>
