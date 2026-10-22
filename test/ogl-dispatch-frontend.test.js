import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { shanghaiDateDaysAgo, shanghaiDateKey, shanghaiDateText } from "../frontend/admin/utils/shanghai-date.js";
import { STATE_META } from "../frontend/orders/constants/orders-ui.js";

const serviceSource = readFileSync(new URL("../frontend/orders/services/ogl-dispatch-service.js", import.meta.url), "utf8")
  .replace(/^import[^\n]*\n/gm, "").replace(/export /g, "");
const panelSource = readFileSync(new URL("../frontend/orders/components/OglDispatchPanel.vue", import.meta.url), "utf8")
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, "");

const detail = (changes = {}) => ({ batch: { id: 71, batch_number: "OGL-TEST", containers_count: 3, official_status: "not_created", ...changes }, members: [], events: [], summary: {} });
function fixture({ preview, action, bootstrap, props = {}, officialList, officialDetail, officialTracking } = {}) {
  const calls = [], emitted = [], mounts = [];
  let session = "A";
  const service = {
    bootstrap: async () => bootstrap ? bootstrap() : ({ settings: { dispatch_shop_id: 8 }, shops: [{ id: 8, name: "Creation Shop" }], can_manage_settings: true }),
    preview: async (ids) => { calls.push(["preview", ids]); return preview || { eligible: [{ id: 11, shop_id: 8, shop_name: "A" }, { id: 22, shop_id: 9, shop_name: "B" }], rejected: [{ id: 33, reason: "尚未打印" }] }; },
    create: async (payload) => { calls.push(["create", payload]); return detail(); },
    action: async (...args) => { calls.push(["action", ...args]); return action ? action(...args) : detail(); },
    detail: async (id) => { calls.push(["detail", id]); return detail({ official_status: "create_unknown" }); },
    list: async () => ({ rows: [], total: 0 }),
    officialList: async (date) => { calls.push(["official-list", date]); return officialList ? officialList(date) : { rows: [{ carriage_id: "88001", status: "formed", departure_date: `${date}T02:00:00Z` }], total: 1, dispatch_shop: { id: 8, name: "Creation Shop" } }; },
    officialDetail: async (id, date) => { calls.push(["official-detail", id, date]); return officialDetail ? officialDetail(id, date) : { carriage: { carriage_id: id, status: "formed", containers_count: 4 }, members: [{ posting_number: "fixture-only", matched_local: false }], summary: { official_members: 1, matched_local: 0, unmatched_local: 1, online: 0 }, dispatch_shop: { id: 8, name: "Creation Shop" } }; },
    officialTracking: async (id, date) => { calls.push(["official-tracking", id, date]); return officialTracking ? officialTracking(id, date) : { tracking: { status: "found", source: "official_container_label", carrier_name: "圆通", master_tracking_number: "YT000000000001", tracking_numbers: ["YT000000000001"], page_count: 1, containers_count: 4, labels: [{ label_page: 1, tracking_numbers: ["YT000000000001"] }], container_mapping_confirmed: false } }; }
  };
  const context = vm.createContext({
    URLSearchParams, console, apiClient: {}, service,
    defineProps: () => ({ mode: "create", orderIds: [11, "22", 33, 11], batchId: 0, ...props }),
    defineEmits: () => (...args) => emitted.push(args),
    useAuthStore: () => ({ user: { id: 1, tenant: { id: 10 } } }), currentApiCacheScope: () => session,
    ref: (value) => ({ value }), reactive: (value) => value,
    computed: (getter) => ({ get value() { return getter(); } }),
    onMounted: (callback) => mounts.push(callback), onBeforeUnmount() {}, watch() {},
    ElMessage: { success() {}, info() {} },
    ElMessageBox: { prompt: async () => ({ value: "核实缺货未交出" }), confirm: async () => true },
    shanghaiDateDaysAgo, shanghaiDateKey, shanghaiDateText, shanghaiDateTimeText: (value) => value || "-", crypto: { randomUUID: () => "stable-operation-id" }
  });
  vm.runInContext(serviceSource, context);
  // The component deliberately consumes the injected transport, never a real API.
  vm.runInContext(panelSource, context);
  return { context, calls, emitted, mount: () => mounts[0](), get: (code) => vm.runInContext(code, context), rotate: () => { session = "B"; } };
}

