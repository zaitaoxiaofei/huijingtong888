import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import mysql from "mysql2/promise";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { createOperationsRoutes, handleOperationsRestRoute } from "../src/server/routes/operations.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("logistics rule schema and explicit migration preserve unattributed legacy rows", () => {
  const schema = read("../scripts/init-mysql-schema.mjs");
  const migration = read("../scripts/migrate-tenant-logistics-rules.mjs");
  const packageJson = read("../package.json");
  const table = schema.match(/CREATE TABLE IF NOT EXISTS logistics_fee_rules \(([\s\S]*?)\) ENGINE=InnoDB/);
  assert.ok(table, "logistics fee rules schema exists");
  assert.match(table[1], /tenant_id BIGINT UNSIGNED NULL/);
  assert.match(table[1], /idx_logistics_rules_tenant_enabled_version \(tenant_id, enabled, version_group_id, effective_from, id\)/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /existing logistics rules remain NULL and visible only to the default tenant/);
  assert.doesNotMatch(migration, /UPDATE logistics_fee_rules SET tenant_id/);
  assert.match(packageJson, /"db:migrate:tenant-logistics-rules": "node scripts\/migrate-tenant-logistics-rules\.mjs"/);
});

test("logistics writes are platform-only while the exact tariff GET remains available to enterprise business users", () => {
  const platform = { personId: 7, platform_role: "super_admin", roles: [] };
  const owner = { personId: 8, roles: ["admin"], tenant: { id: 42, slug: "company-a", role: "owner" } };
  for (const [method, parts] of [
    ["GET", ["api", "logistics-rules"]],
    ["POST", ["api", "logistics-rules"]],
    ["PUT", ["api", "logistics-rules", "12"]],
    ["DELETE", ["api", "logistics-rules", "12"]]
  ]) {
    assert.equal(tenantIsolationDecision(platform, parts, method).allowed, true);
    assert.equal(authorizeApiRequest({ method, _session: platform }, parts).allowed, true);
    assert.equal(authorizeApiRequest({ method, _session: owner }, parts).allowed, method === "GET");
    assert.equal(authorizeApiRequest({ method, _session: { ...owner, tenant: { ...owner.tenant, id: 1, slug: "default" } } }, parts).allowed, method === "GET");
    assert.equal(tenantIsolationDecision(owner, parts, method).allowed, method === "GET");
  }
  const packing = { roles: ["packing"], tenant: { id: 1, slug: "default", role: "member" } };
  for (const [method, parts] of [["HEAD", ["api", "logistics-rules"]], ["GET", ["api", "logistics-rules", "12"]], ["GET", ["api", "logistics-rules", "changes"]]]) {
    assert.equal(authorizeApiRequest({ method, _session: packing }, parts).allowed, false);
  }
  assert.equal(authorizeApiRequest({ method: "GET", _session: { roles: ["packing"] } }, ["api", "logistics-rules"]).allowed, false);
});

test("platform-only and switched-platform logistics operations always use the canonical default scope", async () => {
  const calls = [];
  const services = {
    logisticsRules: async scope => { calls.push(["list", scope]); return [{ id: 12, tenant_id: 1, name: "Common tariff" }]; },
    createLogisticsRule: async (...args) => { calls.push(["create", ...args]); return { id: 13 }; },
    updateLogisticsRule: async (...args) => { calls.push(["update", ...args]); return { ok: true }; },
    deleteLogisticsRule: async (...args) => { calls.push(["delete", ...args]); return { ok: true }; }
  };
  const readJson = async req => req.body || {};
  const routes = createOperationsRoutes({ services, readJson });
  const platform = { personId: 7, platform_role: "super_admin" };
  const req = { _session: platform, headers: { "x-tenant-id": "42" }, body: { name: "Common tariff" } };
  const rows = await routes["GET /api/logistics-rules"](req);
  assert.deepEqual(rows, [{ id: 12, name: "Common tariff" }]);
  await routes["GET /api/logistics-rules"]({ ...req, _session: { ...platform, tenant: { id: 42, slug: "company-a" } } });
  await routes["POST /api/logistics-rules"](req);
  await handleOperationsRestRoute({ req: { ...req, method: "PUT" }, parts: ["api", "logistics-rules", "12"], services, readJson, json: (_res, data) => data });
  await handleOperationsRestRoute({ req: { ...req, method: "DELETE" }, parts: ["api", "logistics-rules", "12"], services, readJson, json: (_res, data) => data });
  assert.deepEqual(calls, [
    ["list", "admin"], ["list", "admin"], ["create", req.body, "admin"],
    ["update", 12, req.body, "admin"], ["delete", 12, "admin"]
  ]);
});

