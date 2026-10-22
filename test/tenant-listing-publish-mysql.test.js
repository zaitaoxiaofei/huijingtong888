import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { parse } from "acorn";
import mysql from "mysql2/promise";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey, restoreBusinessTaskSession } from "../src/services/business-task-tenant.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });
const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const declarations = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.map(node => node.declaration || node);
const implementation = name => {
  const node = declarations.find(node => node.type === "FunctionDeclaration" && node.id.name === name);
  assert.ok(node, `Missing service implementation: ${name}`);
  return source.slice(node.start, node.end);
};

test("real publish SQL keeps A/B/default records and external calls in the persisted enterprise", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const database = `ozon_publish_test_${randomBytes(8).toString("hex")}`;
  const admin = await mysql.createConnection({ socketPath, user: "root" });
  let created = false, pool;
  try {
    const [[server]] = await admin.query("SELECT @@skip_networking AS disabled");
    assert.equal(Number(server.disabled), 1);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ socketPath, user: "root", database, connectionLimit: 6 });
    const query = async (sql, params = []) => (await pool.execute(sql, params))[0];
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, PRIMARY KEY(tenant_id, person_id))",
      "CREATE TABLE shops (id BIGINT PRIMARY KEY, tenant_id BIGINT NULL, name VARCHAR(80), status VARCHAR(32) DEFAULT 'active', ozon_client_id VARCHAR(80), ozon_api_key VARCHAR(80), api_key_hint VARCHAR(80), watermark_path TEXT, watermark_name TEXT, watermark_position TEXT, watermark_x_percent INT, watermark_y_percent INT, watermark_scale_percent INT, watermark_opacity_percent INT)",
      "CREATE TABLE products (id BIGINT PRIMARY KEY, tenant_id BIGINT NULL)",
      "CREATE TABLE listing_publish_records (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id VARCHAR(80), draft_id BIGINT NOT NULL, shop_id BIGINT NOT NULL, offer_id VARCHAR(128), status VARCHAR(64), request_json LONGTEXT, list_summary_json LONGTEXT, template_snapshot_json LONGTEXT, source_product_id BIGINT, offer_source VARCHAR(64), source_collector_sku VARCHAR(160), publish_task_id BIGINT, publish_task_item_id BIGINT, created_by_person_id BIGINT, task_id VARCHAR(128) DEFAULT '', response_json LONGTEXT, error_json LONGTEXT, ozon_product_id VARCHAR(128), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, published_at TIMESTAMP NULL)",
      "CREATE TABLE listing_publish_variant_links (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id VARCHAR(80), record_id BIGINT, ozon_status VARCHAR(64))"
    ]) await query(sql);
    await query("INSERT INTO tenants (id, slug) VALUES (1, 'default'), (2, 'enterprise-2'), (3, 'enterprise-3')");
    await query("INSERT INTO people (id) VALUES (7)");
    await query("INSERT INTO tenant_members (tenant_id, person_id, business_roles_json) VALUES (1, 7, JSON_ARRAY('operations')), (2, 7, JSON_ARRAY('operations')), (3, 7, JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id, tenant_id, name) VALUES (10, NULL, 'Legacy'), (11, 1, 'Default'), (20, 2, 'A'), (30, 3, 'B')");
    await query("INSERT INTO products (id, tenant_id) VALUES (100, NULL), (200, 2), (300, 3)");

    const externalCalls = [], queued = [], mediaContexts = [];
    let beforeExternal = null;
    const context = vm.createContext({
      console: { info() {}, warn() {} }, process, Buffer, Date, Number, String, Object, Array, Map, Set, JSON, Math, Promise, AsyncLocalStorage,
      mysqlQuery: query, mysqlExecute: query, listingTenantLookup, assertBusinessTaskPermission, businessTaskTenantKey,
      authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value, query),
      restoreBusinessTaskSession: (tenant, person) => restoreBusinessTaskSession(tenant, person, query),
      ensureListingAutomationSchema: async () => {},
      normalizeArray: value => Array.isArray(value) ? value : [],
      cleanText: value => String(value || "").trim(),
      parseJson: (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } },
      personId: value => Number(value?.personId || 0),
      firstOfferId: value => value.items?.[0]?.offer_id || "",
      normalizeShopTextVariantPolicy: () => ({}),
      normalizeRetryPublishPayload: value => value,
      normalizePublishRecordRow: value => value,
      assertNoEmbeddedMediaForPersistence() {},
      buildPublishRecordListSummary: value => ({ name: value.items?.[0]?.name }),
      resolveListingSourceProductId: async body => Number(body.source_product_id || 0),
      resolveShopTailImageUrl: async () => "https://fixture.invalid/tail.png",
      mapWithConcurrency: async (items, _limit, action) => Promise.all(items.map(action)),
      LISTING_PUBLISH_SHOP_CONCURRENCY: 2,
      listingPublishExecutionGuards: new WeakMap(),
      LISTING_PUBLISH_SHOP_SELECT: source.match(/const LISTING_PUBLISH_SHOP_SELECT = (`[\s\S]*?`);/)[1].slice(1, -1),
      validateListingTemplatePublish: async () => ({ ok: true, payload: { items: [{ offer_id: "own-offer", name: "own" }] }, errors: [], warnings: [] }),
      applyShopPublishDefaults: async payload => payload,
      buildListingCategoryPublishDiagnostics: async () => null,
      fetchOzonProductInfoLimit: async shop => { externalCalls.push({ type: "limit", shop: shop.id }); return {}; },
      isMissingRequiredAttributeMessage: () => false,
      missingRequiredAttributeMessage: () => "",
      localizePublishMessage: value => value,
      buildShopPublishPayloadForOzon: async ({ basePayload }) => ({ textVariantPayload: {}, watermarkedPayload: {}, tailImageUrl: "", tailApplied: {}, shopPayload: basePayload, mediaRepair: {} }),
      runBackgroundListingPublish: (_label, action) => queued.push(action),
      repairOzonPublishPayloadMedia: async (payload, options) => {
        mediaContexts.push({ tenant: options.session.tenant.id, person: options.session.personId });
        if (beforeExternal) await beforeExternal();
        return { payload, changed: false };
      },
      prepareOzonSellerMediaForPublishPayload: async payload => ({ payload, changed: false, jobs: [], pending: [] }),
      assertPublishPayloadHasOnlyPublicMedia() {}, assertPublishPayloadMediaReachable: async () => {},
      importOzonProducts: async (shop, payload) => {
        externalCalls.push({ type: "import", shop: Number(shop.id || shop.shop_id), tenant: context.currentAiTenantSession().tenant.id, offer: payload.items[0].offer_id });
        return { result: { task_id: "fixture-task" } };
      },
      fetchOzonProductImportInfo: async () => ({ result: {} }),
      normalizeOzonImportInfoErrors: () => ({ has_errors: false }),
      extractOzonImportInfoFailure: () => "",
      extractImportedProductRefs: () => ({ productIds: [], offerIds: [] }),
      importInfoStatus: () => "imported",
      refreshPublishRecordQuality: async () => null,
      persistListingVariantLineageForRecord: async () => {},
      autoBindPublishRecordInventory: async () => {},
      buildOzonPublishErrorPayload: error => ({ message: error.message || String(error) }),
      sameTimestamp: () => true
    });
    const contextSource = readFileSync(new URL("../src/services/ai-tenant-context.js", import.meta.url), "utf8").replace(/^import[^;]*;\r?\n/gm, "").replaceAll("export ", "");
    vm.runInContext(contextSource, context);
    for (const name of ["listingTenantId", "listingStoredShopTenantPredicate", "all", "row", "run", "insert", "assertDraftSourceProductTenant", "listingPublishRecordNotFoundError", "savePublishVariantLinks", "ozonProductLimitWarnings", "assertListingPublishExecution", "listingPublishRequestOptions", "validateListingTemplatePublishForShop", "preparePublishRecordForSubmit", "updatePublishRecordAfterSubmit", "publishListingTemplateToOzon", "submitPreparedListingPublishRecord", "retryListingPublishRecord"]) vm.runInContext(implementation(name), context);

    const records = new Map();
    await t.test("foreign and mixed-shop publication reject before Ozon validation or record writes", async () => {
      for (const id of [1, 2]) {
        await assert.rejects(context.publishListingTemplateToOzon({ shop_ids: [30] }, session(id)), /不属于当前企业/);
        await assert.rejects(context.publishListingTemplateToOzon({ shop_ids: [id === 1 ? 11 : 20, 30] }, session(id)), /不属于当前企业/);
        await assert.rejects(context.validateListingTemplatePublishForShop({}, 30, session(id)), { status: 404 });
      }
      assert.equal(externalCalls.length, 0);
      assert.equal((await query("SELECT COUNT(*) AS n FROM listing_publish_records"))[0].n, 0);
    });

    await t.test("own A/B/default and legacy shops persist the authenticated enterprise and actor", async () => {
      for (const [id, shops] of [[1, [10, 11]], [2, [20]], [3, [30]]]) {
        const result = await context.publishListingTemplateToOzon({ tenant_id: "other", shop_ids: shops }, session(id));
        assert.equal(result.ok, true, JSON.stringify(result));
        records.set(id, result.results.map(row => row.record_id));
      }
      const rows = await query("SELECT tenant_id, shop_id, created_by_person_id FROM listing_publish_records ORDER BY id");
      assert.deepEqual(rows, [10, 11, 20, 30].map((shop, i) => ({ tenant_id: ["admin", "admin", "2", "3"][i], shop_id: shop, created_by_person_id: 7 })));
      const foreignProduct = await context.publishListingTemplateToOzon({ shop_ids: [20], source_product_id: 300 }, session(2));
      assert.equal(foreignProduct.ok, false);
      assert.match(foreignProduct.results[0].error, /不属于当前企业/);
      assert.equal((await query("SELECT COUNT(*) AS n FROM listing_publish_records"))[0].n, 4);
    });

    await t.test("background submission reloads persisted A under ambient B and ignores supplied shop/payload", async () => {
      await context.withAiTenantSession(session(3), () => context.submitPreparedListingPublishRecord({ recordId: records.get(2)[0], shop: { id: 30 }, shopPayload: { items: [{ offer_id: "foreign" }] } }));
      assert.deepEqual(externalCalls.filter(call => call.type === "import"), [{ type: "import", shop: 20, tenant: 2, offer: "own-offer" }]);
      assert.deepEqual(mediaContexts, [{ tenant: 2, person: 7 }]);
      assert.equal((await query("SELECT status FROM listing_publish_records WHERE id = ?", records.get(2)))[0].status, "imported");
      await context.submitPreparedListingPublishRecord({ recordId: records.get(1)[0] });
      assert.equal(externalCalls.filter(call => call.type === "import").at(-1).tenant, 1);
      await query("INSERT INTO listing_publish_records (tenant_id, draft_id, shop_id, status, created_by_person_id, request_json) VALUES ('2', 0, 30, 'processing', 7, ?)", [JSON.stringify({ items: [{ offer_id: "poisoned" }] })]);
      const poisoned = (await query("SELECT MAX(id) AS id FROM listing_publish_records"))[0].id;
      await assert.rejects(context.submitPreparedListingPublishRecord({ recordId: poisoned }), /not found/);
    });

    await t.test("foreign retries cannot change records and own concurrent retry submits once", async () => {
      const record = records.get(3)[0];
      await query("UPDATE listing_publish_records SET status = 'failed' WHERE id = ?", [record]);
      for (const id of [1, 2]) await assert.rejects(context.retryListingPublishRecord(record, {}, session(id)), { status: 404 });
      assert.equal((await query("SELECT status FROM listing_publish_records WHERE id = ?", [record]))[0].status, "failed");
      const results = await Promise.allSettled([context.retryListingPublishRecord(record, {}, session(3)), context.retryListingPublishRecord(record, {}, session(3))]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.filter(result => result.status === "rejected" && result.reason.status === 409).length, 1);
      assert.equal(externalCalls.filter(call => call.type === "import" && call.tenant === 3).length, 1);
    });

    await t.test("revoked or downgraded creator cannot submit and late role changes block retries", async () => {
      const record = records.get(2)[0];
      const before = externalCalls.filter(call => call.type === "import").length;
      await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2");
      await assert.rejects(context.submitPreparedListingPublishRecord({ recordId: record }), { statusCode: 403 });
      await query("UPDATE tenant_members SET active = 1, business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 2");
      await assert.rejects(context.submitPreparedListingPublishRecord({ recordId: record }), { statusCode: 403 });
      await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('operations') WHERE tenant_id = 2");
      await query("UPDATE listing_publish_records SET status = 'failed' WHERE id = ?", [record]);
      beforeExternal = async () => { await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 2"); };
      const retried = await context.retryListingPublishRecord(record, {}, session(2));
      assert.equal(retried.status, "failed");
      assert.equal(externalCalls.filter(call => call.type === "import").length, before);
      assert.match(retried.error_json, /无权/);
    });
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