test("OGL preview sends the actual deduplicated cross-page selection and requires explicit rejection exclusion", async () => {
  const f = fixture();
  await f.mount();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ["preview", [11, 22, 33]]);
  assert.equal(f.get("canCreate.value"), false);
  await f.get("createBatch()");
  assert.equal(f.calls.filter(([name]) => name === "create").length, 0);
  f.get("acceptEligible.value = true");
  assert.equal(f.get("canCreate.value"), true);
  await f.get("createBatch()");
  const payload = f.calls.find(([name]) => name === "create")[1];
  assert.deepEqual(Array.from(payload.order_ids), [11, 22]);
  assert.equal(payload.client_request_id, "stable-operation-id");
  assert.equal(payload.container_count, 1);
  assert.equal(f.get("preview.value"), null, "successful creation cannot create the same stale selection again");
  assert.ok(f.emitted.some(([name]) => name === "changed"));
});

test("official failure reloads the saved unknown outcome and never marks actual dispatch", async () => {
  const f = fixture({ action: async () => { throw new Error("Ozon 请求超时，结果待核实"); } });
  await f.mount();
  f.get("useDetail({batch:{id:71,containers_count:3,official_status:'not_created'},members:[]})");
  await f.get("action('official-create', {delivery_method_id:80, departure_date:'2026-10-22'})");
  assert.match(f.get("error.value"), /结果待核实/);
  assert.equal(f.get("batch.value.official_status"), "create_unknown");
  assert.ok(f.calls.some(([name]) => name === "detail"));
  assert.equal(f.calls.filter((call) => call[0] === "action" && call[2] === "dispatch").length, 0);
});

test("withdrawal transmits selected order IDs and operator reason, retaining physical-print state outside this request", async () => {
  const f = fixture();
  await f.mount();
  f.get("useDetail({batch:{id:71,containers_count:3,official_status:'not_created'},members:[]}); selectedMembers.value = [{order_id:11},{order_id:22}]");
  await f.get("selectedAction('withdraw')");
  const call = f.calls.find(([name]) => name === "action");
  assert.equal(call[2], "withdraw");
  assert.deepEqual(Array.from(call[3].order_ids), [11, 22]);
  assert.equal(call[3].reason, "核实缺货未交出");
  assert.equal(Object.hasOwn(call[3], "printed_at"), false);
});

test("tenant/session rotation rejects late reads and prevents stale dialog mutations", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ bootstrap: () => pending });
  const load = f.mount();
  f.rotate();
  finish({ settings: { dispatch_shop_id: 999 }, shops: [{ id: 999, name: "Private old shop" }] });
  await load;
  assert.equal(f.get("bootstrap.value.shops.length"), 0);
  assert.equal(f.calls.length, 0);
  await f.get("action('dispatch', {order_ids:[11]})");
  assert.equal(f.calls.length, 0);
});

test("OGL untracked-member filter distinguishes failed/stale sync, withdrawal and cancellation", () => {
  const f = fixture();
  const match = (overrides, filter = "not_online") => f.context.oglMemberMatches({ active: true, dispatched_at: "2026-10-22", last_synced_at: "2026-10-22", logistics_fresh: true, online: false, ...overrides }, filter);
  assert.equal(match({}), true);
  assert.equal(match({ sync_error: "authorization failed" }), false);
  assert.equal(match({ logistics_fresh: false }), false);
  assert.equal(match({ active: false }), false);
  assert.equal(match({ cancelled: true }), false);
  assert.equal(match({ online: true }), false);
  assert.equal(match({ sync_error: "authorization failed" }, "sync_pending"), true);
  assert.equal(match({ active: false, exception_note: "已撤回" }, "exception"), false);
});

