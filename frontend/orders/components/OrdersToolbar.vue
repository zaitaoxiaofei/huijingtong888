<script setup>
import { computed,inject } from "vue";
import { ArrowDown, Printer, Refresh, Search } from "@element-plus/icons-vue";

import OrderWorkModeSwitch from './OrderWorkModeSwitch.vue';
const workMode=inject('orders-work-mode',null);
const props = defineProps({
  filters: { type: Object, default: () => ({}) },
  shops: { type: Array, default: () => [] },
  logisticsCarrierOptions: { type: Array, default: () => [] },
  logisticsMethodOptions: { type: Array, default: () => [] },
  logisticsServiceClassOptions: { type: Array, default: () => [] },
  searchTypeOptions: { type: Array, default: () => [] },
  syncStatus: { type: String, default: "" },
  syncRunning: { type: Boolean, default: false },
  lastSyncText: { type: String, default: "暂无同步记录" },
  moreActions: { type: Array, default: () => [] },
  selectedCount: { type: Number, default: 0 },
  pageRowCount: { type: Number, default: 0 }
});

const emit = defineEmits([
  "update:filters",
  "submit",
  "sync-incremental",
  "sync-full",
  "cancel-sync",
  "more-action",
  "print-selected",
  "print-page",
  "open-quality-rules",
  "load-logistics-options"
]);

const dateRange = computed({
  get() {
    if (!props.filters?.dateFrom && !props.filters?.dateTo) return [];
    return [props.filters?.dateFrom || "", props.filters?.dateTo || ""];
  },
  set(value) {
    emit("update:filters", {
      ...props.filters,
      dateFrom: Array.isArray(value) ? value[0] || "" : "",
      dateTo: Array.isArray(value) ? value[1] || "" : ""
    });
  }
});

function patchFilters(patch) {
  emit("update:filters", {
    ...props.filters,
    ...patch
  });
}

function changeLogisticsServiceClass(value) {
  const nextFilters = {
    ...props.filters,
    logisticsMethod: "all",
    logisticsServiceClass: value,
    page: 1
  };
  emit("update:filters", nextFilters);
  emit("submit", nextFilters);
}

function changeLogisticsCarrier(value) {
  const nextFilters = { ...props.filters, logisticsCarrier: value, page: 1 };
  emit("update:filters", nextFilters);
  emit("submit", nextFilters);
}

function handleCommand(command) {
  emit("more-action", command);
}

function handlePrintCommand(command) {
  if (command === "print-selected" || command === "print-page") emit(command);
}
</script>

<template>
  <el-card shadow="never" class="orders-toolbar-card">
    <el-form class="orders-toolbar" @submit.prevent>
      <div class="orders-toolbar-row">
        <div class="orders-toolbar-main">
          <el-select
            :model-value="filters.shopId"
            class="orders-toolbar-select"
            @change="patchFilters({ shopId: $event })"
          >
            <el-option label="全部店铺" value="all" />
            <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
          </el-select>

          <el-select
            :model-value="filters.logisticsCarrier"
            class="orders-toolbar-select"
            @change="changeLogisticsCarrier"
          >
            <el-option
              v-for="option in logisticsCarrierOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>

          <el-select
            :model-value="filters.logisticsServiceClass"
            class="orders-toolbar-select orders-toolbar-logistics-select"
            @change="changeLogisticsServiceClass"
            @visible-change="$event && emit('load-logistics-options')"
          >
            <el-option
              v-for="option in logisticsServiceClassOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>

          <div class="orders-toolbar-search-group">
            <el-select
              :model-value="filters.searchType"
              class="orders-toolbar-type"
              @change="patchFilters({ searchType: $event })"
            >
              <el-option v-for="option in searchTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>

            <el-input
              :model-value="filters.searchQuery"
              class="orders-toolbar-search"
              placeholder="请输入搜索内容"
              clearable
              @input="patchFilters({ searchQuery: $event })"
              @keyup.enter="emit('submit')"
            />
          </div>

          <el-date-picker
            v-model="dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="YYYY-MM-DD"
            unlink-panels
            class="orders-toolbar-date"
          />

          <div class="orders-toolbar-actions-main">
            <div class="orders-toolbar-sync-group" aria-label="订单同步操作">
              <el-tooltip content="只拉各店本地最新订单之后的新单，会忽略上方日期；补历史漏单请用“同步当前范围”。" placement="top">
                <el-button
                  class="orders-toolbar-btn orders-toolbar-btn-primary orders-toolbar-action-accent"
                  :icon="Refresh"
                  :loading="syncRunning"
                  :disabled="syncRunning"
                  @click="emit('sync-incremental')"
                >
                  拉取新订单
                </el-button>
              </el-tooltip>
              <el-tooltip :content="`最近成功同步：${lastSyncText}（北京时间）。按当前店铺和日期范围校正订单状态或补历史漏单。`" placement="top">
                <el-button
                  class="orders-toolbar-btn orders-toolbar-btn-secondary"
                  type="primary"
                  plain
                  :icon="Refresh"
                  :loading="syncRunning"
                  :disabled="syncRunning"
                  @click="emit('sync-full')"
                >
                  同步当前范围
                </el-button>
              </el-tooltip>
            </div>

            <el-button class="orders-toolbar-btn orders-toolbar-btn-primary" type="primary" :icon="Search" @click="emit('submit')">查询</el-button>

            <el-dropdown trigger="click" :disabled="syncRunning" @command="handleCommand">
              <el-button class="orders-toolbar-btn orders-toolbar-btn-secondary" :icon="ArrowDown">更多操作</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="action in moreActions" :key="action.value" :command="action.value" :disabled="action.requiresSelection && !selectedCount">
                    {{ action.label }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>

            <el-dropdown
              class="orders-toolbar-print"
              split-button
              trigger="click"
              :button-props="{ class: 'orders-toolbar-btn orders-toolbar-btn-secondary' }"
              :disabled="syncRunning || !pageRowCount"
              @click="emit('print-selected')"
              @command="handlePrintCommand"
            >
              <el-icon class="el-icon--left"><Printer /></el-icon>批量打印
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="print-selected" :disabled="!selectedCount">打印所选</el-dropdown-item>
                  <el-dropdown-item command="print-page" :disabled="!pageRowCount">打印整页</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>

            <el-button v-if="syncRunning" class="orders-toolbar-btn orders-toolbar-btn-danger" type="danger" plain @click="emit('cancel-sync')">取消同步</el-button>
          </div>
        </div>

        <div class="orders-toolbar-actions-side">
          <el-dropdown trigger="click" @command="handleCommand">
            <el-button class="orders-toolbar-btn orders-toolbar-btn-secondary" :icon="ArrowDown">OGL 发运</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="ogl-create-batch" :disabled="!selectedCount">创建发运（已选 {{ selectedCount }} 单）</el-dropdown-item>
                <el-dropdown-item command="ogl-official-carriages">已申请</el-dropdown-item>
                <el-dropdown-item command="ogl-batch-history">发运历史</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <OrderWorkModeSwitch v-if="workMode" :mode="workMode.mode.value" @change="workMode.mode.value=$event"/>
        </div>
      </div>
    </el-form>

    <slot />

    <div v-if="syncStatus" class="orders-toolbar-status">{{ syncStatus }}</div>
  </el-card>
</template>
