<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import ErpPageHeader from "../../components/ErpPageHeader.vue";

const route = useRoute();

const pageDescriptionMap = {
  "inventory-products": "维护商品库存、成本、供应商与采购资料。",
  "inventory-fbp": "查看各店铺 FBP 库存和库存状态。",
  "inventory-fbp-opportunities": "根据销售和库存信号识别备货机会。",
  "inventory-fbp-replenishment": "集中处理 FBP 备货申请与执行记录。",
  "inventory-hidden": "查看和恢复已删除的库存商品。",
  "inventory-mappings": "维护库存商品与店铺 SKU 的绑定关系。",
  "inventory-suppliers": "维护采购供应商及其业务资料。",
  "inventory-alerts": "查看需要优先处理的库存风险。"
};

const pageTitle = computed(() => String(route.meta?.title || "库存中心"));
const pageDescription = computed(() => pageDescriptionMap[String(route.name || "")] || "统一管理库存商品、库存风险和备货流程。");
</script>

<template>
  <div class="page-stack inventory-module-page">
    <el-card shadow="never" class="page-card inventory-module-card">
      <ErpPageHeader :title="pageTitle" :description="pageDescription" compact />
      <router-view />
    </el-card>
  </div>
</template>