test("local historical handover cannot override a later platform status or non-OGL order", () => {
  const f = fixture();
  assert.equal(f.context.isOglDispatched({ display_status: "ogl_dispatched", ogl_dispatch: { dispatched: true } }), true);
  assert.equal(f.context.isOglDispatched({ display_status: "delivering", ogl_dispatch: { dispatched: true } }), false);
  assert.equal(f.context.isOglDispatched({ status: "awaiting_deliver" }), false);
  assert.equal(f.context.isOglDispatched({ display_status: "ogl_dispatched", ogl_dispatch: { dispatched: false } }), false);
});

test("OGL files use the authenticated blob transport and accept only supported file kinds", async () => {
  const f = fixture();
  const calls = [];
  const transport = f.context.createOglDispatchService({ blob: async (url) => { calls.push(url); return { fixture: true }; } });
  await transport.file(71, "barcode");
  assert.equal(calls[0], "/api/ogl-dispatch/file?batch_id=71&type=barcode");
  assert.throws(() => transport.file(71, "html"), /未知发运文件类型/);
  assert.equal(calls.length, 1);
});

test("official date-time options and saved batches become Beijing-calendar date-picker values", () => {
  const f = fixture();
  f.get("useDetail({batch:{id:71,departure_date:'2026-10-21T20:00:00Z'},members:[]})");
  assert.equal(f.get("form.departure_date"), "2026-10-22");
  f.get("options.value = [{id:80,departure_date:'2026-10-22T20:00:00Z'}]; chooseOfficialOption(80)");
  assert.equal(f.get("form.departure_date"), "2026-10-23");
  f.get("options.value = [{id:81,date:'2026-10-24'}]; chooseOfficialOption(81)");
  assert.equal(f.get("form.departure_date"), "2026-10-24");
});

test("official date-only departures display the Beijing calendar day without inventing a time", () => {
  const f = fixture();
  assert.equal(f.get("formatDeparture('2026-10-21')"), "2026-10-21");
  assert.equal(f.get("formatDeparture('2026-10-22')"), "2026-10-22");
  assert.doesNotMatch(f.get("formatDeparture('2026-10-21')"), /08:00|00:00|T|Z/);
  assert.equal(f.get("formatDeparture('2026-10-22T02:00:00Z')"), "2026-10-22T02:00:00Z", "complete timestamps still use the shared date-time formatter");
  assert.equal(f.get("formatDeparture(null)"), "-");
});

test("authoritative OGL platform state overrides stale awaiting-deliver fields in tabs, labels and actions", () => {
  const f = fixture();
  const composable = readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");
  const page = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
  f.context.STATE_META = STATE_META;
  for (const name of ["AWAITING_PACKAGING_STATES", "AWAITING_DELIVER_STATES", "DELIVERING_KEYWORDS"]) vm.runInContext(composable.match(new RegExp(`const ${name} = [^;]*;`))[0], f.context);
  vm.runInContext(composable.match(/function orderTabKey\(row = \{\}\) \{[\s\S]*?\n\}/)[0], f.context);
  for (const name of ["rowStateLabel", "rowDisplayStateKey"]) vm.runInContext(page.match(new RegExp(`function ${name}\\(row\\) \\{[\\s\\S]*?\\n\\}`))[0], f.context);
  for (const state of ["ogl_dispatched", "delivering", "delivered", "cancelled", "dispute"]) {
    const row = { status: "delivering", tracking_stage: "awaiting_deliver", logistics_status: "awaiting_deliver", display_status: state, ogl_dispatch: { dispatched: true } };
    assert.equal(f.context.orderTabKey(row), state);
    assert.equal(f.context.rowDisplayStateKey(row), state);
    assert.equal(f.context.rowStateLabel(row), STATE_META[state].label);
  }
  const ordinary = { status: "awaiting_deliver", display_status: "delivering" };
  assert.equal(f.context.orderTabKey(ordinary), "awaiting_deliver");
  assert.equal(f.context.rowDisplayStateKey(ordinary), "awaiting_deliver");
  assert.equal(f.context.rowStateLabel(ordinary), "等待发货");
  assert.equal(f.context.oglDispatchDisplayStatus({ ogl_dispatch: { dispatched: true }, display_status: "unknown" }), "");
});

