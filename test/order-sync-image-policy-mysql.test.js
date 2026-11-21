import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { compactOnlineProductRawJson } from "../src/services/online-product-media-storage.js";
import { createOrderFixtureSchema, loadTenantOrderService } from "./helpers/tenant-order-service.js";

test("order synchronization stores supplied URLs without fetching media and manual repair stays on one order", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated TCP-disabled MySQL", timeout: 90000
}, async t => {
  const database = `ozon_order_images_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root", dateStrings: true });
  let created = false;
  try {
    assert.equal(Number((await connection.query("SELECT @@skip_networking isolated"))[0][0].isolated), 1);
    await connection.query(`CREATE DATABASE \`${database}\``);
    created = true;
    await connection.changeUser({ database });
    await connection.query("SET time_zone='+00:00'");
    await createOrderFixtureSchema(connection);
    const query = async (sql, params = []) => (await connection.query(sql, params))[0];
    await query("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
    await query("INSERT INTO people(id,name,role) VALUES(7,'Image operator','operations')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,7,'member',JSON_ARRAY('operations')),(2,7,'member',JSON_ARRAY('operations')),(3,7,'member',JSON_ARRAY('operations'))");
    await query("INSERT INTO shops(id,tenant_id,name,status,platform) VALUES(10,NULL,'Legacy','active','ozon'),(20,2,'A','active','ozon'),(30,3,'B','active','ozon')");
    await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(10,10,'legacy','awaiting_packaging','awaiting_packaging','2026-11-20'),(20,20,'posting-a','awaiting_packaging','awaiting_packaging','2026-11-20'),(21,20,'same-shop-other-order','awaiting_packaging','awaiting_packaging','2026-11-20'),(30,30,'posting-b','awaiting_packaging','awaiting_packaging','2026-11-20')");
    await query("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,ozon_image_url) VALUES(10,10,'legacy-sku',1,10,''),(200,20,'sku-a',1,10,'https://images.example/keep-order.jpg'),(201,20,'sku-blank',1,11,''),(210,21,'sku-a',1,12,'https://images.example/keep-other.jpg'),(300,30,'sku-a',1,13,'https://images.example/keep-tenant-b.jpg')");
    await query("INSERT INTO online_products(id,shop_id,ozon_sku,offer_id,name,image_url,primary_image) VALUES(200,20,'sku-a','stale-offer','A','https://images.example/keep-online.jpg','https://images.example/keep-primary.jpg'),(201,20,'sku-blank','blank-offer','Blank','',''),(202,20,'sku-online','online-offer','Online','https://images.example/old-online.jpg','https://images.example/old-primary.jpg')");
    const forbidMedia = () => { throw new Error("Bulk order synchronization must not request media or product image metadata"); };
    const { service: bulk } = loadTenantOrderService(connection, {
      extraMethods: ["activeShopForTenantMysql", "upsertPostingMysql", "upsertOnlineProductFromOrderItemMysql", "orderLifecycleMysql", "resolveProfitSettlementStatusMysql"],
      saveRawPostingMysql: async (_shop, posting) => posting,
      isFbpPosting: () => false, hasMeaningfulPostingMethod: () => true,
      orderCancelLossAppliesMysql: async () => false, recordOrderStatusHistoryMysql: async () => {},
      prepareOrderProfitFx: async () => null, getOrderProfitFxPolicy: async () => null,
      resolveOrderStockLocationMysql: () => ({ stockLocation: "LOCAL", stockLocationSource: "fixture" }),
      accrueDeliveredItemsMysql: async () => {}, isOrderInTransportMysql: () => false,
      markInventoryAlertSkuDailyDirtyMysql: async () => {}, invalidateOrderProcurementCoverage() {},
      retryProfitCalculationTransaction: (transaction, action) => transaction(action),
      profitCalculationDatabase: connection => ({
        query: async (sql, params) => (await connection.query(sql, params))[0],
        queryOne: async (sql, params) => (await connection.query(sql, params))[0][0] || null,
        execute: async (sql, params) => (await connection.execute(sql, params))[0]
      }),
      withVersionedOrderProfitWrite: async (_id, _options, action) => action(),
      profitEstimateInputs: () => ({}), recordOrderExceptionMysql: async () => {}, compactOnlineProductRawJson,
      fetchOzonProductInfoAttributes: forbidMedia, fetchOzonProducts: forbidMedia,
      fetchOzonProductsByIds: forbidMedia, prepareOnlineProductMediaForStorage: forbidMedia,
      archiveRemoteMediaObjectUrl: forbidMedia, resolveOrderItemImageUrlMysql: forbidMedia
    });
    const posting = {
      posting_number: "posting-a", order_number: "order-a", status: "delivering", logistics_status: "in_transit",
      tracking_stage: "on_way", tracking_number: "TRACK-NEW", buyer_region: "Region", ordered_at: "2026-11-20 00:00:00",
      external_tracking_url: "https://tracking.example/a", items: [
        { ozon_sku: "sku-a", name: "A refreshed", quantity: 3, sale_price: 20, image_url: "https://images.example/new-api-a.jpg" },
        { ozon_sku: "sku-blank", name: "Blank", quantity: 2, sale_price: 21, image_url: "https://images.example/new-api-blank.jpg" },
        { ozon_sku: "sku-new", name: "New", quantity: 2, sale_price: 22, image_url: "https://images.example/new-direct.jpg" },
        { ozon_sku: "sku-online", name: "Online", quantity: 1, sale_price: 23 },
        { ozon_sku: "sku-missing", name: "Missing", quantity: 1, sale_price: 24 }
      ]
    };
    await t.test("bulk sync preserves existing images while status, logistics and quantities continue updating", async () => {
      const result = await bulk.upsertPostingMysql({ id: 20, tenant_id: 2 }, posting, "sync", { tenantId: "2" });
      assert.equal(result.updated, 1);
      assert.equal(result.insertedItems, 3);
      const [order] = await query("SELECT status,logistics_status,tracking_stage,tracking_number,external_tracking_url FROM orders WHERE id=20");
      assert.deepEqual(order, { status: "delivering", logistics_status: "in_transit", tracking_stage: "on_way", tracking_number: "TRACK-NEW", external_tracking_url: "https://tracking.example/a" });
      const items = await query("SELECT ozon_sku,quantity,ozon_image_url FROM order_items WHERE order_id=20 ORDER BY id");
      assert.deepEqual(items.map(row => [row.ozon_sku, row.quantity, row.ozon_image_url]), [
        ["sku-a", 3, "https://images.example/keep-order.jpg"], ["sku-blank", 2, ""],
        ["sku-new", 2, "https://images.example/new-direct.jpg"], ["sku-online", 1, "https://images.example/old-primary.jpg"], ["sku-missing", 1, ""]
      ]);
      const [online] = await query("SELECT image_url,primary_image FROM online_products WHERE id=200");
      assert.deepEqual(online, { image_url: "https://images.example/keep-online.jpg", primary_image: "https://images.example/keep-primary.jpg" });
      assert.equal((await query("SELECT image_url FROM online_products WHERE shop_id=20 AND ozon_sku='sku-new'"))[0].image_url, "https://images.example/new-direct.jpg");
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=210"))[0].ozon_image_url, "https://images.example/keep-other.jpg");
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=300"))[0].ozon_image_url, "https://images.example/keep-tenant-b.jpg");
      // Repeated auto/manual bulk synchronization does not fill a missing existing image either.
      await bulk.upsertPostingMysql({ id: 20, tenant_id: 2 }, posting, "manual", { tenantId: "2" });
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=201"))[0].ozon_image_url, "");
    });
    let invalidations = 0, remote = async (_shop, options) => [{ sku: options.skus[0], images: ["https://images.example/repaired.jpg"] }];
    const { service: repair } = loadTenantOrderService(connection, {
      extraMethods: ["syncOrderImagesMysql", "resolveOrderItemImageUrlMysql", "pickLiveProductImageMysql", "activeShopForTenantMysql"],
      invalidateOrderReadCache() { invalidations++; },
      fetchOzonProductInfoAttributes: (...args) => remote(...args)
    });
    const session = { personId: 7, tenant: { id: 2, slug: "a" }, roles: ["operations"] };
    const repairItem = (item_id = 200) => repair.syncOrderImagesMysql(20, { item_id }, "2", { session });
    await t.test("manual metadata lookup uses the order SKU, rejects mismatched identities and never scans the catalog", async () => {
      remote = async (shop, options) => {
        assert.equal(Number(shop.id), 20);
        assert.deepEqual(Array.from(options.skus), ["sku-a"]);
        assert.equal(options.offerIds, undefined, "A stale online offer must not override the order SKU");
        assert.equal(options.limit, 1);
        return [{ sku: "different-sku", images: ["https://images.example/wrong.jpg"] }];
      };
      const rejected = await repairItem();
      assert.equal(rejected.failed_count, 1);
      assert.equal(rejected.updated_count, 0);
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=200"))[0].ozon_image_url, "https://images.example/keep-order.jpg");
      // Historical financial data may have stored the SKU in this catalog-ID field.
      await query("UPDATE order_items SET ozon_product_id='12345' WHERE id=200");
      remote = async () => [{ id: 67890, sources: [{ sku: "sku-a" }], images: [{ url: "https://images.example/repaired.jpg" }] }];
      const fixed = await repairItem();
      assert.equal(fixed.updated_count, 1);
      assert.equal(fixed.items[0].image_url, "https://images.example/repaired.jpg");
      assert.equal((await query("SELECT ozon_product_id FROM order_items WHERE id=200"))[0].ozon_product_id, "12345");
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=210"))[0].ozon_image_url, "https://images.example/keep-other.jpg");
      assert.equal((await query("SELECT primary_image FROM online_products WHERE id=200"))[0].primary_image, "https://images.example/keep-primary.jpg");
    });
    await t.test("manual repair invalidates an earlier committed image even if authorization is revoked on the next item", async () => {
      const before = invalidations;
      let requested = 0;
      remote = async (_shop, options) => {
        if (++requested === 2) await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
        return [{ sku: options.skus[0], images: ["https://images.example/partial.jpg"] }];
      };
      await assert.rejects(repair.syncOrderImagesMysql(20, {}, "2", { session }), error => error.statusCode === 403);
      assert.equal(requested, 2);
      assert.equal(invalidations, before + 1);
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=200"))[0].ozon_image_url, "https://images.example/partial.jpg");
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=201"))[0].ozon_image_url, "");
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
    });
    await t.test("default legacy NULL ownership is retained and a nondefault inactive shop cannot repair images", async () => {
      remote = async (shop, options) => {
        assert.equal(Number(shop.id), 10);
        return [{ sku: options.skus[0], primary_image: "https://images.example/legacy-fixed.jpg" }];
      };
      const fixed = await repair.syncOrderImagesMysql(10, {}, "admin", { session: { personId: 7, tenant: { id: 1, slug: "default" } } });
      assert.equal(fixed.updated_count, 1);
      await query("UPDATE shops SET status='inactive' WHERE id=20");
      await assert.rejects(repairItem(), error => error.statusCode === 404);
      await query("UPDATE shops SET status='active' WHERE id=20");
      await query("UPDATE shops SET status='deleted' WHERE id=10");
      await assert.rejects(repair.syncOrderImagesMysql(10, {}, "admin", { session: { personId: 7, tenant: { id: 1, slug: "default" } } }), error => error.statusCode === 404);
    });
  } finally {
    if (created) await connection.query(`DROP DATABASE \`${database}\``);
    await connection.end();
  }
});
