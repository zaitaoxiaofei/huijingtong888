function tenantIdFromRequest(req) {
  return String(req.headers?.["x-tenant-id"] || req.query?.tenantId || req.query?.tenant_id || "admin").trim() || "admin";
}

export function createSellerAnalyticsRoutes({ services, readJson }) {
  return {
    "GET /api/db/seller-analytics/summary": (req) => services.sellerAnalyticsSummary(tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/metrics": (req, url) => services.sellerAnalyticsMetrics(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/analysis": (req, url) => services.sellerAnalyticsAnalysis(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/operation-todos": (req, url) => services.sellerAnalyticsOperationTodos(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/plugin-status": (req) => services.sellerAnalyticsPluginStatus(tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/auth-binding": (req, url) => services.sellerAnalyticsAuthBindingStatus(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/plugin-status/validate": (req, url) => services.sellerAnalyticsValidatePluginStatus(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/snapshots": (req, url) => services.sellerAnalyticsSnapshots(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/collect-runs": (req, url) => services.sellerAnalyticsCollectRuns(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "POST /api/db/seller-analytics/plugin-prepare": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsPreparePlugin(await readJson(req), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/collect-runs": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsCreateCollectRun(await readJson(req), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/direct-collect/start": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsStartDirectCollect(await readJson(req), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/operation-todos/refresh": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsRefreshOperationTodos(await readJson(req), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/snapshots/batch-delete": async (req) => {
      const body = await readJson(req);
      return services.sellerAnalyticsDeleteSnapshots(Array.isArray(body?.ids) ? body.ids : [], tenantIdFromRequest(req));
    }
  };
}

export async function handleSellerAnalyticsRestRoute({ req, res, parts, services, readJson, json }) {
  if (parts[0] !== "api" || parts[1] !== "db" || parts[2] !== "seller-analytics") return false;
  const tenantId = tenantIdFromRequest(req);

  if (req.method === "POST" && parts[3] === "collect-runs" && parts[4] && parts[5] === "retry") {
    return json(res, {
      success: true,
      data: await services.sellerAnalyticsRetryCollectRun(decodeURIComponent(parts[4]), tenantId)
    });
  }

  if (req.method === "DELETE" && parts[3] === "collect-runs" && parts[4]) {
    return json(res, await services.sellerAnalyticsDeleteCollectRun(decodeURIComponent(parts[4]), tenantId));
  }

  if (req.method === "DELETE" && parts[3] === "snapshots" && parts[4]) {
    return json(res, await services.sellerAnalyticsDeleteSnapshot(decodeURIComponent(parts[4]), tenantId));
  }

  return false;
}