test("duplicate method IDs display all Beijing departure days and preserve an available selected day", () => {
  const f = fixture();
  f.get("options.value = [{id:80,name:'OGL',departure_date:'2026-10-21T20:00:00Z'},{id:80,name:'OGL',departure_date:'2026-10-22T20:00:00Z'}]; form.departure_date = '2026-10-23'; chooseOfficialOption(80)");
  assert.equal(f.get("officialMethodOptions.value.length"), 1);
  assert.equal(f.get("officialMethodOptions.value[0].label"), "OGL（2026-10-22、2026-10-23）");
  assert.equal(f.get("form.departure_date"), "2026-10-23");
});

test("existing Ozon carriages can be read for today and yesterday with no selected orders or internal batch writes", async () => {
  const f = fixture({ props: { mode: "official", orderIds: [] } });
  await f.mount();
  assert.equal(f.get("tab.value"), "official");
  assert.deepEqual(f.calls[0], ["official-list", shanghaiDateKey()]);
  assert.equal(f.get("officialRows.value.length"), 1);
  await f.get("showOfficialCarriages('2026-10-21')");
  await f.get("openOfficialCarriage('88001')");
  assert.equal(f.get("tab.value"), "official-detail");
  assert.equal(f.get("officialCarriage.value.containers_count"), 4, "use the actual detail count rather than assuming the list/member count");
  assert.equal(f.get("officialMembers.value[0].matched_local"), false);
  assert.deepEqual(f.calls.find(([name]) => name === "official-detail"), ["official-detail", "88001", "2026-10-21"]);
  assert.ok(f.calls.every(([name]) => ["official-list", "official-detail", "official-tracking"].includes(name)), "read-only workflow must not create, preview, approve or dispatch a batch");
  assert.equal(f.emitted.length, 0);
  assert.equal(f.get("carriageStatus({status:'formed'})"), "已生成");
  assert.equal(f.get("carriageStatus({status:'received'})"), "承运方已接收");
  assert.equal(f.get("carriageStatus({status:'received',status_label:'验收中'})"), "验收中");
  assert.equal(f.get("officialMemberStatus({platform_status:'acceptance_in_progress',logistics_status:'posting_acceptance_in_progress'})"), "平台验收中");
  assert.equal(f.get("officialMemberStatus({platform_status:'awaiting_deliver',logistics_status:'posting_in_carriage'})"), "已加入发运");
});

test("late existing-carriage details cannot appear after tenant/session rotation", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ props: { mode: "official", orderIds: [] }, officialDetail: () => pending });
  await f.mount();
  const read = f.get("openOfficialCarriage('88001')");
  f.rotate();
  finish({ carriage: { carriage_id: "private-old-tenant" }, members: [{ posting_number: "private-old-tenant" }] });
  await read;
  assert.equal(f.get("officialDetail.value"), null);
  assert.equal(f.get("tab.value"), "official");
});

test("existing-carriage transport uses only authenticated date-filtered GET endpoints", async () => {
  const f = fixture();
  const calls = [];
  const transport = f.context.createOglDispatchService({ get: async (url) => { calls.push(url); return {}; } });
  await transport.officialList("2026-10-21");
  await transport.officialDetail("88001", "2026-10-21");
  await transport.officialTracking("88001", "2026-10-21");
  assert.deepEqual(calls, ["/api/ogl-dispatch/official-carriages?date=2026-10-21", "/api/ogl-dispatch/official-carriage?id=88001&date=2026-10-21", "/api/ogl-dispatch/official-carriage-tracking?id=88001&date=2026-10-21"]);
});

