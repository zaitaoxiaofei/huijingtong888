import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("FBP replenishment list SQL scopes parent and print-record reads through tenant shops", () => {
  const source = read("../src/services/mysql-cutover.js");
  const start = source.indexOf("export async function fbpReplenishmentOrdersMysql");
  const end = source.indexOf("export async function createFbpReplenishmentOrdersMysql", start);
  const list = source.slice(start, end);
  assert.match(list, /resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(list, /o\.shop_id IN \(SELECT scoped_shop\.id FROM shops scoped_shop/);
  assert.match(list, /tenantShopPredicateMysql\("scoped_shop", defaultTenant\)/);
  assert.match(list, /JOIN fbp_replenishment_orders o ON o\.id = i\.order_id[\s\S]*tenantShopPredicateMysql\("scoped_shop", defaultTenant\)/);
  assert.match(list, /const params = \[normalizedTenantId\]/);
  assert.match(list, /query\.inventory === '1' && defaultTenant/);
  assert.match(list, /defaultTenant \? "COALESCE\(NULLIF\(current_product\.name/);
  assert.match(list, /defaultTenant \? "LEFT JOIN products current_product[\s\S]*: ""/);
});

test("only the FBP replenishment collection route is opened and its tenant comes from the session", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders"], "POST").allowed, false);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "items", "adjustments"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "items"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "delete"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "items", "delete"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "items", "adjustments"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "items", "adjustments"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "items", "adjustments", "reason"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "link"], "POST").allowed, false);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "unlink"], "POST").allowed, false);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-batches", "fill-preview"], "GET").allowed, false);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "status"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "fbp-replenishment-orders", "inventory-allocation"], "POST").allowed, false);
  const server = read("../src/server.js");
  assert.match(server, /services\.fbpReplenishmentOrders\(req\.query \|\| \{\}, tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.updateFbpReplenishmentOrderItems\(await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.deleteFbpReplenishmentOrder\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.deleteFbpReplenishmentOrderItem\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.updateFbpReplenishmentOrderStatus\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.fbpReplenishmentItemAdjustments\(req\.query \|\| \{\}, tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.addFbpReplenishmentItemAdjustment\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.updateFbpReplenishmentItemAdjustmentReason\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.linkFbpReplenishmentOrders\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.unlinkFbpReplenishmentOrder\(await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.match(server, /services\.fbpReplenishmentBatchFillPreview\(req\.query \|\| \{\}, tenantIdFromRequest\(req\)\)/);
});

test("FBP batch services scope linked orders and preview through tenant-owned shops", () => {
  const source = read("../src/services/mysql-cutover.js");
  const linkStart = source.indexOf("export async function linkFbpReplenishmentOrdersMysql");
  const unlinkStart = source.indexOf("export async function unlinkFbpReplenishmentOrderMysql", linkStart);
  const previewStart = source.indexOf("export async function fbpReplenishmentBatchFillPreviewMysql", unlinkStart);
  const fillStart = source.indexOf("export async function recordFbpReplenishmentBatchFillMysql", previewStart);
  const link = source.slice(linkStart, unlinkStart);
  const unlink = source.slice(unlinkStart, previewStart);
  const preview = source.slice(previewStart, fillStart);
  for (const method of [link, unlink, preview]) {
    assert.match(method, /resolveShopTenantIdMysql\(tenantId\)/);
    assert.match(method, /tenantShopPredicateMysql\("s", defaultTenant\)/);
    assert.match(method, /s\.status != 'deleted'/);
  }
  assert.match(link, /JOIN shops s ON s\.id = o\.shop_id/);
  assert.match(link, /WHERE o\.id IN \(\$\{placeholders\}\) AND s\.status != 'deleted' AND \$\{shopScope\}/);
  assert.match(unlink, /JOIN fbp_replenishment_orders o ON o\.id = bm\.order_id/);
  assert.match(unlink, /JOIN shops s ON s\.id = o\.shop_id/);
  assert.match(unlink, /FROM fbp_replenishment_batches b[\s\S]*WHERE b\.id = \? AND s\.status != 'deleted' AND \$\{shopScope\}/);
  assert.match(preview, /WHERE b\.id = \? AND s\.status != 'deleted' AND \$\{shopScope\}/);
});

test("FBP draft writes lock and validate the parent order through tenant shop ownership", () => {
  const source = read("../src/services/mysql-cutover.js");
  for (const [name, next] of [
    ["updateFbpReplenishmentOrderItemsMysql", "saveFbpReplenishmentInventoryAllocationMysql"],
    ["deleteFbpReplenishmentOrderMysql", "deleteFbpReplenishmentOrderItemMysql"],
    ["deleteFbpReplenishmentOrderItemMysql", "updateFbpReplenishmentOrderStatusMysql"],
    ["updateFbpReplenishmentOrderStatusMysql", "const FBP_TRANSFER_STATUSES"]
  ]) {
    const start = source.indexOf(`export async function ${name}`);
    const end = source.indexOf(`export async function ${next}`, start + 1);
    assert.notEqual(start, -1, name);
    const method = source.slice(start, end);
    assert.match(method, /resolveShopTenantIdMysql\(tenantId\)/, name);
    assert.match(method, /JOIN shops s ON s\.id = o\.shop_id/, name);
    assert.match(method, /tenantShopPredicateMysql\("s", defaultTenant\)/, name);
    assert.match(method, /withMysqlTransaction/, name);
  }
  const status = source.slice(source.indexOf("export async function updateFbpReplenishmentOrderStatusMysql"), source.indexOf("const FBP_TRANSFER_STATUSES"));
  assert.match(status, /!defaultTenant && \["approved", "sent", "ozon_created", "completed"\]\.includes\(status\)/);
  assert.match(status, /!defaultTenant && status === "cancelled"/);
  const adjustmentStart = source.indexOf("export async function addFbpReplenishmentItemAdjustmentMysql");
  const adjustmentEnd = source.indexOf("const fbpAdjustmentReasonLabels", adjustmentStart);
  const adjustment = source.slice(adjustmentStart, adjustmentEnd);
  assert.match(adjustment, /reasonCode === "stock_shortage"/);
  assert.match(adjustment, /!defaultTenant && reasonCode === "stock_shortage"/);
  assert.match(adjustment, /JOIN shops s ON s\.id = o\.shop_id/);
  assert.match(adjustment, /LIMIT 1 FOR UPDATE/);
  const adjustmentReadStart = source.indexOf("export async function fbpReplenishmentItemAdjustmentsMysql");
  const adjustmentReadEnd = source.indexOf("export async function updateFbpReplenishmentItemAdjustmentReasonMysql", adjustmentReadStart);
  assert.match(source.slice(adjustmentReadStart, adjustmentReadEnd), /JOIN shops s ON s\.id = o\.shop_id/);
  const reasonStart = source.indexOf("export async function updateFbpReplenishmentItemAdjustmentReasonMysql");
  const reasonEnd = source.indexOf("export async function fbpShortageProcurementDraftsMysql", reasonStart);
  const reason = source.slice(reasonStart, reasonEnd);
  assert.match(reason, /resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(reason, /JOIN shops s ON s\.id = o\.shop_id/);
  assert.match(reason, /!defaultTenant && reasonCode === "stock_shortage"/);
  assert.match(reason, /defaultTenant \? \(Number\(adjustment\.procurement_request_id \|\| 0\) \|\| null\) : null/);
});
