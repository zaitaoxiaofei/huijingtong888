<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();

const tabs = [
  { key: "dashboard", label: "利润看板", route: "/profit" },
  { key: "sku", label: "SKU 排行榜", route: "/profit/sku-ranking" },
  { key: "shop", label: "店铺排行榜", route: "/profit/shop-ranking" }
];

const activeRoute = computed(() => {
  const matched = tabs.find((item) => route.path === item.route);
  return matched?.route || "/profit";
});

function handleChange(target) {
  if (target && target !== route.path) {
    router.push(target);
  }
}
</script>

<template>
  <el-card shadow="never" class="page-card profit-module-tabs-card">
    <div class="profit-module-tabs-card__head">
      <strong>利润模块</strong>
      <span>看板、SKU 排行榜、店铺排行榜互相可达，保持同一业务上下文。</span>
    </div>
    <el-segmented
      :model-value="activeRoute"
      :options="tabs.map((item) => ({ label: item.label, value: item.route }))"
      @change="handleChange"
    />
  </el-card>
</template>

<style scoped>
.profit-module-tabs-card {
  padding-bottom: 4px;
}

.profit-module-tabs-card__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}

.profit-module-tabs-card__head strong {
  color: #0f172a;
}

.profit-module-tabs-card__head span {
  color: #64748b;
  font-size: 13px;
}

@media (max-width: 768px) {
  .profit-module-tabs-card__head {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
