import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { handleOrderRestRoute } from "../src/server/routes/orders.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { createOrderFixtureSchema, loadTenantOrderService } from "./helpers/tenant-order-service.js";

test("single-order image HTTP boundary uses live enterprise authorization and isolated SQL writes", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires independent TCP-disabled MySQL", timeout: 90000
}, async t => {
  const database = `ozon_image_route_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root", dateStrings: true });
  let created = false;
  try {
    const [[server]] = await connection.query("SELECT @@skip_networking AS disabled");
    assert.equal(Number(server.disabled), 1);
    await connection.query(`CREATE DATABASE \`${database}\``);
    created = true;
    await connection.changeUser({ database });
    await connection.query("SET time_zone='+00:00'");
    await createOrderFixtureSchema(connection);
    const query = async (sql, params = []) => (await connection.query(sql, params))[0];
    await query("INSERT INTO tenants(id,slug,name,status) VALUES(2,'enterprise-a','A','active'),(3,'enterprise-b','B','active')");
    await query("INSERT INTO people(id,name,role) VALUES(7,'Fixture operator','operations')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,7,'member',JSON_ARRAY('operations')),(3,7,'member',JSON_ARRAY('operations'))");
    await query("INSERT INTO shops(id,tenant_id,name,status,platform) VALUES(20,2,'A','active','ozon'),(30,3,'B','active','ozon')");
    await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(20,20,'posting-a','awaiting_packaging','2026-11-20'),(30,30,'posting-b','awaiting_packaging','2026-11-20')");
    await query("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,ozon_image_url) VALUES(200,20,'sku-a',2,15,'https://ir.ozone.ru/old-a.jpg'),(201,20,'sku-a2',1,10,'https://ir.ozone.ru/old-a2.jpg'),(300,30,'sku-b',3,20,'https://ir.ozone.ru/old-b.jpg')");
    await query("INSERT INTO online_products(id,shop_id,ozon_sku,offer_id,name) VALUES(200,20,'sku-a','offer-a','A'),(201,20,'sku-a2','offer-a2','A2'),(300,30,'sku-b','offer-b','B')");
    let requests = 0, hook = null, invalidations = 0;
    const { service } = loadTenantOrderService(connection, {
      extraMethods: ["syncOrderImagesMysql", "resolveOrderItemImageUrlMysql", "pickLiveProductImageMysql", "activeShopForTenantMysql"],
      invalidateOrderReadCache() { invalidations += 1; },
      fetchOzonProductInfoAttributes: async (shop, options) => {
        requests += 1;
        assert.equal(Number(shop.id), 20);
        assert.equal(options.limit, 1);
        assert.equal(options.skus.length, 1);
        assert.equal(options.skus[0], "sku-a");
        await hook?.();
        return [{ offer_id: "offer-a", sku: "sku-a", images: ["https://ir.ozone.ru/new-a.jpg"] }];
      }
    });
    const current = { personId: 7, roles: ["operations"], tenant: { id: 2, slug: "enterprise-a", role: "member" } };
    const call = async (orderId = 20, body = { item_id: 200 }, session = current, signal = new AbortController().signal) => {
      const parts = ["api", "orders", String(orderId), "sync-images"];
      const req = { method: "POST", _session: session, _abortSignal: signal };
      for (const decision of [authorizeApiRequest(req, parts), tenantIsolationDecision(session, parts, "POST")]) {
        if (!decision.allowed) throw Object.assign(new Error(decision.error), { statusCode: 403 });
      }
      return handleOrderRestRoute({ req, res: {}, parts, url: new URL(`http://localhost/api/orders/${orderId}/sync-images`),
        services: { syncOrderImages: (...args) => service.syncOrderImagesMysql(...args) }, readJson: async () => body,
        json: (_res, result) => result, notFound: () => null, writeHead() {} });
    };
    const status = code => error => Number(error.statusCode || error.status) === code;
    const restore = async () => {
      hook = null;
      await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('operations') WHERE tenant_id=2 AND person_id=7");
      await query("UPDATE order_items SET ozon_image_url='https://ir.ozone.ru/old-a.jpg' WHERE id=200");
    };

    await t.test("URL and batch selectors cannot turn one order action into arbitrary remote or bulk work", async () => {
      for (const body of [null, [], { url: "https://example.invalid/x" }, { image_url: "https://example.invalid/x" },
        { urls: ["https://example.invalid/x"] }, { order_ids: [20, 30] }, { item_ids: [200, 201] },
        { item_id: [200, 201] }, { tenant_id: 3 }, { shop_id: 30 }, { force: true }]) {
        await assert.rejects(call(20, body), status(400));
      }
      assert.equal(requests, 0);
    });
    await t.test("foreign order or item is rejected before any Ozon request", async () => {
      await assert.rejects(call(30, { item_id: 300 }), status(404));
      await assert.rejects(call(20, { item_id: 300 }), status(404));
      assert.equal(requests, 0);
    });
    await t.test("stale roles and platform grants cannot bypass current enterprise duties", async () => {
      await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7");
      await assert.rejects(call(), status(403));
      await assert.rejects(call(20, { item_id: 200 }, { ...current, platform_role: "super_admin" }), status(403));
      assert.equal(requests, 0);
      await restore();
    });
    await t.test("membership revocation during the remote response prevents image persistence", async () => {
      hook = () => query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await assert.rejects(call(), status(403));
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=200"))[0].ozon_image_url, "https://ir.ozone.ru/old-a.jpg");
      await restore();
    });
    await t.test("a concurrent manual image update is preserved", async () => {
      hook = () => query("UPDATE order_items SET ozon_image_url='https://ir.ozone.ru/concurrent.jpg' WHERE id=200");
      const result = await call();
      assert.equal(result.updated_count, 0);
      assert.equal(result.failed_count, 1);
      assert.equal((await query("SELECT ozon_image_url FROM order_items WHERE id=200"))[0].ozon_image_url, "https://ir.ozone.ru/concurrent.jpg");
      await restore();
    });
    await t.test("the successful path changes only the selected order-item image and invalidates reads", async () => {
      const beforeOrders = await query("SELECT * FROM orders ORDER BY id");
      const beforeItems = await query("SELECT * FROM order_items ORDER BY id");
      const beforeOnline = await query("SELECT * FROM online_products ORDER BY id");
      const beforeInventory = await query("SELECT * FROM inventory_movements ORDER BY id");
      const previousInvalidations = invalidations;
      const result = await call();
      assert.equal(result.order_id, 20);
      assert.equal(result.updated_count, 1);
      assert.equal(result.failed_count, 0);
      assert.equal(invalidations, previousInvalidations + 1);
      assert.deepEqual(await query("SELECT * FROM orders ORDER BY id"), beforeOrders);
      const expected = beforeItems.map(item => item.id === 200 ? { ...item, ozon_image_url: "https://ir.ozone.ru/new-a.jpg" } : item);
      assert.deepEqual(await query("SELECT * FROM order_items ORDER BY id"), expected);
      assert.deepEqual(await query("SELECT * FROM online_products ORDER BY id"), beforeOnline);
      assert.deepEqual(await query("SELECT * FROM inventory_movements ORDER BY id"), beforeInventory);
    });
  } finally {
    if (created) await connection.query(`DROP DATABASE \`${database}\``);
    await connection.end();
  }
});
