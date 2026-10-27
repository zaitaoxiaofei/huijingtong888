import assert from "node:assert/strict";
import test from "node:test";
import { aiMediaRetentionFingerprint, auditAiMediaRetention, applyAiMediaRetention, createAiMediaRetentionSweep } from "../src/services/ai-media-retention.js";
import { headManagedOssRetentionObject, deleteManagedOssRetentionObject, listManagedOssRetentionObjects } from "../src/services/object-storage.js";
import { verifyAiMediaRetentionMaintenance } from "../scripts/cleanup-ai-media-retention.mjs";

const now = new Date("2026-10-26T12:00:00Z"), old = "2026-10-01T00:00:00.000Z";
const storage = { bucket: "fixture", region: "oss-cn-test", publicBaseUrl: "https://media.fixture.invalid" };
const key = name => `listing-media/aa/${name}.jpg`;
const url = name => `${storage.publicBaseUrl}/${key(name)}`;
const asset = (id = 1, extra = {}) => ({ id, tenant_id: 7, source_type: "ai_generated", role: "main_image", status: "pending_review", url: url(String(id)), created_at: old, updated_at: old, ...extra });
function fixture(extra = {}, { nonUniqueIdTables = [] } = {}) {
  const tables = { material_assets: [asset()], listing_media_assets: [], listing_drafts: [], listing_category_templates: [], listing_publish_records: [], online_products: [], products: [], ...structuredClone(extra) };
  const deleted = [], removed = [], heads = new Map(), candidatePageSizes = [], referencePageSizes = [], referenceQueries = [];
  const head = async objectKey => {
    if (heads.has(objectKey)) return heads.get(objectKey);
    const value = { object_key: objectKey, bucket: storage.bucket, size: 123, etag: "fixture-etag", last_modified: old, version_id: "" };
    return { ...value, fingerprint: aiMediaRetentionFingerprint(value) };
  };
  const query = async (sql, params = []) => {
    if (sql.startsWith("SELECT DATABASE()")) return [{ database_name: "fixture_only", server_uuid: "fixture-server" }];
    if (sql.startsWith("SELECT id FROM tenants")) return [{ id: 7 }];
    if (sql.includes("information_schema.columns")) return Object.entries(tables).flatMap(([table, rows]) => {
      const columns = new Set(["id", "tenant_id", "status", "created_at", "updated_at", "payload_json", ...rows.flatMap(row => Object.keys(row))]);
      return [...columns].map(column_name => ({ table_name: table, column_name, data_type: column_name.endsWith("json") ? "longtext" : "varchar", is_nullable: column_name === "id" ? "NO" : "YES" }));
    });
    if (sql.includes("information_schema.statistics")) return Object.keys(tables).map(table => ({ table_name: table, index_name: "PRIMARY", column_names: nonUniqueIdTables.includes(table) ? "tenant_id,id" : "id", has_prefix: 0 }));
    const table = /FROM\s+`?([a-z_]+)`?/i.exec(sql)?.[1];
    if (!Object.hasOwn(tables, table)) throw new Error(`Unexpected fixture SQL ${sql}`);
    if (sql.includes("FOR UPDATE")) return structuredClone(tables[table].filter(row => String(row.id) === String(params[0])));
    if (sql.includes("WHERE `source_")) {
      const rows = tables[table].filter(row => Date.parse(row.created_at) < now.getTime() - 7 * 86400000 && Number(row.id) > Number(params[params.length - 2])).slice(0, Number(params[params.length - 1]));
      candidatePageSizes.push(rows.length); return structuredClone(rows);
    }
    referenceQueries.push({ table, sql, params: [...params] });
    const hasOffset = / OFFSET \?/.test(sql), after = /(?:WHERE|AND) `?id`? > \?/.test(sql) ? params[0] : null;
    const compare = (left, right) => /^\d+$/.test(String(left)) && /^\d+$/.test(String(right))
      ? BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0 : String(left).localeCompare(String(right));
    const sorted = [...tables[table]].sort((a, b) => compare(a.id, b.id));
    const filtered = sorted.filter(row => (after === null || compare(row.id, after) > 0) && (!sql.includes("status='verified'") || row.status === "verified"));
    const offset = hasOffset ? Number(params[params.length - 1] || 0) : 0;
    const size = Number(params[hasOffset ? params.length - 2 : params.length - 1]);
    const rows = filtered.slice(offset, offset + size);
    referencePageSizes.push(rows.length); return structuredClone(rows);
  };
  const execute = async (sql, params) => {
    const table = /DELETE FROM `([a-z_]+)`/.exec(sql)?.[1];
    if (!table) throw new Error("Unexpected fixture mutation");
    tables[table] = tables[table].filter(row => String(row.id) !== String(params[0]));
    deleted.push(`${table}:${params[0]}`); return { affectedRows: 1 };
  };
  const dependencies = { query, storage, now, headObject: head,
    transaction: callback => callback({ query, execute }),
    deleteObject: async (object_key, fingerprint) => { removed.push({ object_key, fingerprint }); return { object_key, deleted: true, bytes: 123 }; },
    maintenance: async () => ({ verified: true }) };
  return { tables, deleted, removed, heads, candidatePageSizes, referencePageSizes, referenceQueries, dependencies };
}

