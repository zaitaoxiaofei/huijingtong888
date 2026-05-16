export function createProfitRoutes({ services, readJson }) {
  return {
    "GET /api/profit-summary": (req, url) => services.profitSummary(
      url?.searchParams?.get("from") || "",
      url?.searchParams?.get("to") || "",
      { refresh: url?.searchParams?.get("refresh") === "1" || url?.searchParams?.get("refresh") === "true" }
    ),
    "GET /api/profit-dashboard": (req, url) => services.profitDashboard(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profit-ranking": (req, url) => services.profitRanking(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profit-ranking/details": (req, url) => services.profitRankingDetails(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profit-details": (req, url) => services.profitDetails(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profits/historical-review": (req, url) => services.historicalProfitReview(Object.fromEntries(url.searchParams.entries())),
    "POST /api/profit-snapshots/refresh": async (req) => services.refreshProfitAnalyticsSnapshots(await readJson(req)),
    "POST /api/profits/recalculate-historical": async (req) => services.recalculateHistoricalOrderProfits(await readJson(req)),
    "POST /api/profits/cleanup-delivered-return-loss": async (req) => services.cleanupHistoricalDeliveredReturnLoss(await readJson(req)),
    "POST /api/profits/historical-review/actions": async (req) => services.applyHistoricalProfitReviewAction(await readJson(req), req._session?.personId),
    "GET /api/ozon-finance/summary": () => services.ozonFinanceSummary()
  };
}
