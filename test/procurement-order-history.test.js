import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("procurement workspace exposes historical order summary and detail", async () => {
  const [view, service, routes, runtime, taskView] = await Promise.all([
    read("frontend/admin/views/procurement/ProcurementWorkspaceView.vue"),
    read("src/services/mysql-cutover.js"),
    read("src/server/routes/operations.js"),
    read("src/services/mysql-runtime-services.js"),
    read("frontend/admin/views/team/ProductDevelopmentCenterView.vue")
  ]);
  assert.match(view, /label="历史订单"/);
  assert.match(view, /移出本次采购/);
  assert.doesNotMatch(view, /v-if="row\.manually_added"[^>]+removeBulkItem/);
  assert.match(view, /historical_total_order_count/);
  assert.match(view, /historical_cancelled_quantity/);
  assert.match(view, /historical_returned_quantity/);
  assert.match(view, /缺货待采购/);
  assert.match(view, /采购在途/);
  assert.match(view, /按缺口补采购/);
  assert.match(view, /openOrderHistory\(row\.source_row \|\| row\)/);
  assert.match(view, /width:72px[^\n]+height:96px/);
  assert.match(service, /export async function procurementProductOrderHistoryMysql/);
  assert.match(service, /procurement_covered/);
  assert.match(routes, /GET \/api\/procurement\/order-history/);
  assert.match(runtime, /procurementProductOrderHistory: procurementProductOrderHistoryMysql/);
  assert.match(service, /advanced_without_purchase/);
  assert.match(taskView, /min-height:132px/);
  assert.doesNotMatch(taskView, /height:120px;min-height:120px/);
});
