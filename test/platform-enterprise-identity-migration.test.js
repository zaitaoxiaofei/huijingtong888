import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyIdentitySeparationMysql, inspectIdentitySeparation, normalizeIdentityManifest } from "../scripts/lib/platform-enterprise-identity-migration.mjs";

function reviewedManifest() {
  return { version: 1, reviewed_by_person_id: 10, reason: "Reviewed identity boundary migration", accounts: [
    { person_id: 10, platform_role: "super_admin", memberships: [{ tenant_id: 1, role: "owner", active: 1, business_roles: ["operations"] }] },
    { person_id: 20, platform_role: "super_admin", memberships: [] },
    { person_id: 30, platform_role: null, memberships: [{ tenant_id: 1, role: "member", active: 1, business_roles: ["packing"] }] }
  ] };
}

function fixture(change = () => {}) {
  let state = {
    tenants: [{ id: 1, slug: "company-a", status: "active", member_limit: 3 }, { id: 2, slug: "company-b", status: "active", member_limit: 1 }],
    people: [10, 20, 30, 40, 50].map(id => ({ id, active: 1, role: id <= 20 ? "admin" : "operator", roles_json: null, password_hash: "untouched-credential" })),
    grants: [{ person_id: 40, role: "super_admin", active: 1 }],
    members: [
      { person_id: 10, tenant_id: 1, role: "owner", active: 1, business_roles_json: null },
      { person_id: 20, tenant_id: 1, role: "owner", active: 1, business_roles_json: null },
      { person_id: 30, tenant_id: 1, role: "member", active: 1, business_roles_json: null },
      { person_id: 50, tenant_id: 2, role: "owner", active: 1, business_roles_json: '["operations"]' }
    ],
    sessions: [10, 20, 30, 40, 50].map(person_id => ({ person_id })), logs: []
  };
  change(state);
  const calls = [];
  const connection = { async execute(sql, params = []) {
    calls.push({ sql, params: Array.from(params) });
    if (sql.startsWith("SELECT id, slug, status, member_limit FROM tenants")) return [state.tenants];
    if (sql.startsWith("SELECT id, active, role, roles_json FROM people")) return [state.people.filter(item => params.includes(item.id)).map(({ password_hash, ...item }) => item)];
    if (sql.startsWith("SELECT pg.person_id")) return [state.grants.map(grant => ({ ...grant, account_active: state.people.find(item => item.id === grant.person_id)?.active || 0 }))];
    if (sql.startsWith("SELECT tm.person_id, tm.tenant_id,")) return [state.members.map(member => {
      const person = state.people.find(item => item.id === member.person_id);
      return { ...member, legacy_role: person.role, roles_json: person.roles_json, account_active: person.active };
    })];
    if (sql.startsWith("INSERT INTO platform_grants")) {
      const grant = state.grants.find(item => item.person_id === params[0]);
      const values = { person_id: params[0], role: "super_admin", active: 1, granted_by_person_id: params[1], reason: params[2] };
      if (grant) Object.assign(grant, values); else state.grants.push(values);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE platform_grants")) {
      Object.assign(state.grants.find(item => item.person_id === params[2]), { active: 0, granted_by_person_id: params[0], reason: params[1] });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE tenant_members")) {
      state.members.find(item => item.tenant_id === params[0] && item.person_id === params[1]).active = 0;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("INSERT INTO tenant_members")) {
      const member = state.members.find(item => item.tenant_id === params[0] && item.person_id === params[1]);
      const values = { tenant_id: params[0], person_id: params[1], role: params[2], business_roles_json: params[3], active: params[4] };
      if (member) Object.assign(member, values); else state.members.push(values);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("INSERT INTO platform_identity_migration_log")) {
      if (state.failLog) throw new Error("Simulated audit log failure");
      state.logs.push(Array.from(params));
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("DELETE FROM sessions")) {
      state.sessions = state.sessions.filter(item => !params.includes(item.person_id));
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  return { connection, calls, get state() { return state; }, async apply(manifest) {
    const before = structuredClone(state);
    try { return await applyIdentitySeparationMysql(connection, manifest); }
    catch (error) { state = before; throw error; }
  } };
}

test("review manifest requires explicit platform decisions, IDs, activity and business roles", () => {
  assert.deepEqual(normalizeIdentityManifest(reviewedManifest()), reviewedManifest());
  for (const change of [
    manifest => { delete manifest.accounts[0].platform_role; },
    manifest => { manifest.accounts[0].person_id = "10"; },
    manifest => { manifest.accounts.push(manifest.accounts[0]); },
    manifest => { manifest.accounts[0].memberships[0].active = "1"; },
    manifest => { manifest.accounts[0].memberships[0].business_roles = ["super_admin"]; },
    manifest => { manifest.accounts[0].memberships[0].role = "super_admin"; },
    manifest => { manifest.accounts[0].platform_role = "developer"; },
    manifest => { manifest.accounts[2].memberships = []; },
    manifest => { manifest.reason = ""; }
  ]) {
    const manifest = reviewedManifest();
    change(manifest);
    assert.throws(() => normalizeIdentityManifest(manifest));
  }
});

test("dry-run reads existing grants/memberships without creating schema, credentials or inferred privileges", async () => {
  const queries = [];
  const report = await inspectIdentitySeparation(async sql => {
    queries.push(sql);
    if (sql.startsWith("SELECT id, active")) return [{ id: 10, active: 1, role: "admin", roles_json: null }];
    if (sql.startsWith("SHOW")) return [];
    if (sql.includes("FROM tenant_members")) return [{ person_id: 10, tenant_id: 1, role: "owner", active: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  });
  assert.equal(report.changes_database, false);
  assert.equal(report.schema_ready, false);
  assert.equal(report.accounts[0].platform_grant, null);
  assert.equal(report.accounts[0].proposed, null);
  assert.ok(queries.every(sql => /^(SELECT|SHOW)/.test(sql)));
  assert.equal(JSON.stringify(report).includes("password"), false);
  const cli = readFileSync(new URL("../scripts/migrate-platform-enterprise-identities.mjs", import.meta.url), "utf8");
  const dryRun = cli.slice(cli.indexOf("if (!apply)"), cli.indexOf('const socketPath = option("mysql-admin-socket")'));
  assert.doesNotMatch(dryRun, /ensure.*Schema|CREATE|ALTER|execute\(/);
  assert.match(dryRun, /return;/);
});

test("dry-run distinguishes stored default auto-owner rows from effective staff roles", async () => {
  const report = await inspectIdentitySeparation(async sql => {
    if (sql.startsWith("SELECT id, active")) return [{ id: 20, active: 1, role: "packing", roles_json: null }];
    if (sql.startsWith("SHOW")) return [];
    if (sql.includes("FROM tenant_members")) return [{ person_id: 20, tenant_id: 1, tenant_slug: "default", role: "owner", active: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  });
  assert.equal(report.accounts[0].memberships[0].stored_role, "owner");
  assert.equal(report.accounts[0].memberships[0].role, "member");
});

test("reviewed migration supports dual, platform-only and enterprise-only without deleting identities or business references", async () => {
  const f = fixture();
  const people = structuredClone(f.state.people);
  const result = await f.apply(reviewedManifest());
  assert.deepEqual(result.changed_person_ids, [10, 20, 30]);
  assert.equal(f.state.grants.find(item => item.person_id === 10).role, "super_admin");
  assert.equal(f.state.grants.find(item => item.person_id === 20).active, 1);
  assert.equal(f.state.grants.some(item => item.person_id === 30), false);
  assert.equal(f.state.members.find(item => item.person_id === 20).active, 0);
  assert.equal(f.state.members.find(item => item.person_id === 10).active, 1);
  assert.deepEqual(f.state.people, people);
  assert.deepEqual(f.state.sessions, [{ person_id: 40 }, { person_id: 50 }]);
  assert.equal(f.state.logs.length, 3);
  assert.equal(JSON.stringify(f.state.logs).includes("untouched-credential"), false);
  assert.equal(f.calls.some(call => /UPDATE people|DELETE FROM people|DELETE FROM tenant_members/.test(call.sql)), false);
  const repeated = await f.apply(reviewedManifest());
  assert.deepEqual(repeated.changed_person_ids, []);
});

test("legacy admin identities never satisfy the final active platform-superadmin requirement", async () => {
  const f = fixture(state => { state.grants = []; });
  const manifest = reviewedManifest();
  manifest.accounts = [manifest.accounts[2]];
  await assert.rejects(f.apply(manifest), /at least one active platform/);
  assert.equal(f.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), false);
});

test("reviewed platform migration preserves existing disabled memberships in archived enterprises", async () => {
  const f = fixture(state => {
    state.tenants.push({ id: 3, slug: "archived", status: "archived", member_limit: 0 });
    state.members.push({ person_id: 10, tenant_id: 3, role: "owner", active: 0, business_roles_json: '["operations"]' });
  });
  const manifest = reviewedManifest();
  manifest.accounts[0].memberships.push({ tenant_id: 3, role: "owner", active: 0, business_roles: ["operations"] });
  await f.apply(manifest);
  assert.deepEqual(f.state.members.find(m => m.person_id === 10 && m.tenant_id === 3), {
    person_id: 10, tenant_id: 3, role: "owner", active: 0, business_roles_json: '["operations"]'
  });
});

test("archived enterprises cannot receive a new membership or reactivate a disabled one", async () => {
  for (const [existing, active] of [[false, 0], [false, 1], [true, 1]]) {
    const f = fixture(state => {
      state.tenants.push({ id: 3, slug: "archived", status: "archived", member_limit: 0 });
      if (existing) state.members.push({ person_id: 10, tenant_id: 3, role: "owner", active: 0, business_roles_json: '["operations"]' });
    });
    const manifest = reviewedManifest();
    manifest.accounts[0].memberships.push({ tenant_id: 3, role: "owner", active, business_roles: ["operations"] });
    await assert.rejects(f.apply(manifest), /existing active enterprises/);
    assert.equal(f.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), false);
  }
});

test("final platform grant, last enterprise owner, quota and selected identity validation happen before writes", async () => {
  const cases = [
    { change: state => { state.grants = [{ person_id: 10, role: "super_admin", active: 1 }]; }, manifest: () => ({ ...reviewedManifest(), accounts: [{ person_id: 10, platform_role: null, memberships: [{ tenant_id: 1, role: "owner", active: 1, business_roles: ["operations"] }] }] }), error: /at least one active platform/ },
    { change: state => { state.members[1].role = "admin"; }, manifest: () => ({ ...reviewedManifest(), accounts: [{ person_id: 10, platform_role: "super_admin", memberships: [] }] }), error: /last active enterprise owner/ },
    { change: state => { state.tenants[1].member_limit = 0; }, manifest: () => ({ ...reviewedManifest(), accounts: [{ person_id: 30, platform_role: null, memberships: [{ tenant_id: 2, role: "member", active: 1, business_roles: ["packing"] }] }] }), error: /quota/ },
    { change: () => {}, manifest: () => ({ ...reviewedManifest(), reviewed_by_person_id: 999 }), error: /must exist/ },
    { change: state => { state.people[1].active = 0; }, manifest: reviewedManifest, error: /inactive global account/ }
  ];
  for (const item of cases) {
    const f = fixture(item.change);
    await assert.rejects(f.apply(item.manifest()), item.error);
    assert.equal(f.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), false);
  }
});

test("caller rollback protects all privilege and membership changes when mandatory audit logging fails", async () => {
  const f = fixture(state => { state.failLog = true; });
  const before = structuredClone(f.state);
  await assert.rejects(f.apply(reviewedManifest()), /audit log failure/);
  assert.deepEqual(f.state, before);
  const cli = readFileSync(new URL("../scripts/migrate-platform-enterprise-identities.mjs", import.meta.url), "utf8");
  assert.ok(cli.indexOf("await connection.beginTransaction()") < cli.indexOf("await applyIdentitySeparationMysql"));
  assert.match(cli, /await connection\.rollback\(\)/);
});

test("migration cannot rely on historical default auto-owners when removing the last effective owner", async () => {
  const f = fixture(state => {
    state.tenants[0].slug = "default";
    state.people.find(person => person.id === 20).role = "packing";
  });
  const manifest = { ...reviewedManifest(), accounts: [{ person_id: 10, platform_role: "super_admin", memberships: [] }] };
  await assert.rejects(f.apply(manifest), /last active enterprise owner/);
  assert.equal(f.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), false);
});

test("migration cannot rely on a globally disabled owner to remove the last usable owner", async () => {
  const f = fixture(state => { state.people.find(person => person.id === 20).active = 0; });
  const manifest = { ...reviewedManifest(), accounts: [{ person_id: 10, platform_role: "super_admin", memberships: [] }] };
  await assert.rejects(f.apply(manifest), /last active enterprise owner/);
  assert.equal(f.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), false);
});