test("preview is read-only; reviewed index deletion requires maintenance and keeps every physical object unless GC is requested", async () => {
  const f = fixture({ material_assets: [asset(1), asset(2, { source_type: "manual_upload" }), asset(3, { role: "reference_image" }), asset(4, { created_at: now.toISOString() }), asset(5, { status: "running" })] });
  const manifest = await auditAiMediaRetention(f.dependencies);
  assert.deepEqual(manifest.rows.map(row => row.id), ["1"]);
  assert.equal(manifest.objects.length, 1);
  assert.equal(f.deleted.length, 0);
  await assert.rejects(applyAiMediaRetention({ ...f.dependencies, maintenance: null, manifest }), /writer-freeze/);
  const result = await applyAiMediaRetention({ ...f.dependencies, manifest });
  assert.equal(result.rows_deleted, 1); assert.equal(result.objects_deleted, 0);
  assert.equal(f.removed.length, 0); assert.equal(f.tables.material_assets.length, 4);
});

test("observed AI output sources and public_ready/local_only states are eligible; current and unfinished AI asset records remain protected", async () => {
  const f = fixture({ material_assets: [], listing_media_assets: [
    { id: 2, tenant_id: "admin", source_module: "ai_variant_lab", role: "main", status: "public_ready", publish_url: url("2"), created_at: old, updated_at: old },
    { id: 3, tenant_id: null, source_module: "ai_ecommerce_suite_workbench", role: "detail", status: "local_only", publish_url: url("3"), created_at: old, updated_at: old },
    { id: 4, tenant_id: "admin", source_module: "ai_generated", role: "main", status: "public_ready", publish_url: url("4"), created_at: old, updated_at: old }
  ], listing_ai_variant_assets: [
    { id: 8, tenant_id: "admin", source_module: "ai_variant_workbench", field_status: "generated", field_key: "mainImage", status: "active", asset_json: JSON.stringify({ url: url("8") }), created_at: old, updated_at: old },
    { id: 9, tenant_id: "admin", source_module: "ai_variant_workbench", field_status: "running", status: "active", asset_json: JSON.stringify({ url: url("running") }), created_at: old, updated_at: old }
  ] });
  const manifest = await auditAiMediaRetention(f.dependencies);
  assert.deepEqual(manifest.rows.map(item => `${item.table}:${item.id}`), ["listing_media_assets:2", "listing_media_assets:3", "listing_media_assets:4", "listing_ai_variant_assets:8"]);
  assert.equal(manifest.objects.length, 4);
});

