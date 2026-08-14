<script setup>
import { computed, defineAsyncComponent } from "vue";
import { useRoute, useRouter } from "vue-router";

const MonthlyBillingDetailsView = defineAsyncComponent(() => import("./MonthlyBillingDetailsView.vue"));
const MonthlyBillingOrdersView = defineAsyncComponent(() => import("./MonthlyBillingOrdersView.vue"));
const ProfitAftersalesView = defineAsyncComponent(() => import("./ProfitAftersalesView.vue"));

const route = useRoute();
const router = useRouter();
const tabs = [
  { label: "经营账单", value: "overview" },
  { label: "订单明细", value: "orders" },
  { label: "售后损益", value: "aftersales" }
];
const activeTab = computed(() => {
  const tab = String(route.query.tab || "");
  return ["orders", "aftersales"].includes(tab) ? tab : "overview";
});

function changeTab(tab) {
  router.replace({
    path: "/profit/monthly-billing",
    query: { ...route.query, tab: tab === "overview" ? undefined : tab }
  });
}
</script>

<template>
  <div class="monthly-billing-hub">
    <el-card shadow="never" class="page-card monthly-billing-hub__tabs">
      <el-segmented :model-value="activeTab" :options="tabs" @change="changeTab" />
    </el-card>
    <ProfitAftersalesView v-if="activeTab === 'aftersales'" />
    <MonthlyBillingOrdersView v-else-if="activeTab === 'orders'" />
    <MonthlyBillingDetailsView v-else />
  </div>
</template>

<style scoped>
.monthly-billing-hub {
  display: grid;
  gap: 12px;
}

.monthly-billing-hub__tabs :deep(.el-card__body) {
  padding: 10px 14px;
}
</style>
