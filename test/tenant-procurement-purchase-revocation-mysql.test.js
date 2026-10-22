import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

test("free purchases preserve tenant ownership and recheck current procurement authority after row-lock waits", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL", timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture("purchase_current");
  const oldFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error("No live calls in purchase acceptance"); };
    const service = await import("../src/services/mysql-cutover.js");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const q = fixture.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await q("INSERT INTO people(id,name,role) VALUES(7,'Buyer','procurement'),(8,'Other B','procurement')");
    for (const id of [1, 2, 3]) {
      await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,7,'member',JSON_ARRAY('procurement'))", [id]);
    }
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(3,8,'member',JSON_ARRAY('procurement'))");
    await service.warmCoreInventoryRuntimeMysql("admin");
    for (const id of [1, 2, 3]) {
      await q("INSERT INTO products(id,tenant_id,name,code) VALUES(?,?,?,?)", [id * 100, id === 1 ? null : id, `Inventory ${id}`, `PURCHASE-${id}`]);
      await q("INSERT INTO suppliers(id,tenant_id,name) VALUES(?,?,?)", [id * 100, id === 1 ? null : id, `Supplier ${id}`]);
    }
    const body = (product = 200) => ({ tenant_id: 3, items: [{ product_id: product, quantity: 2, amount: 10 }] });
    const snapshot = async () => {
      const rows = {};
      for (const table of ["procurement_requests", "purchase_orders", "purchase_order_items", "purchase_cost_versions", "inbound_records", "inventory_movements", "procurement_ledger_actions"]) {
        rows[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
      }
      rows.products = await q("SELECT id,tenant_id,purchase_cost FROM products ORDER BY id");
      rows.inventory_current = await q("SELECT * FROM inventory_current ORDER BY real_product_id");
      return rows;
    };

    await t.test("ordinary default/A/B buyers retain free purchases and numeric ownership on every new row", async () => {
      for (const id of [1, 2, 3]) {
        const result = await service.recordProcurementPurchaseMysql(body(id * 100), 7, id === 1 ? "admin" : id);
        assert.equal(result.ok, true);
        assert.ok(result.ids.length > 0);
        const [request] = await q("SELECT tenant_id,person_id,created_by_person_id,purchase_order_id FROM procurement_requests WHERE id=?", [result.ids[0]]);
        assert.equal(Number(request.tenant_id), id);
        assert.equal(Number(request.person_id), 7);
        assert.equal(Number(request.created_by_person_id), 7);
        const [purchase] = await q("SELECT tenant_id,created_by_person_id FROM purchase_orders WHERE id=?", [request.purchase_order_id]);
        assert.equal(Number(purchase.tenant_id), id);
        assert.equal(Number(purchase.created_by_person_id), 7);
      }
      const result = await service.recordProcurementPurchaseMysql({ items: [{ product_id: 200, purchase_mode: "inventory_update", quantity: 6, amount: 30 }] }, 7, 2);
      assert.equal(result.ok, true);
      assert.equal(result.direct_results.length, 1);
      assert.ok((await q("SELECT tenant_id FROM inventory_movements WHERE product_id=200")).every(row => Number(row.tenant_id) === 2));
    });

    await t.test("foreign resources and spoofed body actors never grant access or leave partial purchases", async () => {
      const before = await snapshot();
      await assert.rejects(service.recordProcurementPurchaseMysql({ items: [{ product_id: 200, quantity: 1, amount: 5 }, { product_id: 300, quantity: 1, amount: 5 }] }, 7, 2));
      await assert.rejects(service.recordProcurementPurchaseMysql({ ...body(), supplier_id: 300 }, 7, 2));
      await assert.rejects(service.recordProcurementPurchaseMysql({ ...body(), person_id: 7 }, 8, 2), { statusCode: 403 });
      await assert.rejects(service.recordProcurementPurchaseMysql({ ...body(), person_id: 7 }, null, 2), { statusCode: 403 });
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("a failed mixed purchase rolls back the already applied direct inventory adjustment", async () => {
      const before = await snapshot();
      await assert.rejects(service.recordProcurementPurchaseMysql({ items: [
        { product_id: 200, purchase_mode: "inventory_update", quantity: 9, amount: 45 },
        { product_id: 200, quantity: 1, amount: -1 }
      ] }, 7, 2));
      assert.deepEqual(await snapshot(), before);
    });

    for (const [name, disable, restore] of [
      ["procurement duty", "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7", "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=7"],
      ["enterprise membership", "UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7", "UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7"],
      ["subscription", "UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE id=2", "UPDATE tenants SET subscription_expires_at=NULL WHERE id=2"],
      ["login identity", "UPDATE people SET active=0 WHERE id=7", "UPDATE people SET active=1 WHERE id=7"]
    ]) {
      await t.test(`revoked ${name} during an actual product row-lock wait rolls back all purchase and inventory writes`, async () => {
        const blocker = await mysql.createConnection({ socketPath: fixture.env.DB_SOCKET_PATH, user: "root", database: fixture.database });
        let checked;
        try {
          await blocker.beginTransaction();
          await blocker.query("SELECT id FROM products WHERE id=200 FOR UPDATE");
          const before = await snapshot();
          checked = service.recordProcurementPurchaseMysql(body(), 7, 2).then(value => ({ value }), error => ({ error }));
          let waiting = false;
          for (let n = 0; n < 100; n++) {
            const [row] = await q("SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_DB=?", [fixture.database]);
            if (Number(row.n)) { waiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.ok(waiting, "Actual purchase must reach a database row-lock wait before revocation");
          await q(disable);
          await blocker.commit();
          assert.equal((await checked).error?.statusCode, 403);
          assert.deepEqual(await snapshot(), before);
        } finally {
          await blocker.rollback();
          if (checked) await checked;
          await blocker.end();
          await q(restore);
        }
      });
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
