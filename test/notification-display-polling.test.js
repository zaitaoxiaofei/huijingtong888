import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createDisplayReadScope } from "../frontend/admin/utils/display-read-scope.js";

const source = readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");
const loadSource = source.slice(source.indexOf("async function loadNotifications("), source.indexOf("async function openNotificationDrawer("));
const ref = value => ({ value });
function fixture(get) {
  const calls = [], errors = [];
  let currentScope = "tenant-A", token = "fixture-session";
  const context = { notificationReadVersion: 0, notificationReadController: null, notificationListRevision: "",
    notificationDrawerVisible: ref(false), notificationLoading: ref(false), notificationUnread: ref(0),
    notificationStatus: ref("all"), notifications: ref([{ id: 99 }]),
    authStore: { user: { personId: 7, tenant: { id: 2 } } }, URLSearchParams,
    getAuthToken: () => token, currentApiCacheScope: () => currentScope,
    ElMessage: { error: message => errors.push(message) },
    apiClient: { get: async (url, options) => { const request = { url, options }; calls.push(request); return get(request); } } };
  context.notificationReads = createDisplayReadScope({ onPause: () => { context.notificationReadVersion++; context.notificationLoading.value = false; } });
  context.notificationReads.activate();
  vm.createContext(context);
  const load = vm.runInContext(`(${loadSource})`, context);
  return { load, calls, context, errors, changeScope: value => { currentScope = value; }, logout: () => { token = ""; } };
}

test("closed notifications read only counts; opening reads the list and unchanged revisions keep its rows", async () => {
  const page = fixture(({ url }) => {
    const query = new URL(url, "https://fixture.invalid").searchParams;
    if (query.has("summaryOnly")) return { summary_only: true, unread: 2, revision: "counts" };
    if (query.has("sinceRevision")) return { unchanged: true, unread: 2, revision: "full" };
    return { rows: [{ id: 12 }], unread: 2, revision: "full" };
  });
  await page.load({ quiet: true });
  assert.match(page.calls[0].url, /summaryOnly=1/);
  assert.equal(page.context.notifications.value[0].id, 99); assert.equal(page.context.notificationUnread.value, 2);
  page.context.notificationDrawerVisible.value = true;
  await page.load();
  assert.doesNotMatch(page.calls[1].url, /summaryOnly|sinceRevision/);
  assert.equal(page.context.notifications.value[0].id, 12);
  await page.load({ quiet: true });
  assert.match(page.calls[2].url, /sinceRevision=full/); assert.equal(page.context.notifications.value[0].id, 12);
  assert.ok(page.calls.every(request => request.options.signal && request.options.noCache));
});

test("hiding notifications aborts a pending list and prevents a late or foreign response from replacing it", async () => {
  let finish;
  const page = fixture(() => new Promise(resolve => { finish = resolve; }));
  page.context.notificationDrawerVisible.value = true;
  const pending = page.load();
  page.context.notificationReads.setVisible(false);
  assert.equal(page.calls[0].options.signal.aborted, true);
  finish({ rows: [{ id: 12 }], unread: 4, revision: "late" }); await pending;
  assert.equal(page.context.notifications.value[0].id, 99);
  await page.load(); assert.equal(page.calls.length, 1);
  page.context.notificationReads.setVisible(true);
  const foreign = page.load(); page.changeScope("tenant-B");
  finish({ rows: [{ id: 33 }], unread: 9, revision: "foreign" }); await foreign;
  assert.equal(page.context.notifications.value[0].id, 99);
  page.logout(); await page.load(); assert.equal(page.calls.length, 2);
});

for (const status of [401, 403]) test(`notification HTTP ${status} blocks repeated reads until authority is verified`, async () => {
  let allowed = false;
  const page = fixture(() => { if (!allowed) throw Object.assign(new Error("fixture denied"), { status }); return { unread: 1, summary_only: true }; });
  await page.load({ quiet: true }); assert.equal(page.calls.length, 1);
  assert.equal(page.context.notificationReads.canRead(), false); assert.equal(page.context.notifications.value.length, 0);
  page.context.notificationReads.setVisible(false); page.context.notificationReads.setVisible(true);
  await page.load(); assert.equal(page.calls.length, 1);
  allowed = true; page.context.notificationReads.resetAuthorization(); await page.load({ quiet: true });
  assert.equal(page.calls.length, 2); assert.equal(page.context.notificationUnread.value, 1);
});
