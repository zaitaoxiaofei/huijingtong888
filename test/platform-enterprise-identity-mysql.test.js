import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { hashPassword, verifyPassword } from "../src/auth-password.js";
import { applyIdentitySeparationMysql, IDENTITY_MIGRATION_LOG_SCHEMA_SQL, inspectIdentitySeparation } from "../scripts/lib/platform-enterprise-identity-migration.mjs";
import { loadIdentityMemberServices } from "./helpers/identity-member-service.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = personId => ({ personId, tenant: { id: 1, slug: "enterprise-a", role: "owner" } });
const fixturePassword = "Synthetic!Fixture77";
const newPerson = suffix => ({ name: `Fixture employee ${suffix}`, username: `fixture-${suffix}`, password: "New!SyntheticPass77", tenant_role: "member", business_roles: ["packing"] });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function migrationManifest() {
  return { version: 1, reviewed_by_person_id: 10, reason: "Fixture reviewed identity separation", accounts: [
    { person_id: 10, platform_role: "super_admin", memberships: [{ tenant_id: 1, role: "owner", active: 1, business_roles: ["operations"] }] },
    { person_id: 43, platform_role: "super_admin", memberships: [] },
    { person_id: 20, platform_role: null, memberships: [{ tenant_id: 1, role: "member", active: 1, business_roles: ["packing"] }] }
  ] };
}

