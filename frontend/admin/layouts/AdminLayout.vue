<script setup>
import { KeepAlive, computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { Bell, Camera, Close, Download, Expand, Fold, Lock, MoonNight, Paperclip, RefreshRight, Sunny, User } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { navigationMenus, navigationMenusForRole } from "../constants/navigation.js";
import { prefetchRouteComponent } from "../router";
import { useAuthStore } from "../stores/auth";
import { useAppStore } from "../stores/app";
import { useWorkspaceTabsStore } from "../stores/workspaceTabs";
import { openAiEcommerceSuiteWindow, openAiProductMaterialOptimizerWindow, openAiVariantLabWindow } from "../utils/ai-variant-lab-window";
import { uploadListingMedia } from "../api/tools/imageCropper";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const appStore = useAppStore();
const tabsStore = useWorkspaceTabsStore();
tabsStore.restoreTabs(router);
const DYNAMIC_IMPORT_INTENDED_ROUTE = "ozon-admin-dynamic-import-intended-route";
const menuRef = ref(null);
const isMobileViewport = ref(false);
const mobileNavigationOpen = ref(false);
const profileDialogVisible = ref(false);
const profileSaving = ref(false);
const profileAvatarUploading = ref(false);
const profileForm = ref({ name: "", avatar_url: "", old_password: "", new_password: "", confirm_password: "" });
let mobileViewportQuery = null;

const activeMenu = computed(() => route.path);
const visibleNavigationMenus = computed(() => navigationMenusForRole(authStore.user));
const standaloneMode = computed(() => String(route.query.standalone || "") === "1");
const breadcrumbs = computed(() => route.meta.breadcrumb || ["ERP Admin"]);
const breadcrumbItems = computed(() => {
  const items = Array.isArray(breadcrumbs.value) ? breadcrumbs.value.filter(Boolean) : [];
  if (items.length <= 2) return items;
  return [items[0], items[items.length - 1]];
});
const currentPageTitle = computed(() => breadcrumbItems.value[breadcrumbItems.value.length - 1] || "ERP Admin");
const themeIcon = computed(() => (appStore.theme === "dark" ? Sunny : MoonNight));
const themeTitle = computed(() => (appStore.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"));
const densityLabel = computed(() => ({
  auto: "自动密度",
  comfortable: "舒适密度",
  standard: "标准密度",
  compact: "紧凑密度"
}[appStore.densityMode] || "自动密度"));
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
const AI_VARIANT_LAB_ROUTE = "/ai-variant-lab";
const AI_PRODUCT_MATERIAL_OPTIMIZER_ROUTE = "/ai-product-material-optimizer";
const AI_OPTIMIZATION_V2_ROUTE = "/ai-optimization-workbench-v2";
const AI_ECOMMERCE_SUITE_ROUTE = "/ai-ecommerce-suite";
const NAV_WORKBENCH_IDS = new Map([
  ["/collector-box", "colwb-main"],
  ["/selection", "selwb-main"],
  ["/listing-automation", "liwb-main"],
  [AI_VARIANT_LAB_ROUTE, "ailab-main"],
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
  mobileNavigationOpen.value = false;
  if (target === AI_VARIANT_LAB_ROUTE) {
    openAiVariantLabWindow({ source: "menu" });
    return;
  }
  if (target === AI_PRODUCT_MATERIAL_OPTIMIZER_ROUTE) {
    openAiProductMaterialOptimizerWindow({ source: "menu" });
    return;
  }
  if (target === AI_ECOMMERCE_SUITE_ROUTE) {
    openAiEcommerceSuiteWindow({ source: "menu" });
    return;
  }
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

function handleNavigationToggle() {
  if (isMobileViewport.value) {
    mobileNavigationOpen.value = !mobileNavigationOpen.value;
    return;
  }
  appStore.toggleSidebar();
}

function handleDensityCommand(command) {
  appStore.setDensityMode(command);
}

function syncMobileViewport(event) {
  isMobileViewport.value = Boolean(event?.matches ?? mobileViewportQuery?.matches);
  if (!isMobileViewport.value) mobileNavigationOpen.value = false;
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

function openProfileDialog() {
  profileForm.value = {
    name: authStore.user?.name || "",
    avatar_url: authStore.user?.avatar_url || "",
    old_password: "",
    new_password: "",
    confirm_password: ""
  };
  profileDialogVisible.value = true;
}

async function cropProfileAvatar(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 5 * 1024 * 1024) throw new Error("头像图片不能超过 5MB");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(1024, sourceSize);
    canvas.getContext("2d").drawImage(image, Math.floor((image.naturalWidth - sourceSize) / 2), Math.floor((image.naturalHeight - sourceSize) / 2), sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    if (!blob) throw new Error("头像裁切失败");
    return new File([blob], "profile-avatar.webp", { type: "image/webp" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function uploadProfileAvatar(options) {
  profileAvatarUploading.value = true;
  try {
    const file = await cropProfileAvatar(options.file);
    const result = await uploadListingMedia(file, { source_module: "person_avatar", role: "avatar" });
    profileForm.value.avatar_url = result.publishUrl || result.url || result.previewUrl || "";
    options.onSuccess?.(result);
  } catch (error) {
    options.onError?.(error);
    ElMessage.error(error.message || "头像上传失败");
  } finally {
    profileAvatarUploading.value = false;
  }
}

async function saveProfile() {
  const form = profileForm.value;
  if (!String(form.name || "").trim()) return ElMessage.warning("请输入姓名");
  if (form.new_password && form.new_password !== form.confirm_password) return ElMessage.warning("两次输入的新密码不一致");
  if (form.new_password && !form.old_password) return ElMessage.warning("请输入当前密码");
  profileSaving.value = true;
  try {
    await apiClient.put("/api/auth/profile", { name: form.name, avatar_url: form.avatar_url });
    if (form.new_password) {
      await apiClient.post("/api/auth/change-password", { old_password: form.old_password, new_password: form.new_password });
    }
    await authStore.verifySession();
    profileDialogVisible.value = false;
    ElMessage.success(form.new_password ? "个人资料和密码已更新" : "个人资料已更新");
  } catch (error) {
    ElMessage.error(error.message || "个人资料保存失败");
  } finally {
    profileSaving.value = false;
  }
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
  if (tab?.route?.query?.draftId || tab?.route?.query?.templateId || tab?.route?.query?.recordId || tab?.route?.query?.recordDraft) {
    clearWorkbenchDraftForTab(tab);
    return false;
  }
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
  mobileViewportQuery = window.matchMedia("(max-width: 1100px), (max-width: 1366px) and (any-pointer: coarse)");
  syncMobileViewport(mobileViewportQuery);
  mobileViewportQuery.addEventListener("change", syncMobileViewport);
  window.addEventListener("pointerdown", handleGlobalPointerDown);
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("app:plugin-update", handlePluginUpdate);
  window.addEventListener("app:plugin-update-clear", clearPluginUpdate);
});

onBeforeUnmount(() => {
  mobileViewportQuery?.removeEventListener("change", syncMobileViewport);
  window.removeEventListener("pointerdown", handleGlobalPointerDown);
  window.removeEventListener("blur", handleWindowBlur);
  window.removeEventListener("app:plugin-update", handlePluginUpdate);
  window.removeEventListener("app:plugin-update-clear", clearPluginUpdate);
  window.clearTimeout(routeSwitchTimer);
});
</script>

<template>
  <el-container class="erp-shell" :class="{ 'is-standalone': standaloneMode, 'is-mobile-navigation-open': mobileNavigationOpen }">
    <button v-if="!standaloneMode && isMobileViewport && mobileNavigationOpen" type="button" class="erp-mobile-navigation-mask" aria-label="关闭导航" @click="mobileNavigationOpen = false"></button>
    <el-aside v-if="!standaloneMode" :width="isMobileViewport ? '280px' : (appStore.sidebarCollapsed ? '52px' : '180px')" class="erp-sidebar">
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
            <template v-for="menu in visibleNavigationMenus" :key="menu.key">
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
      <el-header v-if="!standaloneMode" class="erp-header">
        <div class="erp-header-left">
          <el-button text :aria-label="isMobileViewport ? '打开导航' : '折叠导航'" @click="handleNavigationToggle">
            <el-icon size="18"><component :is="isMobileViewport ? Expand : (appStore.sidebarCollapsed ? Expand : Fold)" /></el-icon>
          </el-button>
          <div class="erp-page-meta">
            <strong>{{ currentPageTitle }}</strong>
            <el-breadcrumb v-if="breadcrumbItems.length > 1" separator="/">
              <el-breadcrumb-item v-for="item in breadcrumbItems" :key="item">{{ item }}</el-breadcrumb-item>
            </el-breadcrumb>
          </div>
        </div>

        <div class="erp-header-right">
          <el-dropdown class="erp-density-control" trigger="click" @command="handleDensityCommand">
            <el-button text :title="`界面密度：${densityLabel}`">
              {{ densityLabel }}
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="auto">自动（推荐）</el-dropdown-item>
                <el-dropdown-item command="comfortable">舒适</el-dropdown-item>
                <el-dropdown-item command="standard">标准</el-dropdown-item>
                <el-dropdown-item command="compact">紧凑</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
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
            <el-avatar :src="authStore.user?.avatar_url" :size="30" class="erp-user-avatar" title="查看和编辑个人资料" @click="openProfileDialog">
              {{ String(authStore.user?.name || authStore.user?.username || "?").slice(0, 1) }}
            </el-avatar>
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

          <div v-if="!standaloneMode && workspaceTabs.length" class="erp-workspace-tabs" role="tablist" aria-label="Open pages">
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
                <KeepAlive :max="6">
                  <component :is="Component" :key="`${activeTabKey || currentRoute.path}:${tabsStore.refreshToken}`" />
                </KeepAlive>
              </RouterView>
            </div>
          </div>
        </div>
      </el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="profileDialogVisible" width="620px" align-center destroy-on-close class="erp-profile-dialog">
    <template #header>
      <div class="erp-profile-dialog-title">
        <span><el-icon><User /></el-icon></span>
        <div><strong>个人资料</strong><small>管理头像、显示名称和账户密码</small></div>
      </div>
    </template>

    <section class="erp-profile-summary">
      <div class="erp-profile-avatar-shell">
        <el-image v-if="profileForm.avatar_url" :src="profileForm.avatar_url" :preview-src-list="[profileForm.avatar_url]" preview-teleported fit="cover" class="erp-profile-avatar-preview" />
        <el-avatar v-else :size="104">{{ String(profileForm.name || "?").slice(0, 1) }}</el-avatar>
        <el-upload action="#" :show-file-list="false" :http-request="uploadProfileAvatar" accept=".jpg,.jpeg,.png,.webp" class="erp-profile-avatar-upload">
          <button type="button" :disabled="profileAvatarUploading" title="更换头像"><el-icon><Camera /></el-icon></button>
        </el-upload>
      </div>
      <div class="erp-profile-summary-text">
        <strong>{{ profileForm.name || "未填写姓名" }}</strong>
        <span>@{{ authStore.user?.username || "-" }}</span>
        <small>点击头像可查看大图；点击相机按钮可重新上传，图片会自动裁成 1:1</small>
      </div>
    </section>

    <el-form label-position="top" class="erp-profile-form">
      <section class="erp-profile-section">
        <header><span><el-icon><User /></el-icon></span><div><strong>基本信息</strong><small>用于系统内人员识别和协作展示</small></div></header>
        <div class="erp-profile-form-grid">
          <el-form-item label="登录账号"><el-input :model-value="authStore.user?.username" disabled /></el-form-item>
          <el-form-item label="显示名称"><el-input v-model="profileForm.name" maxlength="100" placeholder="请输入姓名" /></el-form-item>
        </div>
      </section>

      <section class="erp-profile-section">
        <header><span class="is-security"><el-icon><Lock /></el-icon></span><div><strong>账户安全</strong><small>如不修改密码，以下三项保持为空即可</small></div></header>
        <el-form-item label="当前密码"><el-input v-model="profileForm.old_password" type="password" show-password autocomplete="current-password" placeholder="修改密码时请输入当前密码" /></el-form-item>
        <div class="erp-profile-form-grid">
          <el-form-item label="新密码"><el-input v-model="profileForm.new_password" type="password" show-password autocomplete="new-password" placeholder="至少 8 位，不能为纯数字" /></el-form-item>
          <el-form-item label="确认新密码"><el-input v-model="profileForm.confirm_password" type="password" show-password autocomplete="new-password" placeholder="再次输入新密码" /></el-form-item>
        </div>
      </section>
    </el-form>
    <template #footer><div class="erp-profile-footer"><span>修改后将立即同步到系统人员信息</span><div><el-button @click="profileDialogVisible = false">取消</el-button><el-button type="primary" :loading="profileSaving" @click="saveProfile">保存修改</el-button></div></div></template>
  </el-dialog>

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
