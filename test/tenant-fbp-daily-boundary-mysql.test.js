import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });
const tenantKey = id => id === 1 ? "admin" : id;

test("daily FBP reads, creation and barcode PDFs preserve default/A/B ownership and fresh duties", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL", timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture("fbp_daily");
  const oldFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error("No live Ozon calls in FBP acceptance"); };
    const service = await import("../src/services/mysql-cutover.js");
    const barcode = await import("../src/services/product-barcode-labels.js");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const q = fixture.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await q("INSERT INTO people(id,name,role) VALUES(7,'Buyer','procurement'),(8,'Other B','operations')");
    for (const id of [1, 2, 3]) await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,7,'member',JSON_ARRAY('procurement'))", [id]);
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(3,8,'member',JSON_ARRAY('operations'))");
    await service.warmCoreInventoryRuntimeMysql("admin");
    for (const id of [1, 2, 3]) {
      const owner = id === 1 ? null : id;
      await q("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,?,'fixture-only-key')", [id * 10, owner, `Shop ${id}`, `seller-${id}`]);
      await q("INSERT INTO products(id,tenant_id,name,code,purchase_cost) VALUES(?,?,?,?,1)", [id * 100, owner, `Inventory ${id}`, `P-FBP-${id}`]);
      await q("INSERT INTO online_products(id,shop_id,product_id,ozon_sku,offer_id,ozon_product_id,name,barcodes_json) VALUES(?,?,?,'SHARED-SKU','SHARED-OFFER',?,?,JSON_ARRAY('OZN00112233'))", [id * 10, id * 10, id * 100, String(id * 111), `Online ${id}`]);
      await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,online_product_id,ozon_sku,offer_id) VALUES(?,?,?,?,?,'SHARED-SKU','SHARED-OFFER')", [id * 10, owner, id * 10, id * 100, id * 10]);
      await service.createInventoryMovementMysql({ product_id: id * 100, source_type: "opening_stock", quantity_delta: 20, stock_location: "LOCAL" }, 7, tenantKey(id));
    }

    await t.test("each ordinary buyer sees only its opportunity and can create an application and local transfer", async () => {
      for (const id of [1, 2, 3]) {
        const key = tenantKey(id), shop = id * 10, product = id * 100;
        const result = await service.fbpOpportunitiesMysql({ manualSku: "SHARED-SKU", tenant_id: 3 }, key, { session: session(id) });
        assert.deepEqual(result.rows.map(row => Number(row.shop_id)), [shop]);
        assert.equal(result.rows[0].product_name, `Inventory ${id}`);
        const created = await service.createFbpReplenishmentOrdersMysql({ order_date: "2026-10-22", tenant_id: 3, rows: [{ shop_id: shop, product_id: product, mapping_id: shop, ozon_sku: "SHARED-SKU", requested_qty: 2 }] }, 7, key);
        assert.equal(created.rows[0].shop_id, shop);
        const transfer = await service.createFbpTransferRecordMysql({ product_id: product, mapping_id: shop, shop_id: shop, quantity: 2, person_id: 7 }, 7, key);
        assert.ok(transfer.id);
        const rows = await q("SELECT tenant_id,quantity_delta FROM inventory_movements WHERE product_id=? AND source_type='fbp_transfer_outbound'", [product]);
        assert.ok(rows.length > 0);
        assert.ok(rows.every(row => Number(row.tenant_id) === id));
      }
    });

    await t.test("foreign IDs, suppliers, people and poisoned parent references fail without new source writes", async () => {
      const before = await q("SELECT COUNT(*) n FROM fbp_replenishment_orders");
      await assert.rejects(service.createFbpReplenishmentOrdersMysql({ rows: [{ shop_id: 30, product_id: 300, mapping_id: 30, ozon_sku: "SHARED-SKU" }] }, 7, "admin"));
      await assert.rejects(service.createFbpReplenishmentOrdersMysql({ rows: [{ shop_id: 20, product_id: 300, mapping_id: 20, ozon_sku: "SHARED-SKU" }] }, 7, 2));
      await assert.rejects(service.createFbpTransferRecordMysql({ product_id: 200, mapping_id: 30, quantity: 2 }, 7, 2));
      await assert.rejects(service.createFbpTransferRecordMysql({ product_id: 200, shop_id: 20, person_id: 8, quantity: 2 }, 7, 2));
      await q("INSERT INTO suppliers(id,tenant_id,name) VALUES(300,3,'Private B supplier')");
      await assert.rejects(service.createFbpTransferRecordMysql({ product_id: 200, shop_id: 20, supplier_id: 300, quantity: 2 }, 7, 2));
      assert.deepEqual(await q("SELECT COUNT(*) n FROM fbp_replenishment_orders"), before);
      await q("INSERT INTO sku_mappings(tenant_id,shop_id,product_id,ozon_sku) VALUES(2,20,300,'POISON')");
      const poisoned = await service.fbpOpportunitiesMysql({ manualSku: "POISON" }, 2, { session: session(2) });
      assert.equal(poisoned.total, 0);
      await assert.rejects(service.fbpOpportunitiesMysql({}, "admin", { session: session(2) }), { statusCode: 403 });
    });

    await t.test("barcode PDFs use owned IDs and cache rows; mixed foreign batches perform no generation", async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls++; throw new Error("Unexpected network call"); };
      for (const id of [1, 2, 3]) {
        const label = await barcode.productBarcodeLabelMysql({ online_product_id: id * 10, quantity: 2, tenant_id: 3 }, session(id));
        assert.equal(label.count, 2);
        assert.equal(label.buffer.subarray(0, 4).toString(), "%PDF");
        const [cache] = await q("SELECT shop_id FROM product_barcode_label_cache WHERE online_product_id=?", [id * 10]);
        assert.equal(Number(cache.shop_id), id * 10);
      }
      assert.equal(calls, 0);
      const before = await q("SELECT online_product_id,shop_id,HEX(label_pdf) label FROM product_barcode_label_cache ORDER BY online_product_id");
      await assert.rejects(barcode.productBarcodeLabelMysql({ items: [{ online_product_id: 20 }, { online_product_id: 30 }] }, session(2)), { statusCode: 404 });
      await assert.rejects(barcode.productBarcodeLabelMysql({ online_product_id: 30, shop_id: 20, ozon_sku: "SHARED-SKU" }, session(2)), { statusCode: 404 });
      assert.deepEqual(await q("SELECT online_product_id,shop_id,HEX(label_pdf) label FROM product_barcode_label_cache ORDER BY online_product_id"), before);
      const fallback = await barcode.productBarcodeLabelMysql({ shop_id: 20, ozon_sku: "SHARED-SKU" }, session(2));
      assert.equal(fallback.product_count, 1);
      await q("UPDATE product_barcode_label_cache SET shop_id=30,label_pdf=? WHERE online_product_id=20", [Buffer.from("PRIVATE-B-CACHE")]);
      const clean = await barcode.productBarcodeLabelMysql({ online_product_id: 20 }, session(2));
      assert.equal(clean.buffer.includes(Buffer.from("PRIVATE-B-CACHE")), false);
      assert.equal(Number((await q("SELECT shop_id FROM product_barcode_label_cache WHERE online_product_id=20"))[0].shop_id), 20);
      await q("UPDATE online_products SET product_id=300 WHERE id=20");
      await assert.rejects(barcode.productBarcodeLabelMysql({ online_product_id: 20 }, session(2)), { statusCode: 404 });
      await q("UPDATE online_products SET product_id=200 WHERE id=20");
      assert.equal(calls, 0);
    });

    await t.test("Ozon generation uses only current enterprise credentials and stops after revoked write duties", async () => {
      await q("UPDATE online_products SET barcodes_json=NULL WHERE id=20");
      const calls = [];
      let revoke = false;
      globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), client: options.headers["Client-Id"] });
        if (revoke && calls.length === 1) await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7");
        const payload = String(url).endsWith("/v4/product/info/stocks")
          ? { result: { items: [{ product_id: 222, offer_id: "SHARED-OFFER", sku: "SHARED-SKU", stocks: [] }] } }
          : String(url).endsWith("/v1/barcode/generate")
            ? { result: [{ product_id: 222, barcode: "OZN99887766" }] }
            : { items: [{ id: 222, offer_id: "SHARED-OFFER", name: "Own generated item", barcodes: ["OZN99887766"] }] };
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      };
      const generated = await barcode.generateProductBarcodeLabelMysql({ online_product_id: 20 }, session(2));
      assert.equal(generated.ok, true);
      assert.ok(calls.length >= 3);
      assert.ok(calls.every(call => call.client === "seller-2"));
      const unchangedB = await q("SELECT barcodes_json FROM online_products WHERE id=30");
      await q("UPDATE online_products SET barcodes_json=NULL WHERE id=20");
      calls.length = 0; revoke = true;
      await assert.rejects(barcode.generateProductBarcodeLabelMysql({ online_product_id: 20 }, session(2)), { statusCode: 403 });
      assert.equal(calls.length, 1);
      assert.equal((await q("SELECT barcodes_json FROM online_products WHERE id=20"))[0].barcodes_json, null);
      assert.deepEqual(await q("SELECT barcodes_json FROM online_products WHERE id=30"), unchangedB);
      await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=7");
    });

    await t.test("pagination and retry attempts recheck current write duties before the next external request", async () => {
      for (const mode of ["pagination", "retry"]) {
        await q("UPDATE online_products SET barcodes_json=NULL WHERE id=20");
        let calls = 0;
        globalThis.fetch = async url => {
          calls++;
          const stocks = String(url).endsWith("/v4/product/info/stocks");
          if (mode === "pagination" || !stocks) await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7");
          const payload = stocks ? { result: { cursor: mode === "pagination" ? "next-page" : "", items: [{ product_id: 222, offer_id: "SHARED-OFFER", sku: "SHARED-SKU", stocks: [] }] } } : { message: "fixture transient failure" };
          return { ok: stocks, status: stocks ? 200 : 503, text: async () => JSON.stringify(payload), headers: { get: () => null } };
        };
        await assert.rejects(barcode.generateProductBarcodeLabelMysql({ online_product_id: 20 }, session(2)), { statusCode: 403 });
        assert.equal(calls, mode === "pagination" ? 1 : 2);
        assert.equal((await q("SELECT barcodes_json FROM online_products WHERE id=20"))[0].barcodes_json, null);
        await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=7");
      }
    });

    await t.test("revocation while a transfer waits for its product lock prevents every inventory write", async () => {
      const blocker = await mysql.createConnection({ socketPath: fixture.env.DB_SOCKET_PATH, user: "root", database: fixture.database });
      try {
        await blocker.beginTransaction();
        await blocker.query("SELECT id FROM products WHERE id=200 FOR UPDATE");
        const before = await q("SELECT COUNT(*) n FROM fbp_transfer_records");
        const pending = service.createFbpTransferRecordMysql({ product_id: 200, shop_id: 20, mapping_id: 20, quantity: 2 }, 7, 2);
        const checked = pending.then(value => ({ value }), error => ({ error }));
        let waiting = false;
        for (let n = 0; n < 100; n++) {
          const [row] = await q("SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_DB=?", [fixture.database]);
          if (Number(row.n)) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(waiting, "Actual transfer must reach a database row-lock wait");
        await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7");
        await blocker.commit();
        assert.equal((await checked).error?.statusCode, 403);
        assert.deepEqual(await q("SELECT COUNT(*) n FROM fbp_transfer_records"), before);
        await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=7");
      } finally { await blocker.rollback(); await blocker.end(); }
    });

    await t.test("expired subscription, disabled member and removed procurement duty fail before new applications", async () => {
      const body = { order_date: "2026-10-23", rows: [{ shop_id: 20, product_id: 200, mapping_id: 20, ozon_sku: "SHARED-SKU" }] };
      const before = await q("SELECT COUNT(*) n FROM fbp_replenishment_orders");
      for (const [disable, restore] of [
        ["UPDATE tenants SET subscription_status='expired' WHERE id=2", "UPDATE tenants SET subscription_status='active' WHERE id=2"],
        ["UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7", "UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7"],
        ["UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7", "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=7"]
      ]) {
        await q(disable);
        await assert.rejects(service.createFbpReplenishmentOrdersMysql(body, 7, 2), { statusCode: 403 });
        await q(restore);
      }
      assert.deepEqual(await q("SELECT COUNT(*) n FROM fbp_replenishment_orders"), before);
    });
  } finally {
    globalThis.fetch = oldFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
