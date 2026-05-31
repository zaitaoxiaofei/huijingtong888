import { createApp } from "vue";
import { createPinia } from "pinia";
import { ElLoading } from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import { router } from "./router";
import "./styles/index.css";
import "./styles/erp-theme.css";
import { useAppStore } from "./stores/app";

const DYNAMIC_IMPORT_RELOAD_FLAG = "ozon-admin-dynamic-import-reload";
const DYNAMIC_IMPORT_PENDING_ROUTE = "ozon-admin-dynamic-import-pending-route";
const DYNAMIC_IMPORT_INTENDED_ROUTE = "ozon-admin-dynamic-import-intended-route";

function shouldReloadForDynamicImportError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Failed to fetch dynamically imported module")
    || message.includes("Importing a module script failed")
    || message.includes("Unable to preload CSS");
}

function reloadOnceForDynamicImportError(targetRoute = "") {
  if (sessionStorage.getItem(DYNAMIC_IMPORT_RELOAD_FLAG) === "1") return false;
  sessionStorage.setItem(DYNAMIC_IMPORT_RELOAD_FLAG, "1");
  const route = String(targetRoute || sessionStorage.getItem(DYNAMIC_IMPORT_INTENDED_ROUTE) || "").trim();
  if (route.startsWith("/")) sessionStorage.setItem(DYNAMIC_IMPORT_PENDING_ROUTE, route);
  const url = new URL(window.location.href);
  url.searchParams.set("_erp_chunk_reload", Date.now().toString(36));
  window.location.replace(url.toString());
  return true;
}

function rememberIntendedRoute(targetRoute) {
  const route = String(targetRoute || "").trim();
  if (route.startsWith("/")) sessionStorage.setItem(DYNAMIC_IMPORT_INTENDED_ROUTE, route);
}

window.addEventListener("pageshow", () => {
  sessionStorage.removeItem(DYNAMIC_IMPORT_RELOAD_FLAG);
});

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(ElLoading);
app.use(router);

useAppStore(pinia).initTheme();

app.config.errorHandler = (error) => {
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
  if (shouldReloadForDynamicImportError(error) && reloadOnceForDynamicImportError(to?.fullPath)) return;
  throw error;
});

window.addEventListener("vite:preloadError", (event) => {
  if (shouldReloadForDynamicImportError(event.payload)) {
    event.preventDefault();
    reloadOnceForDynamicImportError();
  }
});

app.mount("#adminApp");
window.__hideAdminStaticLoginFallback?.();

router.isReady().then(() => {
  window.__hideAdminStaticLoginFallback?.();
  const pendingRoute = sessionStorage.getItem(DYNAMIC_IMPORT_PENDING_ROUTE);
  if (!pendingRoute) return;
  sessionStorage.removeItem(DYNAMIC_IMPORT_PENDING_ROUTE);
  sessionStorage.removeItem(DYNAMIC_IMPORT_INTENDED_ROUTE);
  if (pendingRoute !== router.currentRoute.value.fullPath) {
    router.replace(pendingRoute).catch(() => {});
  }
});
