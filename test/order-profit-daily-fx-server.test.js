import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { listOrderProfitDailyFx } from "../src/services/order-profit-daily-fx.js";
import { ORDER_PROFIT_DAILY_FX_JOB } from "../src/services/order-profit-daily-fx-job.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { subscriptionAccessDecision } from "../src/server/subscription-access.js";
import { createApiDocumentation } from "../src/server/api-docs.js";

test("daily history rejects invalid ranges, injection-shaped dates and unsafe pagination before querying", async () => {
  const db = { query: () => { throw Error("invalid filters must not reach DB"); } };
  for (const query of [{ from: "2026-02-30" }, { from: "2026-10-26' OR 1=1" }, { from: "2026-10-27", to: "2026-10-26" }, { page: "0" }, { page: "1.1" }, { page: "9007199254740992" }, { pageSize: "101" }, { pageSize: "-1" }]) {
    await assert.rejects(listOrderProfitDailyFx(db, query), { code: "ORDER_PROFIT_DAILY_FX_FILTER_INVALID", statusCode: 400 });
  }
});

test("archive audit is platform-only and does not expand enterprise or expired subscription privileges", () => {
  const parts = ["api", "exchange-rates", "daily-archive"];
  const platform = { platform_role: "super_admin", roles: [], tenant: null };
  assert.equal(authorizeApiRequest({ _session: platform, method: "GET" }, parts).allowed, true);
  assert.equal(tenantIsolationDecision(platform, parts, "GET").allowed, true);
  assert.equal(subscriptionAccessDecision(platform, parts, "GET").allowed, true);
  assert.equal(authorizeApiRequest({ method: "GET" }, parts).allowed, false);
  for (const slug of ["default", "customer-a", "customer-b"]) {
    const member = { roles: ["admin", "operations"], tenant: { id: 2, slug, role: "owner", access_allowed: true } };
    assert.equal(authorizeApiRequest({ _session: member, method: "GET" }, parts).allowed, false);
    assert.equal(tenantIsolationDecision(member, parts, "GET").allowed, false);
    assert.equal(subscriptionAccessDecision({ ...member, tenant: { ...member.tenant, access_allowed: false } }, parts, "GET").allowed, false);
  }
});

test("server wires bounded archive into existing scheduler and a DB-only route, with generated API documentation", () => {
  assert.equal(ORDER_PROFIT_DAILY_FX_JOB.intervalMinutes, 15);assert.equal(ORDER_PROFIT_DAILY_FX_JOB.catchupEnabled, true);assert.equal(ORDER_PROFIT_DAILY_FX_JOB.maxCatchupRuns, 1);
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /const scheduledJobDefinitions = \[\s*ORDER_PROFIT_DAILY_FX_JOB,/);
  assert.match(server, /order_profit_daily_fx_archive: withForegroundApiDeferral\("order_profit_daily_fx_archive", \(\) => \{\s*dailyFxArchiveFirstDueAt = 0;\s*return runOrderProfitDailyFxArchive\(orderProfitDailyFxDb\);/);
  assert.match(server, /"GET \/api\/exchange-rates\/daily-archive": \(req\) => listOrderProfitDailyFx\(orderProfitDailyFxDb, req.query \|\| \{\}\)/);
  assert.ok(createApiDocumentation().sections.flatMap(section => section.endpoints).some(endpoint => endpoint.method === "GET" && endpoint.path === "/api/exchange-rates/daily-archive"));
});

test("continuous foreground deferrals cannot keep resetting the daily archive's first-run due time", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = source.match(/function criticalJobForegroundDeferralExpired\([\s\S]*?\n}\nconst BACKGROUND_ORDER_SYNC/)[0].replace(/\nconst BACKGROUND_ORDER_SYNC$/, "");
  let clock = Date.parse("2026-10-26T00:00:00Z");
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ Date: Clock, Number, Math, String, FOREGROUND_DEFERRAL_BOUNDED_JOBS: new Set(["order_profit_daily_fx_archive"]), BACKGROUND_CRITICAL_JOB_MAX_DEFERRAL_MS: 300000,
    dailyFxArchiveFirstDueAt: 0, oglMonitorFirstDueAt: 0 });
  vm.runInContext(fn, context);
  const firstDue = new Date(clock);
  assert.equal(context.criticalJobForegroundDeferralExpired("order_profit_daily_fx_archive", { plannedFor: firstDue, intervalMinutes: 15 }), false);
  clock += 301000;
  assert.equal(context.criticalJobForegroundDeferralExpired("order_profit_daily_fx_archive", { plannedFor: new Date(clock), intervalMinutes: 15 }), true);
});

test("failed daily archive remains failed in job history and retries after 15 minutes; other jobs preserve existing backoff", async () => {
  const source = readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");
  const fn = source.match(/async function finishRunFailure\([\s\S]*?\n}\n\nasync function finishRunSkipped/)[0].replace(/\n\nasync function finishRunSkipped$/, "");
  for (const [key, interval, expected] of [["order_profit_daily_fx_archive", 15, 15], ["other_interval_job", 15, 5], ["other_slow_job", 360, 60]]) {
    const queries = [], start = Date.now();
    const context = vm.createContext({ Date, Math, Number, compactError: error => error.message,
      withMysqlTransaction: callback => callback({ execute: async (sql, parameters) => { queries.push({ sql, parameters }); } }),
      sqlDate: date => date.toISOString(), addMinutes: (date, minutes) => new Date(date.getTime() + minutes * 60000) });
    vm.runInContext(fn, context);
    await context.finishRunFailure({ job_key: key, interval_minutes: interval, id: 1, locked_by: "fixture" }, 7, new Error("missing 2026-10-26"));
    assert.equal(queries.length, 2);assert.match(queries[0].sql, /scheduled_job_runs[\s\S]*status = 'failed'/);
    assert.match(queries[1].sql, /last_status = 'failed'/);assert.equal(queries[1].parameters[0], "missing 2026-10-26");
    const retryAfter = Date.parse(queries[1].parameters[1]) - start;
    assert.ok(Math.abs(retryAfter - expected * 60000) < 1000);
  }
});