test("official carriage details render without waiting for the separate label tracking read", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ props: { mode: "official", orderIds: [] }, officialTracking: () => pending });
  await f.mount();
  assert.equal(f.calls.some(([name]) => name === "official-tracking"), false, "list loading must not download every label PDF");
  await f.get("openOfficialCarriage('88001')");
  assert.equal(f.get("officialCarriage.value.carriage_id"), "88001");
  assert.equal(f.get("busy.value"), false);
  assert.equal(f.get("trackingLoading.value"), true);
  assert.equal(f.get("masterTrackingLabel.value"), "待获取");
  finish({ tracking: { status: "found", master_tracking_number: "YT000000000001", tracking_numbers: ["YT000000000001"], containers_count: 4 } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(f.get("masterTrackingLabel.value"), "YT000000000001");
  assert.equal(f.get("trackingLoading.value"), false);
});

test("late tracking reads cannot leak another carriage, Beijing date or tenant into the current detail", async () => {
  const pending = [];
  const f = fixture({ props: { mode: "official", orderIds: [] }, officialTracking: () => new Promise((resolve) => pending.push(resolve)) });
  await f.mount();
  await f.get("openOfficialCarriage('88001')");
  await f.get("showOfficialCarriages('2026-10-21');");
  await f.get("openOfficialCarriage('88002')");
  pending[0]({ tracking: { status: "found", master_tracking_number: "YT000000000001" } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(f.get("officialTracking.value"), null);
  assert.equal(f.get("masterTrackingLabel.value"), "待获取");
  pending[1]({ tracking: { status: "found", master_tracking_number: "YT000000000002" } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(f.get("masterTrackingLabel.value"), "YT000000000002");
  const read = f.get("loadOfficialTracking()");
  assert.equal(f.get("officialTracking.value"), null, "retry must clear the last number immediately");
  f.rotate();
  pending[2]({ tracking: { status: "found", master_tracking_number: "private-old-tenant" } });
  await read;
  assert.equal(f.get("officialTracking.value"), null);
});

test("tracking failures and multiple label numbers do not guess a master number or overwrite the main detail", async () => {
  let attempt = 0;
  const f = fixture({ props: { mode: "official", orderIds: [] }, officialTracking: async () => {
    if (++attempt === 1) throw new Error("标签读取暂不可用");
    if (attempt === 2) return { tracking: { status: "not_found", master_tracking_number: null, tracking_numbers: [], labels: [] } };
    return { tracking: { status: "ambiguous", master_tracking_number: null, tracking_numbers: ["YT000000000001", "YT000000000002"], page_count: 3, containers_count: 2, labels: [{ label_page: 1, tracking_numbers: ["YT000000000001"] }, { label_page: 2, tracking_numbers: ["YT000000000001"] }, { label_page: 3, tracking_numbers: ["YT000000000002"] }], container_mapping_confirmed: false } };
  } });
  await f.mount();
  await f.get("openOfficialCarriage('88001')");
  assert.match(f.get("trackingError.value"), /标签读取暂不可用/);
  assert.equal(f.get("error.value"), "");
  assert.equal(f.get("officialCarriage.value.carriage_id"), "88001");
  await f.get("loadOfficialTracking()");
  assert.equal(f.get("trackingError.value"), "");
  assert.equal(f.get("masterTrackingLabel.value"), "待获取");
  await f.get("loadOfficialTracking()");
  assert.equal(f.get("masterTrackingLabel.value"), "多个运单，主单关系待确认");
  assert.equal(f.get("officialTracking.value.tracking_numbers.length"), 2);
  assert.equal(f.get("officialTracking.value.labels.length"), 3);
  assert.equal(f.get("officialTracking.value.containers_count"), 2);
  assert.equal(f.get("officialTracking.value.container_mapping_confirmed"), false);
});
