import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/marketing/OzonActionsView.vue", import.meta.url), "utf8");
function harness(post) {
  const state = { storeId: 20, mode: "official", selectedActionId: "123", editValues: { "501": { action_price: 88, currency: "CNY" } }, selectedRowKeys: ["501"] };
  const messages = [], calls = [];
  const context = vm.createContext({ state, visibleProducts: { value: [{ id: 501, currency: "CNY" }] }, selectedAction: { value: {} }, getProductKey: row => String(row.id), getProductId: row => row.id, getFirstSku: row => row.sku, localizeActionTitle: () => "活动", ElMessageBox: { confirm: async () => {} }, ElMessage: { success: text => messages.push(["success", text]), warning: text => messages.push(["warning", text]), error: text => messages.push(["error", text]) }, apiClient: { post: async (url, body) => { calls.push({ url, body }); return post(state); } }, loadProducts: async () => {} });
  for (const name of ["buildSubmitProducts", "hasInvalidSubmitProduct", "submitSelected", "submitSingleProduct"]) {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    vm.runInContext(match[0], context);
  }
  return { state, context, messages, calls };
}

for (const method of ["submitSelected", "submitSingleProduct"]) {
  test(`${method} submits explicit currency and preserves partial official outcomes`, async () => {
    const outcome = { success: false, count: 0, failures: [{ product_id: 501, reason: "rejected" }], warnings: [] };
    const h = harness(async () => outcome);
    await h.context[method]({ id: 501 });
    assert.equal(h.calls[0].body.products[0].currency, "CNY");
    assert.equal(h.calls[0].body.confirmSharedPrice, true);
    assert.equal(h.state.enrollmentResult, outcome);
    assert.equal(h.messages[0][0], "warning");
  });
  test(`${method} keeps uncertainty visible and ignores a response from another shop`, async () => {
    const h = harness(async () => { throw new Error("timeout"); });
    await h.context[method]({ id: 501 });
    assert.equal(h.state.enrollmentResult.success, false);
    assert.match(h.state.enrollmentResult.failures[0].reason, /timeout/);
    const late = harness(async state => { state.storeId = 30; return { success: true, count: 1 }; });
    await late.context[method]({ id: 501 });
    assert.equal(late.state.enrollmentResult, null);
    assert.equal(late.messages.length, 0);
  });
  test(`${method} cannot submit old product selections after switching shop during confirmation`, async () => {
    const h = harness(async () => ({ success: true, count: 1 }));
    h.context.ElMessageBox.confirm = async () => { h.state.storeId = 30; };
    await h.context[method]({ id: 501 });
    assert.equal(h.calls.length, 0);
  });
}
