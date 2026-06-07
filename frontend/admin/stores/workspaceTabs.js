import { computed, markRaw, ref } from "vue";
import { defineStore } from "pinia";
import { navigationIconByRoute } from "../constants/navigation.js";

const WORKSPACE_TABS_STORAGE_KEY = "ozon-admin-workspace-tabs";
const MAX_RESTORED_TABS = 8;

function clonePlainObject(value) {
  return { ...(value || {}) };
}

function cloneRouteLocation(route) {
  return {
    fullPath: route.fullPath,
    hash: route.hash,
    meta: clonePlainObject(route.meta),
    name: route.name,
    params: clonePlainObject(route.params),
    path: route.path,
    query: clonePlainObject(route.query),
    matched: markRaw(route.matched.slice())
  };
}

function serializeRoute(route) {
  return {
    fullPath: route.fullPath,
    hash: route.hash,
    meta: clonePlainObject(route.meta),
    name: route.name,
    params: clonePlainObject(route.params),
    path: route.path,
    query: clonePlainObject(route.query)
  };
}

function normalizeFullPathTabKey(route) {
  const path = String(route.path || "").trim();
  const query = { ...(route.query || {}) };
  delete query.tabTitle;
  delete query.title;
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        return value.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    });
  return entries.length ? `${path}?${entries.join("&")}` : path;
}

function normalizeWorkbenchTabKey(route) {
  const path = String(route.path || "").trim();
  const workbenchId = String(route.query?.workbenchId || "").trim();
  return workbenchId ? `${path}?workbenchId=${encodeURIComponent(workbenchId)}` : path;
}

function resolveTabKey(route) {
  if (route.meta?.tabKey === "workbench") return normalizeWorkbenchTabKey(route);
  return route.meta?.tabKey === "fullPath" ? normalizeFullPathTabKey(route) : route.path;
}

function resolveTabTitle(route) {
  const dynamicTitle = String(route.query?.tabTitle || route.query?.title || "").trim();
  if (dynamicTitle) return dynamicTitle;
  return String(route.meta?.title || route.name || route.path || "Untitled").trim();
}

function resolveTabIcon(route) {
  return navigationIconByRoute.get(route.path) || null;
}

function isClosable(route) {
  if (route.meta?.tabClosable === false) return false;
  return route.path !== "/dashboard";
}

function toPersistedTab(tab) {
  return {
    key: tab.key,
    title: tab.title,
    closable: tab.closable,
    pinned: Boolean(tab.pinned),
    route: serializeRoute(tab.route)
  };
}

function canPersistRoute(route) {
  return route?.path && !route.meta?.public;
}

function compactRestoredTabs(tabs, activeKey) {
  if (tabs.length <= MAX_RESTORED_TABS) return tabs;
  const pinnedTabs = tabs.filter((tab) => tab.pinned || !tab.closable);
  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const recentTabs = tabs.filter((tab) => tab !== activeTab && !pinnedTabs.includes(tab)).slice(-MAX_RESTORED_TABS);
  const compacted = [...pinnedTabs, activeTab, ...recentTabs].filter(Boolean);
  return compacted.slice(Math.max(0, compacted.length - MAX_RESTORED_TABS));
}

function dedupeTabsByKey(tabs) {
  const byKey = new Map();
  for (const tab of tabs) byKey.set(tab.key, tab);
  return [...byKey.values()];
}

