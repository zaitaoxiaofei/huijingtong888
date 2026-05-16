<script setup>
import { computed } from "vue";

const props = defineProps({
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 30 },
  totalPages: { type: Number, default: 0 },
  pageSizes: { type: Array, default: () => [30, 50, 100] },
  compact: { type: Boolean, default: false },
  summary: { type: String, default: "" },
  pageSizeLabel: { type: String, default: "每页" }
});

const emit = defineEmits(["update:page", "update:pageSize"]);

const resolvedTotalPages = computed(() => {
  const explicit = Number(props.totalPages || 0);
  if (explicit > 0) return explicit;
  const size = Math.max(1, Number(props.pageSize || 1));
  return Math.max(1, Math.ceil(Number(props.total || 0) / size));
});

const summaryText = computed(() => (
  String(props.summary || "").trim() || `第 ${Number(props.page || 1)} / ${resolvedTotalPages.value} 页，共 ${Number(props.total || 0)} 条记录`
));
</script>

<template>
  <div class="table-footer erp-footer-pagination" :class="{ 'is-compact': compact }">
    <div class="table-footer-meta erp-footer-pagination__meta">{{ summaryText }}</div>
    <div class="erp-footer-pagination__actions">
      <div class="erp-page-size">
        <span>{{ pageSizeLabel }}</span>
        <el-select
          :model-value="pageSize"
          size="small"
          class="erp-page-size__select"
          @change="emit('update:pageSize', Number($event))"
        >
          <el-option v-for="size in pageSizes" :key="size" :label="`${size} 条`" :value="size" />
        </el-select>
      </div>
      <el-pagination
        background
        size="small"
        layout="prev, pager, next"
        :current-page="page"
        :page-size="pageSize"
        :page-sizes="pageSizes"
        :total="total"
        @current-change="emit('update:page', $event)"
      />
    </div>
  </div>
</template>
