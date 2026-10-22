import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { hasPermission, isPlatformAdmin } from "../src/shared/permissions.js";

const source = readFileSync(new URL("../frontend/admin/views/inventory/OnlineProductsView.vue", import.meta.url), "utf8");
const declaration = name => {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(match, `Missing actual page handler ${name}`); return match[0];
};
const user = (slug = "enterprise-2", role = "operations", platform = false) => ({ roles: [role], tenant: { id: slug === "default" ? 1 : 2, slug, role: "member" }, ...(platform ? { platform_role: "super_admin" } : {}) });
function fixture({ currentUser = user(), post, get } = {}) {
  const calls = { posts: [], gets: [], errors: [], warnings: [], successes: [], loads: 0 };
  const timers = new Map(); let nextTimer = 0;
  const authStore = { user: currentUser };
  const context = vm.createContext({
    Number, String, Boolean, Object, Promise, authStore, hasPermission, isPlatformAdmin,
    computed: getter => ({ get value() { return getter(); } }),
    tenantReadOnly: { get value() { return authStore.user?.tenant?.slug !== "default"; } },
    state: { filters: { shopId: "all" } },
    syncLoading: { value: false }, onlineProductSyncProgress: { value: null },
    window: {
      setInterval: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
      clearInterval: id => timers.delete(id)
    },
    ElMessage: {
      error: text => calls.errors.push(text), warning: text => calls.warnings.push(text), success: text => calls.successes.push(text)
    },
    apiClient: {
      post: async (path, payload) => { calls.posts.push({ path, payload }); return post ? post(calls.posts.length) : { started: true, running: true }; },
      get: async (path, options) => { calls.gets.push({ path, options }); return get ? get(calls.gets.length) : { running: true }; }
    },
    loadPageData: async () => { calls.loads++; }
  });
  vm.runInContext("let onlineProductSyncPollTimer=0; let onlineProductSyncPollInFlight=false;", context);
  for (const name of ["canSyncOnline", "canSyncOzonStocks"]) {
    const match = source.match(new RegExp(`^const ${name} = [^\\n]+;`, "m"));
    assert.ok(match, `Missing actual ${name} policy`);
    vm.runInContext(match[0].replace(/^const /, "globalThis."), context);
  }
  vm.runInContext(["syncOnlineProducts", "onlineProductSyncProgressText", "stopOnlineProductSyncPolling", "pollOnlineProductSyncStatus", "startOnlineProductSyncPolling"].map(declaration).join("\n"), context);
  return { context, calls, timers, authStore };
}

test("ordinary default/customer operations can pull products without opening the platform stock sync", () => {
  for (const slug of ["default", "enterprise-2"]) {
    const f = fixture({ currentUser: user(slug) });
    assert.equal(f.context.canSyncOnline.value, true);
    assert.equal(f.context.canSyncOzonStocks.value, false);
  }
  const admin = fixture({ currentUser: user("default", "operations", true) });
  assert.equal(admin.context.canSyncOnline.value, true);
  assert.equal(admin.context.canSyncOzonStocks.value, true);
  assert.equal(fixture({ currentUser: user("enterprise-2", "operations", true) }).context.canSyncOzonStocks.value, false);
  for (const currentUser of [user("enterprise-2", "packing"), user("default", "procurement"), { roles: ["operations"] }, null]) {
    assert.equal(fixture({ currentUser }).context.canSyncOnline.value, false);
  }
});

test("pending pull sends one bounded scoped POST and polls status without resubmitting or loading the full list", async () => {
  const f = fixture(); f.context.state.filters.shopId = "20";
  await f.context.syncOnlineProducts();
  await f.context.syncOnlineProducts();
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.posts[0].path, "/api/sync/online-products");
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.posts[0].payload)), { pending_listing: true, scope: "pending_listing", concurrency: 5, shop_id: 20 });
  assert.equal(f.calls.loads, 0);
  assert.equal(f.context.syncLoading.value, true);
  assert.equal(f.timers.size, 1);
  const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 2500);
  await timer.callback();
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.loads, 0);
  assert.ok(f.calls.gets.every(item => item.path === "/api/sync/online-products/status"));
});

test("all-shops pull leaves shop ownership to the backend and does not fabricate shop IDs", async () => {
  const f = fixture(); await f.context.syncOnlineProducts();
  assert.equal(Object.hasOwn(f.calls.posts[0].payload, "shop_id"), false);
});

