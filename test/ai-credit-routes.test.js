import test from "node:test";
import assert from "node:assert/strict";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { handleAiCreditRoute } from "../src/server/routes/aiCredits.js";

const session = { personId: 7, roles: ["operations"], tenant: { id: 2, slug: "enterprise-2", role: "member", access_allowed: true } };
test("AI credit APIs admit exact read paths and keep settlement server-only", async () => {
  for (const path of ["wallet", "entries", "audit", "tasks/12345678-1234-1234-1234-123456789012"]) {
    const parts = ["api", "ai-credits", ...path.split("/")];
    assert.equal(authorizeApiRequest({ method: "GET", _session: session }, parts).allowed, true);
    assert.equal(tenantIsolationDecision(session, parts, "GET").allowed, true);
    assert.equal(authorizeApiRequest({ method: "POST", _session: session }, parts).allowed, false);
  }
  for (const action of ["accounts", "prices", "recharges", "reconcile"]) assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "platform", "ai-credits", action]).allowed, false);
  for (const action of ["reserve", "outcome", "attempt", "wallet/more"]) assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "ai-credits", ...action.split("/")]).allowed, false);
  let trusted;
  const req = { method: "GET", _session: session }, headers = {}, res = { setHeader: (key, value) => { headers[key] = value; } };
  await handleAiCreditRoute({ req, res, url: new URL("http://localhost:8788/api/ai-credits/wallet?tenantId=1"), parts: ["api", "ai-credits", "wallet"],
    ledger: { wallet: async value => { trusted = value; return { available_points: 20 }; } }, json: (_, value) => assert.equal(value.available_points, 20) });
  assert.equal(trusted, session); assert.equal(headers["Cache-Control"], "no-store");
});

test("missing credit tables return an explicit service setup error without hiding other SQL failures", async () => {
  const input = { req: { method: "GET", _session: session }, res: { setHeader() {} }, url: new URL("http://localhost:8788/api/ai-credits/wallet"), parts: ["api", "ai-credits", "wallet"], json() {} };
  await assert.rejects(handleAiCreditRoute({ ...input, ledger: { wallet: async () => { throw Object.assign(new Error("private SQL"), { code: "ER_NO_SUCH_TABLE" }); } } }), { code: "AI_CREDIT_SCHEMA_PENDING", status: 503 });
  await assert.rejects(handleAiCreditRoute({ ...input, ledger: { wallet: async () => { throw Object.assign(new Error("fixture failure"), { code: "ER_LOCK_DEADLOCK" }); } } }), { code: "ER_LOCK_DEADLOCK" });
});
