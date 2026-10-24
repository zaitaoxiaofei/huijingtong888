import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { migrateListingDraftListIndexes } from "../src/services/listing-draft-list-schema.js";
import { auditListingDraftStorage } from "../src/services/listing-draft-storage-audit.js";

test("draft overview preserves ownership, filters, media and publish statistics with bounded page aggregation", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated TENANT_TEST_MYSQL_SOCKET"
}, async (t) => {
  const fixture = await createTenantMysqlFixture("draft_list");
  let closeMysqlPool;
  const originalFetch = globalThis.fetch;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error("External network forbidden in draft list test"); };
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const listing = await import("../src/services/listing-automation.js");
    await listing.ensureListingAutomationSchema();
    const q = fixture.query;
    await q("INSERT INTO tenants (id,slug,name) VALUES (1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
    await q("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
    const session = (id) => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : String(id) } });
    for (const [id, owner] of [[1,"admin"],[2,"2"],[3,"3"]]) {
      await q("INSERT INTO listing_category_templates (id,tenant_id,ozon_category_id,category_name,template_name,required_attributes_json,ai_rules_json,title_prompt,description_prompt,image_rules_json) VALUES (?,?,'100:200',?,'Template','[]','{}','','','{}')", [id, owner, `Category ${id}`]);
      await q("INSERT INTO shops (id,tenant_id,name) VALUES (?,?,?)", [id, id, `Shop ${id}`]);
      for (let ordinal = 0; ordinal < 5; ordinal++) {
        const images = ordinal === 0 ? [] : [`https://example.invalid/${id}/${ordinal}.jpg`];
        const payload = { editable_payload: { variants: [{ images, images_manually_edited: ordinal === 0 }] } };
        await q("INSERT INTO listing_drafts (id,tenant_id,template_id,product_name,internal_code,source_urls_json,source_images_json,template_payload_json,manual_facts_json,ai_payload_json,created_by_person_id,created_at,updated_at) VALUES (?,?,?,?,?,'[]',?,?,'{}','{}',7,?,?)", [id * 100 + ordinal, owner, id, `Draft ${id}-${ordinal}`, `SKU-${id}-${ordinal}`, JSON.stringify([`https://example.invalid/old-${id}.jpg`]), JSON.stringify(payload), `2026-10-20 00:00:0${ordinal}`, `2026-10-21 00:00:0${4-ordinal}`]);
        if (ordinal) await q("INSERT INTO listing_shop_copies (tenant_id,draft_id,shop_id,images_json,validation_json,status) VALUES (?,?,?,'[]','{}',?)", [owner, id * 100 + ordinal, id, ["prepared","blocked","imported","published"][ordinal-1]]);
      }
    }
    await q("INSERT INTO listing_drafts (id,tenant_id,product_name,source_urls_json,source_images_json,manual_facts_json,ai_payload_json,created_at) VALUES (199,NULL,'Legacy default','[]','[]','{}','{}','2026-10-22')");
    for (let i = 0; i < 80; i++) {
      await q("INSERT INTO listing_publish_records (tenant_id,draft_id,shop_id,status,created_at,updated_at) VALUES ('2',200,2,?,DATE_ADD('2026-10-20', INTERVAL ? SECOND),DATE_ADD('2026-10-20', INTERVAL ? SECOND))", [i % 2 ? "failed" : "success", i, i]);
    }
    await q("INSERT INTO listing_publish_records (tenant_id,draft_id,shop_id,status,updated_at) VALUES ('2',200,2,'deleted','2026-10-23'),('3',200,3,'success','2026-10-24'),(NULL,199,1,'success','2026-10-23')");
    const read = (id, filters = {}) => listing.listingDrafts({ paged: "1", lightweight: "1", pageSize: "20", sortBy: "created_at", ...filters }, session(id));

    await t.test("A/B/default pages are ordered and do not share rows, labels or aggregate records", async () => {
      for (const id of [1,2,3]) {
        const page = await read(id);
        assert.deepEqual(page.rows.map((r) => Number(r.id)), id === 1 ? [199,104,103,102,101,100] : [id*100+4,id*100+3,id*100+2,id*100+1,id*100]);
        assert.equal(page.total, id === 1 ? 6 : 5);
        for (const row of page.rows) if (row.id !== 199) assert.equal(row.category_name, `Category ${id}`);
      }
      const [draft] = (await read(2, { ids: "200" })).rows;
      assert.equal(draft.publish_status, "failed");
      assert.equal(draft.publish_record_count, 80);
      assert.equal(draft.publish_success_count, 40);
      assert.equal(draft.publish_failed_count, 40);
      assert.equal((await read(1, { ids: "199" })).rows[0].publish_record_count, 1);
      assert.equal((await read(3, { ids: "200" })).total, 0);
    });
    await t.test("project and category filters, shop details and pagination retain the old business meaning", async () => {
      assert.deepEqual((await read(2, { projectOnly: "1" })).rows.map((r) => Number(r.id)), [202,201,200]);
      assert.deepEqual((await read(2, { projectOnly: "1", status: "editing" })).rows.map((r) => Number(r.id)), [200]);
      assert.deepEqual((await read(2, { projectOnly: "1", status: "waiting" })).rows.map((r) => Number(r.id)), [201]);
      assert.equal((await read(2, { category: "Category 3" })).total, 0);
      assert.equal((await read(2, { keyword: "Category 2" })).total, 5);
      const page = await read(2, { shopId: "2", includeShopDetails: "1", pageSize: "2", page: "2" });
      assert.deepEqual(page.rows.map((r) => Number(r.id)), [202,201]);
      assert.ok(page.rows.every((r) => r.shop_copies[0].shop_name === "Shop 2"));
    });
    await t.test("explicitly empty manual image sets never fall back to collected or template images", async () => {
      assert.deepEqual((await read(2, { ids: "200" })).rows[0].effective_images, []);
      assert.deepEqual((await read(2, { ids: "201" })).rows[0].effective_images, ["https://example.invalid/2/1.jpg"]);
    });
    await t.test("storage audit is bounded and private, reports exact repetitions and tolerates invalid legacy JSON", async () => {
      const attributes = [{ attribute_id: 7, value: "private filled value" }];
      const userFacts = { title: "private factual title", source_product_id: 42 };
      await q("UPDATE listing_drafts SET template_payload_json=?,manual_facts_json=?,ai_payload_json=? WHERE id=201", [JSON.stringify({ attributes, editable_payload: { attributes } }), JSON.stringify({ attributes, user_facts: userFacts }), JSON.stringify({ manual_facts: userFacts })]);
      const query = async (sql, params = []) => {
        assert.match(sql.trim(), /^SELECT/);
        return (await fixture.connection.query(sql, params))[0];
      };
      const result = await auditListingDraftStorage(query, { tenantId: "2", afterId: 200, limit: 1 });
      assert.equal(result.sampled_drafts, 1);
      assert.equal(result.last_id, 201);
      assert.equal(result.duplicate_template_attribute_sections, 1);
      assert.equal(result.duplicate_manual_attribute_sections, 1);
      assert.equal(result.duplicate_ai_fact_sections, 1);
      assert.ok(result.duplicate_template_attribute_bytes > 0);
      assert.doesNotMatch(JSON.stringify(result), /private filled|private factual/);
      assert.equal((await auditListingDraftStorage(query, { tenantId: "3", afterId: 200, limit: 1 })).last_id, 300);
      // Source text may be historically malformed; audit does not repair it.
      await q("UPDATE listing_drafts SET manual_facts_json='legacy malformed' WHERE id=202");
      assert.equal((await auditListingDraftStorage(query, { tenantId: "2", afterId: 201, limit: 1 })).duplicate_manual_attribute_sections, 0);
      await assert.rejects(auditListingDraftStorage(query, { tenantId: "2 OR 1=1" }), /explicit enterprise/);
      await assert.rejects(auditListingDraftStorage(query, { tenantId: "2", limit: 1001 }), /Invalid audit/);
    });
    await t.test("read-only index plan, additive apply and repeated apply preserve every stored row", async () => {
      const digest = async () => createHash("sha256").update(JSON.stringify(await q("SELECT * FROM listing_drafts ORDER BY id"))).digest("hex");
      const before = await digest();
      await q("ALTER TABLE listing_drafts DROP INDEX idx_listing_drafts_tenant_created, DROP INDEX idx_listing_drafts_tenant_creator_created");
      const query = async (sql, params = []) => (await fixture.connection.query(sql, params))[0];
      const plan = await migrateListingDraftListIndexes(query, { database: fixture.database });
      assert.equal(plan.changes_database, false);
      assert.equal(plan.missing_indexes.length, 2);
      assert.equal((await migrateListingDraftListIndexes(query, { database: fixture.database, apply: true })).changes_database, true);
      assert.equal((await migrateListingDraftListIndexes(query, { database: fixture.database, apply: true })).changes_database, false);
      assert.equal(await digest(), before);
      const [explain] = await query("EXPLAIN FORMAT=JSON SELECT id FROM listing_drafts FORCE INDEX (idx_listing_drafts_tenant_created) WHERE tenant_id='2' ORDER BY created_at DESC,id DESC LIMIT 20");
      assert.match(explain.EXPLAIN, /idx_listing_drafts_tenant_created/);
      assert.doesNotMatch(explain.EXPLAIN, /using_filesort": true/);
      await query("ALTER TABLE listing_drafts DROP INDEX idx_listing_drafts_tenant_created, ADD INDEX idx_listing_drafts_tenant_created (created_at,id)");
      await assert.rejects(migrateListingDraftListIndexes(query, { database: fixture.database, apply: true }), /Unexpected existing index definition/);
      assert.equal(await digest(), before);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