test("logistics write guards reject enterprise administrators and platform selector tampering before service calls", async () => {
  let called = 0;
  const services = Object.fromEntries(["logisticsRules", "createLogisticsRule", "updateLogisticsRule", "deleteLogisticsRule"].map(name => [name, async () => { called += 1; return []; }]));
  const readJson = async req => req.body || {};
  const routes = createOperationsRoutes({ services, readJson });
  const platform = { personId: 7, platform_role: "super_admin" };
  const owner = { personId: 8, roles: ["admin"], tenant: { id: 42, slug: "company-a", role: "owner" } };
  for (const action of [
    () => routes["GET /api/logistics-rules"]({ _session: { roles: ["packing"] } }),
    () => routes["POST /api/logistics-rules"]({ _session: owner }),
    () => handleOperationsRestRoute({ req: { method: "PUT", _session: owner }, parts: ["api", "logistics-rules", "12"], services, readJson }),
    () => handleOperationsRestRoute({ req: { method: "DELETE", _session: owner }, parts: ["api", "logistics-rules", "12"], services, readJson })
  ]) await assert.rejects(action(), { statusCode: 403 });
  for (const key of ["tenant_id", "tenantId"]) {
    await assert.rejects(routes["GET /api/logistics-rules"]({ _session: platform, query: { [key]: 42 } }), { statusCode: 400 });
    await assert.rejects(routes["GET /api/logistics-rules"]({ _session: platform, url: `/api/logistics-rules?${key}=42` }), { statusCode: 400 });
    await assert.rejects(routes["POST /api/logistics-rules"]({ _session: platform, body: { [key]: 42 } }), { statusCode: 400 });
    await assert.rejects(handleOperationsRestRoute({ req: { method: "PUT", _session: platform, body: { [key]: 42 } }, parts: ["api", "logistics-rules", "12"], services, readJson }), { statusCode: 400 });
    await assert.rejects(handleOperationsRestRoute({ req: { method: "DELETE", _session: platform }, url: new URL(`http://localhost/api/logistics-rules/12?${key}=42`), parts: ["api", "logistics-rules", "12"], services, readJson }), { statusCode: 400 });
  }
  assert.equal(called, 0);
  for (const parts of [["api", "logistics-rules", "other"], ["api", "logistics-rules", "12", "other"]]) {
    assert.equal(await handleOperationsRestRoute({ req: { method: "PUT", _session: platform }, parts, services, readJson }), false);
  }
});

test("business tariff reads ignore forged customer selectors and never invoke the management service", async () => {
  const reads = [];
  const tariffs = [{ id: 1, name: "Common tariff", carrier: "OTHER", enabled: 0, filter_keywords: "cargo" }];
  const routes = createOperationsRoutes({ services: {
    logisticsRules: async () => { throw new Error("Business users cannot invoke the management reader"); }
  }, readJson: async () => ({}), readBusinessLogisticsRules: async (...args) => { reads.push(args); return tariffs; } });
  for (const tenant of [{ id: 1, slug: "default" }, { id: 42, slug: "company-a" }]) {
    const session = { personId: 7, roles: ["packing"], tenant: { ...tenant, role: "member" } };
    const req = { method: "GET", _session: session, query: { tenant_id: 99, tenantId: 99 }, headers: { "x-tenant-id": "99" }, url: "/api/logistics-rules?tenant_id=99" };
    assert.equal(tenantIsolationDecision(session, ["api", "logistics-rules"], "GET").allowed, true);
    assert.equal(authorizeApiRequest(req, ["api", "logistics-rules"]).allowed, true);
    assert.deepEqual(await routes["GET /api/logistics-rules"](req), tariffs);
  }
  assert.deepEqual(reads, [[], []], "customer selectors must never enter the canonical tariff query");
});

