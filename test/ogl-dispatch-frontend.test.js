import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { shanghaiDateKey } from "../frontend/admin/utils/shanghai-date.js";
import { STATE_META } from "../frontend/orders/constants/orders-ui.js";

const serviceSource = readFileSync(new URL("../frontend/orders/services/ogl-dispatch-service.js", import.meta.url), "utf8")
  .replace(/^import[^\n]*\n/gm, "").replace(/export /g, "");
const panelSource = readFileSync(new URL("../frontend/orders/components/OglDispatchPanel.vue", import.meta.url), "utf8")
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, "");

const detail = (changes = {}) => ({ batch: { id: 71, batch_number: "OGL-TEST", containers_count: 3, official_status: "not_created", ...changes }, members: [], events: [], summary: {} });
function fixture({ preview, action, bootstrap } = {}) {
  const calls = [], emitted = [], mounts = [];
  let session = "A";
  const service = {
    bootstrap: async () => bootstrap ? bootstrap() : ({ settings: { dispatch_shop_id: 8 }, shops: [{ id: 8, name: "Creation Shop" }], can_manage_settings: true }),
    preview: async (ids) => { calls.push(["preview", ids]); return preview || { eligible: [{ id: 11, shop_id: 8, shop_name: "A" }, { id: 22, shop_id: 9, shop_name: "B" }], rejected: [{ id: 33, reason: "尚未打印" }] }; },
    create: async (payload) => { calls.push(["create", payload]); return detail(); },
    action: async (...args) => { calls.push(["action", ...args]); return action ? action(...args) : detail(); },
    detail: async (id) => { calls.push(["detail", id]); return detail({ official_status: "create_unknown" }); },
    list: async () => ({ rows: [], total: 0 })
  };
  const context = vm.createContext({
    URLSearchParams, console, apiClient: {}, service,
    defineProps: () => ({ mode: "create", orderIds: [11, "22", 33, 11], batchId: 0 }),
    defineEmits: () => (...args) => emitted.push(args),
    useAuthStore: () => ({ user: { id: 1, tenant: { id: 10 } } }), currentApiCacheScope: () => session,
    ref: (value) => ({ value }), reactive: (value) => value,
    computed: (getter) => ({ get value() { return getter(); } }),
    onMounted: (callback) => mounts.push(callback), onBeforeUnmount() {}, watch() {},
    ElMessage: { success() {}, info() {} },
    ElMessageBox: { prompt: async () => ({ value: "核实缺货未交出" }), confirm: async () => true },
    shanghaiDateKey, shanghaiDateTimeText: (value) => value || "-", crypto: { randomUUID: () => "stable-operation-id" }
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
