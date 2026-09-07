import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("order procurement preview uses trend-specific stock targets", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

  assert.match(service, /recent_7d_qty/);
  assert.match(service, /recent_30d_qty/);
  assert.match(service, /week1_qty/);
  assert.match(service, /suggested_purchase_qty/);
  assert.match(service, /dormantTwoWeeks/);
  assert.match(service, /targetStock = recent30d/);
  assert.match(service, /targetStock = recent7d/);
  assert.match(service, /recent30d \* 21 \/ 30/);
  assert.match(service, /Math\.min\(recent30d, Math\.ceil\(recent7d \* 2\)\)/);
});

test("order procurement expands combo recipes into purchasable child products", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const candidateQuery = service.slice(
    service.indexOf("async function orderProcurementCandidateRowsMysql"),
    service.indexOf("async function orderProcurementMissingItemsMysql")
  );
  const page = await readFile(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");

  assert.match(candidateQuery, /LEFT JOIN sku_inventory_recipes recipe/);
  assert.match(candidateQuery, /LEFT JOIN sku_inventory_recipe_items recipe_item/);
  assert.match(candidateQuery, /COALESCE\(recipe_item\.product_id, pc\.component_product_id, p\.id\)/);
  assert.match(candidateQuery, /oi\.quantity \* COALESCE\(recipe_item\.quantity, pc\.quantity, 1\) AS quantity/);
  assert.match(candidateQuery, /sales\.recent_30d_qty, 0\) \* COALESCE\(recipe_item\.quantity, pc\.quantity, 1\) AS recent_30d_qty/);
  assert.match(candidateQuery, /oi\.quantity AS order_quantity/);
  assert.match(page, /const orderProcurementProductItems = computed/);
  assert.match(page, /row\.order_quantity \?\? row\.quantity/);
});

test("order procurement dialog presents one compact intelligent recommendation", async () => {
  const page = await readFile(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
  const styles = await readFile(new URL("../frontend/orders/orders-view.css", import.meta.url), "utf8");

  assert.match(page, /智能采购建议/);
  assert.match(page, /按订单缺口/);
  assert.match(page, /采用建议/);
  assert.match(page, /order-procurement-signal-list/);
  assert.match(styles, /\.order-procurement-decision-row/);
  assert.match(styles, /\.order-procurement-signal-list/);
  assert.doesNotMatch(page, /order-procurement-sales-grid/);
});
