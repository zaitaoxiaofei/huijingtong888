<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Bell, Expand, Fold, MoonNight, Sunny } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { navigationMenus } from "../constants/navigation.js";
import { useAuthStore } from "../stores/auth";
import { useAppStore } from "../stores/app";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const appStore = useAppStore();
const DYNAMIC_IMPORT_INTENDED_ROUTE = "ozon-admin-dynamic-import-intended-route";

const activeMenu = computed(() => route.path);
const breadcrumbs = computed(() => route.meta.breadcrumb || ["ERP 后台"]);
const themeIcon = computed(() => (appStore.theme === "dark" ? Sunny : MoonNight));
const themeTitle = computed(() => (appStore.theme === "dark" ? "切换为亮色主题" : "切换为暗色主题"));

function rememberIntendedRoute(target) {
  const routeTarget = String(target || "").trim();
  if (routeTarget.startsWith("/")) sessionStorage.setItem(DYNAMIC_IMPORT_INTENDED_ROUTE, routeTarget);
}

function handleMenuSelect(index) {
  const target = String(index || "").trim();
  if (!target.startsWith("/")) return;
  rememberIntendedRoute(target);
  if (target === route.path && !Object.keys(route.query || {}).length) return;
  router.push({ path: target }).catch(() => {});
}

async function handleLogout() {
  await ElMessageBox.confirm("确认退出当前账号吗？", "退出确认", {
    type: "warning",
    confirmButtonText: "退出登录",
    cancelButtonText: "取消"
  });
  await authStore.logout();
  ElMessage.success("已退出登录");
  router.push("/login");
}

function openDashboard() {
  rememberIntendedRoute("/dashboard");
  router.push("/dashboard");
}
</script>

<template>
  <el-container class="erp-shell">
    <el-aside :width="appStore.sidebarCollapsed ? '56px' : '190px'" class="erp-sidebar">
      <div class="erp-sidebar-inner">
        <button type="button" class="erp-logo" @click="openDashboard">
          <div class="erp-logo-mark">OZON</div>
        </button>

        <el-scrollbar class="erp-sidebar-scroll">
          <el-menu
            :default-active="activeMenu"
            :collapse="appStore.sidebarCollapsed"
            class="erp-menu"
            @select="handleMenuSelect"
          >
            <template v-for="menu in navigationMenus" :key="menu.key">
              <el-sub-menu v-if="menu.children?.length" :index="menu.key">
                <template #title>
                  <el-icon><component :is="menu.icon" /></el-icon>
                  <span>{{ menu.label }}</span>
                </template>
                <el-menu-item v-for="child in menu.children" :key="child.key" :index="child.route">
                  {{ child.label }}
                </el-menu-item>
              </el-sub-menu>
              <el-menu-item v-else :index="menu.route || menu.key">
                <el-icon><component :is="menu.icon" /></el-icon>
                <span>{{ menu.label }}</span>
              </el-menu-item>
            </template>
          </el-menu>
        </el-scrollbar>
      </div>
    </el-aside>

    <el-container class="erp-main-shell">
      <el-header class="erp-header">
        <div class="erp-header-left">
          <el-button text @click="appStore.toggleSidebar()">
            <el-icon size="18"><component :is="appStore.sidebarCollapsed ? Expand : Fold" /></el-icon>
          </el-button>
          <div class="erp-page-meta">
            <el-breadcrumb separator="/">
              <el-breadcrumb-item v-for="item in breadcrumbs" :key="item">{{ item }}</el-breadcrumb-item>
            </el-breadcrumb>
          </div>
        </div>

        <div class="erp-header-right">
          <el-badge :value="0" class="erp-header-badge">
            <el-button circle>
              <el-icon><Bell /></el-icon>
            </el-button>
          </el-badge>
          <el-button circle class="erp-theme-toggle" :title="themeTitle" @click="appStore.toggleTheme()">
            <el-icon><component :is="themeIcon" /></el-icon>
          </el-button>
          <div class="erp-user-card">
            <div class="erp-user-meta">
              <strong>{{ authStore.user?.name || authStore.user?.username || "Unknown" }}</strong>
            </div>
            <el-button link type="primary" @click="handleLogout">Logout</el-button>
          </div>
        </div>
      </el-header>

      <el-main class="erp-content">
        <div class="erp-content-inner">
          <router-view :key="route.fullPath" />
        </div>
      </el-main>
    </el-container>
  </el-container>
</template>
