<script setup>
const props = defineProps({
  filters: { type: Object, required: true },
  shops: { type: Array, default: () => [] },
  showShop: { type: Boolean, default: true },
  showDateRange: { type: Boolean, default: true },
  queryLabel: { type: String, default: "关键词" },
  queryPlaceholder: { type: String, default: "产品名称 / SKU / 库存编码" }
});

defineEmits(["search", "reset"]);
</script>

<template>
  <div class="inventory-toolbar inventory-toolbar-sticky">
    <el-form inline class="inventory-toolbar-form">
      <el-form-item :label="queryLabel">
        <el-input
          v-model="props.filters.query"
          :placeholder="queryPlaceholder"
          clearable
          style="width: 320px"
          @keyup.enter="$emit('search')"
        />
      </el-form-item>
      <el-form-item v-if="showShop" label="店铺">
        <el-select v-model="props.filters.shopId" style="width: 180px">
          <el-option label="全部店铺" value="all" />
          <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="showDateRange" label="创建开始">
        <el-date-picker v-model="props.filters.dateFrom" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" />
      </el-form-item>
      <el-form-item v-if="showDateRange" label="创建结束">
        <el-date-picker v-model="props.filters.dateTo" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
      </el-form-item>
      <slot />
      <el-form-item>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="$emit('search')">查询</el-button>
        <el-button class="erp-btn erp-btn-secondary" @click="$emit('reset')">重置</el-button>
      </el-form-item>
      <el-form-item class="inventory-toolbar-actions">
        <slot name="actions" />
      </el-form-item>
    </el-form>
  </div>
</template>
