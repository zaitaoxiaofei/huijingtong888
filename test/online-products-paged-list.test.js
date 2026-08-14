import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { onlineProductMatchesStatusForTest, onlineProductSkuRepairCandidateForTest, onlineProductStatusKeyForTest, onlineProductStockUpdateTargetForTest, onlineProductsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const onlineProductList = onlineProductsMysql;
const onlineProductsViewSource = readFileSync(new URL("../frontend/admin/views/inventory/OnlineProductsView.vue", import.meta.url), "utf8");
const mysqlCutoverSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("batch stock results use one in-memory snapshot for local pagination", () => {
  assert.match(onlineProductsViewSource, /let batchStockSnapshotRows = \[\]/);
  assert.match(onlineProductsViewSource, /filteredRows\.slice\(start, start \+ state\.filters\.pageSize\)/);
  assert.match(onlineProductsViewSource, /Boolean\(displayedOzonSku\(row\)\) && !\["archived", "hidden"\]\.includes/);
  assert.match(onlineProductsViewSource, /showProductLimitPanel\.value && batchStockSnapshotKey\) applyBatchStockSnapshotPage\(\)/);
  assert.match(onlineProductsViewSource, /invalidateBatchStockSnapshot\(\);\s*await loadPageData\(\{ forceSnapshot: true \}\)/);
});

