import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { getRoles, validateRoles } from "../src/shared/permissions.js";
import { assertTenantQuotaAvailable } from "../src/services/tenant-quotas.js";
import { validatePasswordStrength } from "../src/auth-password.js";
import { effectiveTenantMembershipRole } from "../src/services/tenant-membership-authority.js";

const source = readFileSync(new URL("../src/services/tenant-people.js", import.meta.url), "utf8")
  .replace(/^import[^\n]+\n/gm, "").replaceAll("export ", "");
const ownerSession = { personId: 10, tenant: { id: 1, slug: "company-a", role: "owner" } };
const updatedAt = "2026-10-21T02:00:00.000Z";

function fixture(change = () => {}) {
  let state = {
    tenants: [{ id: 1, slug: "company-a", status: "active", member_limit: 2 }, { id: 2, slug: "company-b", status: "active", member_limit: 2 }],
    people: [10, 20, 30, 40].map(id => ({ id, name: `Person ${id}`, username: `user${id}`, role: "operator", roles_json: '["operator"]', avatar_url: "", active: 1 })),
    members: [
      { tenant_id: 1, person_id: 10, role: "owner", active: 1, business_roles_json: '["operations"]', updated_at: updatedAt },
      { tenant_id: 1, person_id: 20, role: "member", active: 1, business_roles_json: '["packing"]', updated_at: updatedAt },
      { tenant_id: 2, person_id: 30, role: "owner", active: 1, business_roles_json: '["operations"]', updated_at: updatedAt }
    ],
    grants: [], sessions: [{ person_id: 20, active_tenant_id: 1 }, { person_id: 20, active_tenant_id: 2 }]
  };
  change(state);
  const calls = [];
  const connection = { async execute(sql, params = []) {
    calls.push({ sql, params: Array.from(params) });
    if (sql.startsWith("SELECT id, slug, status, member_limit")) return [state.tenants.filter(item => item.id === params[0])];
    if (sql.startsWith("SELECT tm.role,")) {
      const member = state.members.find(item => item.tenant_id === params[0] && item.person_id === params[1] && item.active === 1
        && state.people.some(person => person.id === item.person_id && person.active === 1));
      const person = member && state.people.find(item => item.id === member.person_id);
      return [member ? [{ role: member.role, business_roles_json: member.business_roles_json, legacy_role: person.role, roles_json: person.roles_json }] : []];
    }
    if (sql.startsWith("SELECT p.id, p.id AS person_id")) {
      const rows = state.members.filter(item => item.tenant_id === params[0] && (params.length === 1 || item.person_id === params[1])).map(member => {
        const person = state.people.find(item => item.id === member.person_id);
        return { ...person, person_id: person.id, legacy_role: person.role, account_active: person.active, tenant_slug: state.tenants.find(item => item.id === member.tenant_id)?.slug,
          tenant_role: member.role, business_roles_json: member.business_roles_json, member_active: member.active, updated_at: member.updated_at,
          can_edit_identity: Number(!state.members.some(item => item.person_id === person.id && item.tenant_id !== member.tenant_id)
            && !state.grants.some(item => item.person_id === person.id)) };
      });
      return [rows];
    }
    if (sql.startsWith("SELECT tm.person_id, tm.role,")) return [state.members.filter(item => item.tenant_id === params[0]).map(member => {
      const person = state.people.find(item => item.id === member.person_id);
      return { ...member, legacy_role: person.role, roles_json: person.roles_json, account_active: person.active };
    })];
    if (sql.startsWith("SELECT tenant_id FROM tenant_members")) return [state.members.filter(item => item.person_id === params[0])];
    if (sql.startsWith("SELECT person_id FROM platform_grants")) return [state.grants.filter(item => item.person_id === params[0])];
    if (sql.startsWith("INSERT INTO people")) {
      if (state.people.some(item => item.name === params[0] || item.username === params[1])) throw Object.assign(new Error("Private database duplicate detail"), { code: "ER_DUP_ENTRY" });
      const id = Math.max(...state.people.map(item => item.id)) + 1;
      state.people.push({ id, name: params[0], username: params[1], role: "operator", roles_json: '["operator"]', avatar_url: params[2], active: 1, password_hash: params[3] });
      return [{ insertId: id }];
    }
    if (sql.startsWith("INSERT INTO tenant_members")) {
      if (state.failMemberInsert) throw new Error("Simulated membership insert failure");
      state.members.push({ tenant_id: params[0], person_id: params[1], role: params[2], business_roles_json: params[3], active: params[4], updated_at: updatedAt });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE tenant_members")) {
      Object.assign(state.members.find(item => item.tenant_id === params[3] && item.person_id === params[4]), { role: params[0], business_roles_json: params[1], active: params[2], updated_at: updatedAt });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE people")) {
      const person = state.people.find(item => item.id === params.at(-1));
      Object.assign(person, { name: params[0], username: params[1], avatar_url: params[2] });
      if (sql.includes("password_hash")) person.password_hash = params[3];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("DELETE FROM sessions")) {
      state.sessions = state.sessions.filter(item => item.person_id !== params[0] || (params.length === 2 && item.active_tenant_id !== params[1]));
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const context = vm.createContext({
    getRoles, validateRoles, validatePasswordStrength, assertTenantQuotaAvailable, effectiveTenantMembershipRole,
    ensureTenantSchemaMysql: async () => {}, ensurePlatformGrantSchemaMysql: async () => {},
    hashPassword: () => "hashed-with-test-salt",
    withMysqlTransaction: async work => {
      const before = structuredClone(state);
      try { return await work(connection); } catch (error) { state = before; throw error; }
    }
  });
  vm.runInContext(source, context);
  return { services: context, calls, get state() { return state; } };
}

test("enterprise directory includes disabled members, scopes both member and actor, and never returns credentials", async () => {
  const f = fixture(state => { state.members[1].active = 0; state.people[1].password_hash = "private"; });
  const rows = await f.services.listEnterprisePeopleMysql(ownerSession);
  assert.deepEqual(Array.from(rows, row => row.id), [10, 20]);
  assert.equal(rows[1].member_active, 0);
  assert.equal(rows[1].can_edit_identity, true);
  assert.deepEqual(Array.from(rows[1].business_roles), ["packing"]);
  assert.equal(JSON.stringify(rows).includes("private"), false);
  assert.equal(JSON.stringify(rows).includes("password_hash"), false);
  const directoryQuery = f.calls.find(call => call.sql.startsWith("SELECT p.id"));
  assert.deepEqual(directoryQuery.params, [1]);
});

test("legacy business admin and stale/platform session flags never replace actual enterprise management membership", async () => {
  const f = fixture(state => { state.members[1].business_roles_json = '["admin"]'; });
  const session = { personId: 20, roles: ["admin"], platform_role: "super_admin", tenant: { id: 1, slug: "company-a", role: "owner" } };
  await assert.rejects(f.services.listEnterprisePeopleMysql(session), { statusCode: 403 });
  await assert.rejects(f.services.listEnterprisePeopleMysql({ personId: 10, platform_role: "super_admin" }), { statusCode: 403 });
});

test("new enterprise account and member are created atomically with member-local business roles", async () => {
  const f = fixture();
  const person = await f.services.createEnterprisePersonMysql({ name: "New employee", username: "employee-new", password: "Fictional!Pass42", tenant_role: "member", business_roles: ["procurement"] }, ownerSession);
  assert.equal(person.person_id, 41);
  assert.equal(f.state.people.at(-1).role, "operator");
  assert.equal(f.state.people.at(-1).password_hash, "hashed-with-test-salt");
  assert.deepEqual(JSON.parse(f.state.members.at(-1).business_roles_json), ["procurement"]);
  assert.equal(JSON.stringify(person).includes("password"), false);
  const failed = fixture(state => { state.failMemberInsert = true; });
  await assert.rejects(failed.services.createEnterprisePersonMysql({ name: "New employee", username: "employee-new", password: "Fictional!Pass42" }, ownerSession), /Simulated/);
  assert.equal(failed.state.people.length, 4);
});

test("quota and invalid identity/linking inputs reject account creation before insertion", async () => {
  const f = fixture(state => { state.tenants[0].member_limit = 1; });
  const body = { name: "New employee", username: "employee-new", password: "Fictional!Pass42" };
  await assert.rejects(f.services.createEnterprisePersonMysql(body, ownerSession), { statusCode: 409 });
  await assert.rejects(f.services.createEnterprisePersonMysql({ ...body, person_id: 30 }, ownerSession), { statusCode: 403 });
  await assert.rejects(f.services.createEnterprisePersonMysql({ ...body, platform_role: "super_admin" }, ownerSession), { statusCode: 403 });
  await assert.rejects(f.services.createEnterprisePersonMysql({ ...body, password: "12345678" }, ownerSession), { statusCode: 400 });
  assert.equal(f.calls.some(call => call.sql.startsWith("INSERT")), false);
});

test("enterprise membership updates preserve shared login identity and other-company sessions", async () => {
  const f = fixture(state => { state.members.push({ tenant_id: 2, person_id: 20, role: "member", active: 0 }); });
  const changed = await f.services.updateEnterprisePersonMysql(20, { tenant_role: "admin", business_roles: ["operations"], member_active: 0 }, ownerSession);
  assert.equal(changed.can_edit_identity, false);
  assert.equal(changed.member_active, 0);
  assert.equal(f.state.people[1].active, 1);
  assert.equal(f.state.people[1].role, "operator");
  assert.deepEqual(f.state.sessions, [{ person_id: 20, active_tenant_id: 2 }]);
  assert.equal(f.calls.some(call => call.sql.startsWith("UPDATE people")), false);
});

test("shared and explicitly granted platform identities remain read-only even when their other access is disabled", async () => {
  for (const change of [
    state => state.members.push({ tenant_id: 2, person_id: 20, role: "member", active: 0 }),
    state => state.grants.push({ person_id: 20, role: "super_admin", active: 0 })
  ]) {
    const f = fixture(change);
    await assert.rejects(f.services.updateEnterprisePersonMysql(20, { name: "Another name", password: "Fictional!Pass42" }, ownerSession), { statusCode: 403 });
    assert.equal(f.calls.some(call => call.sql.startsWith("UPDATE")), false);
    assert.ok(f.calls.some(call => call.sql === "SELECT tenant_id FROM tenant_members WHERE person_id = ? FOR UPDATE"));
    assert.ok(f.calls.some(call => call.sql === "SELECT person_id FROM platform_grants WHERE person_id = ? FOR UPDATE"));
  }
});

test("exclusive identity password changes validate and hash passwords without changing global authorization", async () => {
  const f = fixture();
  const changed = await f.services.updateEnterprisePersonMysql(20, { name: "Employee renamed", password: "Fictional!Pass42" }, ownerSession);
  assert.equal(changed.name, "Employee renamed");
  assert.equal(f.state.people[1].password_hash, "hashed-with-test-salt");
  assert.equal(f.state.people[1].role, "operator");
  assert.equal(f.state.sessions.length, 0);
});

test("last owner protection and primary-owner transfers use the final quota count", async () => {
  const f = fixture();
  await assert.rejects(f.services.updateEnterprisePersonMysql(10, { tenant_role: "admin" }, ownerSession), { statusCode: 409 });
  await assert.rejects(f.services.updateEnterprisePersonMysql(10, { member_active: 0 }, ownerSession), { statusCode: 409 });
  const transfer = fixture(state => { state.members[1].role = "owner"; state.tenants[0].member_limit = 1; });
  const changed = await transfer.services.updateEnterprisePersonMysql(10, { tenant_role: "admin" }, ownerSession);
  assert.equal(changed.tenant_role, "admin");
});

test("cross-company target and stale version fail without changing memberships", async () => {
  const f = fixture();
  await assert.rejects(f.services.updateEnterprisePersonMysql(30, { member_active: 0 }, ownerSession), { statusCode: 404 });
  await assert.rejects(f.services.updateEnterprisePersonMysql(20, { updated_at: "2026-10-20T00:00:00.000Z", member_active: 0 }, ownerSession), { statusCode: 409 });
  assert.equal(f.calls.some(call => call.sql.startsWith("UPDATE")), false);
});

function legacyDefaultFixture(state) {
  state.tenants[0].slug = "default";
  state.members[0].business_roles_json = null;
  state.people[0].role = "admin";
  state.people[0].roles_json = null;
  state.members[1].role = "owner";
  state.members[1].business_roles_json = null;
  state.people[1].role = "packing";
  state.people[1].roles_json = null;
}

test("default member directory caps historical auto-owners and identity-only editing cannot formalize owner permissions", async () => {
  const f = fixture(legacyDefaultFixture);
  const rows = await f.services.listEnterprisePeopleMysql({ ...ownerSession, tenant: { ...ownerSession.tenant, slug: "default" } });
  assert.equal(rows.find(person => person.person_id === 20).tenant_role, "member");
  const result = await f.services.updateEnterprisePersonMysql(20, { name: "Renamed ordinary staff" }, { ...ownerSession, tenant: { ...ownerSession.tenant, slug: "default" } });
  assert.equal(result.tenant_role, "member");
  assert.equal(f.state.members[1].role, "member");
  assert.deepEqual(JSON.parse(f.state.members[1].business_roles_json), ["packing"]);
});

test("default actor recheck does not trust a raw legacy auto-owner or a platform flag", async () => {
  const f = fixture(legacyDefaultFixture);
  await assert.rejects(f.services.listEnterprisePeopleMysql({ personId: 20, platform_role: "super_admin", tenant: { id: 1, slug: "default", role: "owner" } }), { statusCode: 403 });
  await assert.rejects(f.services.listEnterprisePeopleMysql({ personId: 10, tenant: { id: 1, slug: "default", role: "member" } }), { statusCode: 403 });
});

test("last effective default owner remains protected when historical ordinary auto-owner rows remain", async () => {
  const f = fixture(legacyDefaultFixture);
  await assert.rejects(f.services.updateEnterprisePersonMysql(10, { member_active: 0 }, { ...ownerSession, tenant: { ...ownerSession.tenant, slug: "default" } }), { statusCode: 409 });
  assert.equal(f.calls.some(call => call.sql.startsWith("UPDATE")), false);
});

test("disabled global owner accounts cannot justify removing the last usable owner", async () => {
  const f = fixture(state => { state.members[1].role = "owner"; state.people[1].active = 0; });
  await assert.rejects(f.services.updateEnterprisePersonMysql(10, { member_active: 0 }, ownerSession), { statusCode: 409 });
  assert.equal(f.calls.some(call => call.sql.startsWith("UPDATE")), false);
});