export const useWorkspaceTabsStore = defineStore("workspace-tabs", () => {
  const tabs = ref([]);
  const activeKey = ref("");
  const refreshToken = ref(0);

  const activeTab = computed(() => tabs.value.find((tab) => tab.key === activeKey.value) || null);

  function persistState() {
    const payload = {
      activeKey: activeKey.value,
      tabs: tabs.value.map(toPersistedTab)
    };
    sessionStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, JSON.stringify(payload));
  }

  function findTab(key) {
    return tabs.value.find((tab) => tab.key === key) || null;
  }

  function sortTabs(nextTabs) {
    const pinnedTabs = nextTabs.filter((tab) => tab.pinned || !tab.closable);
    const normalTabs = nextTabs.filter((tab) => !tab.pinned && tab.closable);
    return [...pinnedTabs, ...normalTabs];
  }

  function openRoute(route) {
    if (!route?.matched?.length || route.meta?.public) return;
    const key = resolveTabKey(route);
    const existingTab = findTab(key);
    const nextTab = {
      key,
      title: resolveTabTitle(route),
      icon: resolveTabIcon(route),
      closable: isClosable(route),
      pinned: existingTab?.pinned || !isClosable(route),
      route: cloneRouteLocation(route)
    };
    const existingIndex = tabs.value.findIndex((tab) => tab.key === key);

    if (existingIndex >= 0) {
      tabs.value.splice(existingIndex, 1, nextTab);
    } else {
      tabs.value.push(nextTab);
    }

    tabs.value = sortTabs(tabs.value);
    activeKey.value = key;
    persistState();
  }

  function restoreTabs(router) {
    const raw = sessionStorage.getItem(WORKSPACE_TABS_STORAGE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const restoredTabs = [];
      for (const tab of parsed?.tabs || []) {
        if (!canPersistRoute(tab?.route)) continue;
        const resolved = router.resolve(tab.route.fullPath || tab.route.path);
        if (!resolved?.matched?.length || resolved.meta?.public) continue;
        restoredTabs.push({
          key: resolveTabKey(resolved),
          title: String(tab.title || resolveTabTitle(resolved)).trim(),
          icon: resolveTabIcon(resolved),
          closable: tab.closable !== false && isClosable(resolved),
          pinned: Boolean(tab.pinned) || !isClosable(resolved),
          route: cloneRouteLocation(resolved)
        });
      }
      const restoredActiveKey = restoredTabs.some((tab) => tab.key === parsed?.activeKey)
        ? parsed.activeKey
        : restoredTabs[restoredTabs.length - 1]?.key || "";
      tabs.value = sortTabs(compactRestoredTabs(dedupeTabsByKey(restoredTabs), restoredActiveKey));
      activeKey.value = tabs.value.some((tab) => tab.key === restoredActiveKey)
        ? restoredActiveKey
        : tabs.value[tabs.value.length - 1]?.key || "";
      persistState();
    } catch {
      sessionStorage.removeItem(WORKSPACE_TABS_STORAGE_KEY);
    }
  }

  function closeTab(key) {
    const index = tabs.value.findIndex((tab) => tab.key === key);
    if (index < 0) return null;
    if (!tabs.value[index].closable) return activeTab.value?.route?.fullPath || null;

    const wasActive = activeKey.value === key;
    tabs.value.splice(index, 1);

    if (!tabs.value.length) {
      activeKey.value = "";
      persistState();
      return "/dashboard";
    }

    if (!wasActive) {
      persistState();
      return activeTab.value?.route?.fullPath || null;
    }

    const fallbackTab = tabs.value[index] || tabs.value[index - 1] || tabs.value[0];
    activeKey.value = fallbackTab.key;
    persistState();
    return fallbackTab.route.fullPath;
  }

  function closeOtherTabs(key) {
    const currentTab = findTab(key);
    if (!currentTab) return null;
    tabs.value = sortTabs(tabs.value.filter((tab) => tab.key === key || tab.pinned || !tab.closable));
    if (!tabs.value.some((tab) => tab.key === key)) tabs.value.push(currentTab);
    tabs.value = sortTabs(tabs.value);
    activeKey.value = key;
    persistState();
    return currentTab.route.fullPath;
  }

  function closeLeftTabs(key) {
    const currentIndex = tabs.value.findIndex((tab) => tab.key === key);
    if (currentIndex < 0) return null;
    tabs.value = sortTabs(tabs.value.filter((tab, index) => index >= currentIndex || tab.pinned || !tab.closable));
    activeKey.value = key;
    persistState();
    return findTab(key)?.route?.fullPath || null;
  }

  function closeRightTabs(key) {
    const currentIndex = tabs.value.findIndex((tab) => tab.key === key);
    if (currentIndex < 0) return null;
    tabs.value = sortTabs(tabs.value.filter((tab, index) => index <= currentIndex || tab.pinned || !tab.closable));
    activeKey.value = key;
    persistState();
    return findTab(key)?.route?.fullPath || null;
  }

  function closeAllTabs() {
    const pinnedTabs = sortTabs(tabs.value.filter((tab) => tab.pinned || !tab.closable));
    tabs.value = pinnedTabs;
    activeKey.value = pinnedTabs[0]?.key || "";
    persistState();
    return pinnedTabs[0]?.route?.fullPath || "/dashboard";
  }

  function refreshActiveTab() {
    refreshToken.value += 1;
    return activeTab.value?.route?.fullPath || null;
  }

  function pinTab(key) {
    const tab = findTab(key);
    if (!tab || !tab.closable) return;
    tab.pinned = true;
    tabs.value = sortTabs(tabs.value.slice());
    persistState();
  }

  function unpinTab(key) {
    const tab = findTab(key);
    if (!tab || !tab.closable) return;
    tab.pinned = false;
    tabs.value = sortTabs(tabs.value.slice());
    persistState();
  }

  return {
    tabs,
    activeKey,
    activeTab,
    refreshToken,
    findTab,
    openRoute,
    restoreTabs,
    closeTab,
    closeLeftTabs,
    closeRightTabs,
    closeOtherTabs,
    closeAllTabs,
    refreshActiveTab,
    pinTab,
    unpinTab
  };
});
