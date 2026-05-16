import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import OrdersPage from "./OrdersPage.vue";

const apps = new Map();

function ensureMounted(selector) {
  const target = document.querySelector(selector);
  if (!target) return null;
  if (!apps.has(selector)) {
    const app = createApp(OrdersPage);
    app.use(ElementPlus);
    const root = app.mount(target);
    apps.set(selector, { app, root });
  }
  return apps.get(selector).root;
}

window.OzonVueOrdersApp = {
  render(payload) {
    const instance = ensureMounted("#ordersVueApp");
    if (!instance) return;
    instance.update(payload || {});
  },
  renderInto(selector, payload) {
    const instance = ensureMounted(selector);
    if (!instance) return;
    instance.update(payload || {});
  },
  remount() {
    return ensureMounted("#ordersVueApp");
  }
};
