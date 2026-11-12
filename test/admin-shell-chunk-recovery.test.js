import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import vm from "node:vm";

let root, shell;
const origin = "http://localhost:8788";
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-shell-recovery-"));
  await fs.mkdir(path.join(root, "public"));
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({ "frontend/admin/main.js": { file: "assets/admin-view-fixture123.js" } }));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/generate-admin-shell.mjs", import.meta.url))], {
    cwd: root, env: { ...process.env, OZON_VITE_MANIFEST_PATH: manifestPath }
  });
  const html = await fs.readFile(path.join(root, "public/admin.html"), "utf8");
  shell = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes("var chunkReloadKey"));
  assert.ok(shell);
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

function page(storage = new Map(), { code = shell, storageBlocked = false } = {}) {
  const listeners = {}, timers = [], navigations = [];
  const element = () => ({ hidden: true, textContent: "", classList: { add() {}, remove() {}, toggle() {} } });
  const app = { children: [] }, fallback = element(), title = element(), hint = element();
  const window = {
    location: { href: `${origin}/admin.html#/orders`, origin, replace: value => navigations.push(value) },
    addEventListener: (type, callback) => { listeners[type] = callback; },
    setTimeout: (callback, delay) => { timers.push({ callback, delay, active: true }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].active = false; },
    setInterval: () => 1, clearInterval() {}
  };
  const context = vm.createContext({ window, URL, Date, sessionStorage: {
    getItem: key => { if (storageBlocked) throw new Error("Storage blocked"); return storage.get(key) ?? null; },
    setItem: (key, value) => { if (storageBlocked) throw new Error("Storage blocked"); storage.set(key, String(value)); },
    removeItem: key => storage.delete(key)
  }, document: { getElementById: id => ({ adminApp: app, adminStaticLoginFallback: fallback, adminStaticLoginTitle: title, adminStaticLoginHint: hint })[id] } });
  vm.runInContext(code, context);
  return {
    storage, fallback, navigations,
    mount() { app.children = [{}]; window.__hideAdminStaticLoginFallback(); },
    emit(type, event) { listeners[type](event); },
    reloadTimers() { return timers.filter(timer => timer.active && [250, 750].includes(timer.delay)); },
    reload() { for (const timer of this.reloadTimers()) timer.callback(); }
  };
}
const imageError = { target: { tagName: "IMG", src: `${origin}/vue-apps/assets/ozon-abc123.png` } };
const scriptError = { target: { tagName: "SCRIPT", src: `${origin}/vue-apps/assets/orders-abc123.js` } };

test("failed desktop badge images never reload the mounted application or consume chunk retries", () => {
  const current = page(); current.mount();
  for (let index = 0; index < 30; index += 1) current.emit("error", imageError);
  assert.equal(current.reloadTimers().length, 0);
  assert.equal(current.storage.size, 0);
  assert.equal(current.fallback.hidden, true);
});

test("runtime errors, external assets, fonts and non-chunk link resources never trigger recovery", () => {
  for (const event of [
    { filename: `${origin}/vue-apps/assets/vendor-abc123.js`, message: "Uncaught TypeError: rendering failed" },
    { target: { tagName: "LINK", rel: "preload", as: "font", href: `${origin}/vue-apps/assets/font.woff2` } },
    { target: { tagName: "LINK", rel: "preload", as: "image", href: `${origin}/vue-apps/assets/ozon.png` } },
    { target: { tagName: "SCRIPT", src: "https://external.example/vue-apps/assets/orders.js" } },
    { target: { tagName: "SCRIPT", src: "chrome-extension://fixture/vue-apps/assets/content.js" } }
  ]) {
    const current = page(); current.mount(); current.emit("error", event);
    assert.equal(current.reloadTimers().length, 0);
  }
  const current = page(); current.mount();
  current.emit("unhandledrejection", { reason: new Error(`Rendering failed in ${origin}/vue-apps/assets/orders.js`) });
  assert.equal(current.reloadTimers().length, 0);
});

test("same-origin script, stylesheet and modulepreload failures retain one recovery attempt per document", () => {
  for (const event of [scriptError,
    { target: { tagName: "LINK", rel: "stylesheet", href: `${origin}/vue-apps/assets/orders-abc123.css` } },
    { target: { tagName: "LINK", rel: "modulepreload", href: `${origin}/vue-apps/assets/orders-abc123.js` } }
  ]) {
    const current = page(); current.mount();
    for (let index = 0; index < 10; index += 1) current.emit("error", event);
    assert.equal(current.reloadTimers().length, 1);
    assert.deepEqual([...current.storage.values()], ["1"]);
    current.reload();
    assert.equal(current.navigations.length, 1);
    assert.equal(new URL(current.navigations[0]).hash, "#/orders");
  }
});

test("explicit browser chunk-load failures still retry while application runtime errors do not", () => {
  for (const message of ["Failed to fetch dynamically imported module: fixture.js", "Importing a module script failed", "Unable to preload CSS for fixture.css"]) {
    const current = page(); current.mount();
    current.emit("unhandledrejection", { reason: new Error(message) });
    assert.equal(current.reloadTimers().length, 1);
  }
});

test("the retry budget survives successful mounts and only a different entry fingerprint gets a fresh budget", () => {
  const storage = new Map(), attempts = [];
  for (let documentNumber = 0; documentNumber < 5; documentNumber += 1) {
    const current = page(storage); current.mount(); current.emit("error", scriptError);
    attempts.push(current.reloadTimers().length);
  }
  assert.deepEqual(attempts, [1, 1, 0, 0, 0]);
  assert.deepEqual([...storage.values()], ["2"]);
  const nextRelease = page(storage, { code: shell.replaceAll("admin-view-fixture123.js", "admin-view-next456.js") });
  nextRelease.mount(); nextRelease.emit("error", scriptError);
  assert.equal(nextRelease.reloadTimers().length, 1);
});

test("blocked browser storage disables automatic reload rather than starting an unbounded recovery loop", () => {
  const current = page(new Map(), { storageBlocked: true }); current.mount();
  assert.doesNotThrow(() => current.emit("error", scriptError));
  assert.equal(current.reloadTimers().length, 0);
});
