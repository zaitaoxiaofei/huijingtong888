<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { Bell, Close, Expand, Fold, MoonNight, Paperclip, RefreshRight, Sunny } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { navigationMenus } from "../constants/navigation.js";
import { prefetchRouteComponent } from "../router";
import { useAuthStore } from "../stores/auth";
import { useAppStore } from "../stores/app";
import { useWorkspaceTabsStore } from "../stores/workspaceTabs";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const appStore = useAppStore();
const tabsStore = useWorkspaceTabsStore();
tabsStore.restoreTabs(router);
const DYNAMIC_IMPORT_INTENDED_ROUTE = "ozon-admin-dynamic-import-intended-route";
const menuRef = ref(null);

const activeMenu = computed(() => route.path);
const breadcrumbs = computed(() => route.meta.breadcrumb || ["ERP Admin"]);
const breadcrumbItems = computed(() => {
  const items = Array.isArray(breadcrumbs.value) ? breadcrumbs.value.filter(Boolean) : [];
  if (items.length <= 2) return items;
  return [items[0], items[items.length - 1]];
});
const currentPageTitle = computed(() => breadcrumbItems.value[breadcrumbItems.value.length - 1] || "ERP Admin");
const themeIcon = computed(() => (appStore.theme === "dark" ? Sunny : MoonNight));
const themeTitle = computed(() => (appStore.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"));
const workspaceTabs = computed(() => tabsStore.tabs);
const activeTabKey = computed(() => tabsStore.activeKey);
const contextMenu = ref({
  visible: false,
  tabKey: "",
  x: 0,
  y: 0
});
const pluginUpdate = ref(null);
const routeSwitching = ref(false);
let routeSwitchTimer = 0;
const prefetchedRoutes = new Set();
const submenuKeys = navigationMenus.filter((menu) => menu.children?.length).map((menu) => menu.key);
const menuParentByRoute = navigationMenus.reduce((map, menu) => {
  if (!menu.children?.length) return map;
  menu.children.forEach((child) => {
    map.set(child.route, menu.key);
  });
  return map;
}, new Map());

function rememberIntendedRoute(target) {
  const routeTarget = String(target || "").trim();
  if (routeTarget.startsWith("/")) sessionStorage.setItem(DYNAMIC_IMPORT_INTENDED_ROUTE, routeTarget);
}

function handleMenuSelect(index) {
  const target = String(index || "").trim();
  if (!target.startsWith("/")) return;
  rememberIntendedRoute(target);
  if (target === route.path && !Object.keys(route.query || {}).length) return;
  showRouteSwitching();
  router.push({ path: target }).catch(() => {});
}

function showRouteSwitching() {
  window.clearTimeout(routeSwitchTimer);
  routeSwitching.value = true;
  routeSwitchTimer = window.setTimeout(() => {
    routeSwitching.value = false;
  }, 5000);
}

function prefetchMenuRoute(target) {
  const routeTarget = String(target || "").trim();
  if (!routeTarget.startsWith("/") || prefetchedRoutes.has(routeTarget)) return;
  prefetchedRoutes.add(routeTarget);
  prefetchRouteComponent(routeTarget);
}

async function handleLogout() {
  await ElMessageBox.confirm("Confirm logout from the current account?", "Logout", {
    type: "warning",
    confirmButtonText: "Logout",
    cancelButtonText: "Cancel"
  });
  await authStore.logout();
  ElMessage.success("Logged out");
  router.push("/login");
}

function openDashboard() {
  rememberIntendedRoute("/dashboard");
  showRouteSwitching();
  router.push("/dashboard");
}

function handleTabClick(key) {
  const tab = tabsStore.findTab(key);
  if (!tab || tab.route.fullPath === route.fullPath) return;
  rememberIntendedRoute(tab.route.fullPath);
  showRouteSwitching();
  router.push(tab.route.fullPath).catch(() => {});
}

function handleTabClose(key) {
  const fallbackRoute = tabsStore.closeTab(key);
  if (!fallbackRoute || fallbackRoute === route.fullPath) return;
  rememberIntendedRoute(fallbackRoute);
  showRouteSwitching();
  router.push(fallbackRoute).catch(() => {});
}

function handleTabCommand(command) {
  const targetTab = contextTab.value;
  closeTabContextMenu();

  if (command === "refresh") {
    tabsStore.refreshActiveTab();
    return;
  }

  if (command === "close-others") {
    const fallbackRoute = tabsStore.closeOtherTabs(activeTabKey.value);
    if (!fallbackRoute || fallbackRoute === route.fullPath) return;
    rememberIntendedRoute(fallbackRoute);
    showRouteSwitching();
    router.push(fallbackRoute).catch(() => {});
    return;
  }

  if (command === "close-all") {
    const fallbackRoute = tabsStore.closeAllTabs();
    if (!fallbackRoute || fallbackRoute === route.fullPath) return;
    rememberIntendedRoute(fallbackRoute);
    showRouteSwitching();
    router.push(fallbackRoute).catch(() => {});
    return;
  }

  const tab = targetTab;
  if (!tab) return;

  if (command === "pin") {
    tabsStore.pinTab(tab.key);
    return;
  }

  if (command === "unpin") {
    tabsStore.unpinTab(tab.key);
    return;
  }

  if (command === "refresh-tab") {
    if (activeTabKey.value !== tab.key) {
      rememberIntendedRoute(tab.route.fullPath);
      showRouteSwitching();
      router.push(tab.route.fullPath).catch(() => {});
    }
    tabsStore.refreshActiveTab();
    return;
  }

  if (command === "close-tab") {
    handleTabClose(tab.key);
    return;
  }

  if (command === "open-window") {
    window.open(`#${tab.route.fullPath}`, "_blank", "noopener,noreferrer");
    return;
  }

  if (command === "close-left") {
    const fallbackRoute = tabsStore.closeLeftTabs(tab.key);
    if (!fallbackRoute) return;
    if (route.fullPath !== fallbackRoute) {
      rememberIntendedRoute(fallbackRoute);
      showRouteSwitching();
      router.push(fallbackRoute).catch(() => {});
    }
    return;
  }

  if (command === "close-right") {
    const fallbackRoute = tabsStore.closeRightTabs(tab.key);
    if (!fallbackRoute) return;
    if (route.fullPath !== fallbackRoute) {
      rememberIntendedRoute(fallbackRoute);
      showRouteSwitching();
      router.push(fallbackRoute).catch(() => {});
    }
  }
}

function openTabContextMenu(event, key) {
  event.preventDefault();
  contextMenu.value = {
    visible: true,
    tabKey: key,
    x: event.clientX,
    y: event.clientY
  };
}

function closeTabContextMenu() {
  if (!contextMenu.value.visible) return;
  contextMenu.value = {
    visible: false,
    tabKey: "",
    x: 0,
    y: 0
  };
}

function handleGlobalPointerDown() {
  closeTabContextMenu();
}

function handleWindowBlur() {
  closeTabContextMenu();
}

function handlePluginUpdate(event) {
  pluginUpdate.value = event?.detail || null;
}

function openPluginDownload() {
  const url = String(pluginUpdate.value?.download_url || "").trim();
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

const contextTab = computed(() => tabsStore.findTab(contextMenu.value.tabKey));
const contextTabCanClose = computed(() => Boolean(contextTab.value?.closable));
const contextTabPinned = computed(() => Boolean(contextTab.value?.pinned || !contextTab.value?.closable));
const contextTabIndex = computed(() => workspaceTabs.value.findIndex((tab) => tab.key === contextMenu.value.tabKey));
const contextHasClosableLeft = computed(() => workspaceTabs.value
  .slice(0, Math.max(0, contextTabIndex.value))
  .some((tab) => tab.closable && !tab.pinned));
const contextHasClosableRight = computed(() => workspaceTabs.value
  .slice(contextTabIndex.value + 1)
  .some((tab) => tab.closable && !tab.pinned));

watch(
  () => route.fullPath,
  () => {
    closeTabContextMenu();
    routeSwitching.value = false;
    window.clearTimeout(routeSwitchTimer);
  }
);

async function syncExpandedMenu(path) {
  if (appStore.sidebarCollapsed) return;
  await nextTick();
  const menu = menuRef.value;
  if (!menu) return;
  const currentPath = String(path || "").trim();
  const parentKey = menuParentByRoute.get(currentPath);

  submenuKeys.forEach((key) => {
    if (key !== parentKey) menu.close(key);
  });

  if (parentKey) menu.open(parentKey);
}

watch(
  () => route.path,
  (path) => {
    syncExpandedMenu(path);
  },
  { immediate: true }
);

watch(
  () => route.fullPath,
  () => {
    tabsStore.openRoute(route);
  },
  { immediate: true }
);

onMounted(() => {
  window.addEventListener("pointerdown", handleGlobalPointerDown);
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("app:plugin-update", handlePluginUpdate);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", handleGlobalPointerDown);
  window.removeEventListener("blur", handleWindowBlur);
  window.removeEventListener("app:plugin-update", handlePluginUpdate);
  window.clearTimeout(routeSwitchTimer);
});
</script>

<template>
  <el-container class="erp-shell">
    <el-aside :width="appStore.sidebarCollapsed ? '52px' : '180px'" class="erp-sidebar">
      <div class="erp-sidebar-inner">
        <button type="button" class="erp-logo" aria-label="爆单单单" @click="openDashboard">
          <span class="brand-logo-sticker">
            <span class="brand-ozon">OZON</span>
            <span class="brand-char brand-bao">爆</span>
            <span class="brand-char brand-dan brand-dan-1">单</span>
            <span class="brand-char brand-dan brand-dan-2">单</span>
            <span class="brand-char brand-dan brand-dan-3">单</span>
          </span>
        </button>

        <el-scrollbar class="erp-sidebar-scroll">
          <el-menu
            ref="menuRef"
            :default-active="activeMenu"
            :collapse="appStore.sidebarCollapsed"
            unique-opened
            class="erp-menu"
            @select="handleMenuSelect"
          >
            <template v-for="menu in navigationMenus" :key="menu.key">
              <el-sub-menu v-if="menu.children?.length" :index="menu.key">
                <template #title>
                  <el-icon><component :is="menu.icon" /></el-icon>
                  <span>{{ menu.label }}</span>
                </template>
                <el-menu-item
                  v-for="child in menu.children"
                  :key="child.key"
                  :index="child.route"
                  @mouseenter="prefetchMenuRoute(child.route)"
                  @focus="prefetchMenuRoute(child.route)"
                >
                  {{ child.label }}
                </el-menu-item>
              </el-sub-menu>
              <el-menu-item
                v-else
                :index="menu.route || menu.key"
                @mouseenter="prefetchMenuRoute(menu.route)"
                @focus="prefetchMenuRoute(menu.route)"
              >
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
            <strong>{{ currentPageTitle }}</strong>
            <el-breadcrumb v-if="breadcrumbItems.length > 1" separator="/">
              <el-breadcrumb-item v-for="item in breadcrumbItems" :key="item">{{ item }}</el-breadcrumb-item>
            </el-breadcrumb>
          </div>
        </div>

        <div class="erp-header-right">
          <el-badge :value="pluginUpdate ? 1 : 0" class="erp-header-badge" :hidden="!pluginUpdate">
            <el-button circle @click="pluginUpdate && openPluginDownload()">
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
            <el-button link type="primary" class="erp-user-action" @click="handleLogout">Logout</el-button>
          </div>
        </div>
      </el-header>

      <el-main class="erp-content">
          <div class="erp-content-inner">
          <el-alert
            v-if="pluginUpdate"
            class="erp-plugin-update-alert"
            type="warning"
            show-icon
            :closable="pluginUpdate.mandatory !== true"
            @close="pluginUpdate = null"
          >
            <template #title>
              <strong>{{ pluginUpdate.title || "爆单ERP插件有新版本" }}</strong>
            </template>
            <div class="erp-plugin-update-alert__body">
              <span>{{ pluginUpdate.message || "请下载最新版爆单ERP插件并重新安装。" }}</span>
              <el-button size="small" type="warning" @click="openPluginDownload">下载插件</el-button>
            </div>
          </el-alert>

          <div v-if="workspaceTabs.length" class="erp-workspace-tabs" role="tablist" aria-label="Open pages">
            <button
              v-for="tab in workspaceTabs"
              :key="tab.key"
              type="button"
              class="erp-workspace-tab"
              :class="{ 'is-active': tab.key === activeTabKey, 'is-pinned': tab.pinned || !tab.closable }"
              @click="handleTabClick(tab.key)"
              @contextmenu="openTabContextMenu($event, tab.key)"
            >
              <span v-if="tab.icon" class="erp-workspace-tab__icon">
                <el-icon><component :is="tab.icon" /></el-icon>
              </span>
              <span v-else-if="tab.pinned || !tab.closable" class="erp-workspace-tab__pin">
                <el-icon><Paperclip /></el-icon>
              </span>
              <span class="erp-workspace-tab__label">{{ tab.title }}</span>
              <span
                v-if="tab.closable"
                class="erp-workspace-tab__close"
                @click.stop="handleTabClose(tab.key)"
              >
                <el-icon><Close /></el-icon>
              </span>
            </button>
          </div>

          <div class="erp-workspace-panels">
            <div v-if="routeSwitching" class="erp-route-switching" aria-live="polite">
              <span></span>
              <strong>正在切换页面</strong>
            </div>
            <div class="erp-workspace-panel">
              <RouterView :key="`${route.fullPath}:${tabsStore.refreshToken}`" />
            </div>
          </div>
        </div>
      </el-main>
    </el-container>
  </el-container>

  <teleport to="body">
    <div
      v-if="contextMenu.visible"
      class="erp-tab-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @pointerdown.stop
    >
      <button type="button" class="erp-tab-context-menu__item" @click.stop="handleTabCommand('refresh-tab')">
        <el-icon><RefreshRight /></el-icon>
        <span>重新加载</span>
      </button>
      <button
        v-if="contextTabCanClose && !contextTabPinned"
        type="button"
        class="erp-tab-context-menu__item"
        @click.stop="handleTabCommand('pin')"
      >
        <el-icon><Paperclip /></el-icon>
        <span>固定标签</span>
      </button>
      <button
        v-if="contextTabCanClose && contextTabPinned"
        type="button"
        class="erp-tab-context-menu__item"
        @click.stop="handleTabCommand('unpin')"
      >
        <el-icon><Paperclip /></el-icon>
        <span>取消固定</span>
      </button>
      <button
        type="button"
        class="erp-tab-context-menu__item"
        @click.stop="handleTabCommand('open-window')"
      >
        <span>在新窗口打开</span>
      </button>
      <button
        v-if="contextHasClosableLeft"
        type="button"
        class="erp-tab-context-menu__item"
        @click.stop="handleTabCommand('close-left')"
      >
        <span>关闭左侧标签页</span>
      </button>
      <button
        v-if="contextHasClosableRight"
        type="button"
        class="erp-tab-context-menu__item"
        @click.stop="handleTabCommand('close-right')"
      >
        <span>关闭右侧标签页</span>
      </button>
      <button type="button" class="erp-tab-context-menu__item" @click.stop="handleTabCommand('close-others')">
        <span>关闭其它标签页</span>
      </button>
      <button type="button" class="erp-tab-context-menu__item" @click.stop="handleTabCommand('close-all')">
        <span>关闭全部标签页</span>
      </button>
      <button
        v-if="contextTabCanClose"
        type="button"
        class="erp-tab-context-menu__item is-danger"
        @click.stop="handleTabCommand('close-tab')"
      >
        <span>关闭当前标签</span>
      </button>
    </div>
  </teleport>
</template>
