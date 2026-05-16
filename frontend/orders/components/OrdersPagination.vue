<script setup>
const props = defineProps({
  page: { type: Number, default: 1 },
  totalPages: { type: Number, default: 1 },
  pageSize: { type: Number, default: 50 },
  total: { type: Number, default: 0 }
});

const emit = defineEmits(["change-page", "change-page-size"]);
</script>

<template>
  <el-card shadow="never" class="orders-pagination-card">
    <div class="orders-pagination">
      <div class="orders-pagination-summary">第 {{ page }} / {{ totalPages }} 页，共 {{ total }} 条记录</div>
      <div class="orders-pagination-actions">
        <div class="orders-page-size">
          <span>每页</span>
          <el-select :model-value="pageSize" size="small" class="orders-pagination-size" @change="emit('change-page-size', Number($event))">
            <el-option label="30 条" :value="30" />
            <el-option label="50 条" :value="50" />
            <el-option label="100 条" :value="100" />
          </el-select>
        </div>
        <el-pagination
          background
          size="small"
          layout="prev, pager, next"
          :current-page="page"
          :page-size="pageSize"
          :total="total"
          @current-change="emit('change-page', $event)"
        />
      </div>
    </div>
  </el-card>
</template>
