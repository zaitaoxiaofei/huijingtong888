import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/advertising/AdvertisingDailyView.vue", import.meta.url), "utf8");
const fn = source.match(/async function saveStrategySetting\(\) \{[^]*?\n\}/)[0];
function harness(result) {
  const calls = [], messages = [];
  const row = { shop_id: 20, campaign_id: "123", ozon_sku: "456" };
  const context = vm.createContext({ currentRow: { value: row }, strategyForm: { mode: "bid", bidRub: 2.5 }, state: { filters: { from: "2026-10-01", to: "2026-10-31" } }, strategyResult: { value: "" }, strategySubmitting: { value: false }, strategyDialogVisible: { value: true }, ElMessageBox: { confirm: async text => calls.push({ confirm: text }) }, apiClient: { post: async (url, payload) => { calls.push({ url, payload }); return result; } }, ElMessage: { warning: text => messages.push(["warning", text]), success: text => messages.push(["success", text]), error: text => messages.push(["error", text]) }, loadRows: async () => {} });
  vm.runInContext(fn, context);
  return { context, calls, messages };
}
test("pending bid read-back stays visible with the dialog open and cannot become success", async () => {
  const h = harness({ ok: false, pending_verification: true, message: "not verified" });
  await h.context.saveStrategySetting();
  assert.match(h.calls[0].confirm, /否定词/);
  assert.equal(h.calls[1].payload.confirmKeywordReset, true);
  assert.equal(h.context.strategyResult.value, "not verified");
  assert.equal(h.context.strategyDialogVisible.value, true);
  assert.equal(h.messages[0][0], "warning");
});
test("only verified outcomes close the strategy dialog", async () => {
  const h = harness({ ok: true, verified: true });
  await h.context.saveStrategySetting();
  assert.equal(h.context.strategyDialogVisible.value, false);
  assert.equal(h.messages[0][0], "success");
});
test("switching current product during confirmation prevents submitting old values", async () => {
  const h = harness({ ok: true, verified: true });
  h.context.ElMessageBox.confirm = async () => { h.context.currentRow.value = {}; };
  await h.context.saveStrategySetting();
  assert.equal(h.calls.length, 0);
});
