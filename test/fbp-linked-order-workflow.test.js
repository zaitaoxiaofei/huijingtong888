import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";

const source = fs.readFileSync(new URL("../frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue", import.meta.url), "utf8");
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = source.indexOf("\n}", start) + 2;
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test("linked source orders retain stage-specific editing and independent reviewer checks", () => {
  const context = vm.createContext({ currentUserId: { value: 2 } });
  vm.runInContext(["applicantIds", "isApplicant", "approveDisabledReason", "canApprove", "canEditQuantities", "canAdjustQuantity", "canMarkSent", "canMarkCompleted"].map(functionSource).join("\n"), context);
  for (const status of ["draft", "pending_review", "approved", "sent", "ozon_created", "completed", "cancelled"]) {
    const order = { id: 10, batch_id: 3, status, created_by: 1 };
    assert.equal(context.canEditQuantities(order), ["draft", "pending_review"].includes(status));
    assert.equal(context.canApprove(order), ["draft", "pending_review"].includes(status));
    assert.equal(context.canAdjustQuantity(order), ["approved", "sent", "ozon_created", "completed"].includes(status));
  }
  assert.equal(context.approveDisabledReason({ status: "draft", created_by: 1 }), "");
  assert.match(context.approveDisabledReason({ status: "draft", created_by: 2 }), /申请人不能审核/);
});

test("saving linked detail sends source IDs and refreshes only that order, preserving other edits", async () => {
  const calls = [];
  const edited = { id: 10, batch_id: 3, items: [{ id: 101, requested_qty: 15 }] };
  const other = { id: 11, batch_id: 3, items: [{ id: 102, requested_qty: 99 }] };
  const fresh = { ...edited, total_requested_qty: 15 };
  const dialog = { visible: true, batch: { batch_id: 3 }, orders: [edited, other] };
  const context = vm.createContext({
    URLSearchParams, batchDetailDialog: dialog, actionLoadingId: { value: "" },
    actionKey: (row, action) => `${row.id}-${action}`,
    loadPageData: async () => calls.push("refresh-list"),
    ElMessage: { success() {}, error(message) { throw new Error(message); } },
    apiClient: { post: async (url, body) => calls.push({ url, body }), get: async () => ({ rows: [fresh, { ...other, items: [] }] }) }
  });
  vm.runInContext(functionSource("refreshOrderViews") + "\n" + functionSource("saveOrderItems"), context);
  await context.saveOrderItems(edited);
  assert.equal(calls[0].body.order_id, 10);
  assert.equal(calls[0].body.items[0].id, 101);
  assert.equal(calls[0].body.items[0].requested_qty, 15);
  assert.ok(calls.includes("refresh-list"));
  assert.equal(dialog.orders[0], fresh);
  assert.equal(dialog.orders[1], other);
  assert.equal(dialog.orders[1].items[0].requested_qty, 99);
});

test("linked detail mounts quantity editing, approval and audited adjustment controls", () => {
  const detail = source.slice(source.indexOf('<el-dialog v-model="batchDetailDialog.visible"'));
  for (const handler of ["saveOrderItems(row.order)", "updateStatus(row.order, 'approved')", "openAdjustmentDialog(row)", "updateStatus(row.order, 'sent')", "updateStatus(row.order, 'completed')"]) assert.ok(detail.includes(handler), handler);
  assert.ok(detail.includes('v-model="row.requested_qty"'));
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: "fbp-workflow" });
  const template = compileTemplate({ source: descriptor.template.content, filename: "InventoryFbpReplenishmentPage.vue", id: "fbp-workflow", compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
});
