import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionAccessDecision } from "../src/server/subscription-access.js";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_NAME ||= "unused_membership_unit_database";
process.env.DB_USER ||= "unused_membership_unit_user";
const { createSelfServiceMembershipService, membershipSummary } = await import("../src/services/self-service-membership.js");
const { createAuthHandler } = await import("../src/server/session.js");

const NOW = Date.parse("2026-10-22T00:00:00Z");
const DAY = 86400000;
const platform = { personId: 99, platform_role: "super_admin" };
const registration = { username: "new-seller", name: "新卖家", password: "Safe-random-82!", enterprise_name: "我的企业" };

function fixture() {
  let state = { people: [{ id: 99, name: "平台", username: "platform", active: 1, role: "operator" }],
    tenants: [{ id: 1, slug: "default", name: "默认企业", status: "active", plan_code: "yearly", subscription_status: "active", subscription_expires_at: null }],
    members: [], grants: [{ person_id: 99, active: 1 }], vouchers: [],
    plans: [{ code: "monthly", name: "月租基础版", duration_days: 30, subscription_status: "active", account_limit: 1, shop_limit: 2, active: 1 }],
    failMembershipInsert: false, failConsume: false };
  const statements = [];
  let clock = NOW, sequence = 1, queue = Promise.resolve();
  const connection = { async execute(sql, params = []) {
    statements.push({ sql, params: structuredClone(params) });
    if (sql.startsWith("INSERT INTO people")) {
      if (state.people.some(person => person.username === params[1] || person.name === params[0])) throw Object.assign(new Error("PRIVATE_SQL_DUPLICATE"), { code: "ER_DUP_ENTRY" });
      const id = Math.max(...state.people.map(person => person.id)) + 1;
      state.people.push({ id, name: params[0], username: params[1], password_hash: params[2], active: 1, role: "operator", roles_json: '["operator"]' });
      return [{ insertId: id }];
    }
    if (sql.startsWith("INSERT INTO tenants")) {
      const id = Math.max(...state.tenants.map(tenant => tenant.id)) + 1;
      state.tenants.push({ id, slug: params[0], name: params[1], status: "active", plan_code: "unactivated", subscription_status: "unactivated", subscription_expires_at: null, member_limit: 0, shop_limit: 0 });
      return [{ insertId: id }];
    }
    if (sql.startsWith("INSERT INTO tenant_members")) {
      if (state.failMembershipInsert) throw new Error("Membership insert failed");
      state.members.push({ tenant_id: params[0], person_id: params[1], role: "owner", business_roles_json: '["operator"]', active: 1 });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("SELECT * FROM tenants")) return [[state.tenants.find(tenant => tenant.id === params[0])].filter(Boolean)];
    if (sql.startsWith("SELECT tm.role AS tenant_role")) return [state.members.filter(member => member.tenant_id === params[0] && member.person_id === params[1] && member.active === 1)
      .filter(member => state.people.find(person => person.id === member.person_id)?.active === 1)
      .map(member => ({ tenant_role: member.role, business_roles_json: member.business_roles_json, legacy_role: "operator", roles_json: '["operator"]' }))];
    if (sql.startsWith("SELECT pg.person_id")) return [state.grants.filter(grant => grant.person_id === params[0] && grant.active === 1 && state.people.find(person => person.id === grant.person_id)?.active === 1)];
    if (sql.startsWith("SELECT * FROM tenant_plans")) return [state.plans.filter(plan => plan.code === params[0] && plan.active === 1)];
    if (sql.startsWith("INSERT INTO tenant_subscription_vouchers")) {
      const id = state.vouchers.length + 1;
      state.vouchers.push({ id, code_hash: params[0], code_hint: params[1], plan_snapshot_json: JSON.parse(params[2]), redeemable_until: new Date(`${params[3].replace(" ", "T")}Z`),
        issued_by_person_id: params[4], status: "active", created_at: new Date(clock), used_at: null, used_by_tenant_id: null });
      return [{ insertId: id }];
    }
    if (sql.startsWith("SELECT id, code_hint, status")) return [[...state.vouchers].reverse().slice(0, 100).map(({ code_hash, issued_by_person_id, ...row }) => row)];
    if (sql.startsWith("SELECT * FROM tenant_subscription_vouchers")) return [state.vouchers.filter(voucher => voucher.code_hash === params[0])];
    if (sql.startsWith("UPDATE tenants SET plan_code")) {
      Object.assign(state.tenants.find(tenant => tenant.id === params[5]), { plan_code: params[0], subscription_status: params[1], subscription_expires_at: new Date(`${params[2].replace(" ", "T")}Z`), member_limit: params[3], shop_limit: params[4] });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE tenant_subscription_vouchers SET status = 'used'")) {
      if (state.failConsume) return [{ affectedRows: 0 }];
      const voucher = state.vouchers.find(row => row.id === params[2] && row.status === "active");
      if (voucher) Object.assign(voucher, { status: "used", used_at: new Date(clock), used_by_person_id: params[0], used_by_tenant_id: params[1] });
      return [{ affectedRows: Number(Boolean(voucher)) }];
    }
    if (sql.startsWith("UPDATE tenant_subscription_vouchers SET status = 'revoked'")) {
      const voucher = state.vouchers.find(row => row.id === params[0] && row.status === "active");
      if (voucher) voucher.status = "revoked";
      return [{ affectedRows: Number(Boolean(voucher)) }];
    }
    throw new Error(`Unexpected test SQL: ${sql}`);
  } };
  const services = createSelfServiceMembershipService({
    ensureTenantSchemaMysql: async () => {}, mysqlExecute: async () => {}, hashPassword: () => "hashed-password",
    inspectVoucherSchema: async () => ({ ready: true }),
    randomBytes: length => Buffer.alloc(length, sequence++), now: () => clock,
    withMysqlTransaction: async action => {
      const previous = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      const before = structuredClone(state);
      try { return await action(connection); }
      catch (error) { state = before; throw error; }
      finally { release(); }
    }
  });
  return { services, statements, get state() { return state; }, setClock(value) { clock = value; },
    async register(suffix = "") {
      const person = await services.register({ ...registration, username: `new-seller${suffix}`, name: `新卖家${suffix}` });
      return { personId: person.id, tenant: { id: person.tenant_id, slug: state.tenants.find(tenant => tenant.id === person.tenant_id).slug, role: "owner" } };
    } };
}

