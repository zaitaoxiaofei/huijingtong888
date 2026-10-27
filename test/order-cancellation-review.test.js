import assert from "node:assert/strict";
import test from "node:test";
import { unclassifiedCancellationReasons, saveCancellationReasonClassification, matchReviewedCancellationReason, matchesCancellationRule } from "../src/services/order-cancellation-review.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { canAccessPage } from "../src/shared/permissions.js";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const platform = { personId: 1, platform_role: "super_admin", tenant: { id: 1, slug: "default", role: "owner" } };
const owner = { personId: 2, roles: [], tenant: { id: 2, slug: "a", role: "owner" } };
const operator = { personId: 3, roles: ["operations"], tenant: { id: 2, slug: "a", role: "member" } };
test("review routes and writes remain platform-only while packaging and logistics expose safe enterprise reads", async () => {
  for (const [method, path] of [["GET", "unclassified"], ["POST", "classifications"]]) {
    const parts = ["api", "order-cancellation-rules", path];
    assert.equal(authorizeApiRequest({ method, _session: platform }, parts).allowed, true);
    for (const session of [owner, operator]) {
      assert.equal(authorizeApiRequest({ method, _session: session }, parts).allowed, false);
      assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
    }
  }
  for (const session of [owner, operator]) {
    assert.equal(canAccessPage(session, "/order-cancellation-rules"), false);
    assert.equal(canAccessPage(session, "/ai-prompts"), false);
    assert.equal(canAccessPage(session, "/tools/packaging-fee-rule"), true);
    assert.equal(canAccessPage(session, "/logistics-settings"), true);
    assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "settings", "packaging-fee-rule"]).allowed, false);
    assert.equal(authorizeApiRequest({ method: "POST", _session: session }, ["api", "logistics-rules"]).allowed, false);
  }
  let reads = 0, writes = 0;
  await assert.rejects(unclassifiedCancellationReasons(async () => { reads++; }, {}, owner), { status: 403 });
  await assert.rejects(saveCancellationReasonClassification(async () => { writes++; }, { original: "unknown", reason_code: "wrong_item" }, owner), { status: 403 });
  assert.equal(reads + writes, 0);
  for (const path of ["/tools/packaging-fee-rule", "/logistics-settings"]) assert.equal(canAccessPage({ platform_role: "super_admin" }, path), true);
});

test("classification uses actual raw fields, skips disabled or unsupported types and never chooses a new loss formula", async () => {
  const rule = { match_text: "Unknown source reason", match_mode: "equals", reason_code: "wrong_item", enabled: 1 };
  assert.equal(matchesCancellationRule({ status: "cancelled", cancel_reason: " Unknown source reason " }, rule), true);
  assert.equal(matchReviewedCancellationReason("unknown SOURCE reason", [rule]), rule);
  assert.equal(matchReviewedCancellationReason("different", [rule]), null);
  assert.equal(matchReviewedCancellationReason("Unknown source reason", [{ ...rule, enabled: 0 }]), null);
  assert.equal(matchReviewedCancellationReason("Unknown source reason", [{ ...rule, reason_code: "arbitrary_new_formula" }]), null);
  assert.equal(matchReviewedCancellationReason({ original: "", reason_id: "9998" }, [{ ...rule, match_text: "reason_id:9998", note: "[reviewed-cancellation-reason]" }])?.reason_code, "wrong_item");
  for (const filters of [{ from: "2026-99-01" }, { from: "2026-02-30" }, { from: "2026-10-27", to: "2026-10-26" }, { from: "2024-01-01", to: "2026-10-26" }, { tenant_id: "2" }]) {
    await assert.rejects(unclassifiedCancellationReasons(async () => { throw Error("Query must not run"); }, filters, platform, new Date("2026-10-26T00:00:00Z")), { status: 400 });
  }
});

test("actual review SQL groups raw reasons, persists only exact classification and preserves all original orders", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async () => {
  const fixture = await createTenantMysqlFixture("cancel_review");
  try {
    const q = fixture.query;
    await q("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Default'),(20,2,'A'),(30,3,'B')");
    for (const [id, shop, reason, code] of [[1,10,"Unknown source reason",9001],[2,20,"Unknown source reason",9001],[3,30,"Second unknown reason",9002],[4,20,"buyer cancelled",0],[5,20,"",9998]]) {
      await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at,cancel_reason,cancel_reason_id,updated_at) VALUES(?,?,?,'cancelled','2026-10-20 00:00:00',?,?,'2026-10-25 18:00:00')", [id,shop,`fixture-${id}`,reason,code]);
    }
    const snapshot = JSON.stringify(await q("SELECT * FROM orders ORDER BY id"));
    const window = { from: "2026-10-26", to: "2026-10-26" };
    const before = await unclassifiedCancellationReasons(q, window, platform);
    assert.equal(before.pending.length, 3);
    assert.equal(before.pending.find(row => row.original === "Unknown source reason").order_count, 2);
    assert.equal(before.classified.length, 0);
    assert.ok(before.types.some(row => row.value === "wrong_item"));
    const transaction = async operation => {
      await fixture.connection.beginTransaction();
      try { const result = await operation({ query: (...args) => fixture.connection.query(...args), execute: (sql, params) => {
        assert.match(sql, /^INSERT INTO order_cancellation_rules/);
        return fixture.connection.execute(sql, params);
      } }); await fixture.connection.commit(); return result; }
      catch (error) { await fixture.connection.rollback(); throw error; }
    };
    const saved = await saveCancellationReasonClassification(transaction, { original: "Unknown source reason", reason_code: "wrong_item", note: "Official reason manually reviewed" }, platform);
    assert.equal(saved.historical_profit_changed, false);
    const again = await saveCancellationReasonClassification(transaction, { original: "Unknown source reason", reason_code: "wrong_item" }, platform);
    assert.equal(again.id, saved.id);
    assert.equal(again.reused, true);
    const after = await unclassifiedCancellationReasons(q, window, platform);
    assert.equal(after.pending.length, 2);
    assert.equal(after.classified.length, 1);
    assert.equal(after.classified[0].classification.reason_code, "wrong_item");
    assert.equal((await q("SELECT COUNT(*) AS n FROM order_cancellation_rules"))[0].n, 1);
    const codeOnly = await saveCancellationReasonClassification(transaction, { original: "", reason_id: "9998", reason_code: "delivery_failed" }, platform);
    assert.equal(codeOnly.historical_profit_changed, false);
    const reviewedCode = await unclassifiedCancellationReasons(q, window, platform);
    assert.equal(reviewedCode.pending.length, 1);
    assert.equal(reviewedCode.classified.find(row => row.reason_id === "9998").classification.reason_code, "delivery_failed");
    await assert.rejects(saveCancellationReasonClassification(transaction, { original: "Unknown source reason", reason_code: "delivery_failed" }, platform), { status: 409 });
    assert.equal(JSON.stringify(await q("SELECT * FROM orders ORDER BY id")), snapshot);
  } finally { await fixture.cleanup(); }
});
