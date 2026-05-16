<script setup>
import { computed } from "vue";
import { ArrowDown, Calendar, Refresh, Search } from "@element-plus/icons-vue";

const props = defineProps({
  filters: { type: Object, default: () => ({}) },
  shops: { type: Array, default: () => [] },
  searchTypeOptions: { type: Array, default: () => [] },
  syncStatus: { type: String, default: "" },
  syncRunning: { type: Boolean, default: false },
  moreActions: { type: Array, default: () => [] }
});

const emit = defineEmits([
  "update:filters",
  "submit",
  "sync-incremental",
  "sync-full",
  "cancel-sync",
  "more-action",
  "open-quality-rules",
  "reset-dates"
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

function handleCommand(command) {
  emit("more-action", command);
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
            <el-button type="primary" :icon="Search" @click="emit('submit')">查询</el-button>
            <el-button :icon="Calendar" :disabled="syncRunning" @click="emit('reset-dates')">近 90 天</el-button>
            <el-button
              class="orders-toolbar-action-accent"
              :icon="Refresh"
              :loading="syncRunning"
              :disabled="syncRunning"
              @click="emit('sync-incremental')"
            >
              拉取新订单
            </el-button>
            <el-button
              type="primary"
              plain
              :icon="Refresh"
              :loading="syncRunning"
              :disabled="syncRunning"
              @click="emit('sync-full')"
            >
              同步订单
            </el-button>

            <el-dropdown trigger="click" :disabled="syncRunning" @command="handleCommand">
              <el-button :icon="ArrowDown">更多操作</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="action in moreActions" :key="action.value" :command="action.value">
                    {{ action.label }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>

            <el-button v-if="syncRunning" type="danger" plain @click="emit('cancel-sync')">取消同步</el-button>
          </div>
        </div>

        <div class="orders-toolbar-actions-side">
          <el-button :disabled="syncRunning" @click="emit('open-quality-rules')">质检规则</el-button>
        </div>
      </div>
    </el-form>

    <div v-if="syncStatus" class="orders-toolbar-status">{{ syncStatus }}</div>
  </el-card>
</template>
