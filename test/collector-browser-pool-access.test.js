import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { resolveCollectorBrowserShop } from "../src/services/collector-browser-pool-access.js";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.function("UTC_TIMESTAMP", () => "2026-11-05 12:00:00");
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY, slug TEXT, status TEXT, subscription_status TEXT, subscription_expires_at TEXT);
    CREATE TABLE shops(id INTEGER PRIMARY KEY, tenant_id INTEGER, name TEXT, ozon_client_id TEXT, status TEXT);
    INSERT INTO tenants VALUES
      (7,'default','active','active',NULL),
      (20,'company-a','active','trial','2026-12-01 00:00:00'),
      (30,'company-b','active','active',NULL),
      (40,'disabled','archived','active',NULL),
      (50,'expired','active','active','2026-11-05 11:59:00'),
      (60,'unpaid','active','expired',NULL);
    INSERT INTO shops VALUES
      (1,30,'Other enterprise same company','shared-company','active'),
      (2,NULL,'Legacy default','legacy-company','active'),
      (3,7,'Default-owned','default-company','active'),
      (4,20,'Inactive duplicate','shared-company','deleted'),
      (8,20,'First active duplicate','shared-company','active'),
      (9,20,'Second active duplicate','shared-company','active'),
      (10,40,'Archived enterprise','disabled-company','active'),
      (11,50,'Expired enterprise','expired-company','active'),
      (12,60,'Unpaid enterprise','unpaid-company','active'),
      (13,NULL,'Legacy duplicate','default-duplicate','active'),
      (14,7,'Numeric default duplicate','default-duplicate','active');`);
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    assert.match(sql.trim(), /^SELECT /);
    assert.equal((sql.match(/\?/g) || []).length, params.length);
    // SQLite text equality is binary by default; MySQL spells that comparison
    // with its BINARY prefix. Execute the same predicates and bound values.
    return db.prepare(sql.replace(/\bBINARY\s+/g, "")).all(...params);
  };
  return { db, calls, query };
}

test("browser pool resolves company only inside its numeric enterprise and chooses the first active duplicate", async t => {
  const f = fixture(t);
  const shop = await resolveCollectorBrowserShop("shared-company", "20", f.query);
  assert.deepEqual(shop, { shop_id: 8, shop_name: "First active duplicate", company_id: "shared-company" });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, [20, "shared-company"]);
  assert.match(f.calls[0].sql, /s\.tenant_id = t\.id/);
  assert.match(f.calls[0].sql, /BINARY s\.ozon_client_id = BINARY \?/);
  assert.deepEqual(await resolveCollectorBrowserShop("shared-company", 30, f.query), {
    shop_id: 1, shop_name: "Other enterprise same company", company_id: "shared-company"
  });
});

test("admin maps to the actual default tenant id and only that enterprise may use legacy NULL shops", async t => {
  const f = fixture(t);
  assert.deepEqual(await resolveCollectorBrowserShop("legacy-company", "admin", f.query), {
    shop_id: 2, shop_name: "Legacy default", company_id: "legacy-company"
  });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, ["default", "legacy-company"]);
  assert.match(f.calls[0].sql, /BINARY t\.slug = BINARY 'default' AND s\.tenant_id IS NULL/);
  assert.equal((await resolveCollectorBrowserShop("default-company", "admin", f.query)).shop_id, 3);
  assert.equal((await resolveCollectorBrowserShop("default-duplicate", "7", f.query)).shop_id, 13);
  await assert.rejects(resolveCollectorBrowserShop("legacy-company", "20", f.query), { statusCode: 403 });
  await assert.rejects(resolveCollectorBrowserShop("shared-company", "admin", f.query), { statusCode: 403 });
});

test("missing, disabled and expired enterprises or unavailable shops fail closed", async t => {
  const f = fixture(t);
  for (const [company, tenant] of [["missing", "20"], ["disabled-company", "40"], ["expired-company", "50"], ["unpaid-company", "60"], ["shared-company", "999"]]) {
    await assert.rejects(resolveCollectorBrowserShop(company, tenant, f.query), { status: 403, code: "COLLECTOR_BROWSER_SHOP_FORBIDDEN" });
  }
  f.db.prepare("UPDATE shops SET status='deleted' WHERE id=8 OR id=9").run();
  await assert.rejects(resolveCollectorBrowserShop("shared-company", "20", f.query), { statusCode: 403 });
  f.db.prepare("UPDATE tenants SET status='archived' WHERE slug='default'").run();
  await assert.rejects(resolveCollectorBrowserShop("legacy-company", "admin", f.query), { statusCode: 403 });
});

test("forged scope and company values cannot widen SQL ownership or inject an arbitrary shop", async t => {
  const f = fixture(t);
  for (const tenant of [null, "", "default", "0", "-1", "20 OR 1=1", "9007199254740992", { id: 20 }]) {
    await assert.rejects(resolveCollectorBrowserShop("shared-company", tenant, f.query), { statusCode: 403 });
  }
  assert.equal(f.calls.length, 0);
  const injection = "shared-company' OR 1=1 --";
  await assert.rejects(resolveCollectorBrowserShop(injection, "20", f.query), { statusCode: 403 });
  assert.ok(f.calls.every(call => !call.sql.includes(injection)));
  assert.deepEqual(f.calls[0].params, [20, injection]);
  await assert.rejects(resolveCollectorBrowserShop({ company_id: "shared-company", shop_id: 1 }, "20", f.query), { statusCode: 403 });
  await assert.rejects(resolveCollectorBrowserShop("SHARED-COMPANY", "20", f.query), { statusCode: 403 });
});
