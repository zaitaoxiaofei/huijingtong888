import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const listSource = readFileSync(new URL("../frontend/admin/views/procurement/PurchaseListView.vue", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");

test("physical receipt and purchasing allow incomplete costs but still require actual quantities", () => {
  assert.match(serviceSource, /采购金额不能为负数/);
  assert.match(serviceSource, /采购数量（actual_quantity）必须大于 0/);
  assert.match(serviceSource, /存在采购数量异常的明细，不能入库/);
  assert.doesNotMatch(serviceSource, /请填写实际货款后再确认采购/);
});

test("procurement UIs allow missing amounts and identify incomplete records", () => {
  assert.match(listSource, /未知金额可稍后补齐/);
  assert.match(workspaceSource, /未知金额可稍后补齐/);
  assert.match(workspaceSource, /记录待补/);
});

test("automatic real-order shortages remain visible when the inventory cost is not yet maintained", () => {
  const start = serviceSource.indexOf("async function ensurePendingOrderProcurementRequestsMysql");
  const end = serviceSource.indexOf("export async function refreshProcurementDemandMysql", start);
  const block = serviceSource.slice(start, end);

  assert.match(block, /采购金额待补/);
  assert.doesNotMatch(block, /if \(!\(amount > 0\)\)[\s\S]*?continue;/);
  assert.match(block, /VALUES \(\?, \?, \?, \?, \?, \?, 'suggested', 'suggested'/);
});

test("procurement list reads never auto-create shortage or inventory-warning requests", () => {
  const listStart = serviceSource.indexOf("export async function procurementRequestsMysql");
  const listEnd = serviceSource.indexOf("export async function repairOrderOutboundMysql", listStart);
  const listBlock = serviceSource.slice(listStart, listEnd);

  assert.match(serviceSource, /const groupedFirstPage = [\s\S]*?Number\(query\.page \|\| 1\)[\s\S]*?=== 1/);
  assert.doesNotMatch(listBlock, /await reconcileTransportedProcurementBacklogMysql\(\)/);
  assert.doesNotMatch(listBlock, /ensurePendingOrderProcurementRequestsMysql\(/);
  assert.doesNotMatch(listBlock, /ensureInventoryWarningProcurementRequestsMysql\(/);
});

test("demand refresh retains pre-shipment real-order procurement requests", () => {
  const start = serviceSource.indexOf("async function ensurePendingOrderProcurementRequestsMysql");
  const end = serviceSource.indexOf("export async function refreshProcurementDemandMysql", start);
  const block = serviceSource.slice(start, end);

  assert.match(block, /WHERE request\.demand_type='real_order' AND request\.status='suggested'\s+AND NOT \(\$\{orderStatusSqlMysql\("awaiting_packaging"\)\} OR \$\{orderStatusSqlMysql\("awaiting_deliver"\)\}\)/);
});
