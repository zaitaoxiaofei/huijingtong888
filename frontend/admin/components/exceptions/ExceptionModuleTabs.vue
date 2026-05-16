<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

const props = defineProps({
  compact: { type: Boolean, default: false }
});

const route = useRoute();
const router = useRouter();

const tabs = [
  { label: "利润异常", route: "/exceptions/profit" },
  { label: "订单超时", route: "/exceptions/deadline" },
  { label: "超时预警", route: "/exceptions/deadline-warning" },
  { label: "库存异常", route: "/exceptions/stock" },
  { label: "未绑定库存", route: "/exceptions/binding" }
];

const activeRoute = computed(() => tabs.find((item) => route.path === item.route)?.route || "/exceptions/profit");

function change(target) {
  if (target && target !== route.path) {
    router.push({ path: target, query: route.query });
  }
}
</script>

<template>
  <el-card shadow="never" class="page-card exception-module-tabs-card" :class="{ 'is-compact': props.compact }">
    <div v-if="!props.compact" class="exception-module-tabs-card__head">
      <strong>异常页面</strong>
      <span>5 个页面共用一套异常处理上下文。</span>
    </div>
    <el-segmented
      :model-value="activeRoute"
      :options="tabs.map((item) => ({ label: item.label, value: item.route }))"
      @change="change"
    />
  </el-card>
</template>

<style scoped>
.exception-module-tabs-card {
  padding-bottom: 4px;
}

.exception-module-tabs-card.is-compact {
  padding-bottom: 0;
}

.exception-module-tabs-card__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}

.exception-module-tabs-card__head strong {
  color: #0f172a;
}

.exception-module-tabs-card__head span {
  color: #64748b;
  font-size: 13px;
}

@media (max-width: 768px) {
  .exception-module-tabs-card__head {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
