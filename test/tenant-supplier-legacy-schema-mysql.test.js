import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const runFile = promisify(execFile);

test("legacy supplier deployment blocks readiness until a lossless explicit migration and preserves default/A/B joins", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL", timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture("supplier_legacy");
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const service = await import("../src/services/mysql-cutover.js");
    const { assertTenantPilotSchemaReady } = await import("../src/services/tenant-pilot-schema.js");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const q = fixture.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'company-a','A'),(3,'company-b','B')");
    await service.warmCoreInventoryRuntimeMysql("admin");
    const migration = async apply => {
      const args = ["scripts/migrate-tenant-suppliers.mjs", ...(apply ? ["--apply", `--mysql-admin-socket=${fixture.env.DB_SOCKET_PATH}`] : [])];
      const { stdout } = await runFile(process.execPath, args, { cwd: new URL("..", import.meta.url), env: { ...process.env, ...fixture.env }, windowsHide: true });
      return JSON.parse(stdout.trim());
    };
    await q("ALTER TABLE suppliers DROP INDEX idx_suppliers_tenant_status_id, DROP COLUMN tenant_id");
    for (let id = 1; id <= 8; id++) {
      await q("INSERT INTO suppliers(id,name,contact_person,contact_phone,wechat_id,business_note,created_at) VALUES(?,?,?,?,?,?,?)", [id, `Legacy supplier ${id}`, `Contact ${id}`, `fixture-${id}`, id % 2 ? null : `chat-${id}`, `Historical note ${id}`, "2025-01-02 03:04:05"]);
    }
    const original = await q("SELECT * FROM suppliers ORDER BY id");

    await t.test("a real legacy supplier table cannot pass candidate startup and dry-run reports all preserved rows", async () => {
      await assert.rejects(assertTenantPilotSchemaReady(q), error => error.statusCode === 503 && error.message.includes("suppliers.tenant_id"));
      const plan = await migration(false);
      assert.equal(plan.changes_database, false);
      assert.equal(plan.before.tenant_id_column, false);
      assert.equal(plan.before.row_count, 8);
      assert.equal(plan.before.legacy_unattributed_rows, 8);
      assert.deepEqual(await q("SELECT * FROM suppliers ORDER BY id"), original);
      assert.equal((await q("SHOW COLUMNS FROM suppliers")).some(row => row.Field === "tenant_id"), false);
    });

    await t.test("the actual release migration preserves every old field, leaves ownership NULL and is idempotent", async () => {
      const result = await migration(true);
      assert.equal(result.legacy_rows_preserved_unattributed, 8);
      assert.equal(result.legacy_rows_backfilled, false);
      const rows = await q("SELECT * FROM suppliers ORDER BY id");
      assert.ok(rows.every(row => row.tenant_id === null));
      assert.deepEqual(rows.map(({ tenant_id, ...oldFields }) => oldFields), original);
      assert.equal((await assertTenantPilotSchemaReady(q)).ok, true);
      const beforeSchema = await q("SHOW CREATE TABLE suppliers");
      assert.equal((await migration(true)).legacy_rows_preserved_unattributed, 8);
      assert.deepEqual(await q("SHOW CREATE TABLE suppliers"), beforeSchema);
      assert.deepEqual(await q("SELECT * FROM suppliers ORDER BY id"), rows);
    });

    await t.test("readiness rejects missing and malformed supplier tenant indexes", async () => {
      await q("ALTER TABLE suppliers DROP INDEX idx_suppliers_tenant_status_id");
      await assert.rejects(assertTenantPilotSchemaReady(q), error => error.statusCode === 503 && error.message.includes("idx_suppliers_tenant_status_id"));
      await q("ALTER TABLE suppliers ADD INDEX idx_suppliers_tenant_status_id(status,id)");
      await assert.rejects(assertTenantPilotSchemaReady(q), { statusCode: 503 });
      await q("ALTER TABLE suppliers DROP INDEX idx_suppliers_tenant_status_id, ADD INDEX idx_suppliers_tenant_status_id(tenant_id,status,id)");
      assert.equal((await assertTenantPilotSchemaReady(q)).ok, true);
    });

    await t.test("existing inventory aliases, logistics and tail-template dependencies also require ownership before readiness", async () => {
      for (const table of ["product_name_aliases", "logistics_fee_rules", "asset_tail_templates"]) {
        await q(`ALTER TABLE ${table} RENAME COLUMN tenant_id TO fixture_old_owner`);
        try {
          await assert.rejects(assertTenantPilotSchemaReady(q), error => error.statusCode === 503 && error.message.includes(`${table}.tenant_id`));
        } finally { await q(`ALTER TABLE ${table} RENAME COLUMN fixture_old_owner TO tenant_id`); }
        assert.equal((await assertTenantPilotSchemaReady(q)).ok, true);
      }
    });

    await t.test("legacy NULL suppliers stay default-only and foreign supplier bindings never leak through inventory", async () => {
      await q("INSERT INTO suppliers(id,tenant_id,name) VALUES(20,2,'Private A supplier'),(30,3,'Private B supplier')");
      await q("INSERT INTO products(id,tenant_id,name,code,supplier_id) VALUES(100,NULL,'Legacy inventory','SUP-100',1),(200,2,'A inventory','SUP-200',20),(201,2,'Poisoned A binding','SUP-201',30),(300,3,'B inventory','SUP-300',30)");
      assert.deepEqual((await service.suppliersMysql({}, "admin")).map(row => Number(row.id)).sort((a,b)=>a-b), [1,2,3,4,5,6,7,8]);
      assert.deepEqual((await service.suppliersMysql({ tenant_id: 3 }, 2)).map(row => Number(row.id)), [20]);
      assert.deepEqual((await service.suppliersMysql({ tenant_id: 2 }, 3)).map(row => Number(row.id)), [30]);
      for (const [key, ids] of [["admin", [100]], [2, [200, 201]], [3, [300]]]) {
        const rows = await service.productsMysql({ paged: "1", tenant_id: key === 3 ? 2 : 3 }, key);
        assert.deepEqual(rows.rows.map(row => Number(row.id)).sort((a,b)=>a-b), ids);
        const own = rows.rows.find(row => Number(row.id) === (key === "admin" ? 100 : key * 100));
        assert.equal(Number(own.supplier_id), key === "admin" ? 1 : key * 10);
        if (key === 2) {
          const poisoned = rows.rows.find(row => Number(row.id) === 201);
          assert.equal(poisoned.supplier_id, null);
          assert.equal(JSON.stringify(rows).includes("Private B supplier"), false);
        }
      }
    });
  } finally {
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