test("all enterprise business roots protect URLs, escaped JSON and explicit asset IDs", async () => {
  for (const table of ["listing_drafts", "listing_frozen_content", "listing_category_templates", "listing_publish_records", "listing_shop_copies", "online_products", "products", "ai_variant_case_templates", "listing_variant_workbench_drafts",
    "order_items", "inbound_records", "product_development_candidates", "product_development_ideas", "ai_vehicle_catalog", "ozon_reviews", "asset_variant_video_cache", "ai_variant_lab_plans"]) {
    const f = fixture({ [table]: [{ id: 91, tenant_id: "88", status: "active", payload_json: JSON.stringify({ nested: { image: url("1") } }).replaceAll("/", "\\/") }] });
    const manifest = await auditAiMediaRetention(f.dependencies);
    assert.equal(manifest.rows.length, 0, table); assert.equal(manifest.objects.length, 0, table);
  }
  const f = fixture({ products: [{ id: 77, payload_json: JSON.stringify({ material_asset_id: 1 }) }] });
  assert.equal((await auditAiMediaRetention(f.dependencies)).rows.length, 0);
  const direct = fixture({ products: [{ id: 77, material_asset_id: 1 }] });
  assert.equal((await auditAiMediaRetention(direct.dependencies)).rows.length, 0);
});

test("a source image in work metadata is not an adopted generated result, while non-AI index duplicates protect the object", async () => {
  const f = fixture({ material_assets: [asset(1, { metadata_json: JSON.stringify({ source_image: url("input") }) })], products: [{ id: 55, image_url: url("input") }] });
  assert.equal((await auditAiMediaRetention(f.dependencies)).rows.length, 1);
  const duplicate = fixture({ listing_media_assets: [{ id: 2, tenant_id: "88", source_module: "collector", status: "active", publish_url: url("1"), created_at: old, updated_at: old }] });
  assert.equal((await auditAiMediaRetention(duplicate.dependencies)).rows.length, 0);
  const migrated = fixture({ products: [{ id: 44, image_url: "https://old.fixture.invalid/original.jpg" }],
    media_migration_map: [{ id: 5, status: "verified", source_url: "https://old.fixture.invalid/original.jpg", oss_url: url("1") }] });
  assert.equal((await auditAiMediaRetention(migrated.dependencies)).rows.length, 0, "a retained legacy business URL protects its verified OSS replacement");
});

test("active jobs and unknown credit work are retained; terminal work output alone does not retain indexes forever", async () => {
  const active = fixture({ ai_generation_tasks: [{ id: 40, tenant_id: "admin", status: "running", input_json: JSON.stringify({ image: url("1") }) }] });
  assert.equal((await auditAiMediaRetention(active.dependencies)).rows.length, 0);
  const unknown = fixture({ ai_credit_tasks: [{ id: "uuid", tenant_id: 7, status: "unknown", result_reference: null }] });
  assert.equal((await auditAiMediaRetention(unknown.dependencies)).rows.length, 0);
  const terminal = fixture({ ai_generation_tasks: [{ id: 40, tenant_id: "admin", status: "completed", created_at: old, updated_at: old, output_json: JSON.stringify({ image: url("1") }) }] });
  assert.equal((await auditAiMediaRetention(terminal.dependencies)).rows.length, 1);
  const reused = fixture({ ai_generation_tasks: [{ id: 40, tenant_id: "admin", status: "completed", created_at: old, updated_at: now.toISOString(), output_json: JSON.stringify({ image: url("1") }) }] });
  assert.equal((await auditAiMediaRetention(reused.dependencies)).rows.length, 0, "a recently reused old output gets seven days from its current task use");
  for (const table of ["listing_publish_tasks", "listing_publish_task_items", "listing_ozon_seller_media_upload_jobs", "ai_variant_draft_save_batches", "ai_variant_draft_save_items"]) {
    const working = fixture({ [table]: [{ id: 40, tenant_id: "admin", status: "running", payload_json: JSON.stringify({ image: url("1") }) }] });
    assert.equal((await auditAiMediaRetention(working.dependencies)).rows.length, 0, table);
  }
  const failedUnknown = fixture({ ai_material_optimization_items: [{ id: 40, tenant_id: "admin", status: "failed", checkpoint_json: JSON.stringify({ draft_state: "submitting" }) }] });
  assert.equal((await auditAiMediaRetention(failedUnknown.dependencies)).rows.length, 0);
});

