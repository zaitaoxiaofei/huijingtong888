<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Box, Connection, Goods, Monitor, ShoppingCart, Tickets, Warning } from "@element-plus/icons-vue";

const route = useRoute();
const router = useRouter();

const desktopTarget = computed(() => {
  const target = String(route.query.desktopTarget || "").trim();
  return target.startsWith("/") && !target.startsWith("/mobile") ? target : "";
});

const workbenchItems = [
  {
    title: "订单工作台",
    description: "查看订单、待绑定商品和发货状态",
    route: "/mobile/orders",
    icon: Tickets,
    tone: "blue"
  },
  {
    title: "采购工作台",
    description: "处理采购需求、到货和入库任务",
    route: "/mobile/procurement",
    icon: ShoppingCart,
    tone: "green"
  },
  {
    title: "库存查询",
    description: "按商品名、库存编码或 SKU 快速查库存",
    route: "/mobile/inventory",
    icon: Goods,
    tone: "purple"
  },
  {
    title: "待绑定订单",
    description: "快速定位尚未绑定库存商品的订单",
    route: "/mobile/orders?status=unbound",
    icon: Warning,
    tone: "orange"
  },
  {
    title: "库存预警",
    description: "查看断货、低库存和 FBP 备货建议",
    route: "/mobile/stock-alerts",
    icon: Warning,
    tone: "red"
  },
  {
    title: "在线商品",
    description: "查询 Ozon 在售商品、价格、库存和绑定状态",
    route: "/mobile/online-products",
    icon: Connection,
    tone: "cyan"
  }
];

function openWorkbench(target) {
  router.push(target);
}

function openDesktopTarget() {
  window.localStorage?.setItem("baodanMobileMode", "desktop");
  router.push(desktopTarget.value || "/dashboard");
}
</script>

<template>
  <div class="mobile-home-page">
    <section class="mobile-home-hero">
      <span class="mobile-home-hero__icon"><el-icon><Box /></el-icon></span>
      <div>
        <p>爆单 ERP</p>
        <h1>手机工作台</h1>
        <span>先处理高频任务，复杂编辑可继续使用电脑版。</span>
      </div>
    </section>

    <button
      v-if="desktopTarget"
      type="button"
      class="mobile-continue-card"
      @click="openDesktopTarget"
    >
      <el-icon><Monitor /></el-icon>
      <span>
        <strong>继续访问原页面</strong>
        <small>{{ desktopTarget }}</small>
      </span>
      <b>打开</b>
    </button>

    <section class="mobile-home-section">
      <div class="mobile-home-section__heading">
        <strong>常用工作台</strong>
        <span>适合手机操作</span>
      </div>
      <div class="mobile-home-grid">
        <button
          v-for="item in workbenchItems"
          :key="item.route"
          type="button"
          class="mobile-home-card"
          :class="`is-${item.tone}`"
          @click="openWorkbench(item.route)"
        >
          <span class="mobile-home-card__icon"><el-icon><component :is="item.icon" /></el-icon></span>
          <strong>{{ item.title }}</strong>
          <small>{{ item.description }}</small>
        </button>
      </div>
    </section>

    <button type="button" class="mobile-desktop-entry" @click="openDesktopTarget">
      <el-icon><Monitor /></el-icon>
      <span>打开完整电脑版</span>
    </button>
  </div>
</template>

<style scoped>
.mobile-home-page { display: grid; gap: 14px; }
.mobile-home-hero { min-height: 132px; display: flex; align-items: center; gap: 14px; padding: 20px; border-radius: 18px; color: #fff; background: linear-gradient(135deg, #1d4ed8, #2563eb 55%, #38bdf8); box-shadow: 0 14px 30px rgba(37, 99, 235, 0.2); }
.mobile-home-hero__icon { width: 52px; height: 52px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 16px; background: rgba(255, 255, 255, 0.18); font-size: 26px; }
.mobile-home-hero p, .mobile-home-hero h1, .mobile-home-hero span { margin: 0; }
.mobile-home-hero p { color: #dbeafe; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.mobile-home-hero h1 { margin-top: 4px; font-size: 24px; line-height: 1.25; }
.mobile-home-hero div > span { display: block; margin-top: 7px; color: #e0f2fe; font-size: 13px; line-height: 1.5; }
.mobile-continue-card, .mobile-desktop-entry { width: 100%; min-height: 52px; display: flex; align-items: center; gap: 12px; border: 1px solid #c7d7f2; border-radius: 14px; background: #fff; color: #1e3a5f; text-align: left; }
.mobile-continue-card { padding: 12px 14px; }
.mobile-continue-card > .el-icon { font-size: 22px; color: #2563eb; }
.mobile-continue-card span { min-width: 0; display: grid; flex: 1; gap: 3px; }
.mobile-continue-card small { overflow: hidden; color: #64748b; text-overflow: ellipsis; white-space: nowrap; }
.mobile-continue-card b { color: #2563eb; font-size: 13px; }
.mobile-home-section { display: grid; gap: 10px; }
.mobile-home-section__heading { display: flex; align-items: baseline; justify-content: space-between; padding: 0 2px; }
.mobile-home-section__heading strong { color: #172033; font-size: 16px; }
.mobile-home-section__heading span { color: #64748b; font-size: 12px; }
.mobile-home-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.mobile-home-card { min-width: 0; min-height: 148px; display: flex; align-items: flex-start; flex-direction: column; gap: 8px; padding: 14px; border: 1px solid #dbe3ef; border-radius: 16px; background: #fff; color: #172033; text-align: left; }
.mobile-home-card__icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; font-size: 20px; }
.mobile-home-card.is-blue .mobile-home-card__icon { color: #1d4ed8; background: #dbeafe; }
.mobile-home-card.is-green .mobile-home-card__icon { color: #047857; background: #d1fae5; }
.mobile-home-card.is-orange .mobile-home-card__icon { color: #c2410c; background: #ffedd5; }
.mobile-home-card.is-purple .mobile-home-card__icon { color: #6d28d9; background: #ede9fe; }
.mobile-home-card.is-red .mobile-home-card__icon { color: #b91c1c; background: #fee2e2; }
.mobile-home-card.is-cyan .mobile-home-card__icon { color: #0e7490; background: #cffafe; }
.mobile-home-card strong { font-size: 14px; line-height: 1.35; }
.mobile-home-card small { color: #64748b; font-size: 12px; line-height: 1.5; }
.mobile-desktop-entry { justify-content: center; padding: 0 16px; color: #475569; font-size: 14px; font-weight: 700; }
@media (max-width: 360px) {
  .mobile-home-grid { grid-template-columns: 1fr; }
  .mobile-home-card { min-height: 116px; }
}
</style>
