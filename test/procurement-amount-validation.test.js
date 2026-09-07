import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const listSource = readFileSync(new URL("../frontend/admin/views/procurement/PurchaseListView.vue", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");

test("procurement writes and inbound reject a missing purchase amount", () => {
  assert.match(serviceSource, /采购金额（amount）必须大于 0；请填写实际货款后再提交采购/);
  assert.match(serviceSource, /采购金额（amount）必须大于 0；请填写实际货款后再保存/);
  assert.match(serviceSource, /存在采购数量或采购金额异常的明细，不能入库/);
  assert.match(serviceSource, /采购数量（quantity）和采购金额（amount）都必须大于 0/);
  assert.match(serviceSource, /请填写实际货款后再确认采购/);
});

test("procurement UIs block zero-amount saves and purchase confirmation", () => {
  assert.match(listSource, /请填写采购金额，货款必须大于 0/);
  assert.match(listSource, /存在未填写采购金额的明细/);
  assert.match(workspaceSource, /采购金额必须大于0，请填写实际货款/);
});

test("procurement list reads never auto-create shortage or inventory-warning requests", () => {
  const listStart = serviceSource.indexOf("export async function procurementRequestsMysql");
  const listEnd = serviceSource.indexOf("export async function repairOrderOutboundMysql", listStart);
  const listBlock = serviceSource.slice(listStart, listEnd);

  assert.match(serviceSource, /const groupedFirstPage = [\s\S]*?Number\(query\.page \|\| 1\)[\s\S]*?=== 1/);
  assert.match(listBlock, /if \(groupedFirstPage\) await reconcileTransportedProcurementBacklogMysql\(\)/);
  assert.doesNotMatch(listBlock, /ensurePendingOrderProcurementRequestsMysql\(/);
  assert.doesNotMatch(listBlock, /ensureInventoryWarningProcurementRequestsMysql\(/);
});
