import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const scheduledJobsSource = readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");

test("scheduled heavy jobs defer while foreground API traffic is active", () => {
  assert.match(configSource, /backgroundTaskForegroundIdleSeconds/);
  assert.match(serverSource, /function trackForegroundApiRequest/);
  assert.match(serverSource, /function foregroundApiDeferral/);
  assert.match(serverSource, /String\(context\?\.mode \|\| ""\) === "manual"/);
  assert.match(serverSource, /reason: "foreground_api_active"/);
  assert.match(serverSource, /reason: "foreground_api_recent"/);
  assert.match(serverSource, /reason: "database_pool_pressure"/);
  assert.match(serverSource, /function backgroundJobDeferral/);
  assert.match(serverSource, /order_status_sync: withForegroundApiDeferral/);
  assert.match(serverSource, /advertising_today_sync: withForegroundApiDeferral/);
  assert.match(serverSource, /seller_analytics_daily_sync: withForegroundApiDeferral/);
  assert.match(serverSource, /listing_publish_record_sync: withForegroundApiDeferral/);
  assert.match(serverSource, /ozon_action_cleanup: withForegroundApiDeferral/);
  assert.match(serverSource, /scheduled_history_cleanup: withForegroundApiDeferral/);
});

test("critical background jobs cannot be starved indefinitely by foreground traffic", () => {
  assert.match(configSource, /backgroundCriticalJobMaxDeferralSeconds:\s*readNumberEnv\("BACKGROUND_CRITICAL_JOB_MAX_DEFERRAL_SECONDS", 300\)/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"order_status_sync"/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"cancelled_order_sync"/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"posting_detail_sync"/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"ozon_action_cleanup"/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"advertising_sync"/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"advertising_today_sync"/);
  assert.match(serverSource, /criticalJobForegroundDeferralExpired\(jobKey, context\)/);
  assert.match(serverSource, /Date\.now\(\) - plannedFor\.getTime\(\) >= maxDeferralMs/);
  assert.match(serverSource, /beforeRun: \(\{ key, mode, plannedFor, lastSuccessAt, intervalMinutes, config: jobConfig \}\)/);
  assert.match(serverSource, /foregroundApiDeferral\(jobKey, context\) \|\| databasePoolDeferral\(jobKey, context\)/);
});

test("hourly posting detail sync reconciles recent order gaps before refreshing statuses", () => {
  assert.match(configSource, /backgroundPostingDetailReconciliationDays:\s*readNumberEnv\("BACKGROUND_POSTING_DETAIL_RECONCILIATION_DAYS", 2\)/);
  const handler = serverSource.match(/async function runBackgroundPostingDetailSync\(\)[\s\S]*?\n}\n\nasync function runBackgroundPostingDetailDeepSync/)?.[0] || "";
  assert.match(handler, /rollingOrderSyncWindow\(BACKGROUND_POSTING_DETAIL_RECONCILIATION_DAYS\)/);
  assert.match(handler, /services\.syncDemoOrders\(\{[\s\S]*skip_post_processing: true/);
  assert.match(handler, /services\.syncKnownOzonPostingDetails\(/);
  assert.match(handler, /reconciliation:/);
});

test("order sync foreground deferral is bounded from its last successful interval", () => {
  assert.match(serverSource, /jobKey === "order_status_sync"[\s\S]*60_000/);
  assert.match(serverSource, /lastSuccessAt\.getTime\(\) \+ intervalMs/);
  assert.match(serverSource, /Date\.now\(\) - \(lastSuccessAt\.getTime\(\) \+ intervalMs\) >= maxDeferralMs/);
  assert.match(scheduledJobsSource, /lastSuccessAt: fromSqlDate\(job\.last_success_at\)/);
  assert.match(scheduledJobsSource, /intervalMinutes: Number\(job\.interval_minutes \|\| 0\)/);
  assert.equal((scheduledJobsSource.match(/lastSuccessAt: fromSqlDate\(job\.last_success_at\)/g) || []).length, 2);
});

test("slow API logs expose runtime and database pressure", () => {
  assert.match(serverSource, /getMysqlPoolMetrics/);
  assert.match(serverSource, /\[runtime-health\]/);
  assert.match(serverSource, /event_loop_lag=/);
  assert.match(serverSource, /db_active=/);
  assert.match(serverSource, /rss_mb=/);
});
