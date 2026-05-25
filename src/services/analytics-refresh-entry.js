import { refreshProfitAnalyticsSnapshots as refreshProfitAnalyticsSnapshotsService } from "./analytics-refresh.js";

function analyticsRefreshRuntime() {
  const runtime = globalThis.__ozonAnalyticsRefreshRuntime;
  if (!runtime) throw new Error("Analytics refresh runtime is not configured");
  return runtime;
}

export function configureAnalyticsRefreshRuntime(runtime) {
  globalThis.__ozonAnalyticsRefreshRuntime = runtime;
}

export function refreshProfitAnalyticsSnapshots(body = {}) {
  const runtime = analyticsRefreshRuntime();
  return refreshProfitAnalyticsSnapshotsService({
    buildOrderOutcomeSql: runtime.buildOrderOutcomeSql,
    chinaDateSql: runtime.chinaDateSql,
    execute: runtime.execute,
    queryOne: runtime.queryOne,
    db: runtime.db,
    get: runtime.get
  }, body);
}
