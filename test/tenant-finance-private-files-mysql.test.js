import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

test("finance, private files and background tasks use A/B/default ownership in real MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL"
}, async t => {
  const fixture = await createTenantMysqlFixture("finance_files");
  fixture.useEnvironment();
  const finance = await import("../src/services/finance-center.js");
  const { closeMysqlPool } = await import("../src/mysql-pool.js");
  const { createTenantPrivateFiles } = await import("../src/services/tenant-private-files.js");
  const { authorizeBusinessTaskSession } = await import("../src/services/business-task-tenant.js");
  const { createTenantBackgroundTasks } = await import("../src/services/tenant-background-tasks.js");
  const query = fixture.query;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-tenant-private-test-"));
  const authorize = session => authorizeBusinessTaskSession(session, query);
  const files = createTenantPrivateFiles({ query, execute: query, authorize, roots: [root] });
  const session = id => ({ personId: 1, tenant: { id, slug: id === 1 ? "default" : `tenant-${id}` } });
  const key = id => id === 1 ? "admin" : String(id);
  const companies = new Map(), expenses = new Map(), urls = new Map();
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'tenant-2','A'),(3,'tenant-3','B')");
    await query("INSERT INTO people(id,name,role) VALUES(1,'Shared login','operations')");
    for (const id of [1, 2, 3]) {
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,1,'owner',JSON_ARRAY('operations'))", [id]);
      await query("INSERT INTO shops(id,tenant_id,name) VALUES(?,?,?)", [id * 10, id === 1 ? null : id, id === 1 ? "RuVibe Mart" : `Secret tenant ${id}`]);
    }
    await finance.ensureFinanceCenterSchema();
    await t.test("company seed, shop directories and assignment reject foreign shops even for default", async () => {
      for (const id of [1, 2, 3]) {
        const company = await finance.saveFinanceCompany({ name: "Same company name" }, key(id));
        companies.set(id, company.id);
        await finance.saveShopCompanyAssignment({ company_id: company.id, shop_id: id * 10, effective_from: "2026-01-01" }, key(id));
        const result = await finance.financeCompanies(key(id));
        assert.deepEqual(result.shops.map(row => row.id), [id * 10]);
        assert.ok(result.companies.every(row => id === 1 ? row.tenant_id == null : Number(row.tenant_id) === id));
        const foreign = id === 2 ? 3 : 2;
        await assert.rejects(finance.saveShopCompanyAssignment({ company_id: company.id, shop_id: foreign * 10, effective_from: "2026-01-01" }, key(id)), { statusCode: 404 });
      }
      // A historically polluted assignment cannot bring a customer's sales into default.
      await query("INSERT INTO finance_shop_company_assignments(tenant_id,shop_id,company_id,effective_from) VALUES(NULL,30,?,'2025-01-01')", [companies.get(1)]);
      await query("INSERT INTO analytics_shop_daily(date_key,shop_id,revenue,effective_orders) VALUES('2026-10-01',10,10,1),('2026-10-01',20,20,1),('2026-10-01',30,30000,1)");
    });
    await t.test("expenses and vouchers validate company, shop, expense and private attachment ownership", async () => {
      for (const id of [1, 2, 3]) {
        const expense = await finance.saveFinanceExpense({ company_id: companies.get(id), shop_id: id * 10, expense_date: "2026-10-01", original_amount: id, description: `Only tenant ${id}` }, 1, key(id));
        expenses.set(id, expense.id);
        const name = `tenant-${id}.pdf`, buffer = Buffer.from(`private finance ${id}`);
        await fs.writeFile(path.join(root, name), buffer);
        const url = await files.register({ storageName: name, name, size: buffer.length, contentType: "application/pdf" }, session(id), "finance");
        urls.set(id, url);
        await finance.saveFinanceVoucher({ company_id: companies.get(id), expense_id: expense.id, attachment_url: url, issue_date: "2026-10-01", review_status: "approved" }, 1, key(id));
      }
      for (const id of [1, 2, 3]) {
        const foreign = id === 2 ? 3 : 2;
        await assert.rejects(finance.saveFinanceExpense({ id: expenses.get(foreign), company_id: companies.get(id), expense_date: "2026-10-01" }, 1, key(id)), { statusCode: 404 });
        await assert.rejects(finance.saveFinanceExpense({ company_id: companies.get(id), shop_id: foreign * 10, expense_date: "2026-10-01" }, 1, key(id)), { statusCode: 404 });
        await assert.rejects(finance.saveFinanceVoucher({ company_id: companies.get(id), expense_id: expenses.get(foreign) }, 1, key(id)), { statusCode: 404 });
        await assert.rejects(finance.saveFinanceVoucher({ company_id: companies.get(id), attachment_url: urls.get(foreign) }, 1, key(id)), { statusCode: 404 });
        assert.equal((await finance.financeExpenses({ company_id: companies.get(id), month: "2026-10" }, key(id))).length, 1);
        const vouchers = await finance.financeVouchers({ company_id: companies.get(id), month: "2026-10" }, key(id));
        assert.equal(vouchers[0].attachment_url, urls.get(id));
      }
    });
    await t.test("reports, export and closing preserve only owned data including legacy default rows", async () => {
      for (const id of [1, 2, 3]) {
        const report = await finance.financeMonthlyReport({ company_id: companies.get(id), month: "2026-10" }, key(id));
        assert.equal(report.metrics.revenue, id === 3 ? 30000 : id * 10);
        assert.deepEqual(report.shops.map(row => row.id), [id * 10]);
        const file = await finance.financeMonthlyExport({ company_id: companies.get(id), month: "2026-10" }, key(id));
        assert.ok(file.buffer.toString().includes(`Only tenant ${id}`));
        assert.ok(!file.buffer.toString().includes(`Only tenant ${id === 2 ? 3 : 2}`));
        assert.equal((await finance.closeFinancePeriod({ company_id: companies.get(id), month: "2026-10" }, 1, key(id))).ok, true);
      }
      await assert.rejects(finance.financeMonthlyExport({ company_id: companies.get(3), month: "2026-10" }, "admin"), { statusCode: 404 });
    });
    await t.test("legacy file migration is read-only by default, explicitly scoped and repeatable", async () => {
      await fs.writeFile(path.join(root, "legacy.pdf"), "old default file");
      const args = ["scripts/migrate-tenant-private-files.mjs", `--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`, `--legacy-root=${root}`];
      const run = extra => JSON.parse(execFileSync(process.execPath, [...args, ...extra], { env: { ...process.env, ...fixture.env }, encoding: "utf8" }));
      const before = (await query("SELECT COUNT(*) n FROM tenant_private_files"))[0].n;
      assert.equal(run([]).changes_database, false);
      assert.equal((await query("SELECT COUNT(*) n FROM tenant_private_files"))[0].n, before);
      assert.equal(run(["--apply", "--backfill-legacy-default"]).registered_default_files, 1);
      assert.equal(run(["--apply", "--backfill-legacy-default"]).registered_default_files, 0);
      assert.equal((await files.read("/uploads/team-attachments/legacy.pdf", session(1))).buffer.toString(), "old default file");
      await assert.rejects(files.read("/uploads/team-attachments/legacy.pdf", session(2)), { statusCode: 404 });
    });
    await t.test("AI quota management preserves account and shop quotas on partial updates", async () => {
      const { setTenantQuotasMysql } = await import("../src/services/tenants.js");
      await setTenantQuotasMysql(2, { member_limit: 4, shop_limit: 5 });
      const result = await setTenantQuotasMysql(2, { monthly_ai_request_limit: 12 });
      assert.equal(result.member_limit, 4);
      assert.equal(result.shop_limit, 5);
      assert.equal((await query("SELECT monthly_request_limit FROM tenant_ai_limits WHERE tenant_id=2"))[0].monthly_request_limit, 12);
      await assert.rejects(setTenantQuotasMysql(2, { monthly_ai_request_limit: -1 }));
    });
    await t.test("private file reads fail for foreign, unregistered, traversed and revoked contexts", async () => {
      assert.equal((await files.read(urls.get(2), session(2))).buffer.toString(), "private finance 2");
      for (const id of [1, 3]) await assert.rejects(files.read(urls.get(2), session(id)), { statusCode: 404 });
      await fs.writeFile(path.join(root, "orphan.pdf"), "orphan");
      await assert.rejects(files.read("/uploads/team-attachments/orphan.pdf", session(1)), { statusCode: 404 });
      await assert.rejects(files.read("/uploads/team-attachments/%2e%2e%2ftenant-2.pdf", session(2)), { statusCode: 404 });
      await query("UPDATE tenant_members SET role='member',business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=1");
      await assert.rejects(files.read(urls.get(2), session(2)), { statusCode: 403 });
      await query("UPDATE tenant_members SET role='owner',business_roles_json=JSON_ARRAY('operations') WHERE tenant_id=2 AND person_id=1");
      await query("UPDATE tenants SET subscription_expires_at='2000-01-01' WHERE id=2");
      await assert.rejects(files.read(urls.get(2), session(2)), { statusCode: 403 });
      await query("UPDATE tenants SET subscription_expires_at=NULL WHERE id=2");
    });
    await t.test("concurrent enterprise tasks have separate progress, results and cancellation", async () => {
      const tasks = createTenantBackgroundTasks({ authorize });
      const pending = new Map();
      for (const id of [1, 2, 3]) {
        await tasks.start(session(id), "orders", ({ session: restored, signal, onProgress }) => new Promise(resolve => {
          assert.equal(restored.tenant.id, id);
          onProgress({ company: id });
          signal.addEventListener("abort", () => resolve({ cancelled: id }));
          pending.set(id, resolve);
        }));
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.deepEqual((await tasks.snapshot(session(2), "orders")).progress, { company: 2 });
      await tasks.cancel(session(2), "orders");
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((await tasks.snapshot(session(2), "orders")).running, false);
      assert.equal((await tasks.snapshot(session(3), "orders")).running, true);
      assert.equal((await tasks.snapshot(session(1), "orders")).running, true);
      pending.get(1)({ tenant: 1 }); pending.get(3)({ tenant: 3 });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual((await tasks.snapshot(session(3), "orders")).result, { tenant: 3 });
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=1");
      await assert.rejects(tasks.snapshot(session(2), "orders"), { statusCode: 403 });
    });
  } finally {
    await closeMysqlPool();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.join(os.tmpdir(), "ozon-tenant-private-test-")));
    await fs.rm(resolved, { recursive: true, force: true });
    await fixture.cleanup();
  }
});
