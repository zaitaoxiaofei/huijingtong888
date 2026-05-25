import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { closeMysqlPool } from "../src/mysql-pool.js";
import { ordersPagedMysql } from "../src/services/mysql-cutover.js";

const mysqlTest = config.dbClient === "mysql" ? test : test.skip;

test.after(async () => {
  await closeMysqlPool();
});

mysqlTest("MySQL order list supports status tabs, print filters, inventory sorting, and purchase search", async () => {
  const all = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5, status: "all" });
  assert.ok(all.total > 0);
  assert.equal(all.rows.length, Math.min(5, all.total));
  assert.ok(all.counts.all >= all.total);

  for (const status of ["awaiting_packaging", "awaiting_deliver", "delivering", "delivered", "cancelled", "unbound"]) {
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
  assert.ok(all.logisticsMethodOptions.some((option) => option.value === "cel_air_land_1_500g"));
  assert.ok(all.logisticsMethodOptions.some((option) => option.value === "hunchun_2"));
  assert.ok(all.logisticsMethodOptions.some((option) => option.value === "cel_land_500_25000g"));
  assert.ok(all.logisticsMethodOptions.some((option) => option.value === "cel_land_2_30kg"));
  assert.ok(all.logisticsMethodOptions.some((option) => option.value === "cel_land_0_5_30kg"));
  assert.ok(!all.logisticsMethodOptions.some((option) => option.value === "cel_large_land"));

  const hunchunOption = all.logisticsMethodOptions.find((option) => option.value === "hunchun_2");
  if (Number(hunchunOption?.count || 0) > 0) {
    const hunchun = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5, logisticsMethod: "hunchun_2" });
    assert.equal(hunchun.total, Number(hunchunOption.count || 0));
    assert.ok(hunchun.rows.length <= 5);
    assert.ok(hunchun.rows.every((row) => `${row.delivery_method_name || ""} ${row.warehouse_name || ""} ${row.logistics_channel || ""}`.toLowerCase().includes("hunchun")
      || `${row.delivery_method_name || ""} ${row.warehouse_name || ""} ${row.logistics_channel || ""}`.toLowerCase().includes("hch-pd")));
  }

  const celAirOption = all.logisticsMethodOptions.find((option) => option.value === "cel_air_land_1_500g");
  if (Number(celAirOption?.count || 0) > 0) {
    const celAir = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5, logisticsMethod: "cel_air_land_1_500g" });
    assert.equal(celAir.total, Number(celAirOption.count || 0));
    assert.ok(celAir.rows.length <= 5);
    assert.ok(celAir.rows.every((row) => !`${row.delivery_method_name || ""} ${row.warehouse_name || ""} ${row.logistics_channel || ""}`.toLowerCase().includes("hunchun")));
  }

  for (const [value, expectedText] of [
    ["cel_land_500_25000g", "cel陆运(500-25000g"],
    ["cel_land_2_30kg", "cel陆运(2-30kg"],
    ["cel_land_0_5_30kg", "cel陆运(0.5-30kg"]
  ]) {
    const option = all.logisticsMethodOptions.find((item) => item.value === value);
    if (Number(option?.count || 0) <= 0) continue;
    const result = await ordersPagedMysql({ paged: "1", page: 1, pageSize: 5, logisticsMethod: value });
    assert.equal(result.total, Number(option.count || 0));
    assert.ok(result.rows.length <= 5);
    assert.ok(result.rows.every((row) => `${row.warehouse_name || ""}`.toLowerCase().includes(expectedText)));
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
    assert.notEqual(row.sku_images, undefined);
    assert.notEqual(row.sku_stock_summaries, undefined);
    assert.notEqual(row.product_codes, undefined);
    assert.notEqual(row.product_names, undefined);
    assert.notEqual(row.mark_type, undefined);
    assert.notEqual(row.shipment_deadline_at, undefined);
  }
});
