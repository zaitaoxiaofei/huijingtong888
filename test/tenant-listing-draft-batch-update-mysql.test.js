import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { createListingAutomationRoutes } from "../src/server/routes/listingAutomation.js";

test("ordinary default/A/B batch draft edits keep every SQL read and write in the current enterprise", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL", timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture("draft_batch_edit");
  let closeMysqlPool;
  const originalFetch = globalThis.fetch;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error("No external requests are permitted in batch edit tests"); };
    const query = fixture.query;
    await query("INSERT INTO tenants (id,slug,name) VALUES (7,'default','Default'),(42,'a','A'),(43,'b','B')");
    await query("INSERT INTO people (id,name,role) VALUES (11,'Operator','operations')");
    for (const id of [7, 42, 43]) await query("INSERT INTO tenant_members (tenant_id,person_id,role,business_roles_json) VALUES (?,11,'member',JSON_ARRAY('operations'))", [id]);
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const services = await import("../src/services/listing-automation.js");
    await services.ensureListingAutomationSchema();
    const templates = new Map(), drafts = new Map();
    const keyOf = id => id === 7 ? "admin" : String(id);
    const session = (id, roles = ["operations"]) => ({ personId: 11, roles, tenant: { id, slug: id === 7 ? "default" : id === 42 ? "a" : "b", role: "member" } });
    const payload = (id, index) => ({
      ozon_category_id: "111:222", title: `Product ${id}-${index}`,
      editable_payload: { description_category_id: 111, type_id: 222, variants: [{ offer_id: `SKU-${id}-${index}`, title: `Product ${id}-${index}`, images: [] }] }
    });
    for (const id of [7, 42, 43]) {
      const template = await query("INSERT INTO listing_category_templates (tenant_id,ozon_category_id,category_name,template_name,required_attributes_json,ai_rules_json,title_prompt,description_prompt,image_rules_json,editable_payload_json,title,attributes_json,images_json) VALUES (?,'111:222','Fixture',?,'[]','{}','','','{}','{}',?,'[]','[]')", [keyOf(id), `Template ${id}`, `Product ${id}`]);
      templates.set(id, Number(template.insertId));
      const ids = [];
      for (const index of [1, 2]) {
        const draft = await query("INSERT INTO listing_drafts (tenant_id,template_id,product_name,internal_code,source_urls_json,source_images_json,template_payload_json,manual_facts_json,ai_payload_json,created_by_person_id) VALUES (?,?,?,?,'[]','[]',?,'{}','{}',11)", [keyOf(id), template.insertId, `Product ${id}-${index}`, `SKU-${id}-${index}`, JSON.stringify(payload(id, index))]);
        ids.push(Number(draft.insertId));
      }
      drafts.set(id, ids);
    }
    const body = id => ({ tenant_id: 999, created_by_person_id: 999, items: drafts.get(id).map((draftId, index) => ({
      id: draftId, template_id: templates.get(id), product_name: `Edited ${id}-${index}`, internal_code: `SKU-${id}-${index + 1}`,
      weight_g: 100 + index, template_payload: payload(id, index + 1), tenant_id: 999
    })) });
    const snapshot = () => query("SELECT id, tenant_id, template_id, product_name, internal_code, weight_g, template_payload_json, manual_facts_json FROM listing_drafts ORDER BY id");
    const parts = ["api", "listing", "drafts", "batch-update"];
    const routes = createListingAutomationRoutes({ services, readJson: async req => req.body });
    const request = async (member, data) => {
      for (const decision of [tenantIsolationDecision(member, parts, "POST"), authorizeApiRequest({ method: "POST", _session: member }, parts)]) {
        if (!decision.allowed) throw Object.assign(new Error(decision.error), { status: decision.status || 403, code: decision.code });
      }
      return routes["POST /api/listing/drafts/batch-update"]({ _session: member, body: data });
    };

    await t.test("same-enterprise rows save independently for ordinary default/A/B operators", async () => {
      for (const id of [7, 42, 43]) {
        const result = await request(session(id), body(id));
        assert.equal(result.updated, 2);
        assert.deepEqual(result.items.map(item => Number(item.id)), drafts.get(id));
        for (const [index, item] of result.items.entries()) {
          assert.equal(item.tenant_id, keyOf(id));
          assert.equal(item.product_name, `Edited ${id}-${index}`);
          assert.equal(Number(item.weight_g), 100 + index);
          assert.equal(item.template_payload.editable_payload.variants.length, 1);
          assert.equal(item.template_payload.editable_payload.variants[0].offer_id, `SKU-${id}-${index + 1}`);
        }
      }
    });
    await t.test("foreign draft IDs and template IDs reject the entire mixed batch without writes", async () => {
      for (const [own, foreign] of [[7, 42], [42, 43], [43, 42]]) {
        const before = await snapshot();
        const mixed = body(own);
        mixed.items[0].product_name = "Must not partially save";
        mixed.items[1].id = drafts.get(foreign)[0];
        await assert.rejects(request(session(own), mixed), /not found/i);
        assert.deepEqual(await snapshot(), before);
        const foreignTemplate = body(own);
        foreignTemplate.items[1].template_id = templates.get(foreign);
        await assert.rejects(request(session(own), foreignTemplate), /not found/i);
        assert.deepEqual(await snapshot(), before);
      }
    });
    await t.test("non-operations roles cannot reach the batch writer", async () => {
      const before = await snapshot();
      for (const id of [7, 42, 43]) for (const roles of [["packing"], ["procurement"], ["technical"], []]) {
        await assert.rejects(request(session(id, roles), body(id)), { status: 403 });
      }
      assert.deepEqual(await snapshot(), before);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
