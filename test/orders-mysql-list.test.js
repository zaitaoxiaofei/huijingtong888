import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { ordersPagedMysql } from "../src/services/mysql-cutover.js";
import { resolveOrderLogisticsRuleValue } from "../src/services/order-logistics-filter-rules.js";

const mysqlTest = config.dbClient === "mysql" ? test : test.skip;

test.after(async () => {
  await closeMysqlPool();
});

function logisticsRuleFilterValue(row = {}) {
  const keywords = String(row.filter_keywords || "")
    .split(/\r?\n|[|｜]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const fallbackKeywords = [row.name, row.carrier, row.channel]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return resolveOrderLogisticsRuleValue({
    name: row.name,
    carrier: row.carrier,
    channel: row.channel,
    warehousePatterns: keywords.length ? keywords : fallbackKeywords
  }) || `logistics_rule_${row.id}`;
}

test("pending purchase filter excludes every supported inventory source", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const pendingFilter = service.slice(
    service.indexOf('if (status === "pending_purchase")'),
    service.indexOf('if (status === "unbound")')
  );

  assert.match(pendingFilter, /purchase_fbp\.stock_type = 'fbp_real'/);
  assert.match(pendingFilter, /FROM sku_inventory_recipes purchase_recipe/);
  assert.match(pendingFilter, /FROM product_components purchase_component/);
  assert.match(pendingFilter, /FROM inventory_movements purchase_im/);
  assert.match(pendingFilter, /FROM inbound_records purchase_ir/);
});

mysqlTest("MySQL order list supports status tabs, print filters, inventory sorting, and purchase search", async () => {
  const all = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5, status: "all" });
  assert.ok(all.total > 0);
  assert.equal(all.rows.length, Math.min(5, all.total));
  assert.ok(all.counts.all >= all.total);

  for (const status of ["awaiting_packaging", "awaiting_deliver", "delivering", "delivered", "cancelled", "unbound", "pending_purchase"]) {
    const result = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5, status });
    assert.equal(result.total, result.counts[status]);
    assert.ok(result.rows.length <= 5);
  }

  const printed = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5, printFilter: "printed" });
  assert.ok(printed.rows.every((row) => row.printed_at));

  const unprintedInventory = await ordersPagedMysql({
    paged: "1",
    page: 1,
    pageSize: 5,
    printFilter: "unprinted",
    sortMode: "inventory"
  });
  assert.ok(unprintedInventory.rows.every((row) => !row.printed_at));
  assert.ok(unprintedInventory.rows.every((row) => row.inventory_ids || row.product_codes || row.skus));

  for (const fulfillmentType of ["fbs", "fbp"]) {
    const fulfillmentInventory = await ordersPagedMysql({
      paged: "1",
      page: 1,
      pageSize: 5,
      fulfillmentType,
      sortMode: "inventory"
    });
    assert.ok(fulfillmentInventory.rows.every((row) => row.fulfillment_type_key === fulfillmentType));
  }

  const packagingFbsUnprintedInventory = await ordersPagedMysql({
    paged: "1",
    page: 1,
    pageSize: 5,
    status: "awaiting_packaging",
    fulfillmentType: "fbs",
    printFilter: "unprinted",
    sortMode: "inventory"
  });
  assert.ok(packagingFbsUnprintedInventory.total > 0);
  assert.ok(packagingFbsUnprintedInventory.rows.every((row) => row.fulfillment_type_key === "fbs"));
  assert.ok(packagingFbsUnprintedInventory.rows.every((row) => !row.printed_at));

  const purchaseSearch = await ordersPagedMysql({
    paged: "1",
    page: 1,
    pageSize: 5,
    searchType: "purchaseTracking",
    searchQuery: "PO-"
  });
  assert.ok(purchaseSearch.total > 0);
  assert.ok(purchaseSearch.rows.every((row) => row.purchase_order_numbers || row.purchase_tracking_numbers));
});

mysqlTest("MySQL order list supports logistics method filters", async () => {
  const all = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5 });
  assert.ok(all.logisticsMethodOptions.some((option) => option.value === "all"));

  const configuredRules = await mysqlQuery(`
    SELECT id, name, filter_keywords, carrier, channel, enabled
    FROM logistics_fee_rules
  `);
  const enabledValues = new Set(
    configuredRules
      .filter((row) => Number(row.enabled) !== 0)
      .map(logisticsRuleFilterValue)
      .filter(Boolean)
  );
  const disabledOnlyValues = new Set(
    configuredRules
      .filter((row) => Number(row.enabled) === 0)
      .map(logisticsRuleFilterValue)
      .filter((value) => value && !enabledValues.has(value))
  );
  const visibleOptions = all.logisticsMethodOptions.filter((option) => option.value !== "all");

  if (configuredRules.length > 0) {
    assert.ok(visibleOptions.length > 0);
    assert.ok(visibleOptions.every((option) => enabledValues.has(option.value)));
    assert.ok(visibleOptions.every((option) => !disabledOnlyValues.has(option.value)));
  }
  assert.ok(visibleOptions.every((option) => Number(option.count || 0) > 0));

  for (const option of visibleOptions.slice(0, 3)) {
    const result = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5, logisticsMethod: option.value });
    assert.equal(result.total, Number(option.count || 0));
    assert.ok(result.rows.length <= 5);
  }
});

mysqlTest("MySQL order list rows expose fields required by the frontend table", async () => {
  const result = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 10, status: "all" });
  assert.ok(result.rows.length > 0);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.ok(row.posting_number);
    assert.ok(row.shop_name);
    assert.notEqual(row.item_count, undefined);
    assert.notEqual(row.total_quantity, undefined);
    assert.notEqual(row.revenue, undefined);
    assert.notEqual(row.estimated_profit, undefined);
    assert.notEqual(row.actual_profit, undefined);
    assert.notEqual(row.skus, undefined);
    assert.notEqual(row.sku_quantities, undefined);
    assert.notEqual(row.sku_names, undefined);
    assert.notEqual(row.sku_inventory_names, undefined);
    assert.notEqual(row.sku_images, undefined);
    assert.notEqual(row.sku_stock_summaries, undefined);
    assert.notEqual(row.sku_incoming_summaries, undefined);
    assert.notEqual(row.sku_component_counts, undefined);
    assert.notEqual(row.product_codes, undefined);
    assert.notEqual(row.product_names, undefined);
    assert.notEqual(row.mark_type, undefined);
    assert.notEqual(row.shipment_deadline_at, undefined);
  }
});
