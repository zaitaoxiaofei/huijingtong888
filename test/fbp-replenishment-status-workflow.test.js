import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue", import.meta.url), "utf8");

test("FBP approval reserves local stock without creating a transfer or outbound movement", () => {
  assert.match(source, /reserveFbpReplenishmentApprovedStockMysql/);
  assert.match(source, /source_type: "fbp_replenishment_reserve"/);
  assert.match(source, /movement_type: "ORDER_RESERVED"/);
  const statusBlock = source.slice(source.indexOf("export async function updateFbpReplenishmentOrderStatusMysql"), source.indexOf("const FBP_TRANSFER_STATUSES"));
  assert.match(statusBlock, /if \(status === "approved"\) \{[\s\S]*?reserveFbpReplenishmentApprovedStockMysql/);
  assert.match(statusBlock, /if \(status === "sent" && \["approved", "ozon_created"\][\s\S]*?createFbpReplenishmentApprovedTransfersMysql/);
});

test("FBP confirmation of shipment creates outbound and releases the reservation", () => {
  assert.match(source, /status === "sent" && \["approved", "ozon_created"\]/);
  assert.match(source, /releaseFbpReplenishmentReservationMysql/);
  assert.match(source, /FBP备货单确认发货，本地转发仓/);
  assert.match(source, /source_type: 'fbp_replenishment_reserve_release'/);
});

test("FBP completion requires all linked transfers to be received", () => {
  assert.match(source, /fbpReplenishmentCompletionStateMysql/);
  assert.match(source, /还没有确认发货，不能确认入仓/);
  assert.match(source, /还有 \$\{completion\.remainingQuantity\} 件 FBP 发仓在途/);
});

test("FBP replenishment page exposes shipment and warehouse receipt stages", () => {
  assert.match(page, /if \(status === "sent"\) return "运输中"/);
  assert.match(page, /if \(status === "completed"\) return "已入仓"/);
  assert.match(page, />确认发货</);
  assert.match(page, />确认入仓</);
});
