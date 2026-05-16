import { createApp } from "vue";
import ConfigPage from "./ConfigPage.vue";

const apps = new Map();

function ensureMounted(selector) {
  const target = document.querySelector(selector);
  if (!target) return null;
  if (!apps.has(selector)) {
    const app = createApp(ConfigPage);
    const root = app.mount(target);
    apps.set(selector, { app, root });
  }
  return apps.get(selector).root;
}

window.OzonVueConfigApp = {
  render(payload) {
    const instance = ensureMounted("#configNewVueApp");
    if (!instance) return;
    instance.update(payload || {});
  },
  renderInto(selector, payload) {
    const instance = ensureMounted(selector);
    if (!instance) return;
    instance.update(payload || {});
  },
  remount() {
    return ensureMounted("#configNewVueApp");
  }
};
