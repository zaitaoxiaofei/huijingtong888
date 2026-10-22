import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

test("selection list, summaries, filtered projections and publish jobs keep default/A/B isolated", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const fixture = await createTenantMysqlFixture("selection");
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    await query("INSERT INTO tenants (id, slug, name) VALUES (1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await query("INSERT INTO people (id,name,role) VALUES (7,'Shared','operations'),(30,'Private B person','operations')");
    await query("INSERT INTO tenant_members (tenant_id,person_id) VALUES (1,7),(2,7),(3,7),(3,30)");
    await query("INSERT INTO suppliers (id,tenant_id,name) VALUES (300,3,'Private B supplier')");
    await query("INSERT INTO products (id,tenant_id,name,product_type,selection_status,owner_person_id,created_by_person_id,supplier_id) VALUES (100,NULL,'Legacy','selection','draft',7,7,NULL),(110,1,'Default','selection','draft',30,30,300),(200,2,'A','selection','draft',7,7,NULL),(300,3,'B','selection','draft',30,30,300)");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const { selectionProductsMysql } = await import("../src/services/mysql-cutover.js");
    await t.test("own default numeric and NULL rows remain visible without exposing other people or suppliers", async () => {
      const rows = await selectionProductsMysql({}, "admin");
      assert.deepEqual(rows.map(row => row.id).sort(), [100,110]);
      const poisoned = rows.find(row => row.id === 110);
      assert.equal(poisoned.owner_name, null);
      assert.equal(poisoned.creator_name, null);
      assert.equal(poisoned.supplier_name, null);
      assert.equal(poisoned.owner_person_id, null);
      for (const id of [2,3]) assert.deepEqual((await selectionProductsMysql({}, id)).map(row => row.id), [id * 100]);
    });
    await t.test("paged and summary-only totals and business/quote filters never include new customers", async () => {
      for (const query of [{ paged: "1" }, { paged: "1", summary_only: "1" }, { paged: "1", quote_status: "unquoted" }, { business_status: "all", owner_person_id: 30 }]) {
        const result = await selectionProductsMysql(query, "admin");
        const rows = Array.isArray(result) ? result : result.rows;
        assert.ok(rows.every(row => [100,110].includes(row.id)));
        if (result.total !== undefined) assert.equal(result.total, 2);
        if (result.summary) assert.equal(result.summary.products, 2);
      }
      assert.equal((await selectionProductsMysql({ query: "Private B supplier" }, "admin")).length, 0);
    });
    await t.test("latest publish job joins reject foreign tenant jobs even with a poisoned product reference", async () => {
      await query("INSERT INTO asset_variant_jobs (id,tenant_id,job_no,job_type,product_id,status) VALUES (1,'admin','own','publish_selection',100,'failed'),(2,'3','foreign','publish_selection',100,'completed')");
      const result = await selectionProductsMysql({ paged: "1" }, "admin");
      const legacy = result.rows.find(row => row.id === 100);
      assert.equal(legacy.listing_job_id, 1);
      assert.equal(legacy.listing_job_no, "own");
      assert.equal(legacy.listing_job_status, "failed");
    });
  } finally {
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
