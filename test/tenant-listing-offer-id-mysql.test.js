import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import mysql from "mysql2/promise";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";
import { createListingAutomationRoutes } from "../src/server/routes/listingAutomation.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

function functionSource(name) {
  const match = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing production function ${name}`);
  const end = source.indexOf("\n}", match.index);
  assert.ok(end > match.index, `Missing production function end ${name}`);
  return source.slice(match.index, end + 2).replace(/^export /, "");
}

test("listing offer ID collisions use real SQL scoped to A/B/default and legacy NULL", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const database = `ozon_offer_test_${randomBytes(8).toString("hex")}`;
  const admin = await mysql.createConnection({ socketPath, user: "root" });
  let created = false, pool;
  try {
    const [[server]] = await admin.query("SELECT @@skip_networking AS networking_disabled");
    assert.equal(Number(server.networking_disabled), 1, "Fixture server must have TCP disabled");
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ socketPath, user: "root", database, connectionLimit: 5 });
    const query = async (sql, params = []) => (await pool.execute(sql, params))[0];
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80) NOT NULL)",
      "CREATE TABLE shops (id BIGINT PRIMARY KEY, tenant_id BIGINT NULL)",
      "CREATE TABLE online_products (id BIGINT PRIMARY KEY AUTO_INCREMENT, shop_id BIGINT NOT NULL, offer_id VARCHAR(128) NOT NULL)",
      "CREATE TABLE listing_publish_records (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id VARCHAR(80) NULL, offer_id VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active')",
      "CREATE TABLE listing_shop_copies (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id VARCHAR(80) NULL, offer_id VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active')",
      "CREATE TABLE listing_drafts (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id VARCHAR(80) NULL, internal_code VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active')"
    ]) await query(sql);
    await query("INSERT INTO tenants VALUES (1,'default'),(2,'company-a'),(3,'company-b')");
    await query("INSERT INTO shops VALUES (10,NULL),(11,1),(20,2),(30,3)");
    const sqlErrors = [], reads = [];
    let randomValues = [];
    const math = Object.create(Math);
    math.random = () => { assert.ok(randomValues.length, "Unexpected extra candidate attempt"); return randomValues.shift(); };
    const context = vm.createContext({
      Math: math,
      listingTenantLookup,
      ensureListingAutomationSchema: async () => {},
      row: async (sql, params = []) => {
        reads.push({ sql, params });
        try { return (await query(sql, params))[0] || null; }
        catch (error) { sqlErrors.push(error); throw error; }
      }
    });
    // Keep the production entry, collision SQL and normalization helpers intact;
    // only schema initialization is replaced by the explicit fixture above.
    const functions = ["generateListingOfferId", "normalizeListingOfferId", "listingOfferIdExistsInTenant", "listingTenantId", "cleanText", "productTypeAbbr", "normalizeStringList", "splitLooseStringList"];
    vm.runInContext(functions.map(functionSource).join("\n"), context, { filename: "listing-offer-id-production-functions.js" });
    const session = id => ({ personId: 7, roles: ["operations"], tenant: { id, slug: id === 1 ? "default" : `company-${id}` } });
    const generate = async (prefix, id, extra = {}, values = [0, 0.5]) => {
      randomValues = [...values];
      const result = await context.generateListingOfferId({ prefix, ...extra }, session(id));
      assert.deepEqual(sqlErrors, [], "Production catch clauses must not hide a broken SQL fixture");
      return result.offerId;
    };
    const stores = [
      { name: "online", insert: (offer, owner) => query("INSERT INTO online_products (shop_id,offer_id) VALUES (?,?)", [owner === null ? 10 : owner === 1 ? 11 : owner * 10, offer]) },
      { name: "records", insert: (offer, owner) => query("INSERT INTO listing_publish_records (tenant_id,offer_id) VALUES (?,?)", [owner === null ? null : owner === 1 ? "admin" : String(owner), offer]) },
      { name: "copies", insert: (offer, owner) => query("INSERT INTO listing_shop_copies (tenant_id,offer_id) VALUES (?,?)", [owner === null ? null : owner === 1 ? "admin" : String(owner), offer]) },
      { name: "drafts", insert: (offer, owner) => query("INSERT INTO listing_drafts (tenant_id,internal_code) VALUES (?,?)", [owner === null ? null : owner === 1 ? "admin" : String(owner), offer]) }
    ];

    for (const store of stores) {
      for (const id of [1, 2, 3]) {
        await t.test(`${store.name}: enterprise ${id} ignores foreign collisions and skips its own`, async () => {
          const prefix = `${store.name.toUpperCase()}-${id}`, foreign = id === 2 ? 3 : 2;
          await store.insert(`${prefix}-100000`, foreign);
          assert.equal(await generate(prefix, id), `${prefix}-100000`);
          await store.insert(`${prefix}-100000`, id);
          assert.equal(await generate(prefix, id), `${prefix}-550000`);
        });
      }
      await t.test(`${store.name}: NULL legacy ownership blocks default only`, async () => {
        const prefix = `${store.name.toUpperCase()}-LEGACY`;
        await store.insert(`${prefix}-100000`, null);
        assert.equal(await generate(prefix, 1), `${prefix}-550000`);
        assert.equal(await generate(prefix, 2), `${prefix}-100000`);
        assert.equal(await generate(prefix, 3), `${prefix}-100000`);
      });
    }

    await t.test("forged body tenant fields cannot change the authenticated route scope", async () => {
      await stores[0].insert("BODY-100000", 3);
      const body = { prefix: "BODY", tenant_id: "admin", tenantId: 3, tenant: { id: 3, slug: "company-b" } };
      randomValues = [0, 0.5];
      const current = session(2);
      const routes = createListingAutomationRoutes({ services: { generateListingOfferId: context.generateListingOfferId }, readJson: async req => req.body });
      const result = await routes["POST /api/listing/generate-offer-id"]({ body, _session: current });
      assert.equal(result.offerId, "BODY-100000");
      assert.deepEqual(sqlErrors, []);
    });

    await t.test("case-insensitive existingIds still skip candidates before database reads", async () => {
      reads.length = 0;
      assert.equal(await generate("EXISTING", 2, { existingIds: ["existing-100000"] }), "EXISTING-550000");
      assert.equal(reads.length, 4);
      assert.ok(reads.every(read => read.params.includes("EXISTING-550000")));
      assert.ok(reads.every(read => !read.params.includes("EXISTING-100000")));
      assert.equal(await generate("EXISTING-ALIAS", 2, { existing_ids: "existing-alias-100000" }), "EXISTING-ALIAS-550000");
    });

    await t.test("deleted records do not reserve IDs and excluding one own draft does not exclude another", async () => {
      await query("INSERT INTO listing_publish_records (tenant_id,offer_id,status) VALUES ('2','DELETED-100000','deleted')");
      await query("INSERT INTO listing_shop_copies (tenant_id,offer_id,status) VALUES ('2','DELETED-100000','deleted')");
      await query("INSERT INTO listing_drafts (tenant_id,internal_code,status) VALUES ('2','DELETED-100000','deleted')");
      assert.equal(await generate("DELETED", 2), "DELETED-100000");
      const first = await query("INSERT INTO listing_drafts (tenant_id,internal_code) VALUES ('2','SAME-DRAFT')");
      assert.equal(await context.listingOfferIdExistsInTenant("SAME-DRAFT", { session: session(2), excludeDraftId: first.insertId }), false);
      await query("INSERT INTO listing_drafts (tenant_id,internal_code) VALUES ('2','SAME-DRAFT')");
      assert.equal(await context.listingOfferIdExistsInTenant("SAME-DRAFT", { session: session(2), excludeDraftId: first.insertId }), true);
      assert.deepEqual(sqlErrors, []);
    });
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