test("missing roots, malformed JSON or bounded incomplete scans retain everything", async () => {
  const bad = fixture({ listing_drafts: [{ id: 1, template_payload_json: "{broken" }] });
  const manifest = await auditAiMediaRetention(bad.dependencies);
  assert.equal(manifest.scan.complete, false); assert.equal(manifest.rows.length, 0);
  const missing = fixture(); delete missing.tables.products;
  assert.equal((await auditAiMediaRetention(missing.dependencies)).scan.complete, false);
  const bounded = fixture({ products: [{ id: 81, image_url: url("other") }] });
  await assert.rejects(auditAiMediaRetention({ ...bounded.dependencies, maxScanRows: 1 }), { code: "AI_MEDIA_RETENTION_SCAN_INCOMPLETE" });
});

test("offline object GC needs unchanged rows, current references and unchanged OSS head fingerprints", async () => {
  const f = fixture(), manifest = await auditAiMediaRetention(f.dependencies);
  await assert.rejects(applyAiMediaRetention({ ...f.dependencies, manifest, deleteObjects: true, maintenance: async () => ({ verified: false }) }), /freeze evidence/);
  assert.equal(f.deleted.length, 0);
  f.tables.products.push({ id: 90, image_url: url("1") });
  const kept = await applyAiMediaRetention({ ...f.dependencies, manifest, deleteObjects: true });
  assert.equal(kept.rows_deleted, 0); assert.equal(kept.objects_deleted, 0);
  f.tables.products = []; f.tables.material_assets[0].title = "concurrent change";
  const changed = await applyAiMediaRetention({ ...f.dependencies, manifest, deleteObjects: true });
  assert.equal(changed.rows_deleted, 0); assert.equal(changed.objects_deleted, 0);
  const good = fixture(), reviewed = await auditAiMediaRetention(good.dependencies);
  const result = await applyAiMediaRetention({ ...good.dependencies, manifest: reviewed, deleteObjects: true });
  assert.equal(result.rows_deleted, 1); assert.equal(result.objects_deleted, 1); assert.equal(result.reclaimed_bytes, 123);
  const altered = fixture(), oldManifest = await auditAiMediaRetention(altered.dependencies);
  altered.heads.set(key("1"), { ...(await altered.dependencies.headObject(key("1"))), fingerprint: "f".repeat(64) });
  const preserved = await applyAiMediaRetention({ ...altered.dependencies, manifest: oldManifest, deleteObjects: true });
  assert.equal(preserved.rows_deleted, 1); assert.equal(preserved.objects_deleted, 0);
});

test("database-bound manifests reject tampering, expiry and foreign origins before mutation", async () => {
  const f = fixture(), manifest = await auditAiMediaRetention(f.dependencies);
  await assert.rejects(applyAiMediaRetention({ ...f.dependencies, manifest: { ...manifest, cutoff: now.toISOString() } }), /checksum/);
  await assert.rejects(applyAiMediaRetention({ ...f.dependencies, manifest, now: new Date("2026-10-28T00:00:00Z") }), /stale/);
  const other = fixture(); const query = async (sql, params) => sql.startsWith("SELECT DATABASE()") ? [{ database_name: "foreign", server_uuid: "foreign" }] : other.dependencies.query(sql, params);
  await assert.rejects(applyAiMediaRetention({ ...other.dependencies, query, manifest }), /another database/);
  assert.equal(f.deleted.length, 0); assert.equal(other.deleted.length, 0);
});

test("temporary inventory is allowed, arbitrary old permanent inventory never supplies AI provenance", async () => {
  const f = fixture({ material_assets: [] });
  const manifest = await auditAiMediaRetention({ ...f.dependencies, objects: [{ object_key: "ai-unused/aa/one.jpg" }, { object_key: key("unknown-permanent") }, { object_key: "product-media/old.jpg" }] });
  assert.deepEqual(manifest.objects.map(item => item.object_key), ["ai-unused/aa/one.jpg"]);
});

test("scheduled sweep saves a private manifest and cannot delete indexes or physical OSS objects online", async () => {
  const f = fixture(), saved = [];
  const run = createAiMediaRetentionSweep({ ...f.dependencies, saveManifest: async manifest => saved.push(manifest) });
  const result = await run();
  assert.equal(saved.length, 1); assert.deepEqual(saved[0].rows[0].row.output_urls, [url("1")]);
  assert.equal(result.rows_queued, 1); assert.equal(result.rows_deleted, 0); assert.equal(result.objects_deleted, 0);
  assert.equal(f.deleted.length, 0); assert.equal(f.removed.length, 0);
});

