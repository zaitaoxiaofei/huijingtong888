import assert from "node:assert/strict";
import test from "node:test";
import { createExchangeRateToolRoutes } from "../src/server/routes/exchangeRateTool.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { subscriptionAccessDecision } from "../src/server/subscription-access.js";

const db = { query: async () => { throw Error("Route must use supplied authorization and read handlers"); } };
const member = (slug = "customer-a", roles = ["operator"]) => ({ personId: 8, roles, tenant: { id: 10, slug, role: "member", access_allowed: true } });

test("only the two exact shared GET endpoints open to ordinary active enterprise members", () => {
  for (const slug of ["default", "customer-a", "customer-b"]) {
    const session = member(slug);
    for (const suffix of ["tool", "tool/today"]) {
      const parts = ["api", "exchange-rates", ...suffix.split("/")];
      assert.equal(authorizeApiRequest({ _session: session, method: "GET" }, parts).allowed, true);
      assert.equal(tenantIsolationDecision(session, parts, "GET").allowed, true);
      assert.equal(subscriptionAccessDecision(session, parts, "GET").allowed, true);
      assert.equal(subscriptionAccessDecision({ ...session, tenant: { ...session.tenant, access_allowed: false } }, parts, "GET").allowed, false);
      assert.equal(authorizeApiRequest({ method: "GET" }, parts).allowed, false);
      assert.equal(authorizeApiRequest({ _session: session, method: "POST" }, parts).allowed, false);
    }
    for (const suffix of ["daily-archive", "tool/extra"]) {
      const parts = ["api", "exchange-rates", suffix];
      assert.equal(authorizeApiRequest({ _session: session, method: "GET" }, parts).allowed, false);
    }
  }
});

test("tool financial scope comes only from fresh membership and permission, never a query enterprise", async () => {
  let received, calls = 0;
  const routes = createExchangeRateToolRoutes({ db,
    authorizeSession: async session => { calls++;return { ...session, roles: ["admin"], tenant: { id: 10, slug: "customer-a", role: "member" } }; },
    tool: async (_, options) => { received = options;return { month_impact: {} }; }
  });
  await routes["GET /api/exchange-rates/tool"]({ _session: member(), query: { range: "year" } });
  assert.equal(calls, 1);
  assert.deepEqual(received.tenantScope, { id: 10, isDefault: false, financeAuthorized: true });
  const downgraded = createExchangeRateToolRoutes({ db, authorizeSession: async () => member(), tool: async (_, options) => options });
  assert.equal((await downgraded["GET /api/exchange-rates/tool"]({ _session: member("customer-a", ["admin"]) })).tenantScope, null);
});

test("revocation rejects before financial reading; platform-only access never synthesizes default membership", async () => {
  let reads = 0;
  const denied = createExchangeRateToolRoutes({ db, authorizeSession: async () => { throw Object.assign(Error("membership revoked"), { statusCode: 403 }); }, tool: async () => { reads++; } });
  await assert.rejects(denied["GET /api/exchange-rates/tool"]({ _session: member() }), { statusCode: 403 });
  assert.equal(reads, 0);
  const publicOnly = createExchangeRateToolRoutes({ db, authorizeSession: async () => { throw Error("No enterprise lookup allowed"); }, tool: async (_, options) => options });
  assert.equal((await publicOnly["GET /api/exchange-rates/tool"]({ _session: { platform_role: "super_admin", tenant: null } })).tenantScope, null);
});

test("the home card reads only today's public rate and rejects misleading enterprise selectors", async () => {
  let reads = 0;
  const routes = createExchangeRateToolRoutes({ db, today: async () => { reads++;return { public: { today: { available: true, rate: 12 } } }; }, authorizeSession: async () => { throw Error("No business query for public home card"); } });
  assert.equal((await routes["GET /api/exchange-rates/tool/today"]({ _session: member() })).public.today.rate, 12);
  assert.equal(reads, 1);
  for (const key of ["tenant_id", "tenantId", "shop_id", "shopId"]) assert.throws(() => routes["GET /api/exchange-rates/tool/today"]({ query: { [key]: "20" } }), { statusCode: 400 });
});
