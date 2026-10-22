import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");
const load = source.match(/async function loadNotifications\([\s\S]*?(?=\nasync function openNotificationDrawer)/)[0];
function fixture(tenant = { id: 42 }) {
  let scope = "a", resolve, calls = 0;
  const pending = new Promise(done => { resolve = done; });
  const context = vm.createContext({
    authStore: { user: { id: 1, tenant } }, currentApiCacheScope: () => scope,
    notifications: { value: [{ id: "old" }] }, notificationUnread: { value: 1 },
    notificationLoading: { value: false }, notificationStatus: { value: "all" },
    apiClient: { get() { calls++; return pending; } }, ElMessage: { error(message) { throw new Error(message); } }
  });
  vm.runInContext(load, context);
  return { context, resolve, calls: () => calls, rotate: () => { scope = "b"; } };
}

test("platform-only accounts never request enterprise business notifications", async () => {
  const f = fixture(null);
  await f.context.loadNotifications();
  assert.equal(f.calls(), 0);
  assert.equal(f.context.notifications.value.length, 0);
  assert.equal(f.context.notificationUnread.value, 0);
});

test("unactivated enterprises do not poll paid business notifications", async () => {
  const f = fixture({ id: 42, access_allowed: false });
  await f.context.loadNotifications();
  assert.equal(f.calls(), 0);
  assert.equal(f.context.notificationUnread.value, 0);
});

test("an earlier enterprise notification response cannot replace the next session's state", async () => {
  const f = fixture();
  const pending = f.context.loadNotifications();
  f.rotate();
  f.context.notifications.value = [];
  f.context.notificationUnread.value = 0;
  f.resolve({ rows: [{ id: "private-a" }], unread: 9 });
  await pending;
  assert.equal(f.context.notifications.value.length, 0);
  assert.equal(f.context.notificationUnread.value, 0);
});

test("current enterprise notifications still load normally", async () => {
  const f = fixture();
  const pending = f.context.loadNotifications();
  f.resolve({ rows: [{ id: "current" }], unread: 2 });
  await pending;
  assert.equal(f.context.notifications.value[0].id, "current");
  assert.equal(f.context.notificationUnread.value, 2);
  assert.equal(f.context.notificationLoading.value, false);
});
