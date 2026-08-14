import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("purchase cost center is registered under procurement navigation", async () => {
  const navigation = await readFile(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");
  const router = await readFile(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");

  assert.match(navigation, /purchase-cost-center/);
  assert.match(navigation, /成本与异常/);
  assert.match(router, /PurchaseCostCenterView/);
});

test("purchase cost center exposes latest, exception and history modes", async () => {
  const page = await readFile(new URL("../frontend/admin/views/procurement/PurchaseCostCenterView.vue", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const routes = await readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");

  assert.match(page, /成本动态/);
  assert.match(page, /异常待处理/);
  assert.match(page, /版本记录/);
  assert.match(page, /采购渠道/);
  assert.match(service, /purchaseCostVersionsMysql/);
  assert.match(service, /reviewPurchaseCostVersionMysql/);
  assert.match(routes, /procurement\/cost-versions/);
});

test("historical purchase cost backfill requires preview and explicit confirmation", async () => {
  const page = await readFile(new URL("../frontend/admin/views/procurement/PurchaseCostCenterView.vue", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
  const routes = await readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");

  assert.match(service, /previewPurchaseCostBackfillMysql/);
  assert.match(service, /initializePurchaseCostBackfillMysql/);
  const schemaGuard = service.slice(
    service.indexOf("async function ensurePurchaseCostVersionSchemaMysql()"),
    service.indexOf("export async function latestOrderSyncStatusMysql")
  );
  assert.match(schemaGuard, /await mysqlExecute\(`/);
  assert.doesNotMatch(schemaGuard, /connection\.execute/);
  assert.match(service, /body\.confirm !== true/);
  assert.match(service, /source_key = \? AND status = 'active'/);
  assert.match(runtime, /previewPurchaseCostBackfill: previewPurchaseCostBackfillMysql/);
  assert.match(runtime, /initializePurchaseCostBackfill: initializePurchaseCostBackfillMysql/);
  assert.match(routes, /cost-versions\/backfill-preview/);
  assert.match(routes, /cost-versions\/backfill/);
  assert.match(page, /openBackfillPreview/);
  assert.match(page, /confirmBackfill/);
  assert.match(page, /\{ confirm: true \}/);
});
