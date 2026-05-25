import {
  reapplySyncedOzonFinance as reapplySyncedOzonFinanceService,
  syncOzonFinance as syncOzonFinanceService
} from "./finance-sync.js";

function syncRuntime() {
  const runtime = globalThis.__ozonSyncRuntime;
  if (!runtime) throw new Error("Sync runtime is not configured");
  return runtime;
}

export function configureSyncRuntime(runtime) {
  globalThis.__ozonSyncRuntime = runtime;
}

export async function syncDemoOrders(body = {}, options = {}) {
  return syncRuntime().syncDemoOrdersImpl(body, options);
}

export async function syncOzonIncrementalOrders(body = {}, options = {}) {
  return syncRuntime().syncOzonIncrementalOrdersImpl(body, options);
}

export async function syncOzonFinance(body = {}, options = {}) {
  const runtime = syncRuntime();
  return syncOzonFinanceService({
    all: runtime.all,
    classifyOrderOutcome: runtime.classifyOrderOutcome,
    currentExchangeRate: runtime.currentExchangeRate,
    dateKeyDaysAgo: runtime.dateKeyDaysAgo,
    db: runtime.db,
    describeCancellation: runtime.describeCancellation,
    estimateOutcomeReturnLoss: runtime.estimateOutcomeReturnLoss,
    exchangeRateForDate: runtime.exchangeRateForDate,
    fetchOzonFinanceTransactions: runtime.fetchOzonFinanceTransactions,
    get: runtime.get,
    lockProfitItem: runtime.lockProfitItem,
    nullable: runtime.nullable,
    ozonFinanceCategory: runtime.ozonFinanceCategory,
    packagingFeeForSaleAmount: runtime.packagingFeeForSaleAmount,
    refreshProfitAnalyticsSnapshots: runtime.refreshProfitAnalyticsSnapshots,
    refreshOrderProfitDetailSnapshots: runtime.refreshOrderProfitDetailSnapshots,
    resolveOrderLossProfile: runtime.resolveOrderLossProfile,
    roundMoney: runtime.roundMoney,
    rubToCny: runtime.rubToCny,
    shops: runtime.shops,
    todayDateKey: runtime.todayDateKey
  }, body, options);
}

export function reapplySyncedOzonFinance(body = {}) {
  const runtime = syncRuntime();
  return reapplySyncedOzonFinanceService({
    all: runtime.all,
    classifyOrderOutcome: runtime.classifyOrderOutcome,
    db: runtime.db,
    describeCancellation: runtime.describeCancellation,
    estimateOutcomeReturnLoss: runtime.estimateOutcomeReturnLoss,
    get: runtime.get,
    lockProfitItem: runtime.lockProfitItem,
    ozonFinanceCategory: runtime.ozonFinanceCategory,
    packagingFeeForSaleAmount: runtime.packagingFeeForSaleAmount,
    refreshProfitAnalyticsSnapshots: runtime.refreshProfitAnalyticsSnapshots,
    refreshOrderProfitDetailSnapshots: runtime.refreshOrderProfitDetailSnapshots,
    resolveOrderLossProfile: runtime.resolveOrderLossProfile,
    roundMoney: runtime.roundMoney
  }, body);
}