for (const [name, error] of [
  ["permission failure", Object.assign(new Error("当前企业岗位没有商品同步权限"), { status: 403 })],
  ["isolation pending", Object.assign(new Error("该企业的数据隔离尚未完成"), { status: 403 })],
  ["network failure", new TypeError("Failed to fetch")]
]) test(`a ${name} clears loading/polling, exposes its reason and permits a retry`, async () => {
  const f = fixture({ post: count => count === 1 ? Promise.reject(error) : { started: true, running: true } });
  await f.context.syncOnlineProducts();
  assert.equal(f.context.syncLoading.value, false); assert.equal(f.timers.size, 0);
  assert.equal(f.context.onlineProductSyncProgress.value, null);
  assert.deepEqual(f.calls.errors, [`启动商品拉取失败：${error.message}`]);
  assert.equal(f.calls.gets.length, 0);
  await f.context.syncOnlineProducts();
  assert.equal(f.calls.posts.length, 2); assert.equal(f.context.syncLoading.value, true); assert.equal(f.timers.size, 1);
});

test("a forbidden role cannot invoke the page pull handler", async () => {
  const f = fixture({ currentUser: user("enterprise-2", "packing") });
  await f.context.syncOnlineProducts();
  assert.equal(f.calls.posts.length, 0); assert.equal(f.context.syncLoading.value, false); assert.equal(f.timers.size, 0);
});

test("a busy background task is resumed through GET progress, never another POST", async () => {
  const progress = { phase: "products", message: "正在写入商品", total_shops: 3, completed_shops: 1, fetched: 140, upserted: 70, shop_name: "Own shop" };
  const f = fixture({ post: () => ({ started: false, running: true, progress }), get: () => ({ running: true, progress }) });
  await f.context.syncOnlineProducts();
  assert.equal(f.calls.posts.length, 1); assert.equal(f.calls.warnings.length, 1); assert.equal(f.calls.loads, 0);
  assert.equal(f.context.onlineProductSyncProgress.value, progress);
  assert.equal(f.context.onlineProductSyncProgressText(), "正在写入商品 · Own shop · 店铺 1/3 · 已拉取 140 条 · 已更新 70 条");
});

test("legacy progress-free status has readable fallback and numeric zero progress stays visible", () => {
  const f = fixture(); assert.match(f.context.onlineProductSyncProgressText(), /后台正在拉取商品/);
  f.context.onlineProductSyncProgress.value = { phase: "starting", message: "准备开始", total_shops: 2, completed_shops: 0, fetched: 0, upserted: 0 };
  assert.equal(f.context.onlineProductSyncProgressText(), "准备开始 · 店铺 0/2 · 已拉取 0 条 · 已更新 0 条");
});

test("slow status polling runs once and refreshes the paged list exactly once on completion", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ get: () => pending });
  f.context.startOnlineProductSyncPolling();
  await f.context.pollOnlineProductSyncStatus();
  assert.equal(f.calls.gets.length, 1); assert.equal(f.calls.loads, 0);
  finish({ running: false, scope: "pending_listing", result: { upserted: 3, errors: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.loads, 1); assert.equal(f.calls.successes.length, 1);
  assert.equal(f.context.syncLoading.value, false); assert.equal(f.timers.size, 0);
});

test("status failure stops polling and allows the next explicit pull", async () => {
  const f = fixture({ get: () => { throw new Error("商品拉取状态暂不可用"); } });
  f.context.startOnlineProductSyncPolling();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.context.syncLoading.value, false); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls.errors, ["商品拉取状态暂不可用"]);
  await f.context.syncOnlineProducts();
  assert.equal(f.calls.posts.length, 1);
});

test("template preserves stock/admin and image/binding boundaries while exposing live text inside the existing toolbar", () => {
  assert.match(source, /v-if="canSyncOnline"[^\n]+@click="syncOnlineProducts\('pending_listing'\)"/);
  assert.match(source, /v-if="canSyncOzonStocks"[^\n]+@click="syncOzonStocks"/);
  assert.match(source, /<el-text v-if="syncLoading"[^\n]+aria-live="polite">\{\{ onlineProductSyncProgressText\(\) \}\}/);
  assert.match(source, /v-if="tenantCanUpdateStocks"[^\n]+@click="openBatchStockDialog"/);
  assert.match(source, /<template v-if="canManageInventory">/);
  assert.match(source, /<ProductImagePreview[\s\S]*?<\/ProductImagePreview>|<ProductImagePreview[\s\S]*?\/>/);
  assert.match(source, /!dictionaryLoaded && !tenantReadOnly\.value && !showProductLimitPanel\.value/);
});
