import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");
const constants = source.slice(source.indexOf("const STATUS_TABS ="), source.indexOf("const DEFAULT_PAGE_SIZE ="));
const normalize = source.slice(source.indexOf("  function normalizeStatusTabOrder("), source.indexOf("  function statusTabMetaMap("));
const state = vm.runInNewContext(`${constants}\n${normalize}\n({ STATUS_TABS, MORE_ACTIONS, LOGISTICS_CARRIER_OPTIONS, DEFAULT_STATUS_TAB_ORDER, normalizeStatusTabOrder })`);
const array = value => JSON.parse(JSON.stringify(value));
const expected = ["all", "awaiting_packaging", "awaiting_deliver", "ogl_dispatched", "delivering", "delivered", "cancelled", "unbound", "pending_purchase", "purchase_in_transit"];

test("default status and logistics display order preserve backend filter keys", () => {
  assert.deepEqual(array(state.DEFAULT_STATUS_TAB_ORDER), expected);
  assert.deepEqual(array(state.STATUS_TABS.map(row => row.label)), ["全部订单", "等待备货", "等待发运", "已发运", "运输中", "已签收", "已取消", "待绑定库存", "待采购", "采购在途"]);
  assert.deepEqual(array(state.LOGISTICS_CARRIER_OPTIONS.map(row => [row.value, row.label])), [["all", "全部物流商"], ["ogl", "OGL"], ["cel", "CEL"], ["guoo", "GUOO"], ["postal", "邮政"], ["other", "其他"]]);
});
test("only previous built-in tab orders migrate; custom orders and unrelated preferences remain untouched", () => {
  const legacy = ["awaiting_packaging", "awaiting_deliver", "ogl_dispatched", "delivering", "delivered", "cancelled", "all", "unbound", "pending_purchase", "purchase_in_transit"];
  assert.deepEqual(array(state.normalizeStatusTabOrder(legacy)), expected);
  assert.deepEqual(array(state.normalizeStatusTabOrder(legacy.filter(value => value !== "ogl_dispatched"))), expected);
  const allFirst = ["all", "awaiting_packaging", "awaiting_deliver", "delivering", "delivered", "cancelled", "unbound", "ogl_dispatched", "pending_purchase", "purchase_in_transit"];
  assert.deepEqual(array(state.normalizeStatusTabOrder(allFirst)), expected);
  assert.deepEqual(array(state.normalizeStatusTabOrder(allFirst.filter(value => value !== "ogl_dispatched"))), expected);
  const initialDefault = ["all", "awaiting_packaging", "awaiting_deliver", "delivering", "delivered", "cancelled", "dispute", "unbound"];
  assert.deepEqual(array(state.normalizeStatusTabOrder(initialDefault)), expected);
  assert.deepEqual(array(state.normalizeStatusTabOrder(initialDefault.filter(value => value !== "dispute"))), expected);
  const fullyCustom = [...allFirst];
  [fullyCustom[1], fullyCustom[2]] = [fullyCustom[2], fullyCustom[1]];
  assert.deepEqual(array(state.normalizeStatusTabOrder(fullyCustom)), fullyCustom);
  const custom = ["pending_purchase", "all", "ogl_dispatched"];
  assert.deepEqual(array(state.normalizeStatusTabOrder(custom)).slice(0, 3), custom);
  assert.deepEqual(array(state.normalizeStatusTabOrder(["unknown", "all", "all"])), expected);
  assert.deepEqual(custom, ["pending_purchase", "all", "ogl_dispatched"]);
  const load = source.slice(source.indexOf("  async function loadStatusTabPreference("), source.indexOf("  async function saveStatusTabPreference("));
  assert.doesNotMatch(load, /apiClient\.(post|put|delete)/);
});

test("loading the original eight-tab preference migrates the displayed order without writing saved preferences", async () => {
  const load = source.slice(source.indexOf("  async function loadStatusTabPreference("), source.indexOf("  async function saveStatusTabPreference("));
  const stored = ["all", "awaiting_packaging", "awaiting_deliver", "delivering", "delivered", "cancelled", "dispute", "unbound"];
  const calls = [], statusTabOrder = { value: [] };
  const run = vm.runInNewContext(`${load};loadStatusTabPreference`, {
    ensureOrdersViewScope: () => "current", currentOrdersCacheScope: () => "current", URLSearchParams,
    ORDER_STATUS_TAB_PREFERENCE_KEY: "orders.status_tabs", statusTabOrder,
    applyStatusTabOrder: order => { statusTabOrder.value = array(state.normalizeStatusTabOrder(order)); },
    apiClient: { get: async (url, options) => { calls.push([url, options]); return { value: { order: stored } }; } },
    DEFAULT_STATUS_TAB_ORDER: state.DEFAULT_STATUS_TAB_ORDER,
    console: { warn(message) { throw new Error(message); } }
  });
  assert.deepEqual(array(await run()), expected);
  assert.deepEqual(statusTabOrder.value, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/user-preferences?key=orders.status_tabs");
  assert.equal(calls[0][1].noCache, true);
  assert.deepEqual(stored, ["all", "awaiting_packaging", "awaiting_deliver", "delivering", "delivered", "cancelled", "dispute", "unbound"]);
});
test("More actions keeps batch receipt preview in the requested order and leaves OGL separate", () => {
  assert.deepEqual(array(state.MORE_ACTIONS.map(row => row.label)), ["批量备货", "批量登记实收", "重算利润", "质检规则"]);
  assert.ok(state.MORE_ACTIONS.slice(0, 2).every(row => row.requiresSelection));
  const page = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
  const handler = page.match(/function handleToolbarMoreAction\([^]*?\n}/)[0];
  let previews = 0;
  const run = vm.runInNewContext(`${handler};handleToolbarMoreAction`, { previewShippedReceipts: () => { previews += 1; } });
  run("shipped-receipts");
  assert.equal(previews, 1);
  assert.doesNotMatch(page, /class="orders-inline-actions"/);
  assert.match(page, /@open-ogl-batch="id => openOglDispatch\('history', id\)"/);
  const table = readFileSync(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");
  const status = table.slice(table.indexOf('<el-table-column label="状态"'), table.indexOf('<el-table-column label="商品信息"'));
  assert.ok(status.indexOf("row.statusDeadlineHint") < status.indexOf("运货单"));
  assert.doesNotMatch(status, /container_no|货位/);
});
