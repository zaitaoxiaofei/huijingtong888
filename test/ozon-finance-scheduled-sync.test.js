import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const scheduledJobsSource = readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");
const runtimeServicesSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");

test("Ozon finance synchronization is a critical recurring scheduled job", () => {
  assert.match(configSource, /backgroundOzonFinanceSyncIntervalMinutes: readNumberEnv\("BACKGROUND_OZON_FINANCE_SYNC_INTERVAL_MINUTES", 360\)/);
  assert.match(configSource, /backgroundOzonFinanceSyncDays: readNumberEnv\("BACKGROUND_OZON_FINANCE_SYNC_DAYS", 14\)/);
  assert.match(serverSource, /key: "ozon_finance_sync"[\s\S]*name: "Ozon 财务流水与结算同步"[\s\S]*priority: "critical"/);
  assert.match(serverSource, /ozon_finance_sync: withForegroundApiDeferral\("ozon_finance_sync", runBackgroundOzonFinanceSync\)/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"ozon_finance_sync"/);
});

test("scheduled finance synchronization fetches a rolling window and applies profit", () => {
  const handler = serverSource.match(/async function runBackgroundOzonFinanceSync\(context = \{\}\) \{[\s\S]*?\n\}\n\nasync function runBackgroundOzonStockSync/)?.[0] || "";
  assert.match(handler, /rollingOrderSyncWindow\(days\)/);
  assert.match(handler, /services\.syncOzonFinance\(\{ from: window\.from, to: window\.to \}/);
  assert.match(handler, /appliedItems: Number\(result\?\.applied\?\.items \|\| 0\)/);
  assert.match(scheduledJobsSource, /jobKey === "ozon_finance_sync"/);
  assert.match(scheduledJobsSource, /appliedItems: Number\(payload\.applied\?\.items \|\| 0\)/);
});

test("finance summary reports operation-date freshness instead of sync timestamp only", () => {
  assert.match(serviceSource, /MAX\(operation_date\) AS latest_operation_at/);
  assert.match(serviceSource, /AS operation_lag_days/);
  assert.match(serviceSource, /data_stale: Number\(summary\?\.operation_lag_days \|\| 0\) > 3/);
});

test("old unsettled finance facts are repaired by a daily bounded job", () => {
  assert.match(serverSource, /key: "historical_finance_profit_repair"[\s\S]*name: "历史未结算订单与真实利润巡检"[\s\S]*dailyTime: "04:10"/);
  assert.match(serverSource, /config: \{ ageDays: 60, limit: 5000 \}/);
  assert.match(serverSource, /repairHistoricalFinanceProfitFacts\(\{[\s\S]*only_issues: "1"[\s\S]*write: true/);
  assert.match(serverSource, /historical_finance_profit_repair: withForegroundApiDeferral\("historical_finance_profit_repair", runBackgroundHistoricalFinanceProfitRepair\)/);
  assert.match(scheduledJobsSource, /jobKey === "historical_finance_profit_repair"[\s\S]*selectedOrders[\s\S]*appliedItems/);
  assert.match(runtimeServicesSource, /repairHistoricalFinanceProfitFacts: repairHistoricalFinanceProfitFactsMysql/);
});