test("self registration creates only a new isolated unactivated owner with no platform grant", async () => {
  const f = fixture();
  const originalDefault = structuredClone(f.state.tenants[0]);
  const session = await f.register();
  assert.deepEqual(f.state.tenants[0], originalDefault);
  assert.equal(f.state.members.length, 1);
  assert.equal(f.state.members[0].tenant_id, session.tenant.id);
  assert.notEqual(session.tenant.id, 1);
  assert.deepEqual(f.state.grants, [{ person_id: 99, active: 1 }]);
  assert.equal(f.state.members[0].business_roles_json, '["operator"]');
  const status = await f.services.membership(session);
  assert.equal(status.status, "unactivated");
  assert.equal(status.access_allowed, false);
  assert.equal(status.remaining_days, 0);
  assert.equal(status.can_activate, true);
  assert.equal(f.state.people[1].password_hash, "hashed-password");
});

test("registration validates password/identity fields and rolls back all rows on membership failure or duplicates", async () => {
  const f = fixture();
  for (const body of [null, [], { ...registration, username: "x" }, { ...registration, password: "12345678" },
    { ...registration, password: "a".repeat(129) }, { ...registration, tenant_id: 1 }, { ...registration, platform_role: "super_admin" }, { ...registration, role: "admin" }]) {
    await assert.rejects(f.services.register(body), error => error.statusCode === 400);
  }
  assert.equal(f.statements.length, 0);
  f.state.failMembershipInsert = true;
  await assert.rejects(f.services.register(registration), /Membership insert failed/);
  assert.equal(f.state.people.length, 1);
  assert.equal(f.state.tenants.length, 1);
  f.state.failMembershipInsert = false;
  await f.register();
  await assert.rejects(f.services.register(registration), error => error.statusCode === 409 && !error.message.includes("PRIVATE_SQL"));
  assert.equal(f.state.people.length, 2);
});

test("voucher issuance captures immutable quotas, exposes the secret once, and requires current platform authority", async () => {
  const f = fixture();
  const session = await f.register();
  await assert.rejects(f.services.issueVoucher({ plan_code: "monthly" }, session), error => error.statusCode === 403);
  const issued = await f.services.issueVoucher({ plan_code: "monthly" }, platform);
  assert.match(issued.activation_code, /^BD-[A-F0-9]{48}$/);
  assert.equal(f.state.vouchers[0].code_hash.length, 64);
  assert.equal(JSON.stringify(f.state).includes(issued.activation_code), false);
  f.state.plans[0].duration_days = 365;
  f.state.plans[0].shop_limit = 99;
  const list = await f.services.listVouchers(platform);
  assert.equal(list.rows[0].duration_days, 30);
  assert.equal(list.rows[0].shop_limit, 2);
  assert.equal(list.rows[0].member_limit, 0);
  assert.equal(JSON.stringify(list).includes("code_hash"), false);
  assert.equal(JSON.stringify(list).includes(issued.activation_code), false);
  f.state.grants[0].active = 0;
  await assert.rejects(f.services.listVouchers(platform), error => error.statusCode === 403);
  await assert.rejects(f.services.issueVoucher({ plan_code: "monthly" }, platform), error => error.statusCode === 403);
});

