<script setup>
import { computed, onBeforeUnmount, onMounted } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { ArrowLeft, House, Monitor, Refresh, ShoppingCart, Tickets } from "@element-plus/icons-vue";
import { useAuthStore } from "../stores/auth";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const title = computed(() => route.meta?.title || "手机工作台");
const canGoBack = computed(() => !["mobile-home", "mobile-orders", "mobile-procurement"].includes(route.name));

function setMobileViewportState(enabled) {
  document.documentElement.classList.toggle("admin-mobile-open", enabled);
  document.body.classList.toggle("admin-mobile-open", enabled);
}

function goBack() {
  if (window.history.length > 1) {
    router.back();
    return;
  }
  router.push("/mobile/orders");
}

function openDesktop() {
  window.localStorage?.setItem("baodanMobileMode", "desktop");
  router.push("/orders");
}

function refreshPage() {
  router.go(0);
}

onMounted(() => setMobileViewportState(true));
onBeforeUnmount(() => setMobileViewportState(false));
</script>

<template>
  <main class="mobile-shell">
    <header class="mobile-topbar">
      <button v-if="canGoBack" type="button" class="mobile-icon-button" aria-label="返回" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
      </button>
      <RouterLink v-else to="/mobile/orders" class="mobile-icon-button" aria-label="手机工作台">
        <el-icon><House /></el-icon>
      </RouterLink>

      <div class="mobile-topbar__title">
        <strong>{{ title }}</strong>
        <span>{{ authStore.user?.name || authStore.user?.username || "ERP" }}</span>
      </div>

      <button type="button" class="mobile-icon-button" aria-label="刷新" @click="refreshPage">
        <el-icon><Refresh /></el-icon>
      </button>
      <button type="button" class="mobile-icon-button" aria-label="电脑版" @click="openDesktop">
        <el-icon><Monitor /></el-icon>
      </button>
    </header>

    <section class="mobile-content">
      <RouterView />
    </section>

    <nav class="mobile-tabbar" aria-label="手机导航">
      <RouterLink to="/mobile/orders" class="mobile-tabbar__item">
        <el-icon><Tickets /></el-icon>
        <span>订单</span>
      </RouterLink>
      <RouterLink to="/mobile/orders?status=unbound" class="mobile-tabbar__item">
        <span class="mobile-tabbar__dot"></span>
        <span>待绑定</span>
      </RouterLink>
      <RouterLink to="/mobile/procurement" class="mobile-tabbar__item">
        <el-icon><ShoppingCart /></el-icon>
        <span>采购</span>
      </RouterLink>
    </nav>
  </main>
</template>

<style scoped>
.mobile-shell {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  background: #f4f7fb;
  color: #172033;
  touch-action: manipulation;
}

.mobile-topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 38px 38px;
  gap: 8px;
  align-items: center;
  padding: max(10px, env(safe-area-inset-top)) 12px 10px;
  border-bottom: 1px solid #dbe3ef;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(12px);
}

.mobile-icon-button {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid #dbe3ef;
  border-radius: 10px;
  background: #fff;
  color: #334155;
  text-decoration: none;
}

.mobile-topbar__title {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.mobile-topbar__title strong,
.mobile-topbar__title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-topbar__title strong {
  font-size: 16px;
  line-height: 1.2;
}

.mobile-topbar__title span {
  color: #64748b;
  font-size: 12px;
}

.mobile-content {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 12px 12px calc(76px + env(safe-area-inset-bottom));
  touch-action: pan-y;
}

.mobile-tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  border-top: 1px solid #dbe3ef;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(12px);
}

.mobile-tabbar__item {
  min-width: 0;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 12px;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
}

.mobile-tabbar__item.router-link-active {
  background: #eaf1ff;
  color: #1d4ed8;
}

.mobile-tabbar__dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #ef4444;
}

.mobile-tabbar__dot.is-warning {
  background: #f59e0b;
}
</style>
