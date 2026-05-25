import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import { router } from "./router";
import "./styles/index.css";
import { useAppStore } from "./stores/app";

const DYNAMIC_IMPORT_RELOAD_FLAG = "ozon-admin-dynamic-import-reload";

function shouldReloadForDynamicImportError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Failed to fetch dynamically imported module")
    || message.includes("Importing a module script failed");
}

function reloadOnceForDynamicImportError() {
  if (sessionStorage.getItem(DYNAMIC_IMPORT_RELOAD_FLAG) === "1") return false;
  sessionStorage.setItem(DYNAMIC_IMPORT_RELOAD_FLAG, "1");
  window.location.reload();
  return true;
}

window.addEventListener("pageshow", () => {
  sessionStorage.removeItem(DYNAMIC_IMPORT_RELOAD_FLAG);
});

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(ElementPlus);
app.use(router);

useAppStore(pinia).initTheme();

router.onError((error) => {
  if (shouldReloadForDynamicImportError(error) && reloadOnceForDynamicImportError()) return;
  throw error;
});

window.addEventListener("vite:preloadError", (event) => {
  if (shouldReloadForDynamicImportError(event.payload)) {
    event.preventDefault();
    reloadOnceForDynamicImportError();
  }
});

app.mount("#adminApp");