test("saved online manifests retain AI provenance for later offline GC after work indexes were deleted", async () => {
  const f = fixture(), saved = [];
  await createAiMediaRetentionSweep({ ...f.dependencies, saveManifest: async manifest => saved.push(manifest) })();
  assert.equal(saved[0].objects.length, 0);
  await applyAiMediaRetention({ ...f.dependencies, manifest: saved[0] });
  const later = await auditAiMediaRetention({ ...f.dependencies, priorManifests: saved });
  assert.equal(later.rows.length, 0); assert.equal(later.objects.length, 1);
  const result = await applyAiMediaRetention({ ...f.dependencies, manifest: later, deleteObjects: true });
  assert.equal(result.objects_deleted, 1);
  const foreign = { ...saved[0], database: { ...saved[0].database, server_uuid: "other" } };
  const { manifest_sha256, ...body } = foreign; foreign.manifest_sha256 = aiMediaRetentionFingerprint(body);
  await assert.rejects(auditAiMediaRetention({ ...f.dependencies, priorManifests: [foreign] }), /another database/);
});

test("scheduled cursor advances past adopted old rows instead of starving later unused work", async () => {
  const rows = Array.from({ length: 201 }, (_, index) => asset(index + 1));
  const f = fixture({ material_assets: rows, products: [{ id: 900, image_url: url("1") }] }), saved = [], cursors = [];
  const sweep = createAiMediaRetentionSweep({ ...f.dependencies, saveManifest: async manifest => saved.push(manifest), saveCursor: async cursor => cursors.push(cursor) });
  const first = await sweep();
  assert.equal(first.rows_queued, 199); assert.equal(first.rows_deleted, 0);
  assert.equal(cursors[0].material_assets, "200");
  const second = await sweep();
  assert.equal(second.rows_queued, 1); assert.equal(second.rows_deleted, 0);
  assert.equal(f.tables.material_assets.length, 201);
  assert.equal(saved.length, 2);
});

test("large production-style metadata is hashed one small page at a time and never copied into the manifest", async () => {
  const metadata = JSON.stringify({ privatePrompt: "x".repeat(4 * 1024 * 1024) });
  const f = fixture({ material_assets: Array.from({ length: 21 }, (_, index) => asset(index + 1, { metadata_json: metadata, final_prompt: "large private input" })) });
  const manifest = await auditAiMediaRetention({ ...f.dependencies, limit: 25000, headObject: null });
  assert.equal(manifest.rows.length, 21);
  assert.ok(f.candidatePageSizes.length >= 3);
  assert.ok(f.candidatePageSizes.every(size => size <= 10));
  assert.ok(f.referencePageSizes.every(size => size <= 10));
  assert.ok(manifest.rows.every(item => !Object.hasOwn(item.row, "metadata_json") && !Object.hasOwn(item.row, "final_prompt") && /^[a-f0-9]{64}$/.test(item.row_sha256)));
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 40000);
  assert.ok(!JSON.stringify(manifest).includes("privatePrompt"));
});

test("reference and migration scans seek by unique id on later pages without OFFSET", async () => {
  const legacy = "https://legacy.fixture.invalid/final.jpg";
  const f = fixture({
    online_products: Array.from({ length: 31 }, (_, index) => ({ id: index + 10, image_url: index === 30 ? legacy : url(`other-${index}`) })),
    media_migration_map: Array.from({ length: 103 }, (_, index) => ({ id: index + 1, status: "verified", source_url: index === 102 ? legacy : `https://legacy.fixture.invalid/${index}.jpg`, oss_url: url(index === 102 ? "1" : `other-${index}`) }))
  });
  const manifest = await auditAiMediaRetention(f.dependencies);
  assert.equal(manifest.rows.length, 0, "the alias on a later keyset page still protects the final business reference");
  for (const table of ["online_products", "media_migration_map"]) {
    const calls = f.referenceQueries.filter(item => item.table === table);
    assert.ok(calls.length >= 3, table);
    assert.ok(calls.every(item => !item.sql.includes("OFFSET")), table);
    assert.ok(calls.slice(1).every(item => /(?:AND|WHERE) `?id`? > \?/.test(item.sql)), table);
    assert.ok(calls.slice(1).every(item => item.params.length === 2), table);
  }
});

