<script setup>
import { KeepAlive, computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { Bell, Close, Download, Expand, Fold, MoonNight, Paperclip, RefreshRight, Sunny } from "@element-plus/icons-vue";
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
const pluginUpdates = ref({});
const pluginDownloadLinks = [
  { command: "collector", label: "商品采集插件", url: "/downloads/ozon-erp-collector-plugin.rar" },
  { command: "analytics", label: "店铺分析插件", url: "/downloads/ozon-seller-analytics-plugin.rar" }
];
const routeSwitching = ref(false);
let routeSwitchTimer = 0;
const prefetchedRoutes = new Set();
const PLUGIN_UPDATE_DISMISSED_PREFIX = "ozon-admin-plugin-update-dismissed";
const submenuKeys = navigationMenus.filter((menu) => menu.children?.length).map((menu) => menu.key);
const AI_VARIANT_WIZARD_ROUTE = "/asset-variant-center/wizard";
const AI_OPTIMIZATION_V2_ROUTE = "/ai-optimization-workbench-v2";
const NAV_WORKBENCH_IDS = new Map([
  ["/collector-box", "colwb-main"],
  ["/selection", "selwb-main"],
  ["/listing-automation", "liwb-main"],
  [AI_VARIANT_WIZARD_ROUTE, "aiwizard-main"],
  [AI_OPTIMIZATION_V2_ROUTE, "aiopt-v2-main"]
]);
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
  const navWorkbenchId = NAV_WORKBENCH_IDS.get(target);
  if (navWorkbenchId) {
    const nextTarget = {
      path: target,
      query: {
        workbenchId: navWorkbenchId
      }
    };
    const nextFullPath = `${target}?workbenchId=${navWorkbenchId}`;
    if (route.path === target && String(route.query.workbenchId || "") === navWorkbenchId) return;
    rememberIntendedRoute(nextFullPath);
    showRouteSwitching();
    router.push(nextTarget).catch(() => {});
    return;
  }
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

const WORKBENCH_DRAFT_ROUTES = new Map([
  ["/listing-automation", { label: "商品上架", keyPrefix: "listing-workbench-draft:" }],
  [AI_VARIANT_WIZARD_ROUTE, { label: "AI裂变", keyPrefix: "ozon-ai-product-variant-workbench-draft:" }],
  [AI_OPTIMIZATION_V2_ROUTE, { label: "AI 优化新版", keyPrefix: "ozon-ai-optimization-workbench-v2-draft:" }]
]);

function workbenchDraftKeyForTab(tab) {
  const config = WORKBENCH_DRAFT_ROUTES.get(tab?.route?.path);
  if (!config) return "";
  const workbenchId = String(tab.route.query?.workbenchId || "").trim();
  return workbenchId ? `${config.keyPrefix}${workbenchId}` : "";
}

function tabHasSavedWorkbenchDraft(tab) {
  const key = workbenchDraftKeyForTab(tab);
  if (!key) return false;
  try {
    return Boolean(window.sessionStorage.getItem(key) || window.localStorage.getItem(key));
  } catch {
    return false;
  }
}

function clearWorkbenchDraftForTab(tab) {
  const key = workbenchDraftKeyForTab(tab);
  if (!key) return;
  try {
    window.sessionStorage.removeItem(key);
    window.localStorage.removeItem(key);
  } catch {
    // Storage cleanup is best-effort; closing the tab should still work.
  }
}

async function confirmClosingWorkbenchTabs(tabs) {
  const riskyTabs = tabs.filter(tabHasSavedWorkbenchDraft);
  if (!riskyTabs.length) return true;
  const labels = [...new Set(riskyTabs.map((tab) => WORKBENCH_DRAFT_ROUTES.get(tab.route.path)?.label || tab.title))];
  await ElMessageBox.confirm(
    `将关闭 ${labels.join("、")} 中未提交的页面草稿，关闭后本页面临时数据会清除。是否继续？`,
    "关闭工作台草稿",
    {
      type: "warning",
      confirmButtonText: "关闭并清除",
      cancelButtonText: "取消"
    }
  );
  riskyTabs.forEach(clearWorkbenchDraftForTab);
  return true;
}

async function handleTabClose(key) {
  const tab = tabsStore.findTab(key);
  if (!tab) return;
  try {
    await confirmClosingWorkbenchTabs([tab]);
  } catch {
    return;
  }
  const fallbackRoute = tabsStore.closeTab(key);
  if (!fallbackRoute || fallbackRoute === route.fullPath) return;
  rememberIntendedRoute(fallbackRoute);
  showRouteSwitching();
  router.push(fallbackRoute).catch(() => {});
}

async function handleTabCommand(command) {
  const targetTab = contextTab.value;
  closeTabContextMenu();

  if (command === "refresh") {
    tabsStore.refreshActiveTab();
    return;
  }

  if (command === "close-others") {
    const closingTabs = workspaceTabs.value.filter((tab) => tab.key !== activeTabKey.value && tab.closable && !tab.pinned);
    try {
      await confirmClosingWorkbenchTabs(closingTabs);
    } catch {
      return;
    }
    const fallbackRoute = tabsStore.closeOtherTabs(activeTabKey.value);
    if (!fallbackRoute || fallbackRoute === route.fullPath) return;
    rememberIntendedRoute(fallbackRoute);
    showRouteSwitching();
    router.push(fallbackRoute).catch(() => {});
    return;
  }

  if (command === "close-all") {
    const closingTabs = workspaceTabs.value.filter((tab) => tab.closable && !tab.pinned);
    try {
      await confirmClosingWorkbenchTabs(closingTabs);
    } catch {
      return;
    }
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
    const tabIndex = workspaceTabs.value.findIndex((item) => item.key === tab.key);
    const closingTabs = workspaceTabs.value
      .slice(0, Math.max(0, tabIndex))
      .filter((item) => item.closable && !item.pinned);
    try {
      await confirmClosingWorkbenchTabs(closingTabs);
    } catch {
      return;
    }
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
    const tabIndex = workspaceTabs.value.findIndex((item) => item.key === tab.key);
    const closingTabs = workspaceTabs.value
      .slice(tabIndex + 1)
      .filter((item) => item.closable && !item.pinned);
    try {
      await confirmClosingWorkbenchTabs(closingTabs);
    } catch {
      return;
    }
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
  const detail = event?.detail || null;
  const type = String(detail?.type || "collector_plugin").trim() || "collector_plugin";
  if (!detail) return;
  const update = { ...detail, type };
  if (isPluginUpdateDismissed(update)) return;
  pluginUpdates.value = {
    ...pluginUpdates.value,
    [type]: update
  };
}

function clearPluginUpdate(event) {
  const type = String(event?.detail?.type || "").trim();
  if (!type || !pluginUpdates.value[type]) return;
  const next = { ...pluginUpdates.value };
  delete next[type];
  pluginUpdates.value = next;
}

function openPluginDownload() {
  const update = activePluginUpdate.value;
  const url = String(update?.download_url || "").trim();
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function handlePluginDownloadCommand(command) {
  const item = pluginDownloadLinks.find((link) => link.command === command);
  if (!item?.url) return;
  window.open(item.url, "_blank", "noopener,noreferrer");
}

function pluginUpdateDismissKey(update) {
  const type = String(update?.type || "collector_plugin").trim() || "collector_plugin";
  const targetVersion = String(update?.latest_version || update?.version || update?.target_version || "").trim() || "unknown";
  const installedVersion = String(update?.installed_version || update?.current_version || "").trim() || "none";
  return `${PLUGIN_UPDATE_DISMISSED_PREFIX}:${type}:${targetVersion}:${installedVersion}`;
}

function isPluginUpdateDismissed(update) {
  if (update?.mandatory === true) return false;
  try {
    return window.localStorage.getItem(pluginUpdateDismissKey(update)) === "1";
  } catch {
    return false;
  }
}

function dismissPluginUpdate() {
  const update = activePluginUpdate.value;
  if (!update?.type) return;
  if (update.mandatory !== true) {
    try {
      window.localStorage.setItem(pluginUpdateDismissKey(update), "1");
    } catch {
      // Ignore storage failures so closing still hides the current alert.
    }
  }
  const next = { ...pluginUpdates.value };
  delete next[update.type];
  pluginUpdates.value = next;
}

const contextTab = computed(() => tabsStore.findTab(contextMenu.value.tabKey));
const activePluginUpdate = computed(() => null);
const keepAliveRouteNames = ["asset-variant-center-create", "asset-variant-center-wizard", "ai-optimization-workbench-v2", "listing-automation", "collector-box", "selection"];
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
  window.addEventListener("app:plugin-update-clear", clearPluginUpdate);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", handleGlobalPointerDown);
  window.removeEventListener("blur", handleWindowBlur);
  window.removeEventListener("app:plugin-update", handlePluginUpdate);
  window.removeEventListener("app:plugin-update-clear", clearPluginUpdate);
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
          <el-dropdown trigger="click" @command="handlePluginDownloadCommand">
            <el-button circle title="插件下载">
              <el-icon><Download /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="item in pluginDownloadLinks"
                  :key="item.command"
                  :command="item.command"
                >
                  {{ item.label }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-badge :value="activePluginUpdate ? 1 : 0" class="erp-header-badge" :hidden="!activePluginUpdate">
            <el-button circle @click="activePluginUpdate && openPluginDownload()">
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
            v-if="activePluginUpdate"
            class="erp-plugin-update-alert"
            type="warning"
            show-icon
            :closable="activePluginUpdate.mandatory !== true"
            @close="dismissPluginUpdate"
          >
            <template #title>
              <strong>{{ activePluginUpdate.title || "插件有新版本" }}</strong>
            </template>
            <div class="erp-plugin-update-alert__body">
              <span>{{ activePluginUpdate.message || "下载新版插件后重新安装即可。" }}</span>
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
              <RouterView v-slot="{ Component, route: currentRoute }">
                <KeepAlive :include="keepAliveRouteNames">
                  <component :is="Component" :key="`${currentRoute.fullPath}:${tabsStore.refreshToken}`" />
                </KeepAlive>
              </RouterView>
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
