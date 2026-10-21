import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assetVariantExecutionScope, assetVariantTenantScope } from "../src/services/asset-variant-tenant-scope.js";
import { createAssetVariantEngineRoutes, handleAssetVariantEngineRestRoute } from "../src/server/routes/assetVariantEngine.js";
import { assetVariantSource, loadAssetVariantConfigService, loadShopTailResolver } from "./helpers/asset-variant-config-service.js";

const enterprise = (id = 2, role = "admin") => ({ personId: 9, roles: ["operations"], tenant: { id, slug: `enterprise-${id}`, role } });
const defaultSession = { personId: 1, tenant: { id: 1, slug: "default", role: "admin" } };
const defaultOperations = { personId: 7, roles: ["operations"], tenant: { id: 1, slug: "default", role: "member" } };

test("matrix config requires a valid session and tenant administrator without treating business admin as platform identity", () => {
  for (const session of [null, {}, { tenant: { id: 2 } }, { tenant: { id: -1, slug: "a" } }]) {
    assert.throws(() => assetVariantTenantScope(session), { statusCode: 403 });
  }
  assert.throws(() => assetVariantTenantScope(enterprise(2, "member")), { statusCode: 403 });
  assert.throws(() => assetVariantTenantScope({ ...enterprise(2, "member"), roles: ["admin"] }, { write: true }), { statusCode: 403 });
  assert.equal(assetVariantTenantScope({ ...enterprise(2, "member"), platform_role: "super_admin" }, { write: true }).id, 2);
  assert.equal(assetVariantTenantScope(defaultSession).isDefault, true);
  assert.throws(() => assetVariantExecutionScope(enterprise()), { statusCode: 403 });
});

test("default enterprise operations can consume configuration and execute without receiving configuration authority", async () => {
  assert.deepEqual(assetVariantTenantScope(defaultOperations), { id: 1, slug: "default", isDefault: true });
  assert.deepEqual(assetVariantExecutionScope(defaultOperations), { id: 1, slug: "default", isDefault: true });
  assert.throws(() => assetVariantTenantScope(defaultOperations, { write: true }), { statusCode: 403 });
  assert.throws(() => assetVariantExecutionScope({ ...enterprise(2, "owner"), platform_role: "super_admin" }), { statusCode: 403 });
  let writes = 0;
  const service = loadAssetVariantConfigService({
    query: async (sql, params) => {
      if (/shop_watermark_templates/.test(sql)) return [];
      assert.equal(params[0], 1);
      assert.match(sql, /tenant_id IS NULL/);
      return /FROM shops s/.test(sql) ? [{ id: 11, name: "Default shop" }] : [{ id: 100, tenant_id: null, image_path: "default-tail" }];
    },
    execute: async () => { writes += 1; }
  });
  assert.deepEqual(Array.from((await service.assetVariantBootstrap({}, defaultOperations)).shops, shop => shop.id), [11]);
  assert.deepEqual(Array.from(await service.assetTailTemplates({}, defaultOperations), tail => tail.id), [100]);
  await assert.rejects(service.saveShopVariantRule({ shopId: 11 }, defaultOperations), { statusCode: 403 });
  await assert.rejects(service.createAssetTailTemplate({ image: "data:image/png;base64,AA==" }, defaultOperations), { statusCode: 403 });
  assert.equal(writes, 0);
});

test("configuration and private tail routes forward only the authenticated session", async () => {
  const calls = [];
  const session = enterprise();
  const services = Object.fromEntries(["assetVariantBootstrap", "saveShopVariantRule", "assetTailTemplates", "createAssetTailTemplate"].map(name => [name, async (...args) => calls.push([name, ...args])]));
  const routes = createAssetVariantEngineRoutes({ services, readJson: async () => ({ tenant_id: 3 }) });
  const req = { _session: session, query: { tenantId: 3 } };
  await routes["GET /api/asset-variant-engine/bootstrap"](req);
  await routes["POST /api/asset-variant-engine/rules"](req);
  await routes["GET /api/asset-variant-engine/tail-templates"](req);
  await routes["POST /api/asset-variant-engine/tail-templates"](req);
  assert.ok(calls.every(call => call.at(-1) === session));
  let readArgs;
  await handleAssetVariantEngineRestRoute({
    req: { ...req, method: "GET" }, res: {}, parts: ["api", "asset-variant-engine", "tail-template-files", "55"],
    services: { resolveAssetTailTemplateFile: async (...args) => { readArgs = args; return null; } },
    notFound: () => true
  });
  assert.deepEqual(readArgs, ["55", session]);
});

test("bootstrap binds current enterprise for shops and private templates and never reads legacy global watermarks", async () => {
  const calls = [];
  const service = loadAssetVariantConfigService({ query: async (sql, params = []) => {
    calls.push({ sql, params });
    assert.doesNotMatch(sql, /shop_watermark_templates/);
    assert.match(sql, /\.tenant_id = \?/);
    assert.doesNotMatch(sql, /tenant_id IS NULL/);
    assert.equal(params[0], 2);
    return /FROM shops s/.test(sql) ? [{ id: 20, name: "A" }] : [{ id: 200, tenant_id: 2, shop_id: null }];
  } });
  const result = await service.assetVariantBootstrap({ tenantId: 3 }, enterprise());
  assert.deepEqual(Array.from(result.shops, row => row.id), [20]);
  assert.deepEqual(Array.from(result.tailTemplates, row => row.id), [200]);
  assert.equal(calls.length, 2);
});

