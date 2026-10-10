import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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

test("logistics rule routes and service derive ownership from authenticated tenant", () => {
  const routes = read("../src/server/routes/operations.js");
  const service = read("../src/services/mysql-cutover.js");
  const tenant = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "logistics-rules"]],
    ["POST", ["api", "logistics-rules"]],
    ["PUT", ["api", "logistics-rules", "12"]],
    ["DELETE", ["api", "logistics-rules", "12"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "logistics-rules", "12"]],
    ["POST", ["api", "logistics-rules", "12"]],
    ["PUT", ["api", "logistics-rules", "other"]],
    ["DELETE", ["api", "logistics-rules"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, false);
  assert.match(routes, /services\.logisticsRules\(tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.createLogisticsRule\(await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.updateLogisticsRule\(Number\(parts\[2\]\), await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.deleteLogisticsRule\(Number\(parts\[2\]\), tenantIdFromRequest\(req\)\)/);
  assert.match(service, /function logisticsTenantScopeMysql\(tenantId = "admin", alias = "l"\)/);
  assert.match(service, /logisticsRulesMysql\(tenantId = "admin"\)/);
  assert.match(service, /createLogisticsRuleMysql\(body = \{\}, tenantId = "admin"\)/);
  assert.match(service, /updateLogisticsRuleMysql\(id, body = \{\}, tenantId = "admin"\)/);
  assert.match(service, /deleteLogisticsRuleMysql\(id, tenantId = "admin"\)/);
  assert.match(service, /incrementLogisticsRuleUsageMysql\(id, tenantId = "admin"\)/);
  assert.match(service, /物流规则企业隔离暂不可用：logistics_fee_rules\.tenant_id 尚未迁移/);
});

test("default logistics matching and historical version selection cannot choose another tenant rule", () => {
  const service = read("../src/services/mysql-cutover.js");
  assert.match(service, /const tenantScope = await logisticsTenantScopeMysql\(tenantId, "l"\);[\s\S]*?FROM logistics_fee_rules l\s+WHERE l\.enabled != 0 AND \$\{tenantScope\.sql\}/);
  assert.match(service, /const defaultScope = hasTenantColumn\s+\? await logisticsTenantScopeMysql\("admin", "candidate"\)\s+: \{ sql: "1 = 1", params: \[\] \};[\s\S]*?WHERE \$\{defaultScope\.sql\}/);
  assert.match(service, /rule\.tenant_id <=> p\.tenant_id/);
  assert.match(service, /WHERE selected\.id = \?[\s\S]*?AND selected\.tenant_id <=> \?/);
  assert.match(service, /AND candidate\.tenant_id <=> selected\.tenant_id/);
});
