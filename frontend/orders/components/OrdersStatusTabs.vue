<script setup>
import { computed } from "vue";

const props = defineProps({
  statusTabs: { type: Array, default: () => [] },
  activeStatus: { type: String, default: "all" },
  printViews: { type: Array, default: () => [] },
  activePrintView: { type: String, default: "all" },
  markOptions: { type: Array, default: () => [] },
  activeMarkFilter: { type: String, default: "all" },
  selectedCount: { type: Number, default: 0 }
});

const emit = defineEmits([
  "change-status",
  "change-print-view",
  "change-mark-filter",
  "bulk-print",
  "bulk-prepare"
]);

const visibleMarkFilters = computed(() => (
  (props.markOptions || []).filter((item) => item && item.filterable !== false && item.value)
));

const deliveryPrintViews = computed(() => (
  (props.printViews || []).filter((item) => item && item.value !== "all")
));

function actionLabel(base, count) {
  return count > 0 ? `${base} ${count}` : base;
}

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

        <div v-if="visibleMarkFilters.length" class="orders-chip-row orders-chip-row-inline orders-chip-row-marks">
          <button
            v-for="item in visibleMarkFilters"
            :key="`mark-${item.value}`"
            type="button"
            class="orders-chip-button orders-chip-button-mark orders-chip-button-subtle"
            :class="{ active: activeMarkFilter === item.value }"
            @click="emit('change-mark-filter', item.value)"
          >
            <span class="orders-mark-filter-dot" :class="`is-${item.color || 'gray'}`"></span>
            {{ item.label }}
          </button>
        </div>

        <div class="orders-status-actions">
          <span class="orders-selected-count" :class="{ active: selectedCount > 0 }">已选 {{ selectedCount }}</span>
          <button
            type="button"
            class="orders-chip-button orders-status-action-button orders-status-action-print"
            :disabled="selectedCount <= 0"
            @click="emit('bulk-print')"
          >
            {{ actionLabel("批量打印", selectedCount) }}
          </button>
          <el-button
            class="orders-status-action-slot orders-status-action-prepare orders-toolbar-btn orders-toolbar-btn-primary"
            type="primary"
            :disabled="selectedCount <= 0"
            @click="emit('bulk-prepare')"
          >
            {{ actionLabel("批量备货", selectedCount) }}
          </el-button>
        </div>
      </div>
    </div>
  </div>
</template>