test("default packing inventory and selection dictionary bootstraps retain the business tariff GET", async () => {
  const session = { personId: 7, roles: ["packing"], tenant: { id: 1, slug: "default", role: "member" } };
  const tariff = { id: 12, name: "Common tariff", carrier: "OTHER", enabled: 1, filter_keywords: "cargo", version_group_id: 12 };
  let tariffReads = 0;
  const routes = createOperationsRoutes({ services: {}, readJson: async () => ({}), readBusinessLogisticsRules: async () => { tariffReads++; return [tariff]; } });
  const apiClient = { async get(path) {
    if (path === "/api/logistics-rules") {
      assert.equal(authorizeApiRequest({ method: "GET", _session: session }, ["api", "logistics-rules"]).allowed, true);
      return routes["GET /api/logistics-rules"]({ _session: session });
    }
    if (path === "/api/people") return [{ id: 7, active: 1 }];
    if (path.startsWith("/api/suppliers")) return [{ id: 3 }];
    throw new Error(`Unexpected fixture API: ${path}`);
  } };
  for (const [path, start, end, action] of [
    ["../frontend/admin/views/inventory/InventoryProductsPage.vue", "function loadInventoryDictionaries()", "\nconst productCreateDialogRef", "loadInventoryDictionaries"],
    ["../frontend/admin/views/selection/SelectionView.vue", "async function loadSelectionMetaData(", "\nasync function refreshSelectionSummary", "loadSelectionMetaData"]
  ]) {
    const source = read(path);
    const state = { shops: [], people: [], suppliers: [], logisticsRules: [] };
    const context = vm.createContext({ state, apiClient, isTenantScoped: { value: false }, loadShopDictionary: async () => [{ id: 1 }], normalizePagedRows: rows => rows,
      ElMessage: { warning(message) { assert.fail(message); } } });
    vm.runInContext(`let dictionaryLoaded = false; let dictionaryLoading = null;\n${source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))}`, context);
    await context[action]();
    assert.equal(state.logisticsRules[0].id, tariff.id);
    assert.equal(state.logisticsRules[0].filter_keywords, "cargo");
    assert.equal(state.people[0].id, 7);
    assert.equal(state.suppliers[0].id, 3);
  }
  assert.equal(tariffReads, 2);
});

test("logistics storage preserves existing ownership and historical default matching", () => {
  const service = read("../src/services/mysql-cutover.js");
  assert.match(service, /function logisticsTenantScopeMysql\(tenantId = "admin", alias = "l"\)/);
  assert.match(service, /logisticsRulesMysql\(tenantId = "admin"\)/);
  assert.match(service, /createLogisticsRuleMysql\(body = \{\}, tenantId = "admin"\)/);
  assert.match(service, /updateLogisticsRuleMysql\(id, body = \{\}, tenantId = "admin"\)/);
  assert.match(service, /deleteLogisticsRuleMysql\(id, tenantId = "admin"\)/);
  assert.match(service, /incrementLogisticsRuleUsageMysql\(id, tenantId = "admin"\)/);
  assert.match(service, /物流规则企业隔离暂不可用：logistics_fee_rules\.tenant_id 尚未迁移/);
});

test("shared pricing projects only public tariff fields from legacy and canonical platform scope", async () => {
  const source = read("../src/services/pricing-logistics-rules.js");
  let query;
  const context = vm.createContext({ mysqlQuery: async sql => { query = sql; return []; } });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replaceAll("export async function", "async function"), context);
  await context.sharedPricingLogisticsRules();
  assert.match(query, /tenant_id IS NULL OR tenant_id = \(SELECT id FROM tenants WHERE slug = 'default'/);
  assert.match(query, /carrier IN \('GUOO', 'CEL', 'OGL'\) AND enabled != 0/);
  const projection = query.slice(query.indexOf("SELECT"), query.indexOf("FROM logistics_fee_rules"));
  assert.doesNotMatch(projection, /\*|usage_count|last_used_at|tenant_id|note|person|product|order/i);
  assert.match(projection, /base_fee_cny, per_gram_cny, per_ticket_cny/);
});

