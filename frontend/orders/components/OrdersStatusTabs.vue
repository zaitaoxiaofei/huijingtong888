<script setup>
import { computed } from "vue";
import { Sort } from "@element-plus/icons-vue";

const props = defineProps({
  statusTabs: { type: Array, default: () => [] },
  activeStatus: { type: String, default: "all" },
  fulfillmentTypeOptions: { type: Array, default: () => [] },
  activeFulfillmentType: { type: String, default: "all" },
  printViews: { type: Array, default: () => [] },
  activePrintView: { type: String, default: "all" },
  markOptions: { type: Array, default: () => [] },
  activeMarkFilter: { type: String, default: "all" },
  selectedCount: { type: Number, default: 0 }
});

const emit = defineEmits([
  "change-status",
  "change-fulfillment-type",
  "change-print-view",
  "change-mark-filter",
  "configure-status-tabs"
]);

const visibleMarkFilters = computed(() => [
  { value: "all", label: "全部标记", color: "none" },
  ...(props.markOptions || []).filter((item) => item && item.filterable !== false && item.value)
]);

const deliveryPrintViews = computed(() => (
  (props.printViews || []).filter((item) => item && item.value !== "all")
));

const visibleFulfillmentTypes = computed(() => (
  (props.fulfillmentTypeOptions || []).filter((item) => item && item.value !== "all")
));

function tabTone(value) {
  return {
    all: "slate",
    awaiting_packaging: "amber",
    awaiting_deliver: "blue",
    delivering: "green",
    dispute: "red",
    delivered: "teal",
    cancelled: "gray",
    unbound: "orange",
    pending_purchase: "red",
    stock_issue: "red"
  }[value] || "slate";
}
</script>

<template>
  <div class="orders-status-card">
    <div class="orders-status-strip">
      <div class="orders-status-topline orders-status-topline-unified">
        <div class="orders-status-grid">
          <button
            v-for="tab in statusTabs"
            :key="tab.value"
            type="button"
            class="orders-status-item"
            :class="[`tone-${tabTone(tab.value)}`, { active: activeStatus === tab.value }]"
            @click="emit('change-status', tab.value)"
          >
            <span class="orders-status-item-dot" />
            <span class="orders-status-item-label">{{ tab.label }}</span>
            <strong class="orders-status-item-count">{{ tab.count }}</strong>
          </button>
        </div>

        <el-select
          class="orders-mark-filter-select"
          :model-value="activeMarkFilter"
          aria-label="手动标记筛选"
          @change="emit('change-mark-filter', $event)"
        >
          <el-option
            v-for="item in visibleMarkFilters"
            :key="`mark-${item.value}`"
            :label="item.label"
            :value="item.value"
          >
            <span v-if="item.value !== 'all'" class="orders-mark-filter-dot" :class="`is-${item.color || 'gray'}`"></span>
            {{ item.label }}
          </el-option>
        </el-select>

        <div v-if="visibleFulfillmentTypes.length" class="orders-chip-row orders-chip-row-inline orders-chip-row-print">
          <button
            v-for="item in visibleFulfillmentTypes"
            :key="`fulfillment-${item.value}`"
            type="button"
            class="orders-chip-button orders-chip-button-print-slot"
            :class="{ active: activeFulfillmentType === item.value }"
            @click="emit('change-fulfillment-type', item.value)"
          >
            {{ item.label }}
          </button>
        </div>

        <div v-if="deliveryPrintViews.length" class="orders-chip-row orders-chip-row-inline orders-chip-row-print">
          <button
            v-for="item in deliveryPrintViews"
            :key="`print-${item.value}`"
            type="button"
            class="orders-chip-button orders-chip-button-print-slot"
            :class="{ active: activePrintView === item.value }"
            @click="emit('change-print-view', item.value)"
          >
            {{ item.label }}
          </button>
        </div>

        <div class="orders-status-actions">
          <el-tooltip content="调整订单标签顺序" placement="top">
            <button type="button" class="orders-status-sort-button" aria-label="调整订单标签顺序" @click="emit('configure-status-tabs')">
              <el-icon><Sort /></el-icon>
            </button>
          </el-tooltip>
          <span class="orders-selected-count" :class="{ active: selectedCount > 0 }">已选 {{ selectedCount }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
