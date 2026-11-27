import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createDisplayReadScope } from "../frontend/admin/utils/display-read-scope.js";
import { dashboardPollResponse } from "../src/services/dashboard-poll-response.js";
import { createDashboardHandler } from "../src/server/routes/dashboard.js";

test("display reads pause and abort on hiding/deactivation but resume exactly once", () => {
  let starts = 0, stops = 0;
  const scope = createDisplayReadScope({ onResume: () => starts++, onPause: () => stops++ });
  scope.activate(); scope.activate();
  const first = scope.controller();
  scope.setVisible(false);
  assert.equal(first.signal.aborted, true); assert.equal(scope.controller(), null);
  scope.deactivate(); scope.setVisible(true);
  assert.equal(starts, 1);
  scope.activate(); assert.equal(starts, 2);
  const second = scope.controller(); scope.dispose();
  scope.activate(); scope.setVisible(false); scope.setVisible(true); scope.resetAuthorization();
  assert.equal(second.signal.aborted, true); assert.equal(starts, 2); assert.equal(stops, 2);
});

for (const status of [401, 403]) test(`display HTTP ${status} blocks automatic and manual reads until a fresh verification`, () => {
  let starts = 0;
  const scope = createDisplayReadScope({ onResume: () => starts++ });
  scope.activate(); const controller = scope.controller();
  assert.equal(scope.reject({ status }), true); assert.equal(controller.signal.aborted, true);
  scope.deactivate(); scope.activate(); scope.setVisible(false); scope.setVisible(true);
  assert.equal(scope.canRead(), false); assert.equal(scope.controller(), null); assert.equal(starts, 1);
  scope.resetAuthorization(); assert.equal(scope.canRead(), true); assert.equal(starts, 2);
  scope.reject({ status: 502 }); assert.equal(scope.canRead(), true);
});

const member = { personId: 7, tenant: { id: 2, role: "member" }, roles: ["operations"] };
const finance = { ...member, tenant: { id: 2, role: "admin" } };
const metrics = { snapshot: { status: "building", date_key: "2026-11-27" },
  commerce: { today: { effective_orders: 4, profit: 123 } }, summary: { inventory_total_value: 567 } };

test("dashboard status polls reveal only metadata and hash the current caller's visible metrics", () => {
  const before = JSON.stringify(metrics);
  const full = dashboardPollResponse(metrics, member);
  const status = dashboardPollResponse(metrics, member, { statusOnly: true });
  assert.equal(status.status_only, true); assert.equal(status.commerce, undefined); assert.equal(status.summary, undefined);
  assert.equal(status.snapshot.revision, full.snapshot.revision);
  assert.equal(full.commerce.today.profit, undefined);
  const changedSecret = { ...metrics, commerce: { today: { effective_orders: 4, profit: 999 } } };
  assert.equal(dashboardPollResponse(changedSecret, member).snapshot.revision, full.snapshot.revision);
  assert.notEqual(dashboardPollResponse(changedSecret, finance).snapshot.revision, dashboardPollResponse(metrics, finance).snapshot.revision);
  const progress = { ...metrics, commerce: { today: { effective_orders: 5, profit: 123 } } };
  assert.notEqual(dashboardPollResponse(progress, member).snapshot.revision, full.snapshot.revision);
  assert.equal(dashboardPollResponse(full, member).snapshot.revision, full.snapshot.revision, "an existing revision never hashes itself");
  assert.equal(JSON.stringify(metrics), before);
});

test("status-only dashboard reads authorize first, select the current tenant and cannot force a rebuild", async () => {
  const calls = [];
  const handler = createDashboardHandler({ authorize: async () => member, dashboard: async (query, tenant) => {
    calls.push({ query, tenant }); return metrics;
  } });
  const response = await handler({ _session: finance, query: { statusOnly: "1", refresh: "1", tenant_id: 99 } });
  assert.equal(calls[0].tenant, 2); assert.equal(calls[0].query.refresh, "0"); assert.equal(calls[0].query.snapshotOnly, "1");
  assert.equal(response.status_only, true);
  const denied = createDashboardHandler({ authorize: async () => { throw Object.assign(new Error("revoked"), { statusCode: 403 }); },
    dashboard: async () => { throw Error("unauthorized dashboard read"); } });
  await assert.rejects(denied({ _session: member }), /revoked/);
});

const notificationSource = readFileSync(new URL("../src/services/system-notifications.js", import.meta.url), "utf8");
const notificationFunction = notificationSource.slice(notificationSource.indexOf("export async function listSystemNotifications"),
  notificationSource.indexOf("export async function markSystemNotificationRead")).replace(/^export /, "");
function notificationsFixture() {
  const calls = [], stats = { total: 3, unread: 1, resolved: 0, latest_id: 12, created_at: "2026-11-27T00:00:00Z" };
  const context = { createHash, notificationScope: async session => ({ id: session.tenant.id }),
    personId: session => session.personId, inventoryTenantSql: scope => `sn.tenant_id = ${Number(scope.id)}`, PAGE_SIZE_MAX: 100,
    mysqlQuery: async (sql, params) => { calls.push({ sql, params }); return sql.includes("COUNT(*)") ? [{ ...stats }] : [{ id: 12, content: "fixture notification body" }]; } };
  const list = vm.runInNewContext(`(${notificationFunction})`, context);
  return { list, calls, stats };
}

test("closed notification polling returns counts without selecting titles or message bodies", async () => {
  const fixture = notificationsFixture();
  const response = await fixture.list({ summaryOnly: "1", pageSize: 50 }, member);
  assert.equal(response.unread, 1); assert.equal(response.total, 3); assert.equal(response.summary_only, true);
  assert.equal(response.rows, undefined); assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0].sql, /sn\.tenant_id = 2/); assert.equal(fixture.calls[0].params[0], 7);
  assert.doesNotMatch(fixture.calls[0].sql, /SELECT id, notification_type, title, content/);
});

test("unchanged open notifications omit repeated bodies and revisions never cross tenant/person/filter", async () => {
  const fixture = notificationsFixture();
  const initial = await fixture.list({ pageSize: 50 }, member);
  assert.equal(initial.rows[0].id, 12); assert.equal(fixture.calls.length, 2);
  const same = await fixture.list({ pageSize: 50, sinceRevision: initial.revision }, member);
  assert.equal(same.unchanged, true); assert.equal(same.rows, undefined); assert.equal(fixture.calls.length, 3);
  for (const [session, query] of [[{ ...member, tenant: { id: 3 } }, {}], [{ ...member, personId: 8 }, {}], [member, { status: "unread" }]]) {
    const changed = await fixture.list({ pageSize: 50, sinceRevision: initial.revision, ...query }, session);
    assert.notEqual(changed.revision, initial.revision); assert.equal(changed.rows[0].id, 12);
  }
  fixture.stats.unread = 0;
  const read = await fixture.list({ pageSize: 50, sinceRevision: initial.revision }, member);
  assert.equal(read.unread, 0); assert.equal(read.unchanged, undefined); assert.equal(read.rows.length, 1);
});
