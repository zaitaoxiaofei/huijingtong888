import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { MATERIAL_ASSETS_SCHEMA } from "../src/services/material-assets-schema.js";
import { aiMediaRetentionFingerprint, auditAiMediaRetention, applyAiMediaRetention } from "../src/services/ai-media-retention.js";

test("actual MySQL retention deletes only reviewed old AI indexes, retaining cross-enterprise business references", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated TENANT_TEST_MYSQL_SOCKET"
}, async () => {
  const fixture = await createTenantMysqlFixture("ai_retention");
  try {
    const q = fixture.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(7,'default','Default'),(9,'b','B')");
    await q(MATERIAL_ASSETS_SCHEMA);
    await fixture.connection.query(`
      CREATE TABLE listing_drafts(id BIGINT PRIMARY KEY,tenant_id VARCHAR(80),status VARCHAR(32),template_payload_json LONGTEXT,manual_facts_json LONGTEXT,ai_payload_json LONGTEXT);
      CREATE TABLE listing_category_templates(id BIGINT PRIMARY KEY,tenant_id VARCHAR(80),status VARCHAR(32),images_json LONGTEXT);
      CREATE TABLE listing_publish_records(id BIGINT PRIMARY KEY,tenant_id VARCHAR(80),status VARCHAR(32),request_json LONGTEXT);
      CREATE TABLE ai_variant_case_templates(id BIGINT PRIMARY KEY,tenant_id VARCHAR(80),status VARCHAR(32),case_json LONGTEXT);
      CREATE TABLE listing_collected_product_details(id VARCHAR(80) NOT NULL,tenant_id VARCHAR(80) NOT NULL,payload_json LONGTEXT,PRIMARY KEY(id,tenant_id));
      CREATE TABLE IF NOT EXISTS ozon_plugin_collected_products(tenant_id VARCHAR(80) NOT NULL,sku VARCHAR(128) NOT NULL,payload_json LONGTEXT,collect_date DATE,status VARCHAR(32),PRIMARY KEY(tenant_id,sku));
      CREATE TABLE listing_media_assets(id BIGINT PRIMARY KEY,tenant_id VARCHAR(80),source_module VARCHAR(80),role VARCHAR(64),status VARCHAR(32),publish_url TEXT,created_at DATETIME,updated_at DATETIME);
      CREATE TABLE listing_ai_variant_assets(id BIGINT PRIMARY KEY,tenant_id VARCHAR(80),source_module VARCHAR(80),field_key VARCHAR(64),field_status VARCHAR(32),status VARCHAR(32),asset_json LONGTEXT,created_at DATETIME,updated_at DATETIME)
    `);
    const storage = { bucket: "fixture", region: "oss-cn-test", publicBaseUrl: "https://media.fixture.invalid" };
    const url = name => `${storage.publicBaseUrl}/listing-media/aa/${name}.jpg`;
    await q("INSERT INTO material_assets(id,tenant_id,source_type,role,status,url,created_at,updated_at) VALUES(1,NULL,'ai_generated','main_image','active',?,'2026-10-01','2026-10-01')", [url("unused")]);
    await q("INSERT INTO material_assets(id,tenant_id,source_type,role,status,url,created_at,updated_at) VALUES(6,NULL,'ai_generated','main_image','active',?,'2026-10-01','2026-10-01'),(7,NULL,'ai_generated','main_image','active',?,'2026-10-01','2026-10-01')", [url("composite"),url("alias")]);
    await q("INSERT INTO listing_media_assets VALUES(2,'admin','ai_variant_lab','main','public_ready',?,'2026-10-01','2026-10-01'),(3,NULL,'asset_variant','main','local_only',?,'2026-10-01','2026-10-01'),(4,'admin','ai_generated','main','public_ready',?,'2026-10-25','2026-10-25')", [url("online"),url("matrix-unused"),url("recent")]);
    await q("INSERT INTO listing_ai_variant_assets VALUES(5,'admin','ai_variant_workbench','mainImage','generated','active',?,'2026-10-01','2026-10-01')", [JSON.stringify({ url: url("case") })]);
    await q("INSERT INTO shops(id,tenant_id,name) VALUES(9,9,'B')");
    await q("INSERT INTO online_products(id,shop_id,ozon_sku,name,image_url) VALUES(9,9,'B','B product',?)", [url("online")]);
    for (let index = 0; index < 21; index++) {
      await q("INSERT INTO online_products(id,shop_id,ozon_sku,name,image_url) VALUES(?,9,?,'B product',?)", [index + 10, `B-${index}`, index === 20 ? "https://legacy.fixture.invalid/last.jpg" : url(`other-${index}`)]);
      await q("INSERT INTO listing_collected_product_details VALUES('same-id',?,?)", [String(index + 20), JSON.stringify({ image: index === 20 ? url("composite") : url(`other-${index}`) })]);
    }
    for (let index = 0; index < 51; index++) await q("INSERT INTO media_migration_map(id,status,source_fingerprint,source_url,oss_url) VALUES(?,'verified',?,?,?)", [index + 1, aiMediaRetentionFingerprint({ index }),
      index === 50 ? "https://legacy.fixture.invalid/last.jpg" : `https://legacy.fixture.invalid/${index}.jpg`, index === 50 ? url("alias") : url(`other-${index}`)]);
    await q("INSERT INTO ai_variant_case_templates VALUES(9,'9','active',?)", [JSON.stringify({ sample_assets: { generated_main_image_url: url("case") } })]);
    const scanQueries = [];
    const query = async (sql, params = []) => {
      scanQueries.push({ sql, params: [...params] });
      return (await fixture.connection.query(sql, params))[0];
    };
    const transaction = async callback => {
      await fixture.connection.beginTransaction();
      try { const result = await callback({ query, execute: query }); await fixture.connection.commit(); return result; }
      catch (error) { await fixture.connection.rollback(); throw error; }
    };
    const deletedObjects = [];
    const dependencies = { query, transaction, storage, now: new Date("2026-10-26T00:00:00Z"), maintenance: async () => ({ verified: true }),
      headObject: async object_key => {
        const head = { object_key, bucket: storage.bucket, size: 321, etag: "fixture", last_modified: "2026-10-01T00:00:00Z", version_id: "" };
        return { ...head, fingerprint: aiMediaRetentionFingerprint(head) };
      },
      deleteObject: async object_key => { deletedObjects.push(object_key); return { object_key, deleted: true, bytes: 321 }; }
    };
    const manifest = await auditAiMediaRetention(dependencies);
    assert.equal(manifest.scan.complete, true);
    assert.equal(manifest.database.default_tenant_id, 7);
    assert.deepEqual(manifest.rows.map(item => `${item.table}:${item.id}`), ["material_assets:1", "listing_media_assets:3"]);
    assert.equal((await q("SELECT COUNT(*) count FROM material_assets"))[0].count, 3, "preview never mutates data");
    const onlineScans = scanQueries.filter(call => call.sql.includes("FROM `online_products`"));
    assert.ok(onlineScans.length >= 3 && onlineScans.every(call => !call.sql.includes("OFFSET")));
    assert.ok(onlineScans.slice(1).every(call => call.sql.includes("`id` > ?")));
    const aliasScans = scanQueries.filter(call => call.sql.includes("FROM media_migration_map"));
    assert.equal(aliasScans.length, 2);
    assert.ok(aliasScans.every(call => !call.sql.includes("OFFSET")) && aliasScans[1].sql.includes("id > ?"));
    const compositeScans = scanQueries.filter(call => call.sql.includes("FROM `listing_collected_product_details`"));
    assert.equal(compositeScans.length, 3);
    assert.ok(compositeScans.every(call => call.sql.includes("OFFSET")), "composite tenant ids must not use a single-column cursor");
    await q("INSERT INTO listing_drafts(id,tenant_id,status,template_payload_json) VALUES(99,'9','active',?)", [JSON.stringify({ large: "x".repeat(9 * 1024 * 1024), image: url("unused") })]);
    const oversized = await auditAiMediaRetention(dependencies);
    assert.equal(oversized.scan.complete, true, "a large business row is read separately with a bounded single-row query");
    assert.deepEqual(oversized.rows.map(item => `${item.table}:${item.id}`), ["listing_media_assets:3"]);
    assert.equal(oversized.scan.large_rows[0].read, true);
    assert.deepEqual(oversized.scan.large_rows[0].key, { id: 99 });
    assert.ok(JSON.stringify(oversized).length < 50000, "large business payloads never enter the manifest");
    await q("INSERT INTO ozon_plugin_collected_products(tenant_id,sku,payload_json,collect_date,status) VALUES('9','large-sku',?,'2026-10-01','collected')", [JSON.stringify({ large: "x".repeat(9 * 1024 * 1024), image: url("matrix-unused") })]);
    const compositeLarge = await auditAiMediaRetention(dependencies);
    assert.equal(compositeLarge.scan.complete, true);
    assert.equal(compositeLarge.rows.length, 0);
    assert.ok(compositeLarge.scan.large_rows.some(item => item.table === "ozon_plugin_collected_products" && item.key.tenant_id === "9" && item.key.sku === "large-sku" && item.read));
    const singleQueries = scanQueries.filter(call => call.sql.includes("ai_retention_single_reference"));
    assert.ok(singleQueries.length >= 3 && singleQueries.every(call => call.sql.endsWith("LIMIT 1")));
    assert.ok(singleQueries.some(call => call.sql.includes("`tenant_id` <=> ? AND `sku` <=> ?") && call.params.join(":") === "9:large-sku"));
    await q("DELETE FROM listing_drafts WHERE id=99");
    await q("DELETE FROM ozon_plugin_collected_products WHERE tenant_id='9' AND sku='large-sku'");
    await q("INSERT INTO listing_drafts(id,tenant_id,status,manual_facts_json) VALUES(98,'9','active',?)", [JSON.stringify({ large: "x".repeat(17 * 1024 * 1024) })]);
    await q("UPDATE listing_drafts SET ai_payload_json=? WHERE id=98", [JSON.stringify({ large: "x".repeat(17 * 1024 * 1024), image: url("matrix-unused") })]);
    const perColumn = await auditAiMediaRetention(dependencies);
    assert.equal(perColumn.scan.complete, true);
    assert.deepEqual(perColumn.rows.map(item => `${item.table}:${item.id}`), ["material_assets:1"]);
    const split = perColumn.scan.large_rows.find(item => item.key.id === 98);
    assert.equal(split.mode, "per_column"); assert.equal(split.read, true);
    assert.ok(split.column_bytes.manual_facts_json > 17 * 1024 * 1024 && split.column_bytes.ai_payload_json > 17 * 1024 * 1024);
    assert.ok(scanQueries.filter(call => call.sql.includes("ai_retention_reference_column")).every(call => !call.sql.includes("SELECT `manual_facts_json`,") && call.sql.endsWith("LIMIT 1")));
    assert.ok(JSON.stringify(perColumn).length < 50000);
    await q("UPDATE listing_drafts SET manual_facts_json=? WHERE id=98", [JSON.stringify({ large: "x".repeat(33 * 1024 * 1024) })]);
    const overField = await auditAiMediaRetention(dependencies);
    assert.equal(overField.scan.complete, false); assert.equal(overField.rows.length, 0);
    assert.ok(overField.scan.warnings.includes("listing_drafts:98:single_column_byte_bound_exceeded"));
    await q("DELETE FROM listing_drafts WHERE id=98");
    const result = await applyAiMediaRetention({ ...dependencies, manifest, deleteObjects: true });
    assert.equal(result.rows_deleted, 2); assert.equal(result.objects_deleted, 2);
    assert.deepEqual((await q("SELECT id FROM listing_media_assets ORDER BY id")).map(row => row.id), [2,4]);
    assert.equal((await q("SELECT COUNT(*) count FROM listing_ai_variant_assets"))[0].count, 1);
    assert.ok(deletedObjects.every(key => !key.endsWith("online.jpg") && !key.endsWith("case.jpg")));
  } finally { await fixture.cleanup(); }
});