test("composite tenant ids use complete fallback pages and never skip another enterprise with the same id", async () => {
  const f = fixture({ listing_collected_product_details: Array.from({ length: 21 }, (_, index) => ({ id: "same-id", tenant_id: String(index + 1), payload_json: JSON.stringify({ image: index === 20 ? url("1") : url(`other-${index}`) }) })) },
    { nonUniqueIdTables: ["listing_collected_product_details"] });
  const manifest = await auditAiMediaRetention(f.dependencies);
  assert.equal(manifest.rows.length, 0);
  const calls = f.referenceQueries.filter(item => item.table === "listing_collected_product_details");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(item => item.sql.includes("OFFSET") && !/`?id`? > \?/.test(item.sql)));
});

const ossEnv = { OSS_ENABLED: "true", OSS_REGION: "oss-cn-test", OSS_BUCKET: "fixture", OSS_ACCESS_KEY_ID: "test", OSS_ACCESS_KEY_SECRET: "test" };
test("OSS delete helpers reject forbidden namespaces and changed objects, preserving version and ETag evidence", async () => {
  const calls = [];
  const client = { head: async () => ({ res: { headers: { "content-length": "123", etag: '"etag-1"', "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT", "x-oss-version-id": "version-one" } } }),
    delete: async (...args) => calls.push(args) };
  const head = await headManagedOssRetentionObject(key("x"), { env: ossEnv, client });
  assert.equal(head.version_id, "version-one");
  for (const prefix of ["product-media", "collector-media", "video-source", "database-archives"]) {
    await assert.rejects(deleteManagedOssRetentionObject(`${prefix}/old.jpg`, head.fingerprint, { env: ossEnv, client }), /Unreviewed/);
  }
  await assert.rejects(deleteManagedOssRetentionObject(key("x"), "f".repeat(64), { env: ossEnv, client }), /changed/);
  await assert.rejects(deleteManagedOssRetentionObject(key("x"), head.fingerprint, { env: ossEnv, client }), /Versioned/);
  client.head = async () => ({ res: { headers: { "content-length": "123", etag: '"etag-1"', "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT", "x-oss-version-id": "null" } } });
  const suspended = await headManagedOssRetentionObject(key("x"), { env: ossEnv, client });
  await assert.rejects(deleteManagedOssRetentionObject(key("x"), suspended.fingerprint, { env: ossEnv, client }), /Versioned/);
  const versioned = fixture(); versioned.heads.set(key("1"), { ...suspended, object_key: key("1") });
  assert.equal((await auditAiMediaRetention(versioned.dependencies)).objects.length, 0, "a suspended bucket null version is still a versioned object");
  client.head = async () => ({ res: { headers: { "content-length": "123", etag: '"etag-1"', "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT" } } });
  const unversioned = await headManagedOssRetentionObject(key("x"), { env: ossEnv, client });
  await deleteManagedOssRetentionObject(key("x"), unversioned.fingerprint, { env: ossEnv, client });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], [key("x")]);
  await assert.rejects(listManagedOssRetentionObjects({ prefix: "collector-media", env: ossEnv, client }), /Unreviewed/);
});

test("physical GC refuses a live Node worker or other database connection and verifies the local maintenance host", async () => {
  const clean = { platform: "linux", pid: 10, query: async () => [], inspectProcesses: async () => "10 node node retention.mjs\n11 node PM2 v6: God Daemon\n" };
  assert.equal((await verifyAiMediaRetentionMaintenance(clean)).verified, true);
  await assert.rejects(verifyAiMediaRetentionMaintenance({ ...clean, inspectProcesses: async () => "12 node node unfamiliar-worker.js" }), /still running/);
  await assert.rejects(verifyAiMediaRetentionMaintenance({ ...clean, query: async () => [{ ID: 3 }] }), /connections remain/);
  await assert.rejects(verifyAiMediaRetentionMaintenance({ ...clean, platform: "win32" }), /Linux/);
});
