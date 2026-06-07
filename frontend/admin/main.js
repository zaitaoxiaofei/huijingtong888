import { createApp } from "vue";
import { createPinia } from "pinia";
import { ElLoading } from "element-plus";
import App from "./App.vue";
import { router } from "./router";
import "./styles/index.css";
import "./styles/erp-theme.css";
import { useAppStore } from "./stores/app";

const DYNAMIC_IMPORT_RELOAD_STATE = "ozon-admin-dynamic-import-reload-state";
const DYNAMIC_IMPORT_PENDING_ROUTE = "ozon-admin-dynamic-import-pending-route";
const DYNAMIC_IMPORT_INTENDED_ROUTE = "ozon-admin-dynamic-import-intended-route";
const DYNAMIC_IMPORT_RELOAD_MAX_ATTEMPTS = 2;

function shouldReloadForDynamicImportError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Failed to fetch dynamically imported module")
    || message.includes("Importing a module script failed")
    || message.includes("Unable to preload CSS");
}

function dynamicImportReloadState() {
  try {
    return JSON.parse(sessionStorage.getItem(DYNAMIC_IMPORT_RELOAD_STATE) || "{}") || {};
  } catch {
    return {};
  }
}

function clearDynamicImportReloadState() {
  sessionStorage.removeItem(DYNAMIC_IMPORT_RELOAD_STATE);
}

function reloadForDynamicImportError(targetRoute = "") {
  const state = dynamicImportReloadState();
  const attempts = Number(state.attempts || 0);
  if (attempts >= DYNAMIC_IMPORT_RELOAD_MAX_ATTEMPTS) return false;
  const route = String(targetRoute || sessionStorage.getItem(DYNAMIC_IMPORT_INTENDED_ROUTE) || "").trim();
  if (route.startsWith("/")) sessionStorage.setItem(DYNAMIC_IMPORT_PENDING_ROUTE, route);
  sessionStorage.setItem(DYNAMIC_IMPORT_RELOAD_STATE, JSON.stringify({
    attempts: attempts + 1,
    at: Date.now()
  }));
  window.__showAdminStaticLoginFallback?.({ loading: true });
  window.setTimeout(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("_erp_chunk_reload", Date.now().toString(36));
    window.location.replace(url.toString());
  }, 250 + attempts * 500);
  return true;
}

function rememberIntendedRoute(targetRoute) {
  const route = String(targetRoute || "").trim();
  if (route.startsWith("/")) sessionStorage.setItem(DYNAMIC_IMPORT_INTENDED_ROUTE, route);
}

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(ElLoading);
app.use(router);

useAppStore(pinia).initTheme();

app.config.errorHandler = (error) => {
  if (shouldReloadForDynamicImportError(error) && reloadForDynamicImportError(router.currentRoute.value?.fullPath)) {
    return;
  }
  window.__showAdminStaticLoginFallback?.();
  throw error;
};

router.beforeEach((to) => {
  window.dispatchEvent(new CustomEvent("admin:route-changing", {
    detail: { to: to.fullPath }
  }));
  if (!to.meta?.public) rememberIntendedRoute(to.fullPath);
  return true;
});

router.afterEach((to) => {
  window.__hideAdminStaticLoginFallback?.();
  if (sessionStorage.getItem(DYNAMIC_IMPORT_INTENDED_ROUTE) === to.fullPath) {
    sessionStorage.removeItem(DYNAMIC_IMPORT_INTENDED_ROUTE);
  }
});

router.onError((error, to) => {
  if (shouldReloadForDynamicImportError(error) && reloadForDynamicImportError(to?.fullPath)) return;
  throw error;
});

window.addEventListener("vite:preloadError", (event) => {
  if (shouldReloadForDynamicImportError(event.payload)) {
    event.preventDefault();
    reloadForDynamicImportError();
  }
});

app.mount("#adminApp");
window.__hideAdminStaticLoginFallback?.();

router.isReady().then(() => {
  window.__hideAdminStaticLoginFallback?.();
  clearDynamicImportReloadState();
  const pendingRoute = sessionStorage.getItem(DYNAMIC_IMPORT_PENDING_ROUTE);
  if (!pendingRoute) return;
  sessionStorage.removeItem(DYNAMIC_IMPORT_PENDING_ROUTE);
  sessionStorage.removeItem(DYNAMIC_IMPORT_INTENDED_ROUTE);
  if (pendingRoute !== router.currentRoute.value.fullPath) {
    router.replace(pendingRoute).catch(() => {});
  }
});