test("redemption only activates current tenant, consumes once, and never creates or changes membership", async () => {
  const f = fixture();
  const first = await f.register("-a"), second = await f.register("-b");
  const memberships = structuredClone(f.state.members);
  const issued = await f.services.issueVoucher({ plan_code: "monthly" }, platform);
  const result = await f.services.activate({ activation_code: issued.activation_code.toLowerCase() }, first);
  assert.equal(result.membership.remaining_days, 30);
  assert.equal(result.membership.access_allowed, true);
  assert.equal(result.membership.tenant_id, first.tenant.id);
  assert.equal(f.state.tenants.find(tenant => tenant.id === second.tenant.id).subscription_status, "unactivated");
  assert.deepEqual(f.state.members, memberships);
  assert.equal(f.state.vouchers[0].used_by_tenant_id, first.tenant.id);
  assert.equal(f.state.vouchers[0].used_by_person_id, first.personId);
  await assert.rejects(f.services.activate({ activation_code: issued.activation_code }, second), error => error.statusCode === 400);
  assert.equal((await f.services.membership(first)).remaining_days, 30);
});

test("concurrent claims allow exactly one winner and consumption failure rolls back tenant entitlement", async () => {
  const f = fixture();
  const first = await f.register("-a"), second = await f.register("-b");
  const issued = await f.services.issueVoucher({ plan_code: "monthly" }, platform);
  f.state.failConsume = true;
  await assert.rejects(f.services.activate({ activation_code: issued.activation_code }, first), error => error.statusCode === 409);
  assert.equal((await f.services.membership(first)).access_allowed, false);
  assert.equal(f.state.vouchers[0].status, "active");
  f.state.failConsume = false;
  const results = await Promise.allSettled([first, second].map(session => f.services.activate({ activation_code: issued.activation_code }, session)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.state.tenants.filter(tenant => tenant.slug !== "default" && tenant.subscription_status === "active").length, 1);
  assert.ok(f.statements.some(call => call.sql.includes("code_hash = ? FOR UPDATE")));
});

test("renewal retains remaining duration and uses the issued snapshot even after a plan changes", async () => {
  const f = fixture();
  const session = await f.register();
  const first = await f.services.issueVoucher({ plan_code: "monthly" }, platform);
  await f.services.activate({ activation_code: first.activation_code }, session);
  f.setClock(NOW + DAY);
  const next = await f.services.issueVoucher({ plan_code: "monthly" }, platform);
  f.state.plans[0].duration_days = 7;
  const renewal = await f.services.activate({ activation_code: next.activation_code }, session);
  assert.equal(renewal.membership.expires_at, new Date(NOW + 60 * DAY).toISOString());
  assert.equal(renewal.membership.remaining_days, 59);
  f.setClock(NOW + 100 * DAY);
  const expiredRenewalCode = await f.services.issueVoucher({ plan_code: "monthly" }, platform);
  const renewedExpired = await f.services.activate({ activation_code: expiredRenewalCode.activation_code }, session);
  assert.equal(renewedExpired.membership.remaining_days, 7);
});

test("expired, revoked, old bound, malformed and forged-target vouchers fail without entitlement changes", async () => {
  const f = fixture();
  const session = await f.register();
  const issued = await f.services.issueVoucher({ plan_code: "monthly" }, platform);
  await f.services.revokeVoucher(issued.id, platform);
  await assert.rejects(f.services.activate({ activation_code: issued.activation_code }, session));
  const expired = await f.services.issueVoucher({ plan_code: "monthly", redeemable_until: new Date(NOW + DAY).toISOString() }, platform);
  f.setClock(NOW + DAY);
  for (const body of [{ activation_code: expired.activation_code }, { activation_code: "OZ-" + "A".repeat(48) },
    { activation_code: "BD-" + "0".repeat(48) }, { activation_code: issued.activation_code, tenant_id: 1 }]) await assert.rejects(f.services.activate(body, session));
  assert.equal((await f.services.membership(session)).access_allowed, false);
  assert.equal((await f.services.listVouchers(platform)).rows[0].status, "expired");
});

test("fresh owner, account and suspension checks prevent stale-session activation", async () => {
  const f = fixture();
  const session = await f.register();
  const issued = await f.services.issueVoucher({ plan_code: "monthly" }, platform);
  const redeem = () => f.services.activate({ activation_code: issued.activation_code }, session);
  f.state.members[0].role = "member";
  await assert.rejects(redeem(), error => error.statusCode === 403);
  f.state.members[0].role = "owner";
  f.state.people.find(person => person.id === session.personId).active = 0;
  await assert.rejects(redeem(), error => error.statusCode === 403);
  f.state.people.find(person => person.id === session.personId).active = 1;
  f.state.tenants.find(tenant => tenant.id === session.tenant.id).subscription_status = "suspended";
  assert.equal((await f.services.membership(session)).can_activate, false);
  await assert.rejects(redeem(), error => error.statusCode === 403);
  assert.equal(f.state.vouchers[0].status, "active");
});

test("subscription summary handles expiry boundary, remaining partial days and perpetual historical access", () => {
  const tenant = { id: 2, name: "企业", plan_code: "monthly", status: "active", subscription_status: "active", subscription_expires_at: new Date(NOW) };
  assert.equal(membershipSummary(tenant, "owner", NOW).status, "expired");
  assert.equal(membershipSummary(tenant, "owner", NOW - 1).remaining_days, 1);
  assert.equal(membershipSummary({ ...tenant, subscription_expires_at: null }, "owner", NOW).remaining_days, null);
  assert.equal(membershipSummary({ ...tenant, subscription_expires_at: null }, "owner", NOW).can_activate, false);
  assert.equal(membershipSummary({ ...tenant, status: "archived" }, "owner", NOW - DAY).access_allowed, false);
});

test("unactivated access admits only exact safe tool/preferences/version routes and keeps business writes closed", () => {
  const session = { personId: 3, roles: ["operator"], tenant: { id: 2, slug: "customer", role: "owner", access_allowed: false } };
  const decide = (method, path, actor = session) => subscriptionAccessDecision(actor, ["api", ...path.split("/")], method);
  for (const path of ["tools/pricing/logistics-rules", "tools/pricing/reference-rate", "tools/pricing/rfbs-marketplace", "system/info", "system/update-status", "user-preferences"]) assert.equal(decide("GET", path).allowed, true);
  assert.equal(decide("POST", "user-preferences").allowed, true);
  for (const [method, path] of [["POST", "tools/pricing/logistics-rules"], ["GET", "tools/pricing/logistics-rules/secret"], ["GET", "orders"], ["GET", "shops"],
    ["POST", "listing/media/upload"], ["POST", "enterprise/messages/send"], ["GET", "dashboard"], ["GET", "logistics-rules"], ["DELETE", "user-preferences"]]) {
    assert.equal(decide(method, path).status, 402, `${method} ${path}`);
  }
  assert.equal(decide("GET", "orders", { ...session, tenant: { ...session.tenant, access_allowed: true } }).allowed, true);
  assert.equal(decide("GET", "system/info", { ...session, tenant: null }).allowed, false);
  assert.equal(decide("GET", "tenants/subscription-vouchers", platform).allowed, true);
});

test("registration auth route returns the resolved unactivated session and rate-limits before account creation", async () => {
  let calls = 0;
  const session = { personId: 2, roles: ["operator"], tenant: { id: 4, slug: "workspace-test", role: "owner", subscription_status: "unactivated", access_allowed: false } };
  const row = { id: 2, name: "新卖家", username: "seller", role: "operator" };
  const overrides = { getClientIp: () => "test-ip", consumeRateLimit: () => ({ allowed: true }), registerAccount: async body => { calls += 1; assert.deepEqual(body, registration); return row; }, createSession: async () => "new-token", getSession: async () => session };
  const req = { method: "POST", headers: {} }, url = new URL("http://localhost/api/auth/register");
  const result = await createAuthHandler(async () => registration, overrides)(req, url)();
  assert.equal(result.token, "new-token");
  assert.equal(result.user.tenant.access_allowed, false);
  assert.equal(req._sensitiveResponse, true);
  const limited = await createAuthHandler(async () => registration, { ...overrides, consumeRateLimit: () => ({ allowed: false }) })(req, url)();
  assert.equal(limited.__status, 429);
  assert.equal(calls, 1);
});

test("membership auth APIs reject unauthenticated requests and activation throttles before reading a secret", async () => {
  for (const [method, path] of [["GET", "membership"], ["POST", "activate"]]) {
    const req = { method, headers: {} };
    const result = await createAuthHandler(async () => { throw new Error("Must not read body"); }, { getSession: async () => null })(req, new URL(`http://localhost/api/auth/${path}`))();
    assert.equal(result.__status, 401);
    assert.equal(req._sensitiveResponse, true);
  }
  const req = { method: "POST", headers: { authorization: "Bearer test-token" } };
  const result = await createAuthHandler(async () => { throw new Error("Must not read body"); }, { getSession: async () => ({ personId: 2 }), getClientIp: () => "test-ip", consumeRateLimit: () => ({ allowed: false }) })(req, new URL("http://localhost/api/auth/activate"))();
  assert.equal(result.__status, 429);
});
