<script setup>
import { computed, provide, ref } from "vue";
import { useRoute } from "vue-router";
import ErpPageHeader from "../../components/ErpPageHeader.vue";

const route = useRoute();
const replenishmentStatus = ref("applying");
const replenishmentStatusTabs = [
  { label: "申请中", value: "applying" },
  { label: "已通过", value: "approved" },
  { label: "待发货", value: "waiting_shipment" },
  { label: "已完成", value: "completed" },
  { label: "已取消", value: "cancelled" },
  { label: "全部", value: "all" }
];

provide("inventoryFbpReplenishmentStatus", replenishmentStatus);

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
const isFbpReplenishment = computed(() => route.name === "inventory-fbp-replenishment");
</script>

<template>
  <div class="page-stack inventory-module-page">
    <el-card shadow="never" class="page-card inventory-module-card">
      <ErpPageHeader :title="pageTitle" :description="pageDescription" compact>
        <template v-if="isFbpReplenishment" #actions>
          <div class="inventory-header-status" role="tablist" aria-label="备货进度">
            <button
              v-for="tab in replenishmentStatusTabs"
              :key="tab.value"
              type="button"
              role="tab"
              :class="{ 'is-active': replenishmentStatus === tab.value }"
              :aria-selected="replenishmentStatus === tab.value"
              @click="replenishmentStatus = tab.value"
            >
              {{ tab.label }}
            </button>
          </div>
        </template>
      </ErpPageHeader>
      <router-view />
    </el-card>
  </div>
</template>

<style scoped>
.inventory-header-status {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.inventory-header-status button {
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid #dbe3ef;
  border-radius: 9px;
  background: #fff;
  color: #475569;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  white-space: nowrap;
}

.inventory-header-status button:hover {
  border-color: #a5b4fc;
  color: #4338ca;
}

.inventory-header-status button:focus-visible {
  outline: 3px solid rgba(99, 91, 255, 0.2);
  outline-offset: 2px;
}

.inventory-header-status button.is-active {
  border-color: #635bff;
  background: #635bff;
  color: #fff;
  box-shadow: 0 4px 10px rgba(99, 91, 255, 0.2);
}

@media (max-width: 720px) {
  .inventory-header-status {
    width: 100%;
    justify-content: stretch;
  }

  .inventory-header-status button {
    flex: 1 1 calc(33.333% - 6px);
    padding-inline: 8px;
  }
}
</style>
