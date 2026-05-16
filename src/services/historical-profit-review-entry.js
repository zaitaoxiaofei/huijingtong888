import { db } from "../db.js";
import { invalidateExceptionWorkbenchCache } from "./orders.js";
import {
  applyHistoricalProfitReviewAction as applyHistoricalProfitReviewActionService,
  cleanupHistoricalDeliveredReturnLoss as cleanupHistoricalDeliveredReturnLossService,
  historicalProfitReview as historicalProfitReviewService
} from "./historical-profit-review.js";

function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

function get(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function nullable(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number(value);
}

function createHistoricalProfitReviewDeps() {
  const runtime = globalThis.__ozonHistoricalProfitReviewRuntime;
  if (!runtime) {
    throw new Error("Historical profit review runtime is not configured");
  }
  return {
    all,
    db,
    get,
    invalidateExceptionWorkbenchCache,
    nullable,
    reapplySyncedOzonFinance: runtime.reapplySyncedOzonFinance,
    recalculateOrderProfit: runtime.recalculateOrderProfit,
    refreshProfitAnalyticsSnapshots: runtime.refreshProfitAnalyticsSnapshots,
    roundMoney
  };
}

export function configureHistoricalProfitReviewRuntime(runtime) {
  globalThis.__ozonHistoricalProfitReviewRuntime = runtime;
}

export function historicalProfitReview(query = {}) {
  return historicalProfitReviewService(createHistoricalProfitReviewDeps(), query);
}

export function cleanupHistoricalDeliveredReturnLoss(body = {}) {
  return cleanupHistoricalDeliveredReturnLossService(createHistoricalProfitReviewDeps(), body);
}

export function applyHistoricalProfitReviewAction(body = {}, userId = null) {
  return applyHistoricalProfitReviewActionService(createHistoricalProfitReviewDeps(), body, userId);
}
