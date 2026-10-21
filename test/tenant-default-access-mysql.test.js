import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { bootstrapDefaultTenantAccessMysql } from "../src/services/tenant-default-access.js";
import { inspectDefaultTenantMemberships, membershipRepairLogSchema, repairDefaultTenantMemberships } from "../scripts/lib/default-tenant-membership-repair.mjs";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
async function transaction(connection, action) {
  await connection.beginTransaction();
  try {
    const result = await action(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

test("default membership startup and reviewed repair against a disposable MySQL database", {
  skip: !socketPath && "Set TENANT_TEST_MYSQL_SOCKET to an isolated MySQL instance; the test creates and drops only its own fixture database."
}, async t => {
  const database = `ozon_saas_test_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath, user: "root" });
  const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
  let created = false;
  try {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    await connection.changeUser({ database });
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT UNSIGNED PRIMARY KEY, slug VARCHAR(80) UNIQUE, status VARCHAR(32) NOT NULL DEFAULT 'active') ENGINE=InnoDB",
      "CREATE TABLE people (id BIGINT UNSIGNED PRIMARY KEY, role VARCHAR(64), roles_json JSON NULL, active TINYINT NOT NULL DEFAULT 1) ENGINE=InnoDB",
      "CREATE TABLE tenant_members (tenant_id BIGINT UNSIGNED, person_id BIGINT UNSIGNED, role VARCHAR(32), active TINYINT NOT NULL DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (tenant_id, person_id)) ENGINE=InnoDB",
      "CREATE TABLE platform_grants (person_id BIGINT UNSIGNED PRIMARY KEY, role VARCHAR(32) NOT NULL, active TINYINT NOT NULL DEFAULT 1) ENGINE=InnoDB",
      "CREATE TABLE sessions (token VARCHAR(80) PRIMARY KEY, person_id BIGINT UNSIGNED, active_tenant_id BIGINT UNSIGNED NULL) ENGINE=InnoDB",
      membershipRepairLogSchema
    ]) await connection.execute(sql);
    await connection.execute("INSERT INTO tenants (id, slug) VALUES (1, 'default'), (2, 'customer-a'), (3, 'customer-b')");
    await connection.execute(`INSERT INTO people (id, role, roles_json, active) VALUES
      (1, 'admin', NULL, 1), (2, 'packing', NULL, 1), (3, 'operations', NULL, 1),
      (4, 'admin', JSON_ARRAY('packing'), 1), (5, 'technical', JSON_ARRAY('technical', 'admin'), 1),
      (6, 'admin', NULL, 0), (7, 'operations', NULL, 1), (8, 'packing', NULL, 1)`);
    await connection.execute("INSERT INTO tenant_members (tenant_id, person_id, role, active) VALUES (1, 2, 'member', 1), (1, 8, 'member', 0), (2, 3, 'owner', 1), (3, 4, 'owner', 1)");
    await connection.execute("INSERT INTO platform_grants VALUES (1, 'super_admin', 1), (4, 'super_admin', 0)");
    await connection.execute("INSERT INTO sessions VALUES ('legacy-staff', 2, NULL), ('legacy-customer', 3, NULL), ('customer-a', 3, 2), ('disabled-staff', 8, NULL), ('platform-only', 1, NULL)");

    await t.test("startup never creates business or platform memberships and binds only existing active members", async () => {
      await transaction(connection, bootstrapDefaultTenantAccessMysql);
      assert.deepEqual(await query("SELECT person_id, role, active FROM tenant_members WHERE tenant_id = 1 ORDER BY person_id"), [
        { person_id: 2, role: "member", active: 1 }, { person_id: 8, role: "member", active: 0 }
      ]);
      const sessions = await query("SELECT token, active_tenant_id FROM sessions ORDER BY token");
      assert.deepEqual(sessions.map(row => [row.token, row.active_tenant_id]), [["customer-a", 2], ["disabled-staff", null], ["legacy-customer", null], ["legacy-staff", 1], ["platform-only", null]]);
    });

    await t.test("later customer and unassigned accounts remain outside default after repeated and concurrent startup", async () => {
      await connection.execute("INSERT INTO tenant_members (tenant_id, person_id, role) VALUES (2, 7, 'member')");
      await connection.execute("INSERT INTO people (id, role) VALUES (9, 'operations')");
      await connection.execute("INSERT INTO platform_grants VALUES (9, 'super_admin', 1)");
      const second = await mysql.createConnection({ socketPath, user: "root", database });
      try {
        await Promise.all([transaction(connection, bootstrapDefaultTenantAccessMysql), transaction(second, bootstrapDefaultTenantAccessMysql)]);
      } finally {
        await second.end();
      }
      const rows = await query("SELECT person_id FROM tenant_members WHERE tenant_id = 1 AND person_id IN (1, 3, 4, 5, 6, 7, 9)");
      assert.deepEqual(rows, []);
    });

    await t.test("dry-run only reports overlaps for review and does not change membership or sessions", async () => {
      await connection.execute("INSERT INTO tenant_members (tenant_id, person_id, role) VALUES (1, 1, 'owner'), (1, 3, 'owner'), (1, 4, 'owner'), (1, 5, 'owner'), (2, 1, 'member'), (2, 5, 'member')");
      await connection.execute("INSERT INTO sessions VALUES ('mistaken-default-a', 3, 1), ('mistaken-default-b', 4, 1), ('customer-b', 4, 3)");
      const statements = [];
      const report = await inspectDefaultTenantMemberships(async (sql, params) => { statements.push(sql); return query(sql, params); });
      assert.equal(report.platform_grants_schema_ready, true);
      assert.deepEqual(report.review_candidates.map(row => row.person_id), [3, 4, 5]);
      assert.ok(statements.every(sql => sql.trimStart().startsWith("SELECT")));
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 3"))[0].active, 1);
      assert.equal((await query("SELECT COUNT(*) AS total FROM sessions WHERE person_id = 3"))[0].total, 3);
    });

    await t.test("invalid or platform-admin repair selection rolls back without changing valid selections", async () => {
      await assert.rejects(transaction(connection, conn => repairDefaultTenantMemberships(conn, [3, 1], "test review")), /Platform administrators/);
      await assert.rejects(transaction(connection, conn => repairDefaultTenantMemberships(conn, [3, 2], "test review")), /retain an active membership/);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 3"))[0].active, 1);
      assert.equal((await query("SELECT COUNT(*) AS total FROM tenant_membership_repair_log"))[0].total, 0);
    });

    await t.test("explicit repair revokes only reviewed default access and records the reason", async () => {
      const result = await transaction(connection, conn => repairDefaultTenantMemberships(conn, [3], "Reviewed accidental default membership"));
      assert.equal(result.deactivated_memberships, 1);
      assert.equal(result.revoked_sessions, 2);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 3"))[0].active, 0);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 2 AND person_id = 3"))[0].active, 1);
      assert.deepEqual((await query("SELECT token FROM sessions WHERE person_id = 3")).map(row => row.token), ["customer-a"]);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 4"))[0].active, 1);
      assert.deepEqual(await query("SELECT tenant_id, person_id, previous_role, reason FROM tenant_membership_repair_log"), [
        { tenant_id: 1, person_id: 3, previous_role: "owner", reason: "Reviewed accidental default membership" }
      ]);
    });

    await t.test("legacy admin business duties do not substitute for an explicit platform grant", async () => {
      const result = await transaction(connection, conn => repairDefaultTenantMemberships(conn, [5], "Reviewed legacy technical/admin overlap"));
      assert.equal(result.deactivated_memberships, 1);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 5"))[0].active, 0);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 2 AND person_id = 5"))[0].active, 1);
      assert.equal((await query("SELECT active FROM platform_grants WHERE person_id = 1"))[0].active, 1);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 1"))[0].active, 1);
    });

    await t.test("an unmigrated platform-grant schema allows read-only inspection and blocks repair", async () => {
      await connection.execute("RENAME TABLE platform_grants TO fixture_platform_grants");
      try {
        const report = await inspectDefaultTenantMemberships(query);
        assert.equal(report.platform_grants_schema_ready, false);
        await assert.rejects(transaction(connection, conn => repairDefaultTenantMemberships(conn, [4], "Reviewed overlap")), /platform_grants schema/);
        assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 4"))[0].active, 1);
      } finally {
        await connection.execute("RENAME TABLE fixture_platform_grants TO platform_grants");
      }
    });

    await t.test("restart never restores revoked customer or disabled staff access", async () => {
      await transaction(connection, bootstrapDefaultTenantAccessMysql);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 3"))[0].active, 0);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 5"))[0].active, 0);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 1 AND person_id = 8"))[0].active, 0);
      await assert.rejects(transaction(connection, conn => repairDefaultTenantMemberships(conn, [3], "Repeated repair")), /active default-enterprise membership/);
    });
  } finally {
    if (created) await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await connection.end();
  }
});
