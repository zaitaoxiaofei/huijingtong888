export function createProfitRoutes({ services, readJson }) {
  return {
    "GET /api/profit-ranking": (req, url) => services.profitRanking(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profit-reconciliation": (req, url) => services.profitReconciliation(Object.fromEntries(url.searchParams.entries())),
    "GET /api/pending-settlement-costs": (req, url) => services.pendingSettlementCosts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profit-reconciliation/products": (req, url) => services.profitReconciliation({
      ...Object.fromEntries(url.searchParams.entries()),
      view: "products"
    }),
    "GET /api/profit-reconciliation/items": (req, url) => services.profitReconciliation({
      ...Object.fromEntries(url.searchParams.entries()),
      view: "items"
    }),
    "GET /api/monthly-billing-details": (req, url) => services.monthlyBillingDetails(Object.fromEntries(url.searchParams.entries())),
    "GET /api/monthly-billing-orders": (req, url) => services.monthlyBillingOrders(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profit-aftersales": (req, url) => services.profitAftersales(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profit-aftersales/details": (req, url) => services.profitAftersalesDetails(Object.fromEntries(url.searchParams.entries())),
    "GET /api/profits/historical-review": (req, url) => services.historicalProfitReview(Object.fromEntries(url.searchParams.entries())),
    "POST /api/profit-snapshots/refresh": async (req) => services.refreshProfitAnalyticsSnapshots(await readJson(req)),
    "POST /api/order-profit-detail-snapshots/refresh": async (req) => services.refreshOrderProfitDetailSnapshots(await readJson(req)),
    "POST /api/profits/recalculate-historical": async (req) => services.recalculateHistoricalOrderProfits(await readJson(req)),
    "POST /api/profits/repair-terminal-no-revenue": async (req) => services.repairTerminalNoRevenueOrderProfits(await readJson(req)),
    "POST /api/profits/cleanup-delivered-return-loss": async (req) => services.cleanupHistoricalDeliveredReturnLoss(await readJson(req)),
    "POST /api/profits/cleanup-unconfirmed-actual-profit": async (req) => services.cleanupHistoricalUnconfirmedActualProfit(await readJson(req)),
    "POST /api/profits/historical-review/actions": async (req) => services.applyHistoricalProfitReviewAction(await readJson(req), req._session?.personId),
    "GET /api/ozon-finance/summary": () => services.ozonFinanceSummary()
  };
}