test("business tariff SQL projects every carrier and enabled status without management or ownership fields", async () => {
  let query;
  const context = vm.createContext({ mysqlQuery: async sql => { query = sql; return []; } });
  vm.runInContext(read("../src/services/pricing-logistics-rules.js").replace(/^import .*;\r?\n/gm, "").replaceAll("export async function", "async function"), context);
  await context.businessLogisticsRules();
  assert.match(query, /tenant_id IS NULL OR tenant_id = \(SELECT id FROM tenants WHERE slug = 'default'/);
  const projection = query.slice(query.indexOf("SELECT"), query.indexOf("FROM logistics_fee_rules"));
  assert.doesNotMatch(projection, /\*|usage_count|last_used_at|tenant_id|note|person|product|order/i);
  for (const field of ["id", "name", "carrier", "channel", "mode", "min_weight_g", "max_weight_g", "min_price_rub", "max_price_rub", "base_fee_cny", "per_gram_cny", "per_ticket_cny", "enabled", "version_group_id", "effective_from", "effective_to", "filter_keywords"]) {
    assert.match(projection, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(query, /carrier IN|enabled\s*(?:!=|=)\s*[01]/);
});

test("shared tariff SQL includes canonical platform rows and excludes historical customer rules in isolated MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Set TENANT_TEST_MYSQL_SOCKET to an isolated MySQL instance; only a random fixture database is created and dropped."
}, async () => {
  const database = `ozon_tariff_test_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root" });
  let created = false;
  try {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await connection.changeUser({ database });
    await connection.execute("CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80))");
    await connection.execute(`CREATE TABLE logistics_fee_rules (
      id BIGINT PRIMARY KEY, tenant_id BIGINT NULL, name VARCHAR(255) DEFAULT 'Tariff', carrier VARCHAR(32), channel VARCHAR(32) DEFAULT 'standard',
      mode VARCHAR(32) DEFAULT 'per_gram', min_weight_g INT DEFAULT 0, max_weight_g INT DEFAULT 1000, min_price_rub INT DEFAULT 0,
      max_price_rub INT DEFAULT 10000, base_fee_cny DECIMAL(10,4) DEFAULT 1, per_gram_cny DECIMAL(10,4) DEFAULT 0.1,
      per_ticket_cny DECIMAL(10,4) DEFAULT 2, enabled TINYINT DEFAULT 1, version_group_id BIGINT DEFAULT 1,
      effective_from DATETIME DEFAULT '2026-01-01 00:00:00', effective_to DATETIME NULL, filter_keywords TEXT, usage_count INT DEFAULT 99, note TEXT)`);
    await connection.execute("INSERT INTO tenants VALUES (17, 'default'), (42, 'customer-a')");
    await connection.execute(`INSERT INTO logistics_fee_rules (id, tenant_id, carrier, enabled, note) VALUES
      (1, NULL, 'GUOO', 1, 'private note'), (2, 17, 'CEL', 1, 'private note'), (3, 42, 'OGL', 1, 'customer note'),
      (4, 17, 'OGL', 0, 'disabled'), (5, NULL, 'OTHER', 1, 'other')`);
    const source = read("../src/services/pricing-logistics-rules.js");
    const context = vm.createContext({ mysqlQuery: async sql => (await connection.execute(sql))[0] });
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replaceAll("export async function", "async function"), context);
    const rows = await context.sharedPricingLogisticsRules();
    assert.deepEqual(rows.map(row => row.id).sort(), [1, 2]);
    assert.ok(rows.every(row => !["tenant_id", "note", "usage_count"].some(key => Object.hasOwn(row, key))));
    const businessRows = await context.businessLogisticsRules();
    assert.deepEqual(businessRows.map(row => row.id).sort(), [1, 2, 4, 5]);
    assert.equal(businessRows.find(row => row.id === 4).enabled, 0);
    assert.equal(businessRows.find(row => row.id === 5).carrier, "OTHER");
    assert.ok(businessRows.every(row => !["tenant_id", "note", "usage_count", "last_used_at"].some(key => Object.hasOwn(row, key))));
    await connection.execute("UPDATE logistics_fee_rules SET enabled = 1 WHERE id = 4");
    assert.deepEqual((await context.sharedPricingLogisticsRules()).map(row => row.id).sort(), [1, 2, 4]);
    assert.equal((await connection.execute("SELECT tenant_id FROM logistics_fee_rules WHERE id = 3"))[0][0].tenant_id, 42);
  } finally {
    if (created) await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await connection.end();
  }
});

test("default logistics matching and historical version selection cannot choose another tenant rule", async () => {
  const service = read("../src/services/mysql-cutover.js");
  assert.match(service, /const scope = await logisticsTenantScopeMysql\(tenantId, alias\);[\s\S]*?scope\.sql} OR \(\$\{alias}\.tenant_id IS NULL AND \$\{alias}\.carrier = 'OGL'\)/);
  assert.match(service, /const tenantScope = await readableLogisticsTenantScopeMysql\(tenantId, "l"\);[\s\S]*?FROM logistics_fee_rules l\s+WHERE l\.enabled != 0 AND \$\{tenantScope\.sql\}/);
  const scopeHelpers = service.slice(service.indexOf('async function logisticsTenantScopeMysql('), service.indexOf('function logisticsProductTenantPredicateMysql('));
  const matching = service.slice(service.indexOf('async function actualOrderLogisticsRuleMysql('), service.indexOf('async function productForProfitEstimateMysql('));
  const calls = [];
  let hasTenantColumn = true;
  const context = vm.createContext({
    resolveShopTenantIdMysql: async value => value === 'admin' ? 17 : Number(value),
    isDefaultShopTenantMysql: async id => id === 17,
    mysqlSchemaColumnExists: async () => hasTenantColumn,
    resolveOrderFreightDescriptor: () => ({ carrier: 'CEL', channel: 'standard', serviceClass: 'Small' }),
    normalizeMysqlDateTime: value => value,
    mysqlQueryOne: async (sql, params) => { calls.push({ sql, params: Array.from(params) }); return null; }
  });
  vm.runInContext(`${scopeHelpers}\n${matching}`, context);
  for (const [tenantId, expectedId, defaultTenant] of [['admin', 17, true], [17, 17, true], [42, 42, false], [43, 43, false]]) {
    const scope = await context.readableLogisticsTenantScopeMysql(tenantId, 'candidate');
    assert.deepEqual(Array.from(scope.params), [expectedId]);
    assert.equal(scope.sql, `((candidate.tenant_id = ?${defaultTenant ? ' OR candidate.tenant_id IS NULL' : ''}) OR (candidate.tenant_id IS NULL AND candidate.carrier = 'OGL'))`);
    await context.actualOrderLogisticsRuleMysql({}, '2026-10-01 00:00:00', { tenant_id: tenantId === 'admin' ? null : tenantId });
    const call = calls.at(-1);
    assert.ok(call.sql.includes(`WHERE ${scope.sql}`));
    assert.deepEqual(call.params, [expectedId, 'CEL', 'standard', 'Small', '2026-10-01 00:00:00', '2026-10-01 00:00:00']);
  }
  hasTenantColumn = false;
  const before = calls.length;
  await assert.rejects(context.actualOrderLogisticsRuleMysql({}, '2026-10-01 00:00:00', { tenant_id: 42 }), { statusCode: 503 });
  await assert.rejects(context.readableLogisticsTenantScopeMysql('admin'), { statusCode: 503 });
  assert.equal(calls.length, before, 'missing ownership schema must fail before an unscoped tariff query');
  assert.match(service, /rule\.tenant_id <=> p\.tenant_id/);
  assert.match(service, /WHERE selected\.id = \?[\s\S]*?AND \(selected\.tenant_id <=> \? OR \(selected\.tenant_id IS NULL AND selected\.carrier = 'OGL'\)\)/);
  assert.match(service, /AND candidate\.tenant_id <=> selected\.tenant_id/);
});
