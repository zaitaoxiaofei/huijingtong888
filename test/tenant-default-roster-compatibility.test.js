import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import mysql from "mysql2/promise";
import { getRoles } from "../src/shared/permissions.js";
import { assertTenantQuotaAvailable } from "../src/services/tenant-quotas.js";
import { effectiveTenantMembershipRole } from "../src/services/tenant-membership-authority.js";

const source = readFileSync(new URL("../src/services/tenants.js", import.meta.url), "utf8").replaceAll("export ", "");
function service(query, executeTransaction) {
  const context = vm.createContext({ Number, String, Date, Object, Array, Map, Set, JSON,
    getRoles, effectiveTenantMembershipRole, assertTenantQuotaAvailable,
    ensureTenantSchemaMysql: async () => {}, mysqlQuery: query, withMysqlTransaction: executeTransaction,
    text: (value, max = 255) => String(value || "").trim().slice(0, max)
  });
  for (const [start, end] of [
    ["function subscriptionState(", "async function listTenantsMysql("],
    ["async function tenantMembersMysql(", "async function switchSessionTenantMysql("]
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  return context;
}

test("current-enterprise membership selectors expose effective legacy default authority", async () => {
  const membershipRows = [
    { id: 1, slug: "default", status: "active", subscription_status: "active", role: "owner", business_roles_json: null, legacy_role: "admin", roles_json: '["packing"]' },
    { id: 2, slug: "customer-a", status: "active", subscription_status: "active", role: "owner", business_roles_json: null, legacy_role: "packing", roles_json: null }
  ];
  const api = service(async () => membershipRows);
  const memberships = await api.tenantMembershipsMysql(10);
  assert.equal(memberships[0].role, "member");
  assert.equal(memberships[1].role, "owner");
  assert.ok(!("roles_json" in memberships[0]));
  assert.equal((await api.resolveActiveTenantMysql(10, 1)).role, "member");
});

test("default member directory does not display an automatic owner as a reviewed enterprise owner", async () => {
  const api = service(async () => [{ tenant_id: 1, person_id: 10, tenant_slug: "default", role: "owner", business_roles_json: null, business_role: "packing", roles_json: null }]);
  const [member] = await api.tenantMembersMysql(1);
  assert.equal(member.role, "member");
  assert.equal(member.business_role, "packing");
});

test("explicit platform membership saves materialize duties and preserve existing enterprise duties in real MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires an explicitly isolated MySQL named pipe; only a random fixture database is used."
}, async () => {
  const database = `ozon_default_roster_test_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root" });
  let created = false;
  try {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    created = true;
    await connection.changeUser({ database });
    for (const sql of [
      "CREATE TABLE people (id BIGINT PRIMARY KEY, name VARCHAR(64), username VARCHAR(64), avatar_url VARCHAR(255), role VARCHAR(64), roles_json JSON NULL, active TINYINT DEFAULT 1)",
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), name VARCHAR(80), status VARCHAR(32), plan_code VARCHAR(32), subscription_status VARCHAR(32), subscription_expires_at DATETIME NULL, member_limit INT NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, role VARCHAR(32), active TINYINT, business_roles_json JSON NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(tenant_id,person_id))"
    ]) await connection.execute(sql);
    await connection.execute("INSERT INTO people (id, role, roles_json) VALUES (10, 'admin', JSON_ARRAY('packing')), (20, 'admin', JSON_ARRAY('admin')), (30, 'operations', JSON_ARRAY('operations'))");
    await connection.execute("INSERT INTO tenants (id,slug,status,subscription_status,member_limit) VALUES (1,'default','active','active',NULL), (2,'customer-a','active','active',NULL)");
    await connection.execute("INSERT INTO tenant_members (tenant_id,person_id,role,active) VALUES (1,10,'owner',1),(1,20,'owner',1),(2,10,'owner',1)");
    const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
    const api = service(query, async action => {
      await connection.beginTransaction();
      try { const result = await action(connection); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
    });
    assert.equal((await api.resolveActiveTenantMysql(10, 1)).role, "member");
    assert.equal((await api.resolveActiveTenantMysql(20, 1)).role, "owner");
    assert.equal((await api.resolveActiveTenantMysql(10, 2)).role, "owner");
    assert.equal((await api.tenantMembersMysql(1))[0].role, "member");
    await api.upsertTenantMemberMysql(1, { person_id: 10, role: "admin" });
    assert.equal((await api.resolveActiveTenantMysql(10, 1)).role, "admin");
    assert.deepEqual((await query("SELECT business_roles_json FROM tenant_members WHERE tenant_id=1 AND person_id=10"))[0].business_roles_json, ["packing"]);
    await connection.execute("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=1 AND person_id=10");
    await api.upsertTenantMemberMysql(1, { person_id: 10, role: "owner" });
    assert.deepEqual((await query("SELECT business_roles_json FROM tenant_members WHERE tenant_id=1 AND person_id=10"))[0].business_roles_json, ["procurement"]);
    assert.equal((await api.resolveActiveTenantMysql(10, 1)).role, "owner");
  } finally {
    if (created) await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await connection.end();
  }
});