test("foreign shop, watermark, and tail references fail before any configuration write", async () => {
  let writes = 0;
  const service = loadAssetVariantConfigService({
    execute: async () => { writes += 1; },
    query: async (sql, params) => {
      if (/FROM shops s/.test(sql)) return params[0] === 20 && params[1] === 2 ? [{ id: 20, watermark_path: "/own.png" }] : [];
      return [];
    }
  });
  await assert.rejects(service.saveShopVariantRule({ shopId: 30 }, enterprise()), { statusCode: 404 });
  await assert.rejects(service.saveShopVariantRule({ shopId: 20, watermarkTemplateId: "shop-30" }, enterprise()), { statusCode: 404 });
  await assert.rejects(service.saveShopVariantRule({ shopId: 20, watermarkTemplateId: "7" }, enterprise()), { statusCode: 404 });
  await assert.rejects(service.saveShopVariantRule({ shopId: 20, tailTemplateId: 300 }, enterprise()), { statusCode: 404 });
  await assert.rejects(service.createAssetTailTemplate({ shopId: 30, image: "data:image/png;base64,AA==" }, enterprise()), { statusCode: 404 });
  await assert.rejects(service.createAssetTailTemplate({ imagePath: "/other-company/tail.png" }, enterprise()), { statusCode: 400 });
  assert.equal(writes, 0);
});

test("setting enterprise generic default tail only updates that enterprise and writes owner from session", async () => {
  const writes = [];
  const service = loadAssetVariantConfigService({
    query: async () => [{ id: 99, tenant_id: 2, shop_id: null }],
    execute: async (sql, params) => { writes.push({ sql, params }); return { insertId: 99 }; }
  });
  await service.createAssetTailTemplate({ tenant_id: 3, category: "C", vehicleModel: "M", image: "data:image/png;base64,AA==", isDefault: true }, enterprise());
  const update = writes.find(call => /UPDATE asset_tail_templates/.test(call.sql));
  assert.match(update.sql, /t\.tenant_id = \?/);
  assert.doesNotMatch(update.sql, /tenant_id IS NULL/);
  assert.deepEqual(Array.from(update.params), [2, null, "C", "M"]);
  const insert = writes.find(call => /INSERT INTO asset_tail_templates/.test(call.sql));
  assert.match(insert.sql, /\(tenant_id, shop_id,/);
  assert.equal(insert.params[0], 2);
});

test("private tail lookup cannot read bytes for an unavailable enterprise template", async () => {
  let reads = 0;
  const service = loadAssetVariantConfigService({ query: async (sql, params) => {
    assert.match(sql, /t\.tenant_id = \?/);
    assert.equal(params[1], 2);
    return [];
  }, readFile: async () => { reads += 1; return Buffer.from("private"); } });
  assert.equal(await service.resolveAssetTailTemplateFile(300, enterprise()), null);
  assert.equal(reads, 0);
  await assert.rejects(service.resolveAssetTailTemplateFile(300), { statusCode: 403 });
});

test("listing fallback binds template tenant before shop and template parameters", async () => {
  const calls = [];
  const resolve = loadShopTailResolver(async (sql, params) => {
    calls.push({ sql, params });
    return /FROM shop_variant_rules/.test(sql) ? [{ tail_template_id: 200 }] : [{ image_path: "own-tail" }];
  });
  assert.equal(await resolve({ id: 20 }, enterprise()), "own-tail");
  assert.match(calls[1].sql, /AND tenant_id = \?/);
  assert.deepEqual(Array.from(calls[1].params), [2, 20, 200, 200, 20]);
});

test("legacy jobs explicitly retain their default workspace and new requests overwrite client tenant scope", () => {
  const enqueues = assetVariantSource.slice(assetVariantSource.indexOf("export async function enqueuePublishSelectionProductToOzon"), assetVariantSource.indexOf("export async function assetVariantJobs"));
  assert.equal((enqueues.match(/_tenantScope: \{ id: scope\.id, slug: scope\.slug \}/g) || []).length, 2);
  assert.equal((enqueues.match(/assetVariantExecutionScope\(session\)/g) || []).length, 2);
  const worker = assetVariantSource.slice(assetVariantSource.indexOf("async function runAssetVariantJob"), assetVariantSource.indexOf("function createAssetVariantJobProgress"));
  assert.match(worker, /SELECT id, slug FROM tenants WHERE slug = 'default' AND status = 'active'/);
  assert.match(worker, /storedScope\.slug !== "default"/);
  assert.doesNotMatch(worker, /INSERT.*tenant_members|UPDATE.*tenant_members/);
});

test("private tail schema migration is explicit, preserves legacy NULL ownership and validates type", () => {
  const migration = readFileSync(new URL("../scripts/migrate-tenant-asset-variant-config.mjs", import.meta.url), "utf8");
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /Apply mode requires --mysql-admin-socket/);
  assert.match(migration, /tenant_id BIGINT UNSIGNED NULL/);
  assert.match(migration, /tenant_id, shop_id, category, vehicle_model, status/);
  assert.doesNotMatch(migration, /UPDATE asset_tail_templates/);
  assert.match(migration, /tenantColumn\.Null !== "YES"/);
});