test("platform grants, enterprise people and reviewed identity migration against disposable MySQL", {
  skip: !socketPath && "Set TENANT_TEST_MYSQL_SOCKET to an isolated instance; only a generated fixture database is created and dropped.",
  timeout: 60000
}, async t => {
  const database = `ozon_identity_test_${randomBytes(8).toString("hex")}`;
  const admin = await mysql.createConnection({ socketPath, user: "root" });
  let pool;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    pool = mysql.createPool({ socketPath, user: "root", database, timezone: "Z", connectionLimit: 6, maxPreparedStatements: 40 });
    const hooks = {};
    const services = loadIdentityMemberServices(pool, hooks);
    const { enterprise, platform, auth, query, transaction } = services;
    for (const sql of [
      `CREATE TABLE tenants (id BIGINT UNSIGNED PRIMARY KEY, slug VARCHAR(80) UNIQUE, status VARCHAR(32) DEFAULT 'active', member_limit INT UNSIGNED NULL,
        name VARCHAR(255) DEFAULT 'Fixture enterprise', plan_code VARCHAR(32) DEFAULT 'yearly', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL) ENGINE=InnoDB`,
      `CREATE TABLE people (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) UNIQUE, username VARCHAR(255) UNIQUE,
        role VARCHAR(64) DEFAULT 'operator', roles_json JSON NULL, avatar_url TEXT, active TINYINT DEFAULT 1, password_hash TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB`,
      `CREATE TABLE tenant_members (tenant_id BIGINT UNSIGNED, person_id BIGINT UNSIGNED, role VARCHAR(32), business_roles_json JSON NULL,
        active TINYINT DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, person_id), KEY idx_tenant_members_person (person_id, active)) ENGINE=InnoDB`,
      `CREATE TABLE sessions (token VARCHAR(80) PRIMARY KEY, person_id BIGINT UNSIGNED, active_tenant_id BIGINT UNSIGNED NULL,
        name VARCHAR(255) DEFAULT '', role VARCHAR(32) DEFAULT '', username VARCHAR(255) NULL,
        expires_at DATETIME DEFAULT '2099-01-01 00:00:00', created_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
      "CREATE TABLE fixture_business_refs (id INT PRIMARY KEY, person_id BIGINT UNSIGNED, payload VARCHAR(80)) ENGINE=InnoDB",
      IDENTITY_MIGRATION_LOG_SCHEMA_SQL
    ]) await query(sql);
    await platform.ensurePlatformGrantSchemaMysql();
    const passwordHash = hashPassword(fixturePassword);
    async function reset() {
      hooks.beforeExecute = undefined;
      hooks.afterExecute = undefined;
      for (const table of ["platform_identity_migration_log", "sessions", "fixture_business_refs", "tenant_members", "platform_grants", "people", "tenants"]) await query(`DELETE FROM ${table}`);
      await query("INSERT INTO tenants (id, slug, status, member_limit) VALUES (1, 'enterprise-a', 'active', 10), (2, 'enterprise-b', 'active', 10)");
      for (const id of [10, 11, 20, 21, 22, 23, 30, 40, 41, 42, 43]) {
        await query("INSERT INTO people (id, name, username, role, roles_json, avatar_url, active, password_hash) VALUES (?, ?, ?, ?, ?, '', ?, ?)",
          [id, id === 43 ? "Health Check" : `Fixture person ${id}`, `fixture-user-${id}`, [10, 43].includes(id) ? "admin" : "operator", null, id === 42 ? 0 : 1, passwordHash]);
      }
      for (const [tenantId, personId, role, active, roles] of [
        [1, 10, "owner", 1, ["operations"]], [1, 11, "admin", 1, ["operations"]], [1, 20, "member", 1, ["packing"]],
        [1, 21, "member", 0, ["packing"]], [1, 22, "member", 1, ["packing"]], [2, 22, "member", 0, ["operations"]],
        [1, 23, "member", 1, ["packing"]], [2, 30, "owner", 1, ["operations"]], [1, 43, "owner", 1, ["operations"]]
      ]) await query("INSERT INTO tenant_members (tenant_id, person_id, role, active, business_roles_json) VALUES (?, ?, ?, ?, ?)", [tenantId, personId, role, active, JSON.stringify(roles)]);
      for (const [id, active] of [[23, 0], [40, 1], [41, 0], [42, 1]]) await query("INSERT INTO platform_grants (person_id, role, active, granted_by_person_id, reason) VALUES (?, 'super_admin', ?, 10, 'Fixture explicit grant')", [id, active]);
      for (const [token, personId, tenantId] of [["owner-a", 10, 1], ["worker-a", 20, 1], ["shared-a", 22, 1], ["shared-b", 22, 2], ["developer-a", 43, 1], ["platform", 40, null]]) {
        await query("INSERT INTO sessions (token, person_id, active_tenant_id) VALUES (?, ?, ?)", [token, personId, tenantId]);
      }
      await query("INSERT INTO fixture_business_refs VALUES (1, 43, 'historical operational record')");
    }
    async function scenario(name, action) {
      await t.test(name, async () => { await reset(); await action(); });
    }

    await scenario("grant lookup and roster ignore legacy admin roles and developer-like names", async () => {
      assert.equal(await platform.getPlatformGrantMysql(10), null);
      assert.equal(await platform.getPlatformGrantMysql(43), null);
      assert.equal((await platform.getPlatformGrantMysql(40)).role, "super_admin");
      assert.equal(await platform.getPlatformGrantMysql(41), null);
      assert.equal(await platform.getPlatformGrantMysql(42), null);
      await assert.rejects(platform.listPlatformAccountsMysql({ personId: 10, roles: ["admin"], platform_role: "super_admin" }), { statusCode: 403 });
      const rows = await platform.listPlatformAccountsMysql({ personId: 40, platform_role: "super_admin" });
      assert.deepEqual(rows.map(row => row.person_id), [40, 42, 23, 41]);
      assert.ok(rows.every(row => row.platform_role === "super_admin" && !("password_hash" in row)));
      await query("UPDATE platform_grants SET active = 0 WHERE person_id = 40");
      await assert.rejects(platform.listPlatformAccountsMysql({ personId: 40, platform_role: "super_admin" }), { statusCode: 403 });
    });

    await scenario("real session SQL permits platform-only login without inventing default membership", async () => {
      const platformSession = await auth.getSessionMysql("platform");
      assert.equal(platformSession.platform_role, "super_admin");
      assert.equal(platformSession.tenant, null);
      assert.equal(platformSession.tenantId, null);
      assert.deepEqual(Array.from(platformSession.roles), []);
      await auth.createSessionMysql({ token: "new-platform-session", personId: 40, name: "Platform fixture", role: "admin", username: "fixture-user-40", expiresAt: "2099-01-01T00:00:00.000Z" });
      assert.equal((await auth.getSessionMysql("new-platform-session")).tenant, null);
      assert.deepEqual(await query("SELECT tenant_id FROM tenant_members WHERE person_id = 40"), []);
      await assert.rejects(auth.createSessionMysql({ token: "forged-platform-tenant", personId: 40, activeTenantId: 2, expiresAt: "2099-01-01T00:00:00.000Z" }), /无权登录所选企业/);
    });

    await scenario("dual session takes business roles from membership and loses tenant context when that membership is disabled", async () => {
      await query("INSERT INTO platform_grants (person_id, role, active, reason) VALUES (10, 'super_admin', 1, 'Fixture reviewed dual identity')");
      const dual = await auth.getSessionMysql("owner-a");
      assert.equal(dual.platform_role, "super_admin");
      assert.equal(dual.tenant.id, 1);
      assert.deepEqual(dual.roles, ["operations"]);
      assert.equal(dual.role, "operations");
      await query("UPDATE tenant_members SET active = 0 WHERE person_id = 10 AND tenant_id = 1");
      const platformOnly = await auth.getSessionMysql("owner-a");
      assert.equal(platformOnly.platform_role, "super_admin");
      assert.equal(platformOnly.tenant, null);
      assert.deepEqual(Array.from(platformOnly.roles), []);
      await query("UPDATE platform_grants SET active = 0 WHERE person_id = 10");
      assert.equal(await auth.getSessionMysql("owner-a"), null);
    });

    await scenario("revoked grants, inactive global accounts and unassigned legacy admins cannot retain or create sessions", async () => {
      await query("UPDATE platform_grants SET active = 0 WHERE person_id = 40");
      assert.equal(await auth.getSessionMysql("platform"), null);
      await query("INSERT INTO sessions (token, person_id) VALUES ('inactive-platform', 42)");
      assert.equal(await auth.getSessionMysql("inactive-platform"), null);
      await query("INSERT INTO people (id, name, username, role, active) VALUES (44, 'Fixture unassigned admin', 'fixture-unassigned', 'admin', 1)");
      await assert.rejects(auth.createSessionMysql({ token: "unassigned", personId: 44, expiresAt: "2099-01-01T00:00:00.000Z" }), /没有平台授权/);
      await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 1 AND person_id = 20");
      assert.equal(await auth.getSessionMysql("worker-a"), null);
      assert.deepEqual(await query("SELECT token FROM sessions WHERE token = 'unassigned'"), []);
    });

    await scenario("session fallback honors legacy role overrides while explicit empty membership roles stay empty", async () => {
      await query("UPDATE tenant_members SET business_roles_json = NULL WHERE tenant_id = 1 AND person_id = 10");
      await query("UPDATE people SET roles_json = JSON_ARRAY('technical') WHERE id = 10");
      assert.deepEqual((await auth.getSessionMysql("owner-a")).roles, ["technical"]);
      await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY() WHERE tenant_id = 1 AND person_id = 10");
      assert.deepEqual((await auth.getSessionMysql("owner-a")).roles, []);
      await query("UPDATE sessions SET expires_at = '2020-01-01 00:00:00' WHERE token = 'worker-a'");
      assert.equal(await auth.getSessionMysql("worker-a"), null);
      assert.deepEqual(await query("SELECT token FROM sessions WHERE token = 'worker-a'"), []);
    });

    async function legacyDefaultPeople() {
      await query("UPDATE tenants SET slug = 'default' WHERE id = 1");
      await query("UPDATE people SET role = 'packing', roles_json = NULL WHERE id = 20");
      await query("UPDATE people SET role = 'operations', roles_json = NULL WHERE id = 43");
      await query("UPDATE tenant_members SET role = 'owner', business_roles_json = NULL WHERE tenant_id = 1 AND person_id IN (10, 20, 43)");
    }

    await scenario("legacy default staff retain their job permissions without acquiring historical auto-owner authority", async () => {
      await legacyDefaultPeople();
      const actor = await auth.getSessionMysql("owner-a");
      const worker = await auth.getSessionMysql("worker-a");
      assert.equal(actor.tenant.role, "owner");
      assert.equal(actor.platform_role, null);
      assert.equal(worker.tenant.role, "member");
      assert.deepEqual(worker.roles, ["packing"]);
      assert.equal(worker.platform_role, null);
      const memberships = await services.tenants.tenantMembershipsMysql(20);
      assert.equal(memberships[0].role, "member");
      const rows = await enterprise.listEnterprisePeopleMysql(actor);
      assert.equal(rows.find(row => row.person_id === 20).tenant_role, "member");
      assert.equal(rows.find(row => row.person_id === 43).tenant_role, "member");
      await assert.rejects(enterprise.listEnterprisePeopleMysql({ ...worker, platform_role: "super_admin", tenant: { ...worker.tenant, role: "owner" } }), { statusCode: 403 });
      assert.equal((await query("SELECT role FROM tenant_members WHERE tenant_id = 1 AND person_id = 20"))[0].role, "owner");
    });

    await scenario("ordinary default identity edits do not formalize auto-owner and cannot remove the last effective owner", async () => {
      await legacyDefaultPeople();
      const actor = await auth.getSessionMysql("owner-a");
      await assert.rejects(enterprise.updateEnterprisePersonMysql(10, { member_active: 0 }, actor), { statusCode: 409 });
      const result = await enterprise.updateEnterprisePersonMysql(20, { name: "Fixture ordinary rename" }, actor);
      assert.equal(result.tenant_role, "member");
      const stored = (await query("SELECT role, business_roles_json FROM tenant_members WHERE tenant_id = 1 AND person_id = 20"))[0];
      assert.equal(stored.role, "member");
      assert.deepEqual(stored.business_roles_json, ["packing"]);
      await auth.createSessionMysql({ token: "ordinary-after-profile", personId: 20, name: "Fixture ordinary rename", role: "packing", expiresAt: "2099-01-01T00:00:00.000Z" });
      assert.equal((await auth.getSessionMysql("ordinary-after-profile")).tenant.role, "member");
    });

    await scenario("reviewed default ownership, legacy role overrides and independent platform grants remain explicit", async () => {
      await legacyDefaultPeople();
      await query("UPDATE people SET role = 'admin', roles_json = JSON_ARRAY('packing') WHERE id = 20");
      assert.equal((await auth.getSessionMysql("worker-a")).tenant.role, "member");
      await query("INSERT INTO platform_grants (person_id, role, active, reason) VALUES (20, 'super_admin', 1, 'Fixture independent platform identity')");
      const platformWorker = await auth.getSessionMysql("worker-a");
      assert.equal(platformWorker.platform_role, "super_admin");
      assert.equal(platformWorker.tenant.role, "member");
      await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 1 AND person_id = 20");
      assert.equal((await auth.getSessionMysql("worker-a")).tenant.role, "owner");
      await query("UPDATE tenants SET slug = 'enterprise-a' WHERE id = 1");
      await query("UPDATE tenant_members SET business_roles_json = NULL WHERE tenant_id = 1 AND person_id = 20");
      assert.equal((await auth.getSessionMysql("worker-a")).tenant.role, "owner");
    });

    await scenario("directory and actual FOR UPDATE member edit use the current enterprise and database actor permissions", async () => {
      const rows = await enterprise.listEnterprisePeopleMysql(session(10));
      assert.deepEqual(rows.map(row => row.person_id).sort((a, b) => a - b), [10, 11, 20, 21, 22, 23, 43]);
      assert.equal(rows.find(row => row.person_id === 21).member_active, 0);
      assert.equal(rows.find(row => row.person_id === 22).can_edit_identity, false);
      assert.equal(rows.find(row => row.person_id === 23).can_edit_identity, false);
      assert.equal((await enterprise.listEnterprisePeopleMysql(session(11))).length, rows.length);
      await assert.rejects(enterprise.listEnterprisePeopleMysql({ ...session(20), roles: ["admin"], platform_role: "super_admin" }), { statusCode: 403 });
      await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 1 AND person_id = 11");
      await assert.rejects(enterprise.listEnterprisePeopleMysql(session(11)), { statusCode: 403 });
      await assert.rejects(enterprise.updateEnterprisePersonMysql(30, { member_active: 0 }, session(10)), { statusCode: 404 });
      const edited = await enterprise.updateEnterprisePersonMysql(20, { business_roles: ["procurement"] }, session(10));
      assert.deepEqual(edited.business_roles, ["procurement"]);
      assert.equal((await query("SELECT role FROM people WHERE id = 20"))[0].role, "operator");
    });

    await scenario("creation hashes passwords and rolls back a global account if member insertion fails", async () => {
      const createdPerson = await enterprise.createEnterprisePersonMysql(newPerson("created"), session(10));
      const identity = (await query("SELECT role, password_hash FROM people WHERE id = ?", [createdPerson.person_id]))[0];
      assert.equal(identity.role, "operator");
      assert.equal(verifyPassword(newPerson("created").password, identity.password_hash), true);
      assert.equal(JSON.stringify(createdPerson).includes("password"), false);
      await enterprise.updateEnterprisePersonMysql(createdPerson.person_id, { password: "Reset!SyntheticPass88" }, session(10));
      const resetIdentity = (await query("SELECT role, password_hash FROM people WHERE id = ?", [createdPerson.person_id]))[0];
      assert.equal(resetIdentity.role, "operator");
      assert.equal(verifyPassword("Reset!SyntheticPass88", resetIdentity.password_hash), true);
      assert.equal(verifyPassword(newPerson("created").password, resetIdentity.password_hash), false);
      const before = (await query("SELECT COUNT(*) AS total FROM people"))[0].total;
      await pool.query("CREATE TRIGGER fixture_member_failure BEFORE INSERT ON tenant_members FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture membership failure'");
      try {
        await assert.rejects(enterprise.createEnterprisePersonMysql(newPerson("rollback"), session(10)), /fixture membership failure/);
      } finally { await pool.query("DROP TRIGGER fixture_member_failure"); }
      assert.equal((await query("SELECT COUNT(*) AS total FROM people"))[0].total, before);
      assert.deepEqual(await query("SELECT id FROM people WHERE username = 'fixture-rollback'"), []);
    });

    await scenario("concurrent account creation respects one remaining sub-account slot", async () => {
      const [{ used }] = await query("SELECT COUNT(*) - 1 AS used FROM tenant_members WHERE tenant_id = 1 AND active = 1");
      await query("UPDATE tenants SET member_limit = ? WHERE id = 1", [Number(used) + 1]);
      const results = await Promise.allSettled([
        enterprise.createEnterprisePersonMysql(newPerson("race-a"), session(10)),
        enterprise.createEnterprisePersonMysql(newPerson("race-b"), session(10))
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
      assert.equal((await query("SELECT COUNT(*) AS total FROM people WHERE username IN ('fixture-race-a', 'fixture-race-b')"))[0].total, 1);
    });

    await scenario("last-owner validation serializes competing deactivations and preserves quota on owner transfer", async () => {
      const results = await Promise.allSettled([
        enterprise.updateEnterprisePersonMysql(10, { member_active: 0 }, session(10)),
        enterprise.updateEnterprisePersonMysql(43, { member_active: 0 }, session(43))
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
      assert.equal((await query("SELECT COUNT(*) AS total FROM tenant_members WHERE tenant_id = 1 AND role = 'owner' AND active = 1"))[0].total, 1);
      await query("UPDATE tenant_members SET active = 1 WHERE tenant_id = 1 AND person_id IN (10, 43)");
      const [{ used }] = await query("SELECT COUNT(*) - 1 AS used FROM tenant_members WHERE tenant_id = 1 AND active = 1");
      await query("UPDATE tenants SET member_limit = ? WHERE id = 1", [used]);
      assert.equal((await enterprise.updateEnterprisePersonMysql(10, { tenant_role: "admin" }, session(10))).tenant_role, "admin");
      await query("UPDATE tenant_members SET role = 'owner' WHERE person_id = 10 AND tenant_id = 1");
      await query("UPDATE people SET active = 0 WHERE id = 43");
      await assert.rejects(enterprise.updateEnterprisePersonMysql(10, { member_active: 0 }, session(10)), { statusCode: 409 });
      const manifest = { version: 1, reviewed_by_person_id: 10, reason: "Fixture globally disabled owner protection", accounts: [{ person_id: 10, platform_role: "super_admin", memberships: [] }] };
      await assert.rejects(transaction(connection => applyIdentitySeparationMysql(connection, manifest)), /last active enterprise owner/);
    });

    await scenario("inactive foreign membership and inactive grant protect identity while local membership edits revoke only local sessions", async () => {
      await assert.rejects(enterprise.updateEnterprisePersonMysql(22, { password: "Replacement!Fixture88" }, session(10)), { statusCode: 403 });
      await assert.rejects(enterprise.updateEnterprisePersonMysql(23, { username: "replacement-login" }, session(10)), { statusCode: 403 });
      await enterprise.updateEnterprisePersonMysql(22, { member_active: 0 }, session(10));
      assert.deepEqual((await query("SELECT token FROM sessions WHERE person_id = 22")).map(row => row.token), ["shared-b"]);
      assert.equal((await query("SELECT active FROM people WHERE id = 22"))[0].active, 1);
      assert.equal((await query("SELECT active FROM tenant_members WHERE tenant_id = 2 AND person_id = 22"))[0].active, 0);
    });

    for (const boundary of ["membership", "grant"]) {
      await scenario(`locking identity recheck sees a concurrent ${boundary} committed after the initial snapshot`, async () => {
        const reached = deferred();
        const resume = deferred();
        hooks.afterExecute = async (sql, params) => {
          if (sql.startsWith("SELECT p.id,") && params[1] === 20 && sql.endsWith("FOR UPDATE")) {
            reached.resolve();
            await resume.promise;
          }
        };
        const editing = enterprise.updateEnterprisePersonMysql(20, { name: "Fixture attempted rename" }, session(10));
        const rejection = assert.rejects(editing, { statusCode: 403 });
        await reached.promise;
        try {
          if (boundary === "membership") await query("INSERT INTO tenant_members (tenant_id, person_id, role, business_roles_json, active) VALUES (2, 20, 'member', JSON_ARRAY('packing'), 0)");
          else await query("INSERT INTO platform_grants (person_id, role, active, reason) VALUES (20, 'super_admin', 0, 'Fixture concurrent grant')");
        } finally { resume.resolve(); }
        await rejection;
        assert.equal((await query("SELECT name FROM people WHERE id = 20"))[0].name, "Fixture person 20");
      });
    }

    await scenario("exclusive identity edit holds the missing platform-grant gap until it commits", async () => {
      const reached = deferred();
      const resume = deferred();
      hooks.afterExecute = async sql => {
        if (sql === "SELECT person_id FROM platform_grants WHERE person_id = ? FOR UPDATE") { reached.resolve(); await resume.promise; }
      };
      const editing = enterprise.updateEnterprisePersonMysql(20, { name: "Fixture exclusive rename" }, session(10));
      await reached.promise;
      let inserted = false;
      const inserting = query("INSERT INTO platform_grants (person_id, role, active, reason) VALUES (20, 'super_admin', 0, 'Fixture grant after identity edit')").then(() => { inserted = true; });
      try {
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(inserted, false);
      } finally { resume.resolve(); }
      await editing;
      await inserting;
      assert.equal((await query("SELECT name FROM people WHERE id = 20"))[0].name, "Fixture exclusive rename");
    });

    await scenario("migration dry-run is read-only, apply separates three identities and preserves historical references", async () => {
      const statements = [];
      const report = await inspectIdentitySeparation(async (sql, params) => { statements.push(sql); return query(sql, params); }, migrationManifest());
      assert.equal(report.changes_database, false);
      assert.equal(report.accounts.find(account => account.person_id === 43).platform_grant, null);
      assert.ok(statements.every(sql => /^(SELECT|SHOW)/.test(sql)));
      const passwordBefore = await query("SELECT id, password_hash FROM people ORDER BY id");
      const result = await transaction(connection => applyIdentitySeparationMysql(connection, migrationManifest()));
      assert.deepEqual(result.changed_person_ids, [10, 43]);
      assert.equal((await platform.getPlatformGrantMysql(10)).role, "super_admin");
      assert.equal((await platform.getPlatformGrantMysql(43)).role, "super_admin");
      assert.equal(await platform.getPlatformGrantMysql(20), null);
      assert.equal((await query("SELECT COUNT(*) AS total FROM tenant_members WHERE person_id = 43 AND active = 1"))[0].total, 0);
      assert.equal((await query("SELECT COUNT(*) AS total FROM platform_identity_migration_log"))[0].total, 3);
      const history = (await query("SELECT previous_grant_json, previous_memberships_json FROM platform_identity_migration_log WHERE person_id = 43"))[0];
      assert.equal(history.previous_grant_json, null);
      assert.equal(history.previous_memberships_json[0].active, 1);
      assert.deepEqual(await query("SELECT id, password_hash FROM people ORDER BY id"), passwordBefore);
      assert.deepEqual(await query("SELECT * FROM fixture_business_refs"), [{ id: 1, person_id: 43, payload: "historical operational record" }]);
      assert.deepEqual((await query("SELECT token FROM sessions ORDER BY token")).map(row => row.token), ["platform", "shared-a", "shared-b", "worker-a"]);
      assert.deepEqual((await transaction(connection => applyIdentitySeparationMysql(connection, migrationManifest()))).changed_person_ids, []);
    });

    await scenario("migration audit failure rolls back both grants and memberships", async () => {
      const grants = await query("SELECT * FROM platform_grants ORDER BY person_id");
      const members = await query("SELECT * FROM tenant_members ORDER BY tenant_id, person_id");
      const sessions = await query("SELECT * FROM sessions ORDER BY token");
      await pool.query("CREATE TRIGGER fixture_identity_audit_failure BEFORE INSERT ON platform_identity_migration_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture audit failure'");
      try {
        await assert.rejects(transaction(connection => applyIdentitySeparationMysql(connection, migrationManifest())), /fixture audit failure/);
      } finally { await pool.query("DROP TRIGGER fixture_identity_audit_failure"); }
      assert.deepEqual(await query("SELECT * FROM platform_grants ORDER BY person_id"), grants);
      assert.deepEqual(await query("SELECT * FROM tenant_members ORDER BY tenant_id, person_id"), members);
      assert.deepEqual(await query("SELECT * FROM sessions ORDER BY token"), sessions);
      assert.equal((await query("SELECT COUNT(*) AS total FROM platform_identity_migration_log"))[0].total, 0);
    });

    await scenario("migration rejects removal of the last real platform grant even when legacy admins remain", async () => {
      await query("UPDATE platform_grants SET active = 0 WHERE person_id <> 40");
      const manifest = { version: 1, reviewed_by_person_id: 10, reason: "Fixture rejected grant removal", accounts: [
        { person_id: 40, platform_role: null, memberships: [{ tenant_id: 2, role: "member", active: 1, business_roles: ["operations"] }] }
      ] };
      await assert.rejects(transaction(connection => applyIdentitySeparationMysql(connection, manifest)), /at least one active platform/);
      assert.equal((await platform.getPlatformGrantMysql(40)).role, "super_admin");
      assert.equal((await query("SELECT COUNT(*) AS total FROM platform_identity_migration_log"))[0].total, 0);
    });

    await scenario("migration audit exposes legacy stored roles and rejects loss of the last effective default owner", async () => {
      await legacyDefaultPeople();
      const report = await inspectIdentitySeparation(query);
      const member = report.accounts.find(account => account.person_id === 20).memberships[0];
      assert.equal(member.stored_role, "owner");
      assert.equal(member.role, "member");
      const manifest = { version: 1, reviewed_by_person_id: 10, reason: "Fixture last effective owner guard", accounts: [{ person_id: 10, platform_role: "super_admin", memberships: [] }] };
      await assert.rejects(transaction(connection => applyIdentitySeparationMysql(connection, manifest)), /last active enterprise owner/);
      assert.equal(await platform.getPlatformGrantMysql(10), null);
      assert.equal((await query("SELECT COUNT(*) AS total FROM platform_identity_migration_log"))[0].total, 0);
    });
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
