import { tenantIdFromRequest } from "../tenant-context.js";

export { tenantIdFromRequest };

function queryFromUrl(url) {
  const query = Object.fromEntries(url.searchParams.entries());
  delete query.tenantId;
  delete query.tenant_id;
  return query;
}

async function payloadFromRequest(req, readJson) {
  const payload = await readJson(req);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const { tenant_id, tenantId, ...scopedPayload } = payload;
  return scopedPayload;
}

export function createSellerAnalyticsRoutes({ services, readJson }) {
  return {
    "GET /api/db/seller-analytics/summary": (req) => services.sellerAnalyticsSummary(tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/metrics": (req, url) => services.sellerAnalyticsMetrics(queryFromUrl(url), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/analysis": (req, url) => services.sellerAnalyticsAnalysis(queryFromUrl(url), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/operation-todos": (req, url) => services.sellerAnalyticsOperationTodos(queryFromUrl(url), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/plugin-status": (req, url) => services.sellerAnalyticsPluginStatus(tenantIdFromRequest(req), queryFromUrl(url)),
    "GET /api/db/seller-analytics/auth-binding": (req, url) => services.sellerAnalyticsAuthBindingStatus(queryFromUrl(url), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/browser-profile": (req, url) => services.sellerAnalyticsBrowserProfileStatus(queryFromUrl(url), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/plugin-status/validate": (req, url) => services.sellerAnalyticsValidatePluginStatus(queryFromUrl(url), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/snapshots": (req, url) => services.sellerAnalyticsSnapshots(queryFromUrl(url), tenantIdFromRequest(req)),
    "GET /api/db/seller-analytics/collect-runs": (req, url) => services.sellerAnalyticsCollectRuns(queryFromUrl(url), tenantIdFromRequest(req)),
    "POST /api/db/seller-analytics/plugin-prepare": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsPreparePlugin(await payloadFromRequest(req, readJson), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/collect-runs": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsCreateCollectRun(await payloadFromRequest(req, readJson), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/direct-collect/start": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsStartDirectCollect(await payloadFromRequest(req, readJson), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/browser-profile/prepare": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsPrepareBrowserProfile(await payloadFromRequest(req, readJson), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/browser-profile/confirm": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsConfirmBrowserProfile(await payloadFromRequest(req, readJson), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/operation-todos/refresh": async (req) => ({
      success: true,
      data: await services.sellerAnalyticsRefreshOperationTodos(await payloadFromRequest(req, readJson), tenantIdFromRequest(req))
    }),
    "POST /api/db/seller-analytics/snapshots/batch-delete": async (req) => {
      const body = await payloadFromRequest(req, readJson);
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