test("pending listing pull uses bounded parallel detail reads and writes", () => {
  assert.match(mysqlCutoverSource, /visibilityConcurrency: 5/);
  assert.match(mysqlCutoverSource, /detailConcurrency: 5/);
  assert.match(mysqlCutoverSource, /filterPendingListingProductsWithoutFbsStock\(refs, stockRows, \{ requireSku: false \}\)/);
  assert.match(mysqlCutoverSource, /items = filterPendingListingProductsWithoutFbsStock\(detailedItems, stockRows\)/);
  assert.match(mysqlCutoverSource, /mapWithConcurrencyMysql\(matchingItems, 8/);
});

test("online zero-stock status only includes stockable supply-state products", () => {
  assert.equal(onlineProductStatusKeyForTest({
    status: "ready",
    visibility: "READY_TO_SUPPLY",
    ozon_sku: "4601347655",
    archived: 0,
    stock_snapshot_count: 1,
    fbs_available: 0
  }), "zero_stock");

  assert.equal(onlineProductStatusKeyForTest({
    status: "ready",
    visibility: "READY_TO_SUPPLY",
    ozon_sku: "4601347655",
    archived: 0,
    stock_snapshot_count: 0,
    fbs_available: 0
  }), "ready");

  assert.equal(onlineProductStatusKeyForTest({
    status: "ready",
    visibility: "READY_TO_SUPPLY",
    ozon_sku: "4601347655",
    archived: 0,
    stock_snapshot_count: 1,
    fbs_available: 8,
    fbs_present: 8
  }), "selling");

  assert.equal(onlineProductStatusKeyForTest({
    status: "ready",
    visibility: "EMPTY_STOCK",
    ozon_sku: "4601347655",
    archived: 0,
    stock_snapshot_count: 1,
    fbs_available: 0,
    fbs_present: 8
  }), "selling");

  assert.equal(onlineProductStatusKeyForTest({
    status: "ready",
    visibility: "READY_TO_SUPPLY",
    ozon_sku: "__MISSING_SKU__:5402025720",
    archived: 0,
    stock_snapshot_count: 0,
    fbs_available: 0
  }), "other");

  assert.equal(onlineProductStatusKeyForTest({
    status: "active",
    visibility: "VISIBLE",
    ozon_sku: "4601347655",
    archived: 0,
    stock_snapshot_count: 1,
    fbs_available: 0
  }), "selling");

  assert.equal(onlineProductStatusKeyForTest({
    status: "ready",
    visibility: "ARCHIVED",
    archived: 0,
    stock_snapshot_count: 1,
    fbs_available: 0
  }), "archived");
});

test("online ready-for-sale status matches Ozon pending sale stock targets", () => {
  assert.equal(onlineProductMatchesStatusForTest({
    status: "ready",
    visibility: "READY_TO_SUPPLY",
    ozon_sku: "4601347655",
    stock_snapshot_count: 0,
    fbs_available: 0
  }, "ready_for_sale"), true);

  assert.equal(onlineProductMatchesStatusForTest({
    status: "ready",
    visibility: "EMPTY_STOCK",
    ozon_sku: "4601347655",
    stock_snapshot_count: 1,
    fbs_available: 0
  }, "ready_for_sale"), true);

  assert.equal(onlineProductMatchesStatusForTest({
    status: "active",
    visibility: "VISIBLE",
    ozon_sku: "4601347655",
    stock_snapshot_count: 1,
    fbs_available: 0
  }, "ready_for_sale"), false);

  assert.equal(onlineProductMatchesStatusForTest({
    status: "ready",
    visibility: "READY_TO_SUPPLY",
    ozon_sku: "4601347655",
    stock_snapshot_count: 1,
    fbs_available: 888,
    fbs_present: 888
  }, "ready_for_sale"), false);

  assert.equal(onlineProductMatchesStatusForTest({
    status: "ready",
    visibility: "EMPTY_STOCK",
    ozon_sku: "4601347655",
    stock_snapshot_count: 1,
    fbs_available: 0,
    fbs_present: 888
  }, "ready_for_sale"), false);

  assert.equal(onlineProductMatchesStatusForTest({
    status: "archived",
    visibility: "ARCHIVED",
    ozon_sku: "4601347655",
    archived: 1,
    stock_snapshot_count: 1,
    fbs_available: 0
  }, "ready_for_sale"), false);

  assert.equal(onlineProductMatchesStatusForTest({
    status: "ready",
    visibility: "READY_TO_SUPPLY",
    ozon_sku: "__MISSING_SKU__:5485217931",
    stock_snapshot_count: 0,
    fbs_available: 0
  }, "ready_for_sale"), false);
});

test("online stock update can target products even when Ozon SKU is missing", () => {
  const withOfferAndProduct = onlineProductStockUpdateTargetForTest({
    id: 128426,
    ozon_sku: "__MISSING_SKU__:5485217931",
    offer_id: "AI-TOYOTA-LAND-CRUISER-PRADO-663874",
    ozon_product_id: "5485217931"
  }, 888, "12345");

  assert.deepEqual(withOfferAndProduct, {
    target: {
      online_product_id: 128426,
      offer_id: "AI-TOYOTA-LAND-CRUISER-PRADO-663874",
      product_id: 5485217931,
      stock: 888,
      warehouse_id: "12345"
    },
    skipped: null
  });

  const missingRefs = onlineProductStockUpdateTargetForTest({
    id: 128427,
    ozon_sku: "__MISSING_SKU__:unknown",
    offer_id: "",
    ozon_product_id: ""
  }, 888, "12345");

  assert.equal(missingRefs.target, null);
  assert.deepEqual(missingRefs.skipped, {
    online_product_id: 128427,
    reason: "缺少 offer_id / Ozon Product ID"
  });
});

test("online product missing SKU can be repaired from a real stock snapshot SKU", () => {
  assert.equal(onlineProductSkuRepairCandidateForTest({
    ozon_sku: "__MISSING_SKU__:5485217931"
  }, {
    ozon_sku: "4601347655"
  }), "4601347655");

  assert.equal(onlineProductSkuRepairCandidateForTest({
    ozon_sku: "__MISSING_SKU__:5485217931"
  }, {
    ozon_sku: "__MISSING_SKU__:5485217931"
  }), "");

  assert.equal(onlineProductSkuRepairCandidateForTest({
    ozon_sku: "4601347655"
  }, {
    ozon_sku: "9999999999"
  }), "");

  assert.equal(onlineProductSkuRepairCandidateForTest({
    ozon_sku: "__MISSING_SKU__:5484741195"
  }, {
    ozon_sku: "AI-VOLKSWAGEN-JETTA-294948",
    offer_id: "AI-VOLKSWAGEN-JETTA-294948",
    product_id: "5484741195"
  }), "");
});

test("online status does not treat offer_id aliases as real Ozon SKU", () => {
  assert.equal(onlineProductStatusKeyForTest({
    status: "ready",
    visibility: "EMPTY_STOCK",
    ozon_sku: "AI-VOLKSWAGEN-JETTA-294948",
    archived: 0,
    stock_snapshot_count: 1,
    fbs_available: 0,
    fbs_present: 0
  }), "other");
});

test("online products support paged list contract", async () => {
  const result = await onlineProductList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);
  assert.ok(result.statusCounts);
  assert.ok(Number(result.statusCounts.all || 0) >= result.total);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.notEqual(row.shop_name, undefined);
    assert.notEqual(row.name, undefined);
  }
});

test("online products support search, shop, and status filters", async () => {
  const first = await onlineProductList({ paged: "1", page: 1, pageSize: 20 });
  if (!first.rows.length) return;

  const sample = first.rows[0];
  const keyword = sample.ozon_sku || sample.offer_id || sample.name;
  const searched = await onlineProductList({ paged: "1", page: 1, pageSize: 10, offer: keyword });
  assert.ok(searched.total > 0);

  const byShop = await onlineProductList({ paged: "1", page: 1, pageSize: 20, shopId: sample.shop_id });
  assert.ok(byShop.rows.every((row) => Number(row.shop_id) === Number(sample.shop_id)));

  const selling = await onlineProductList({ paged: "1", page: 1, pageSize: 20, status: "selling" });
  assert.ok(selling.rows.length <= 20);
});
