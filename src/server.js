import http from "node:http";
import { Buffer } from "node:buffer";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { config } from "./config.js";
import { resolveUploadSubdirRoots } from "./runtime-uploads.js";
import { calculateCelFbsPricing } from "./celRates.js";
import { mysqlRuntimeServices } from "./services/mysql-runtime-services.js";
import { readForm, readJson, isRequestCancelledError } from "./http/request.js";
import { clearCookie, html, json, notFound, setCookie, text, writeHead } from "./http/response.js";
import { createStaticHandler } from "./http/static.js";
import { cleanExpiredSessions, createAuthHandler, extractToken, getSession } from "./server/session.js";
import { authorizeApiRequest } from "./server/authorization.js";
import { createApiDocumentation, renderApiDocumentationMarkdown } from "./server/api-docs.js";
import { createCatalogRoutes, handleCatalogRestRoute } from "./server/routes/catalog.js";
import { createOrderRoutes, handleOrderRestRoute } from "./server/routes/orders.js";
import { createPrintRoutes } from "./server/routes/print.js";
import { createOperationsRoutes, handleOperationsRestRoute } from "./server/routes/operations.js";
import { createTeamRoutes, handleTeamRestRoute } from "./server/routes/team.js";
import { createProfitRoutes } from "./server/routes/profit.js";
import { createAdvertisingRoutes } from "./server/routes/advertising.js";
import { createFinanceCenterRoutes, handleFinanceCenterRestRoute } from "./server/routes/financeCenter.js";
import { createPayrollRoutes } from "./server/routes/payroll.js";
import { createSellerAnalyticsRoutes, handleSellerAnalyticsRestRoute } from "./server/routes/sellerAnalytics.js";
import { createOzonActionRoutes } from "./server/routes/ozonActions.js";
import { createSyncRoutes } from "./server/routes/sync.js";
import { createReviewRoutes, handleReviewRestRoute } from "./server/routes/reviews.js";
import { createListingAutomationRoutes, handleListingAutomationRestRoute, handleMaterialPackageRestRoute } from "./server/routes/listingAutomation.js";
import { createAssetVariantEngineRoutes, handleAssetVariantEngineRestRoute } from "./server/routes/assetVariantEngine.js";
import { createAiGenerationTaskRoutes, handleAiGenerationTaskRestRoute } from "./server/routes/aiGenerationTasks.js";
import { cleanupAiGenerationTaskHistory } from "./services/ai-generation-tasks.js";
import { collectSkusWithSellerPool, collectorSellerPoolStatus } from "./services/collector-seller-pool.js";
import { createAiPromptTemplateRoutes, handleAiPromptTemplateRestRoute } from "./server/routes/aiPromptTemplates.js";
import { createAiStrategyRoutes, handleAiStrategyRestRoute } from "./server/routes/aiStrategies.js";
import { createMaterialAssetRoutes, handleMaterialAssetRestRoute } from "./server/routes/materialAssets.js";
import { createAiImageRoutes, handleAiImageRestRoute } from "./server/routes/aiImageRoutes.js";
import { createAiVariantLabRoutes, handleAiVariantLabRestRoute } from "./server/routes/aiVariantLab.js";
import { getAiTaskFile } from "./server/services/ai/aiWorkflowService.js";
import { createImageCropperRoutes, handleImageCropperRestRoute } from "./server/routes/tools/imageCropper.js";
import { createOnboardingKnowledgeRoutes, handleOnboardingKnowledgeRestRoute } from "./server/routes/onboardingKnowledge.js";
import {
  cleanupScheduledJobHistory,
  ScheduledJobScheduler,
  listScheduledJobs,
  logScheduledJobEvent,
  recoverInterruptedScheduledJobRuns,
  registerScheduledJobs,
  runScheduledJobNow,
  scheduledJobRunEvents,
  scheduledJobRuns,
  updateScheduledJobConfig,
  updateScheduledJobState
} from "./services/scheduled-jobs.js";
import {
  SITE_ACCESS_LOGIN_PATH,
  SITE_ACCESS_LOGOUT_PATH,
  SITE_ACCESS_SESSION_PATH,
  SITE_ACCESS_API_LOGIN_PATH,
  clearRateLimit,
  consumeRateLimit,
  createSiteAccessCookieValue,
  getClientIp,
  getSiteAccessCookieMaxAgeSeconds,
  getSiteAccessCookieName,
  getSiteAccessPassword,
  isDirectLocalRequest,
  isSiteAccessAuthorized,
  normalizeNextPath,
  renderSiteAccessPage,
  siteAccessUsesSecureCookie
} from "./server/access.js";
import { systemInfo } from "./server/maintenance.js";
import { checkDailyPurchaseNotification, globalUpdateStatus, subscribeGlobalUpdateEvents, updateGlobalUpdateStatus } from "./server/notifications.js";
import { shanghaiDateDaysAgo, shanghaiDateKey } from "./shanghai-time.js";
import { getMysqlPoolMetrics, mysqlExecute, mysqlQuery, warmMysqlPool } from "./mysql-pool.js";
import { isManagedOssObjectUrl, readManagedOssObject } from "./services/object-storage.js";

const services = mysqlRuntimeServices;
const runtimeReadiness = {
  ready: false,
  startedAt: new Date().toISOString(),
  readyAt: "",
  error: ""
};

const publicDir = path.resolve("public");
const serveStatic = createStaticHandler(publicDir, {
  extraRouteRoots: [
    {
      prefix: "/uploads/listing-media/",
      roots: resolveListingMediaStaticRoots()
    },
    {
      prefix: "/uploads/team-attachments/",
      roots: resolveTeamAttachmentStaticRoots()
    }
  ]
});
const handleAuth = createAuthHandler(readJson);
const imageProxyCacheDir = path.resolve("runtime", "image-proxy-cache");
const productThumbnailCacheDir = path.resolve("runtime", "product-thumbnail-cache");
const imageProxyInflight = new Map();
const imageProxyFailureCache = new Map();
const imageProxyFetchWaiters = [];
let activeImageProxyFetches = 0;
const IMAGE_PROXY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_PROXY_BROWSER_CACHE_SECONDS = 24 * 60 * 60;
const IMAGE_PROXY_FETCH_TIMEOUT_MS = Math.max(3000, Math.min(12000, Number(process.env.IMAGE_PROXY_FETCH_TIMEOUT_MS || 6000)));
const IMAGE_PROXY_FETCH_CONCURRENCY = Math.max(1, Math.min(24, Number(process.env.IMAGE_PROXY_FETCH_CONCURRENCY || 8)));
const IMAGE_PROXY_FAILURE_TTL_MS = Math.max(5000, Math.min(5 * 60 * 1000, Number(process.env.IMAGE_PROXY_FAILURE_TTL_MS || 30000)));
const IMAGE_PROXY_MAX_CACHE_BYTES = 8 * 1024 * 1024;
const IMAGE_PROXY_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

async function resolveDownloadArtifactPath(filename) {
  const normalized = String(filename || "").trim();
  if (!normalized) {
    const error = new Error("Missing download filename");
    error.statusCode = 400;
    throw error;
  }
  const aliasNames = normalized === "ozon-erp-collector-plugin.rar"
    ? ["ozon-erp-collector-plugin.rar", "ozon-baodan-erp-plugin.rar"]
    : [normalized];
  const versionedNames = normalized === "ozon-erp-collector-plugin.rar" || normalized === "ozon-baodan-erp-plugin.rar"
    ? ["ozon-baodan-erp-plugin-*.rar"]
    : normalized === "ozon-seller-analytics-plugin.rar"
      ? ["ozon-seller-analytics-plugin-*.rar"]
      : [];
  const candidates = Array.from(new Set([
    ...aliasNames.flatMap((name) => [
      path.resolve("dist", name),
      path.resolve("..", name),
      path.resolve("..", "dist", name),
      path.resolve("..", "..", name),
      path.resolve("..", "..", "dist", name),
      path.resolve(name)
    ])
  ]));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  for (const pattern of versionedNames) {
    const searchDirs = Array.from(new Set([
      path.resolve("dist"),
      path.resolve(".."),
      path.resolve("..", "dist"),
      path.resolve("..", ".."),
      path.resolve("..", "..", "dist")
    ]));
    const prefix = pattern.replace("*", "");
    const suffix = ".rar";
    const matches = [];
    for (const dir of searchDirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix)) {
            const fullPath = path.join(dir, entry.name);
            const stat = await fs.stat(fullPath);
            matches.push({ path: fullPath, mtimeMs: stat.mtimeMs });
          }
        }
      } catch {}
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (matches[0]) return matches[0].path;
  }
  const error = new Error(`Download artifact not found for ${normalized}. Checked: ${candidates.join(" | ")}`);
  error.statusCode = 404;
  throw error;
}

const routeModules = {
  ...createCatalogRoutes({ services, readJson }),
  ...createOperationsRoutes({ services, readJson }),
  ...createTeamRoutes({ services, readJson }),
  ...createProfitRoutes({ services, readJson }),
  ...createAdvertisingRoutes({ services, readJson }),
  ...createFinanceCenterRoutes({ readJson, services }),
  ...createPayrollRoutes({ readJson }),
  ...createSellerAnalyticsRoutes({ services, readJson }),
  ...createOzonActionRoutes({ services, readJson }),
  ...createReviewRoutes({ services, readJson }),
  ...createOrderRoutes({ services, readJson, notFound, writeHead, json }),
  ...createPrintRoutes({ services, readJson }),
  ...createSyncRoutes({ services, readJson, syncExceptionWorkbenchOrders }),
  ...createListingAutomationRoutes({ services, readJson }),
  ...createAssetVariantEngineRoutes({ services, readJson }),
  ...createAiGenerationTaskRoutes({ services, readJson }),
  ...createAiPromptTemplateRoutes({ services, readJson }),
  ...createAiStrategyRoutes({ services, readJson }),
  ...createMaterialAssetRoutes({ services, readJson }),
  ...createAiImageRoutes({ readJson }),
  ...createAiVariantLabRoutes({ services, readJson }),
  ...createImageCropperRoutes({ readJson }),
  ...createOnboardingKnowledgeRoutes({ readJson })
};

// 保持现有 API 不变，但把“简单直连型接口”集中成一个表；
// server.js 只负责分发、鉴权和极少量路径参数解析。
// Keep straightforward routes in a single lookup table so server.js stays
// focused on request dispatch, authentication, and transport concerns.
const routes = {
  ...routeModules,
  "GET /api/system/info": () => systemInfo(),
  "GET /api/system/update-status": (req) => globalUpdateStatus(req.query || {}),
  "POST /api/system/update-status": async (req) => updateGlobalUpdateStatus(await readJson(req)),
  "GET /api/ai-provider/config": () => services.aiProviderConfig(),
  "GET /api/ai-provider/presets": () => services.aiProviderPresets(),
  "POST /api/ai-provider/config": async (req) => services.updateAiProviderConfig(await readJson(req), req._session?.personId),
  "POST /api/ai-provider/test": async (req) => services.testAiProviderConfig(await readJson(req)),
  "POST /api/ai-provider/test-image-channel": async (req) => services.testAiImageProviderChannel(await readJson(req)),
  "POST /api/ai-provider/chat": async (req) => services.chatWithAiProvider(await readJson(req)),
  "GET /api/dashboard": (req) => services.dashboard(req.query || {}),
  "GET /api/scheduled-jobs": (req) => listScheduledJobs(req.query || {}),
  "GET /api/scheduled-job-runs": (req) => scheduledJobRuns(req.query || {}),
  "GET /api/scheduled-job-run-events": (req) => scheduledJobRunEvents(req.query || {}),
  "POST /api/scheduled-jobs/run": async (req) => {
    const body = await readJson(req);
    return runScheduledJobNow(body.job_key || body.jobKey || body.key, scheduledJobHandlers, "manual");
  },
  "POST /api/scheduled-jobs/state": async (req) => updateScheduledJobState(await readJson(req)),
  "POST /api/scheduled-jobs/config": async (req) => updateScheduledJobConfig(await readJson(req)),
  "GET /api/exchange-rate/current": () => services.currentExchangeRate(),
  "GET /api/exchange-rates": () => services.exchangeRates(),
  "GET /api/inventory": (req) => services.inventory(req.query || {}),
  "GET /api/stock-alerts": (req) => services.stockAlerts(req.query || {}),
  "GET /api/fbp-opportunities": (req) => services.fbpOpportunities(req.query || {}),
  "GET /api/fbp-replenishment-orders": (req) => services.fbpReplenishmentOrders(req.query || {}),
  "GET /api/fbp-transfer-records": (req) => services.fbpTransferRecords(req.query || {}),
  "GET /api/stock-warehouse-rules": () => services.stockWarehouseRules(),
  "GET /api/erp/inventory-current": () => services.inventoryCurrent(),
  "GET /api/erp/raw-orders": () => services.rawOzonOrders(),
  "GET /api/erp/profit-items": () => services.profitItems(),
  "GET /api/erp/order-exceptions": () => services.orderExceptions(),
  "POST /api/exchange-rate": async (req) => services.updateExchangeRate(await readJson(req)),
  "POST /api/fbp-replenishment-ignore": async (req) => services.ignoreFbpReplenishment(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-restore": async (req) => services.restoreFbpReplenishment(await readJson(req)),
  "POST /api/fbp-replenishment-orders": async (req) => services.createFbpReplenishmentOrders(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-orders/merge": async (req) => services.mergeFbpReplenishmentOrders(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-orders/link": async (req) => services.linkFbpReplenishmentOrders(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-orders/unlink": async (req) => services.unlinkFbpReplenishmentOrder(await readJson(req), req._session?.personId),
  "GET /api/fbp-replenishment-batches/fill-preview": (req) => services.fbpReplenishmentBatchFillPreview(req.query || {}),
  "POST /api/fbp-replenishment-batches/fill-results": async (req) => services.recordFbpReplenishmentBatchFill(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-orders/items/adjustments": async (req) => services.addFbpReplenishmentItemAdjustment(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-orders/delete": async (req) => services.deleteFbpReplenishmentOrder(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-orders/items": async (req) => services.updateFbpReplenishmentOrderItems(await readJson(req)),
  "POST /api/fbp-replenishment-orders/items/barcode-printed": async (req) => services.markFbpReplenishmentItemBarcodePrinted(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-orders/items/delete": async (req) => services.deleteFbpReplenishmentOrderItem(await readJson(req), req._session?.personId),
  "POST /api/fbp-replenishment-orders/status": async (req) => services.updateFbpReplenishmentOrderStatus(await readJson(req), req._session?.personId),
  "POST /api/fbp-transfer-records": async (req) => services.createFbpTransferRecord(await readJson(req), req._session?.personId),
  "POST /api/fbp-transfer-records/confirm-received": async (req) => services.confirmFbpTransferReceived(await readJson(req), req._session?.personId),
  "POST /api/fbp-transfer-records/pdf-preview": async (req) => services.previewFbpSupplyPdf(await readJson(req)),
  "POST /api/fbp-transfer-records/pdf-import": async (req) => services.importFbpSupplyPdf(await readJson(req), req._session?.personId),
  "POST /api/pricing/cel-fbs": async (req) => calculateCelFbsPricing(await readJson(req)),
};

const API_WARN_ELAPSED_MS = 500;
const API_ERROR_ELAPSED_MS = 1500;

function logSlowApiRequest({ req, res, url, startedAt }) {
  if (!url?.pathname?.startsWith("/api/")) return;
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  if (elapsedMs < API_WARN_ELAPSED_MS) return;
  const level = elapsedMs >= API_ERROR_ELAPSED_MS ? "error" : "warn";
  const status = res?.statusCode || 0;
  const query = url.search || "";
  const pool = getMysqlPoolMetrics();
  const memory = process.memoryUsage();
  const message = `[api-performance] ${req.method} ${url.pathname}${query} status=${status} elapsed=${elapsedMs}ms db_active=${pool.activeConnections}/${pool.connectionLimit} db_wait=${pool.lastAcquireWaitMs.toFixed(1)}ms rss_mb=${(memory.rss / 1024 / 1024).toFixed(1)} heap_mb=${(memory.heapUsed / 1024 / 1024).toFixed(1)}`;
  console[level](message);
  if (req._timingMarks?.length) {
    const segments = [];
    let previousAt = startedAt;
    for (const mark of req._timingMarks) {
      segments.push(`${mark.label}=+${Math.round((mark.at - previousAt) * 10) / 10}ms`);
      previousAt = mark.at;
    }
    segments.push(`finish=+${Math.round((performance.now() - previousAt) * 10) / 10}ms`);
    console[level](`[api-performance:segments] ${req.method} ${url.pathname}${query} ${segments.join(" ")}`);
  }
}

function markRequestTiming(req, label) {
  if (!req._timingMarks) req._timingMarks = [];
  req._timingMarks.push({ label, at: performance.now() });
}

function isForegroundApiRequest(parts = []) {
  if (parts[0] !== "api") return false;
  if (parts[1] === "local-plugin") return false;
  if (parts[1] === "system" && parts[2] === "events") return false;
  return true;
}

function trackForegroundApiRequest(req, res, parts = []) {
  if (!isForegroundApiRequest(parts)) return;
  activeForegroundApiRequests += 1;
  lastForegroundApiAt = Date.now();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    activeForegroundApiRequests = Math.max(0, activeForegroundApiRequests - 1);
    lastForegroundApiAt = Date.now();
  };
  res.once("finish", settle);
  res.once("close", settle);
}

function foregroundApiDeferral(jobKey, context = {}) {
  if (String(context?.mode || "") === "manual") return null;
  if (BACKGROUND_TASK_FOREGROUND_IDLE_MS <= 0) return null;
  if (criticalJobForegroundDeferralExpired(jobKey, context)) return null;
  if (activeForegroundApiRequests > 0) {
    return {
      skipped: true,
      reason: "foreground_api_active",
      retryDelaySeconds: Math.max(15, Math.ceil(BACKGROUND_TASK_FOREGROUND_IDLE_MS / 1000)),
      foregroundApiRequests: activeForegroundApiRequests,
      jobKey
    };
  }
  const idleForMs = Date.now() - lastForegroundApiAt;
  if (lastForegroundApiAt > 0 && idleForMs < BACKGROUND_TASK_FOREGROUND_IDLE_MS) {
    return {
      skipped: true,
      reason: "foreground_api_recent",
      retryDelaySeconds: Math.max(15, Math.ceil((BACKGROUND_TASK_FOREGROUND_IDLE_MS - idleForMs) / 1000)),
      idleForMs,
      jobKey
    };
  }
  return null;
}

function databasePoolDeferral(jobKey, context = {}) {
  if (String(context?.mode || "") === "manual") return null;
  const pool = getMysqlPoolMetrics();
  const backgroundCeiling = Math.max(1, pool.connectionLimit - 2);
  if (pool.activeConnections < backgroundCeiling) return null;
  return {
    skipped: true,
    reason: "database_pool_pressure",
    retryDelaySeconds: 30,
    activeConnections: pool.activeConnections,
    connectionLimit: pool.connectionLimit,
    jobKey
  };
}

function backgroundJobDeferral(jobKey, context = {}) {
  return foregroundApiDeferral(jobKey, context) || databasePoolDeferral(jobKey, context);
}

function withForegroundApiDeferral(jobKey, handler) {
  return async (context = {}) => {
    const deferred = backgroundJobDeferral(jobKey, context);
    if (deferred) {
      console.log(`background job ${jobKey} deferred: ${deferred.reason}`);
      return deferred;
    }
    return handler(context);
  };
}

cleanExpiredSessions();
setInterval(cleanExpiredSessions, 3600 * 1000);
let backgroundOrderSyncRunning = false;
let backgroundCancelledOrderSyncRunning = false;
let backgroundPostingDetailSyncRunning = false;
let backgroundAnalyticsRefreshRunning = false;
let backgroundDashboardSnapshotRefreshRunning = false;
let backgroundAdvertisingSyncRunning = false;
let backgroundAdvertisingTodaySyncRunning = false;
let backgroundSellerAnalyticsSyncRunning = false;
let backgroundOzonStockSyncRunning = false;
let backgroundOzonCategorySyncRunning = false;
let backgroundCustomerMessageRunning = false;
const backgroundModuleLanes = new Map();

function claimBackgroundModuleLane(moduleKey, jobKey) {
  const runningJob = backgroundModuleLanes.get(moduleKey) || "";
  if (runningJob) return runningJob;
  backgroundModuleLanes.set(moduleKey, jobKey);
  return "";
}

function releaseBackgroundModuleLane(moduleKey, jobKey) {
  if (backgroundModuleLanes.get(moduleKey) === jobKey) backgroundModuleLanes.delete(moduleKey);
}

function backgroundModuleLaneStatus() {
  if (!backgroundModuleLanes.size) return "idle";
  return Array.from(backgroundModuleLanes.entries()).map(([moduleKey, jobKey]) => `${moduleKey}:${jobKey}`).join(",");
}
let activeForegroundApiRequests = 0;
let lastForegroundApiAt = 0;
let resourceMonitorExpectedAt = Date.now() + 30_000;
let lastReportedSlowAcquisitions = 0;
setInterval(() => {
  const now = Date.now();
  const eventLoopLagMs = Math.max(0, now - resourceMonitorExpectedAt);
  resourceMonitorExpectedAt = now + 30_000;
  const pool = getMysqlPoolMetrics();
  const memory = process.memoryUsage();
  const rssMb = memory.rss / 1024 / 1024;
  const poolPressure = pool.activeConnections >= Math.max(1, pool.connectionLimit - 1);
  const newSlowAcquisitions = pool.slowAcquisitions > lastReportedSlowAcquisitions;
  if (eventLoopLagMs >= 200 || rssMb >= 512 || poolPressure || newSlowAcquisitions) {
    console.warn(`[runtime-health] event_loop_lag=${eventLoopLagMs}ms rss_mb=${rssMb.toFixed(1)} heap_mb=${(memory.heapUsed / 1024 / 1024).toFixed(1)} db_active=${pool.activeConnections}/${pool.connectionLimit} db_wait_avg=${pool.averageAcquireWaitMs.toFixed(1)}ms db_wait_slow=${pool.slowAcquisitions} foreground=${activeForegroundApiRequests} module_lanes=${backgroundModuleLaneStatus()}`);
  }
  lastReportedSlowAcquisitions = pool.slowAcquisitions;
}, 30_000).unref();
const BACKGROUND_TASK_FOREGROUND_IDLE_MS = Math.max(0, Number(config.backgroundTaskForegroundIdleSeconds || 20)) * 1000;
const BACKGROUND_CRITICAL_JOB_MAX_DEFERRAL_MS = Math.max(0, Number(config.backgroundCriticalJobMaxDeferralSeconds || 300)) * 1000;
const FOREGROUND_DEFERRAL_BOUNDED_JOBS = new Set([
  "customer_message_dispatch",
  "order_status_sync",
  "cancelled_order_sync",
  "posting_detail_sync",
  "ozon_action_cleanup",
  "advertising_sync",
  "advertising_today_sync"
]);

function criticalJobForegroundDeferralExpired(jobKey, context = {}) {
  if (!FOREGROUND_DEFERRAL_BOUNDED_JOBS.has(String(jobKey || ""))) return false;
  const maxDeferralMs = jobKey === "order_status_sync"
    ? Math.min(BACKGROUND_CRITICAL_JOB_MAX_DEFERRAL_MS, 60_000)
    : BACKGROUND_CRITICAL_JOB_MAX_DEFERRAL_MS;
  if (maxDeferralMs <= 0) return true;
  const lastSuccessAt = context?.lastSuccessAt instanceof Date
    ? context.lastSuccessAt
    : new Date(context?.lastSuccessAt || "");
  const intervalMs = Math.max(0, Number(context?.intervalMinutes || 0)) * 60 * 1000;
  if (Number.isFinite(lastSuccessAt.getTime()) && intervalMs > 0) {
    return Date.now() - (lastSuccessAt.getTime() + intervalMs) >= maxDeferralMs;
  }
  const plannedFor = context?.plannedFor instanceof Date
    ? context.plannedFor
    : new Date(context?.plannedFor || "");
  if (!Number.isFinite(plannedFor.getTime())) return false;
  return Date.now() - plannedFor.getTime() >= maxDeferralMs;
}
const BACKGROUND_ORDER_SYNC_INTERVAL_MS = Math.max(1, Number(config.backgroundOrderSyncIntervalMinutes || 10)) * 60 * 1000;
const BACKGROUND_ORDER_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundOrderSyncInitialDelaySeconds || 180)) * 1000;
const BACKGROUND_ORDER_SYNC_DAYS = Math.max(1, Number(config.backgroundOrderSyncDays || 90));
const BACKGROUND_CANCELLED_ORDER_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundCancelledOrderSyncIntervalMinutes || 60)) * 60 * 1000;
const BACKGROUND_CANCELLED_ORDER_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundCancelledOrderSyncInitialDelaySeconds || 360)) * 1000;
const BACKGROUND_CANCELLED_ORDER_SYNC_DAYS = Math.max(1, Number(config.backgroundCancelledOrderSyncDays || 30));
const BACKGROUND_POSTING_DETAIL_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundPostingDetailSyncIntervalMinutes || 60)) * 60 * 1000;
const BACKGROUND_POSTING_DETAIL_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundPostingDetailSyncInitialDelaySeconds || 600)) * 1000;
const BACKGROUND_POSTING_DETAIL_SYNC_DAYS = Math.max(1, Number(config.backgroundPostingDetailSyncDays || 30));
const BACKGROUND_POSTING_DETAIL_RECONCILIATION_DAYS = Math.min(Math.max(1, Number(config.backgroundPostingDetailReconciliationDays || 2)), 7);
const BACKGROUND_POSTING_DETAIL_SYNC_LIMIT = Math.max(1, Number(config.backgroundPostingDetailSyncLimit || 200));
const BACKGROUND_POSTING_DETAIL_SYNC_CONCURRENCY = Math.min(Math.max(Number(config.backgroundPostingDetailSyncConcurrency || 2), 1), 5);
const BACKGROUND_POSTING_DETAIL_DEEP_SYNC_DAYS = Math.max(1, Number(config.backgroundPostingDetailDeepSyncDays || 90));
const BACKGROUND_POSTING_DETAIL_DEEP_SYNC_LIMIT = Math.max(1, Number(config.backgroundPostingDetailDeepSyncLimit || 1000));
const BACKGROUND_ANALYTICS_REFRESH_INTERVAL_MS = Math.max(1, Number(config.backgroundAnalyticsRefreshIntervalMinutes || 60)) * 60 * 1000;
const BACKGROUND_ANALYTICS_REFRESH_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundAnalyticsRefreshInitialDelaySeconds || 240)) * 1000;
const BACKGROUND_DASHBOARD_SNAPSHOT_INTERVAL_MS = Math.max(1, Number(config.backgroundDashboardSnapshotIntervalMinutes || 3)) * 60 * 1000;
const BACKGROUND_DASHBOARD_SNAPSHOT_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundDashboardSnapshotInitialDelaySeconds || 20)) * 1000;
const BACKGROUND_ADVERTISING_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundAdvertisingSyncIntervalMinutes || 15)) * 60 * 1000;
const BACKGROUND_ADVERTISING_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundAdvertisingSyncInitialDelaySeconds || 420)) * 1000;
const BACKGROUND_ADVERTISING_SYNC_DAYS = Math.max(1, Number(config.backgroundAdvertisingSyncDays || 7));
const BACKGROUND_ADVERTISING_SYNC_TIMEOUT_MS = Math.max(1, Number(config.backgroundAdvertisingSyncTimeoutMinutes || 25)) * 60 * 1000;
const BACKGROUND_ADVERTISING_TODAY_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundAdvertisingTodaySyncIntervalMinutes || 15)) * 60 * 1000;
const BACKGROUND_ADVERTISING_TODAY_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundAdvertisingTodaySyncInitialDelaySeconds || 120)) * 1000;
const BACKGROUND_ADVERTISING_TODAY_SYNC_TIMEOUT_MS = Math.max(1, Number(config.backgroundAdvertisingTodaySyncTimeoutMinutes || 25)) * 60 * 1000;
const BACKGROUND_SELLER_ANALYTICS_SYNC_DAYS = Math.max(1, Number(config.backgroundSellerAnalyticsSyncDays || 7));
const BACKGROUND_SELLER_ANALYTICS_SYNC_TIMEOUT_MS = Math.max(1, Number(config.backgroundSellerAnalyticsSyncTimeoutMinutes || 45)) * 60 * 1000;
const BACKGROUND_OZON_STOCK_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundOzonStockSyncIntervalMinutes || 30)) * 60 * 1000;
const BACKGROUND_OZON_STOCK_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundOzonStockSyncInitialDelaySeconds || 480)) * 1000;
const OZON_ACTION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const scheduledJobDefinitions = [
  {
    key: "order_status_sync",
    name: "Ozon 订单增量同步",
    category: "orders",
    priority: "critical",
    intervalMinutes: Math.round(BACKGROUND_ORDER_SYNC_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_ORDER_SYNC_INITIAL_DELAY_MS / 1000),
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "customer_message_dispatch",
    name: "Ozon 客户消息任务扫描",
    category: "orders",
    priority: "high",
    intervalMinutes: 10,
    initialDelaySeconds: 300,
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "cancelled_order_sync",
    name: "Ozon 取消订单补漏",
    category: "orders",
    priority: "critical",
    intervalMinutes: Math.round(BACKGROUND_CANCELLED_ORDER_SYNC_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_CANCELLED_ORDER_SYNC_INITIAL_DELAY_MS / 1000),
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "posting_detail_sync",
    name: "Ozon 货件详情补齐",
    category: "orders",
    priority: "high",
    intervalMinutes: Math.round(BACKGROUND_POSTING_DETAIL_SYNC_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_POSTING_DETAIL_SYNC_INITIAL_DELAY_MS / 1000),
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "posting_detail_deep_sync",
    name: "Ozon 货件详情深度补齐",
    category: "orders",
    priority: "high",
    scheduleType: "daily",
    dailyTime: `${String(config.backgroundPostingDetailDeepSyncHour || 2).padStart(2, "0")}:${String(config.backgroundPostingDetailDeepSyncMinute || 30).padStart(2, "0")}`,
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "analytics_refresh",
    name: "利润分析快照刷新",
    category: "analytics",
    priority: "high",
    intervalMinutes: Math.round(BACKGROUND_ANALYTICS_REFRESH_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_ANALYTICS_REFRESH_INITIAL_DELAY_MS / 1000),
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "dashboard_snapshot_refresh",
    name: "经营首页快照刷新（已合并到订单同步）",
    category: "analytics",
    priority: "normal",
    intervalMinutes: Math.round(BACKGROUND_DASHBOARD_SNAPSHOT_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_DASHBOARD_SNAPSHOT_INITIAL_DELAY_MS / 1000),
    enabled: false,
    catchupEnabled: false,
    maxCatchupRuns: 0
  },
  {
    key: "advertising_sync",
    name: "Ozon 广告近窗同步",
    category: "advertising",
    priority: "high",
    intervalMinutes: Math.round(BACKGROUND_ADVERTISING_SYNC_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_ADVERTISING_SYNC_INITIAL_DELAY_MS / 1000),
    catchupEnabled: true,
    maxCatchupRuns: 1,
    config: {
      scope: "recent_window",
      days: BACKGROUND_ADVERTISING_SYNC_DAYS,
      timeoutMinutes: Math.round(BACKGROUND_ADVERTISING_SYNC_TIMEOUT_MS / 60000),
      campaignChunkSize: 1,
      reportRetryDelayMs: 15000,
      maxCampaignsPerRun: 2
    }
  },
  {
    key: "advertising_today_sync",
    name: "Ozon 广告今日同步",
    category: "advertising",
    priority: "high",
    intervalMinutes: Math.round(BACKGROUND_ADVERTISING_TODAY_SYNC_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_ADVERTISING_TODAY_SYNC_INITIAL_DELAY_MS / 1000),
    catchupEnabled: true,
    maxCatchupRuns: 1,
    config: {
      scope: "rolling_recent",
      rollingDays: 3,
      timeoutMinutes: Math.round(BACKGROUND_ADVERTISING_TODAY_SYNC_TIMEOUT_MS / 60000),
      campaignChunkSize: 1,
      reportRetryDelayMs: 15000,
      maxShopsPerRun: 1,
      maxCampaignsPerRun: 3,
      shopConcurrency: 1
    }
  },
  {
    key: "seller_analytics_daily_sync",
    name: "Ozon 店铺分析 7 天同步",
    category: "analytics",
    priority: "high",
    scheduleType: "daily",
    dailyTime: "02:00",
    catchupEnabled: true,
    maxCatchupRuns: 1,
    config: {
      scope: "recent_window",
      days: 7,
      timeoutMinutes: Math.round(BACKGROUND_SELLER_ANALYTICS_SYNC_TIMEOUT_MS / 60000),
      maxShopsPerRun: 50,
      maxPages: 500,
      requestLimit: 30,
      waitPollMs: 2000,
      shopConcurrency: 3,
      retentionDays: 15
    }
  },
  {
    key: "seller_analytics_28d_sync",
    name: "Ozon 店铺分析 28 天同步",
    category: "analytics",
    priority: "high",
    scheduleType: "daily",
    dailyTime: "03:00",
    catchupEnabled: true,
    maxCatchupRuns: 1,
    config: { scope: "recent_window", days: 28, timeoutMinutes: Math.round(BACKGROUND_SELLER_ANALYTICS_SYNC_TIMEOUT_MS / 60000), maxShopsPerRun: 50, maxPages: 500, requestLimit: 30, waitPollMs: 2000, shopConcurrency: 3, retentionDays: 15 }
  },
  {
    key: "ozon_stock_sync",
    name: "Ozon FBP 库存同步",
    category: "inventory",
    priority: "high",
    enabled: config.backgroundOzonStockSyncEnabled,
    intervalMinutes: Math.round(BACKGROUND_OZON_STOCK_SYNC_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_OZON_STOCK_SYNC_INITIAL_DELAY_MS / 1000),
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "inventory_alert_snapshot_refresh",
    name: "库存告警快照预热",
    category: "inventory",
    priority: "low",
    intervalMinutes: 10,
    initialDelaySeconds: 90,
    catchupEnabled: false,
    maxCatchupRuns: 0
  },
  {
    key: "ozon_category_sync",
    name: "Ozon 类目属性缓存刷新",
    category: "listing",
    priority: "normal",
    enabled: config.backgroundOzonCategorySyncEnabled,
    scheduleType: "daily",
    dailyTime: `${String(config.backgroundOzonCategorySyncHour || 1).padStart(2, "0")}:${String(config.backgroundOzonCategorySyncMinute || 10).padStart(2, "0")}`,
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "listing_publish_record_sync",
    name: "上架记录状态和评分同步",
    category: "listing",
    priority: "high",
    intervalMinutes: 2,
    initialDelaySeconds: 60,
    catchupEnabled: true,
    maxCatchupRuns: 1,
    config: {
      limit: 100,
      minAgeMinutes: 1,
      maxAgeDays: 7
    }
  },
  {
    key: "ozon_action_cleanup",
    name: "Ozon 营销动作清理",
    category: "profit_guard",
    priority: "critical",
    intervalMinutes: Math.round(OZON_ACTION_CLEANUP_INTERVAL_MS / 60000),
    initialDelaySeconds: 5,
    catchupEnabled: true,
    maxCatchupRuns: 1
  },
  {
    key: "listing_publish_summary_backfill",
    name: "上架记录列表摘要回填",
    category: "maintenance",
    priority: "low",
    intervalMinutes: 15,
    initialDelaySeconds: 180,
    catchupEnabled: false,
    maxCatchupRuns: 0,
    config: { limit: 5 }
  },
  {
    key: "scheduled_history_cleanup",
    name: "定时任务日志分级清理",
    category: "maintenance",
    priority: "low",
    scheduleType: "daily",
    dailyTime: "03:40",
    catchupEnabled: true,
    maxCatchupRuns: 1,
    config: {
      successDays: 7,
      detailDays: 7,
      batchSize: 5000
    }
  },
  {
    key: "ai_generation_history_cleanup",
    name: "AI generation history cleanup",
    category: "maintenance",
    priority: "low",
    scheduleType: "daily",
    dailyTime: "03:55",
    catchupEnabled: true,
    maxCatchupRuns: 1,
    config: { retentionDays: 30, batchSize: 1000 }
  }
];

const scheduledJobHandlers = {
  order_status_sync: withForegroundApiDeferral("order_status_sync", runBackgroundOrderStatusSync),
  customer_message_dispatch: withForegroundApiDeferral("customer_message_dispatch", runBackgroundCustomerMessageDispatch),
  cancelled_order_sync: withForegroundApiDeferral("cancelled_order_sync", runBackgroundCancelledOrderSync),
  posting_detail_sync: withForegroundApiDeferral("posting_detail_sync", runBackgroundPostingDetailSync),
  posting_detail_deep_sync: withForegroundApiDeferral("posting_detail_deep_sync", runBackgroundPostingDetailDeepSync),
  analytics_refresh: withForegroundApiDeferral("analytics_refresh", runBackgroundAnalyticsRefresh),
  dashboard_snapshot_refresh: withForegroundApiDeferral("dashboard_snapshot_refresh", runBackgroundDashboardSnapshotRefresh),
  advertising_sync: withForegroundApiDeferral("advertising_sync", runBackgroundAdvertisingSync),
  advertising_today_sync: withForegroundApiDeferral("advertising_today_sync", runBackgroundAdvertisingTodaySync),
  seller_analytics_daily_sync: withForegroundApiDeferral("seller_analytics_daily_sync", runBackgroundSellerAnalyticsDailySync),
  seller_analytics_28d_sync: withForegroundApiDeferral("seller_analytics_28d_sync", runBackgroundSellerAnalyticsDailySync),
  ozon_stock_sync: withForegroundApiDeferral("ozon_stock_sync", runBackgroundOzonStockSync),
  inventory_alert_snapshot_refresh: withForegroundApiDeferral("inventory_alert_snapshot_refresh", () => services.stockAlerts({
    mode: "alerts",
    paged: "1",
    page: 1,
    pageSize: 1,
    refresh: "1"
  })),
  ozon_category_sync: withForegroundApiDeferral("ozon_category_sync", runBackgroundOzonCategorySync),
  listing_publish_record_sync: withForegroundApiDeferral("listing_publish_record_sync", (job) => services.autoSyncListingPublishRecords(job?.config || {})),
  listing_publish_summary_backfill: withForegroundApiDeferral("listing_publish_summary_backfill", (job) => services.backfillListingPublishRecordListSummaries(job?.config || {})),
  ozon_action_cleanup: withForegroundApiDeferral("ozon_action_cleanup", runOzonActionCleanupSweep),
  scheduled_history_cleanup: withForegroundApiDeferral("scheduled_history_cleanup", (job) => cleanupScheduledJobHistory(job?.config || {})),
  ai_generation_history_cleanup: withForegroundApiDeferral("ai_generation_history_cleanup", (job) => cleanupAiGenerationTaskHistory(job?.config || {}))
};

const scheduledJobScheduler = new ScheduledJobScheduler({
  handlers: scheduledJobHandlers,
  beforeRun: ({ key, mode, plannedFor, lastSuccessAt, intervalMinutes, config: jobConfig }) => backgroundJobDeferral(key, {
    mode,
    plannedFor,
    lastSuccessAt,
    intervalMinutes,
    config: jobConfig
  }),
  pollIntervalMs: 60 * 1000,
  maxConcurrent: Math.max(5, Number(config.scheduledJobsMaxConcurrent || 5))
});

async function handleSiteAccess(req, res, url) {
  const nextPath = normalizeNextPath(url.searchParams.get("next") || "/");

  if (req.method === "POST" && url.pathname === SITE_ACCESS_API_LOGIN_PATH) {
    const body = await readJson(req);
    const rateKey = `gate:${getClientIp(req)}`;
    const rate = consumeRateLimit(rateKey);
    if (!rate.allowed) {
      return json(res, { error: "尝试次数过多，请稍后再试" }, 429);
    }
    if ((body.password || body.access_password || "") !== getSiteAccessPassword()) {
      return json(res, { error: "访问口令错误，请重试" }, 401);
    }
    clearRateLimit(rateKey);
    return json(res, {
      ok: true,
      token: createSiteAccessCookieValue(),
      expires_in: getSiteAccessCookieMaxAgeSeconds()
    });
  }

  if (req.method === "GET" && url.pathname === SITE_ACCESS_LOGOUT_PATH) {
    clearCookie(res, getSiteAccessCookieName(), {
      path: "/",
      sameSite: "Lax",
      secure: siteAccessUsesSecureCookie(req)
    });
    writeHead(res, 302, { Location: SITE_ACCESS_SESSION_PATH });
    res.end();
    return true;
  }

  if (req.method === "GET" && url.pathname === SITE_ACCESS_SESSION_PATH) {
    html(res, renderSiteAccessPage(url.searchParams.get("error") ? "访问口令错误，请重试。" : "", nextPath));
    return true;
  }

  if (req.method === "POST" && url.pathname === SITE_ACCESS_LOGIN_PATH) {
    const form = await readForm(req);
    const formNext = normalizeNextPath(form.next || "/");
    const rateKey = `gate:${getClientIp(req)}`;
    const rate = consumeRateLimit(rateKey);
    if (!rate.allowed) {
      html(res, renderSiteAccessPage("尝试次数过多，请稍后再试。", formNext), 429);
      return true;
    }
    if ((form.password || "") !== getSiteAccessPassword()) {
      html(res, renderSiteAccessPage("访问口令错误，请重试。", formNext), 401);
      return true;
    }
    clearRateLimit(rateKey);
    setCookie(res, getSiteAccessCookieName(), createSiteAccessCookieValue(), {
      path: "/",
      sameSite: "Lax",
      secure: siteAccessUsesSecureCookie(req),
      maxAge: getSiteAccessCookieMaxAgeSeconds()
    });
    writeHead(res, 302, { Location: formNext });
    res.end();
    return true;
  }

  return false;
}

async function handleRestRoute(req, res, url, parts) {
  const onboardingHandled = await handleOnboardingKnowledgeRestRoute({ req, res, parts, json, notFound });
  if (onboardingHandled !== false) return onboardingHandled;
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "ai-provider" && parts[2] === "stream") {
    const body = await readJson(req);
    const streamRequestId = randomUUID();
    const streamStartedAt = Date.now();
    console.info("[ai-provider-stream] start", {
      requestId: streamRequestId,
      route: body?.route || "text",
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      personId: req._session?.personId || req._session?.id || 0
    });
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
      if (!res.writableEnded) {
        console.warn("[ai-provider-stream] client closed", {
          requestId: streamRequestId,
          elapsedMs: Date.now() - streamStartedAt
        });
      }
    });
    writeHead(res, 200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const send = (event, payload) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      const result = await services.streamAiProviderResponse(body, {
        signal: controller.signal,
        onDelta: (delta) => send("delta", { delta })
      });
      send("done", result);
      console.info("[ai-provider-stream] done", {
        requestId: streamRequestId,
        elapsedMs: Date.now() - streamStartedAt,
        provider: result?.provider || "",
        model: result?.model || ""
      });
    } catch (error) {
      console.error("[ai-provider-stream] failed", {
        requestId: streamRequestId,
        elapsedMs: Date.now() - streamStartedAt,
        status: error?.status || 502,
        name: error?.name || "Error",
        message: error?.message || String(error)
      });
      if (!controller.signal.aborted) send("error", { error: error?.message || "AI 流式请求失败", status: error?.status || 502 });
    }
    res.end();
    return true;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "system" && parts[2] === "events") {
    writeHead(res, 200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const unsubscribe = subscribeGlobalUpdateEvents(res, {
      ...Object.fromEntries(url.searchParams.entries()),
      personId: req._session?.personId || req._session?.id || 0
    });
    req.on("close", unsubscribe);
    return true;
  }

  if (req.method === "GET" && parts[0] === "downloads" && (
    /^ozon-baodan-erp-plugin-[0-9][0-9A-Za-z.-]*\.rar$/.test(parts[1] || "") ||
    /^ozon-seller-analytics-plugin-[0-9][0-9A-Za-z.-]*\.rar$/.test(parts[1] || "") ||
    parts[1] === "ozon-baodan-erp-plugin.rar" ||
    parts[1] === "ozon-erp-collector-plugin.rar" ||
    parts[1] === "ozon-seller-analytics-plugin.rar"
  )) {
    const filename = parts[1];
    const filePath = await resolveDownloadArtifactPath(filename);
    const buffer = await fs.readFile(filePath);
    writeHead(res, 200, {
      "Content-Type": "application/vnd.rar",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buffer.length,
      "Cache-Control": "no-store"
    });
    res.end(buffer);
    return true;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] === "barcode-label" && parts[3] === "generate") {
    return json(res, await services.generateProductBarcodeLabel(await readJson(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] === "barcode-label") {
    const label = await services.productBarcodeLabel(await readJson(req));
    writeHead(res, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${label.filename}"`,
      "Content-Length": label.buffer.length,
      "X-Ozon-Barcode-Count": String(label.count || 0),
      "X-Ozon-Barcode-Product-Count": String(label.product_count || 0),
      "X-Ozon-Barcode-Stats": encodeURIComponent(JSON.stringify(label.stats || {})),
      "Cache-Control": "no-store"
    });
    res.end(label.buffer);
    return true;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "docs" && !parts[2]) {
    return json(res, createApiDocumentation());
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "docs" && parts[2] === "markdown") {
    return text(res, renderApiDocumentationMarkdown(), 200, "text/markdown; charset=utf-8");
  }

  const orderRestHandled = await handleOrderRestRoute({
    req,
    res,
    url,
    parts,
    services,
    readJson,
    json,
    notFound,
    writeHead
  });
  if (orderRestHandled !== false) {
    return orderRestHandled;
  }

  const financeCenterHandled = await handleFinanceCenterRestRoute({ req, res, url, parts, json, writeHead });
  if (financeCenterHandled !== false) return financeCenterHandled;

  const catalogRestHandled = await handleCatalogRestRoute({
    req,
    res,
    url,
    parts,
    services,
    readJson,
    json,
    notFound,
    sendProductImage
  });
  if (catalogRestHandled !== false) {
    return catalogRestHandled;
  }

  const operationsRestHandled = await handleOperationsRestRoute({
    req,
    res,
    url,
    parts,
    services,
    readJson,
    json,
    notFound
  });
  if (operationsRestHandled !== false) {
    return operationsRestHandled;
  }

  const teamRestHandled = await handleTeamRestRoute({
    req,
    res,
    parts,
    services,
    readJson,
    json
  });
  if (teamRestHandled !== false) {
    return teamRestHandled;
  }

  const materialPackageRestHandled = await handleMaterialPackageRestRoute({
    req,
    res,
    parts,
    services,
    json
  });
  if (materialPackageRestHandled !== false) {
    return materialPackageRestHandled;
  }

  const reviewRestHandled = await handleReviewRestRoute({
    req,
    res,
    parts,
    services,
    readJson,
    json,
    notFound
  });
  if (reviewRestHandled !== false) {
    return reviewRestHandled;
  }

  const sellerAnalyticsRestHandled = await handleSellerAnalyticsRestRoute({
    req,
    res,
    parts,
    services,
    readJson,
    json
  });
  if (sellerAnalyticsRestHandled !== false) {
    return sellerAnalyticsRestHandled;
  }

  const listingAutomationRestHandled = await handleListingAutomationRestRoute({
    req,
    res,
    parts,
    services,
    readJson,
    json
  });
  if (listingAutomationRestHandled !== false) {
    return listingAutomationRestHandled;
  }

  const assetVariantHandled = await handleAssetVariantEngineRestRoute({
    req,
    res,
    parts,
    services,
    json,
    notFound,
    writeHead
  });
  if (assetVariantHandled !== false) {
    return assetVariantHandled;
  }

  const aiGenerationTaskHandled = await handleAiGenerationTaskRestRoute({
    req,
    res,
    parts,
    services,
    readJson,
    json,
    notFound
  });
  if (aiGenerationTaskHandled !== false) {
    return aiGenerationTaskHandled;
  }

  const imageCropperRestHandled = await handleImageCropperRestRoute({
    req,
    res,
    parts,
    json,
    notFound,
    writeHead
  });
  if (imageCropperRestHandled !== false) {
    return imageCropperRestHandled;
  }

  const aiImageRestHandled = await handleAiImageRestRoute({
    req,
    res,
    parts,
    json,
    notFound,
    writeHead
  });
  if (aiImageRestHandled !== false) {
    return aiImageRestHandled;
  }

  const aiVariantLabRestHandled = await handleAiVariantLabRestRoute({
    req,
    res,
    parts,
    services,
    json
  });
  if (aiVariantLabRestHandled !== false) {
    return aiVariantLabRestHandled;
  }

  const aiPromptTemplateRestHandled = await handleAiPromptTemplateRestRoute({
    req,
    res,
    parts,
    services,
    readJson,
    json,
    notFound
  });
  if (aiPromptTemplateRestHandled !== false) {
    return aiPromptTemplateRestHandled;
  }

  const aiStrategyRestHandled = await handleAiStrategyRestRoute({
    req,
    res,
    parts,
    services,
    readJson,
    json,
    notFound
  });
  if (aiStrategyRestHandled !== false) {
    return aiStrategyRestHandled;
  }

  const materialAssetRestHandled = await handleMaterialAssetRestRoute({
    req,
    res,
    parts,
    services,
    readJson,
    json,
    notFound
  });
  if (materialAssetRestHandled !== false) {
    return materialAssetRestHandled;
  }

  return false;
}

function isAllowedLocalPluginCorsOrigin(origin) {
  const value = String(origin || "").trim();
  if (!value) return true;
  if (value === "null") return false;
  if (value.startsWith("chrome-extension://")) return true;
  try {
    const url = new URL(value);
    const appUrl = new URL(config.appBaseUrl || "http://localhost:8788");
    const hostname = url.hostname.toLowerCase();
    const appHostname = appUrl.hostname.toLowerCase();
    if (
      url.protocol === appUrl.protocol &&
      hostname === appHostname &&
      String(url.port || "") === String(appUrl.port || "")
    ) {
      return true;
    }
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname)) return true;
    return /(^|\.)ozon\.(ru|kz|by)$/i.test(hostname);
  } catch {
    return false;
  }
}

function localPluginCorsHeaders(req) {
  const origin = String(req.headers.origin || "").trim();
  const allowOrigin = isAllowedLocalPluginCorsOrigin(origin) ? (origin || "*") : config.appBaseUrl;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-tenant-id,x-local-plugin-token,Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function localPluginJson(req, res, payload, status = 200) {
  const body = JSON.stringify(payload);
  writeHead(res, status, {
    ...localPluginCorsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  try {
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function pluginBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return String(req.headers["x-local-plugin-token"] || bearer || "").trim();
}

function isAuthorizedLocalPluginRequest(req) {
  if (isDirectLocalRequest(req)) return true;
  const token = pluginBearerToken(req);
  const allowedTokens = [
    config.localPluginSharedSecret,
    config.localPluginPublicToken
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return allowedTokens.some((allowedToken) => safeEqualText(token, allowedToken));
}

async function handleLocalPluginRoute(req, res, parts) {
  if (parts[0] !== "api" || parts[1] !== "local-plugin") return false;

  if (req.method === "OPTIONS") {
    writeHead(res, 204, localPluginCorsHeaders(req));
    res.end();
    return true;
  }

  if (!isAuthorizedLocalPluginRequest(req)) {
    return localPluginJson(req, res, { success: false, error: "local plugin endpoint requires localhost or a valid plugin token" }, 403);
  }

  if (parts[2] === "update-status" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return localPluginJson(req, res, {
      success: true,
      data: globalUpdateStatus(Object.fromEntries(url.searchParams.entries()))
    });
  }

  if (parts[2] === "plugin" && parts[3] === "status" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tenantId = String(req.headers["x-tenant-id"] || url.searchParams.get("tenantId") || "admin").trim() || "admin";
    return localPluginJson(req, res, {
      success: true,
      data: {
        connected: true,
        app: "ozon-erp",
        appBaseUrl: config.appBaseUrl,
        tenantId,
        pluginVersion: url.searchParams.get("plugin_version") || "",
        serverTime: new Date().toISOString()
      }
    });
  }

  if (parts[2] === "server-publish" && parts[3] === "media-upload-jobs" && parts[4] === "claim" && req.method === "POST") {
    const body = await readJson(req);
    const result = await services.claimServerPublishMediaUploadJobs(body || {});
    return localPluginJson(req, res, { success: result.success !== false, data: result, ...result });
  }

  if (parts[2] === "server-publish" && parts[3] === "media-upload-jobs" && parts[4] && parts[5] && req.method === "POST") {
    const body = await readJson(req);
    const result = await services.completeServerPublishMediaUploadJob(parts[4], parts[5], body || {});
    return localPluginJson(req, res, { success: result.success !== false, data: result, ...result });
  }

  if (parts[2] === "collected-products" && parts[3] === "sync" && req.method === "POST") {
    const body = await readJson(req);
    const tenantId = String(req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin").trim();
    const result = await services.syncCollectedProductsFromPlugin(body?.products || [], tenantId);
    return localPluginJson(req, res, { success: true, ...result });
  }

  if (parts[2] === "collected-products" && parts[3] === "lookup" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tenantId = String(req.headers["x-tenant-id"] || url.searchParams.get("tenantId") || "admin").trim();
    const result = await services.lookupCollectedProductFromPlugin(url.searchParams.get("sku") || "", tenantId);
    return localPluginJson(req, res, { success: true, data: result });
  }

  if (parts[2] === "collected-products" && parts[3] === "lookup-batch" && req.method === "POST") {
    const body = await readJson(req);
    const tenantId = String(req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin").trim();
    const skus = [...new Set((Array.isArray(body?.skus) ? body.skus : [])
      .map((sku) => String(sku || "").trim())
      .filter(Boolean))].slice(0, 120);
    const results = new Array(skus.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, skus.length || 1) }, async () => {
      while (cursor < skus.length) {
        const index = cursor++;
        const sku = skus[index];
        try {
          results[index] = { sku, success: true, data: await services.lookupCollectedProductFromPlugin(sku, tenantId) };
        } catch (error) {
          results[index] = { sku, success: false, error: error?.message || String(error) };
        }
      }
    }));
    return localPluginJson(req, res, { success: true, total: skus.length, results });
  }

  if (parts[2] === "collector-seller-pool" && parts[3] === "status" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tenantId = String(req.headers["x-tenant-id"] || url.searchParams.get("tenantId") || "admin").trim();
    const result = await collectorSellerPoolStatus(tenantId);
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  if (parts[2] === "collector-seller-pool" && parts[3] === "collect" && req.method === "POST") {
    const body = await readJson(req);
    const tenantId = String(req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin").trim();
    const result = await collectSkusWithSellerPool(body?.skus || [], tenantId);
    return localPluginJson(req, res, { success: result.success !== false, data: result, ...result });
  }

  if (parts[2] === "collected-product-details" && req.method === "POST") {
    const body = await readJson(req);
    const detail = await services.saveListingCollectedProductDetail({
      ...body,
      tenant_id: req.headers["x-tenant-id"] || body?.tenant_id || "admin"
    }, null);
    return localPluginJson(req, res, { success: true, data: detail, id: detail?.id, detail });
  }

  if (parts[2] === "collected-product-details" && parts[3] && req.method === "GET") {
    const tenantId = String(req.headers["x-tenant-id"] || "admin");
    const detail = await services.getListingCollectedProductDetail(parts[3], tenantId);
    if (!detail) return localPluginJson(req, res, { success: false, error: "Collected product detail not found" }, 404);
    return localPluginJson(req, res, { success: true, data: detail, id: detail.id, detail });
  }

  if (parts[2] === "collector-box" && parts[3] && req.method === "POST" && parts[4] === "create-selection") {
    const sku = decodeURIComponent(parts[3]);
    const body = await readJson(req);
    const result = await services.createSelectionFromCollectorBox(sku, {
      ...body,
      tenant_id: req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin"
    }, null);
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  if (parts[2] === "collector-box" && parts[3] && req.method === "POST" && parts[4] === "create-listing-template") {
    const sku = decodeURIComponent(parts[3]);
    const body = await readJson(req);
    const result = await services.createListingTemplateFromCollectorBox(sku, {
      ...body,
      tenant_id: req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin"
    }, null);
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  if (parts[2] === "cancelled-postings" && parts[3] === "sync" && req.method === "POST") {
    const body = await readJson(req);
    const postingNumbers = Array.isArray(body.posting_numbers || body.postingNumbers)
      ? (body.posting_numbers || body.postingNumbers).map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (!postingNumbers.length) {
      return localPluginJson(req, res, { success: false, error: "No posting numbers supplied" }, 400);
    }
    const result = await services.syncOzonPostingsByNumber({
      ...body,
      posting_numbers: postingNumbers
    }, { signal: req._abortSignal });
    return localPluginJson(req, res, { success: result.ok !== false, data: result, ...result });
  }

  if (parts[2] === "seller-analytics" && parts[3] === "snapshots" && req.method === "POST") {
    const body = await readJson(req);
    const tenantId = String(req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin").trim() || "admin";
    const result = await services.sellerAnalyticsSaveSnapshot(body || {}, tenantId);
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  if (parts[2] === "seller-analytics" && parts[3] === "plugin-status" && req.method === "POST") {
    const body = await readJson(req);
    const tenantId = String(req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin").trim() || "admin";
    const result = await services.sellerAnalyticsSavePluginStatus(body || {}, tenantId);
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  if (parts[2] === "seller-analytics" && parts[3] === "plugin-prepare" && parts[4] === "next" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tenantId = String(req.headers["x-tenant-id"] || url.searchParams.get("tenantId") || "admin").trim() || "admin";
    const request = await services.sellerAnalyticsClaimPluginPrepare(tenantId, Object.fromEntries(url.searchParams.entries()));
    return localPluginJson(req, res, { success: true, data: request, request });
  }

  if (parts[2] === "seller-analytics" && parts[3] === "plugin-prepare" && parts[4] === "result" && req.method === "POST") {
    const body = await readJson(req);
    const tenantId = String(req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin").trim() || "admin";
    const result = await services.sellerAnalyticsFinishPluginPrepare(body || {}, tenantId);
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  if (parts[2] === "seller-analytics" && parts[3] === "auth-probe" && req.method === "POST") {
    const body = await readJson(req);
    const result = await services.sellerAnalyticsProbeAuth(body || {});
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  if (parts[2] === "seller-analytics" && parts[3] === "auth-bindings" && req.method === "POST") {
    const body = await readJson(req);
    const tenantId = String(req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin").trim() || "admin";
    const result = await services.sellerAnalyticsBindAuth(body || {}, tenantId);
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  if (parts[2] === "seller-analytics" && parts[3] === "collect-runs" && parts[4] === "next" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tenantId = String(req.headers["x-tenant-id"] || url.searchParams.get("tenantId") || "admin").trim() || "admin";
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 6), 20));
    const requests = await services.sellerAnalyticsNextCollectRequests(tenantId, limit, {
      store_id: url.searchParams.get("store_id") || url.searchParams.get("storeId") || "",
      company_id: url.searchParams.get("company_id") || url.searchParams.get("companyId") || ""
    });
    return localPluginJson(req, res, { success: true, data: requests, requests });
  }

  if (
    parts[2] === "seller-analytics" &&
    parts[3] === "collect-runs" &&
    parts[4] &&
    parts[5] === "requests" &&
    parts[6] &&
    parts[7] === "result" &&
    req.method === "POST"
  ) {
    const body = await readJson(req);
    const tenantId = String(req.headers["x-tenant-id"] || body?.tenant_id || body?.tenantId || "admin").trim() || "admin";
    const result = await services.sellerAnalyticsFinishCollectRequest(decodeURIComponent(parts[4]), decodeURIComponent(parts[6]), body || {}, tenantId);
    return localPluginJson(req, res, { success: true, data: result, ...result });
  }

  return false;
}


async function sendProductImage(res, productId, imageLoader = null, options = {}) {
  try {
    const loadImage = () => imageLoader ? imageLoader(productId) : services.productImage(productId);
    let image = await loadImage();
    if (!image && services.refreshProductImageUrl) {
      image = await services.refreshProductImageUrl(productId).catch(() => "");
    }
    if (!image) return notFound(res);
    const thumbnail = Boolean(options.thumbnail);
    const thumbnailWidth = Math.min(Math.max(Number(options.width || 180), 80), 360);
    const aiFile = await resolveAiImageFile(String(image));
    if (aiFile) {
      const originalBuffer = await fs.readFile(aiFile.filePath);
      const imageBody = thumbnail
        ? await productThumbnailBuffer(originalBuffer, `${productId}:${options.version || ""}:${aiFile.filePath}`, thumbnailWidth)
        : { buffer: originalBuffer, contentType: aiFile.contentType, cacheControl: "no-store, must-revalidate" };
      writeHead(res, 200, {
        "Content-Type": imageBody.contentType,
        "Content-Length": imageBody.buffer.length,
        "Cache-Control": imageBody.cacheControl,
        ...(thumbnail ? { "X-Product-Image-Variant": "thumbnail" } : { "Pragma": "no-cache" })
      });
      return res.end(imageBody.buffer);
    }
    if (/^https?:\/\//i.test(String(image))) {
      let payload = await fetchRemoteImagePayload(String(image)).catch(() => null);
      if (!payload && services.refreshProductImageUrl) {
        const refreshedImage = await services.refreshProductImageUrl(productId).catch(() => "");
        if (refreshedImage) {
          image = refreshedImage;
          payload = await fetchRemoteImagePayload(String(refreshedImage)).catch(() => null);
        }
      }
      if (!payload) return sendImagePlaceholder(res);
      const imageBody = thumbnail
        ? await productThumbnailBuffer(payload.buffer, `${productId}:${options.version || ""}:${image}`, thumbnailWidth)
        : { buffer: payload.buffer, contentType: payload.contentType, cacheControl: "private, max-age=86400" };
      writeHead(res, 200, {
        "Content-Type": imageBody.contentType,
        "Content-Length": imageBody.buffer.length,
        "Cache-Control": imageBody.cacheControl,
        ...(thumbnail ? { "X-Product-Image-Variant": "thumbnail" } : {})
      });
      return res.end(imageBody.buffer);
    }
    const match = String(image).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return json(res, { error: "Unsupported image" }, 415);
    const originalBuffer = Buffer.from(match[2], "base64");
    const imageBody = thumbnail
      ? await productThumbnailBuffer(originalBuffer, `${productId}:${options.version || ""}:${createHash("sha256").update(String(image)).digest("hex")}`, thumbnailWidth)
      : { buffer: originalBuffer, contentType: match[1], cacheControl: "no-store, must-revalidate" };
    writeHead(res, 200, {
      "Content-Type": imageBody.contentType,
      "Content-Length": imageBody.buffer.length,
      "Cache-Control": imageBody.cacheControl,
      ...(thumbnail ? { "X-Product-Image-Variant": "thumbnail" } : { "Pragma": "no-cache" })
    });
    return res.end(imageBody.buffer);
  } catch (error) {
    if (Number(error?.status || 0) === 404) return notFound(res);
    console.error("send product image failed:", error);
    return json(res, { error: "Product image unavailable" }, 500);
  }
}

async function productThumbnailBuffer(buffer, cacheSeed, width) {
  const height = Math.round(width * 1.32);
  const cacheKey = createHash("sha256").update(`${cacheSeed}:${width}:${height}:webp72`).digest("hex");
  const cachePath = path.join(productThumbnailCacheDir, `${cacheKey}.webp`);
  try {
    const cached = await fs.readFile(cachePath);
    return {
      buffer: cached,
      contentType: "image/webp",
      cacheControl: "private, max-age=86400"
    };
  } catch {
    // Cache miss.
  }
  const resized = await sharp(buffer)
    .rotate()
    .resize({ width, height, fit: "cover", withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
  await fs.mkdir(productThumbnailCacheDir, { recursive: true });
  await fs.writeFile(cachePath, resized).catch(() => null);
  return {
    buffer: resized,
    contentType: "image/webp",
    cacheControl: "private, max-age=86400"
  };
}

async function resolveAiImageFile(imageUrl) {
  const match = String(imageUrl || "").match(/^\/api\/ai\/file\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return getAiTaskFile(
    decodeURIComponent(match[1]),
    decodeURIComponent(match[2]),
    match[3].split("/").map(decodeURIComponent).join("/")
  );
}

function sendImagePlaceholder(res) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" rx="12" fill="#f4f7fb"/><path d="M42 104l25-28 18 20 12-14 21 22H42z" fill="#c9d3e3"/><circle cx="106" cy="55" r="11" fill="#c9d3e3"/><text x="80" y="132" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#7b8798">NO IMG</text></svg>`;
  const buffer = Buffer.from(svg);
  writeHead(res, 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store, must-revalidate",
    "X-Image-Proxy-Cache": "PLACEHOLDER"
  });
  return res.end(buffer);
}

function sendImageProxyUnavailable(res) {
  writeHead(res, 502, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": 0,
    "Cache-Control": "no-store, must-revalidate",
    "X-Image-Proxy-Cache": "UNAVAILABLE"
  });
  return res.end();
}

function imageProxyCacheKey(target) {
  return createHash("sha256").update(target).digest("hex");
}

function imageProxyCachePaths(target) {
  const key = imageProxyCacheKey(target);
  return {
    dataPath: path.join(imageProxyCacheDir, `${key}.bin`),
    metaPath: path.join(imageProxyCacheDir, `${key}.json`)
  };
}

async function readCachedRemoteImage(target) {
  const { dataPath, metaPath } = imageProxyCachePaths(target);
  try {
    const [metaRaw, dataStat] = await Promise.all([
      fs.readFile(metaPath, "utf8"),
      fs.stat(dataPath)
    ]);
    if (Date.now() - dataStat.mtimeMs > IMAGE_PROXY_CACHE_TTL_MS) return null;
    const meta = JSON.parse(metaRaw);
    const contentType = String(meta.contentType || "").toLowerCase();
    if (!contentType.startsWith("image/")) return null;
    return {
      buffer: await fs.readFile(dataPath),
      contentType
    };
  } catch {
    return null;
  }
}

async function writeCachedRemoteImage(target, payload) {
  if (!payload?.buffer?.length || payload.buffer.length > IMAGE_PROXY_MAX_CACHE_BYTES) return;
  const { dataPath, metaPath } = imageProxyCachePaths(target);
  await fs.mkdir(imageProxyCacheDir, { recursive: true });
  await Promise.all([
    fs.writeFile(dataPath, payload.buffer),
    fs.writeFile(metaPath, JSON.stringify({
      contentType: payload.contentType,
      cachedAt: new Date().toISOString()
    }), "utf8")
  ]);
}

function sendRemoteImageBuffer(res, payload, cacheState) {
  writeHead(res, 200, {
    "Content-Type": payload.contentType,
    "Content-Length": payload.buffer.length,
    "Cache-Control": `public, max-age=${IMAGE_PROXY_BROWSER_CACHE_SECONDS}`,
    "X-Image-Proxy-Cache": cacheState
  });
  return res.end(payload.buffer);
}

async function fetchRemoteImagePayload(target) {
  await acquireImageProxyFetchSlot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_PROXY_FETCH_TIMEOUT_MS);
  try {
    if (isManagedOssObjectUrl(target)) {
      const managed = await readManagedOssObject(target, {
        maxBytes: IMAGE_PROXY_MAX_RESPONSE_BYTES,
        timeoutMs: IMAGE_PROXY_FETCH_TIMEOUT_MS
      });
      if (!managed?.contentType?.startsWith("image/")) return null;
      return { buffer: managed.buffer, contentType: managed.contentType };
    }
    const upstream = await fetch(target, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": "https://www.ozon.ru/",
        "Origin": "https://www.ozon.ru"
      }
    });
    if (!upstream.ok) return null;
    const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return null;
    const declaredBytes = Number(upstream.headers.get("content-length") || 0);
    if (declaredBytes > IMAGE_PROXY_MAX_RESPONSE_BYTES) return null;
    const chunks = [];
    let receivedBytes = 0;
    for await (const chunk of upstream.body) {
      receivedBytes += chunk.length;
      if (receivedBytes > IMAGE_PROXY_MAX_RESPONSE_BYTES) {
        await upstream.body.cancel().catch(() => null);
        return null;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, receivedBytes);
    return { buffer, contentType };
  } finally {
    clearTimeout(timeout);
    releaseImageProxyFetchSlot();
  }
}

function acquireImageProxyFetchSlot() {
  if (activeImageProxyFetches < IMAGE_PROXY_FETCH_CONCURRENCY) {
    activeImageProxyFetches += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => imageProxyFetchWaiters.push(resolve));
}

function releaseImageProxyFetchSlot() {
  const next = imageProxyFetchWaiters.shift();
  if (next) return next();
  activeImageProxyFetches = Math.max(0, activeImageProxyFetches - 1);
}

async function sendRemoteImage(req, res, url) {
  const target = String(url.searchParams.get("url") || "").trim();
  if (!/^https?:\/\//i.test(target)) return json(res, { error: "Invalid image url" }, 400);

  const cached = await readCachedRemoteImage(target);
  if (cached) return sendRemoteImageBuffer(res, cached, "HIT");
  const failedUntil = Number(imageProxyFailureCache.get(target) || 0);
  if (failedUntil > Date.now()) return sendImageProxyUnavailable(res);
  if (failedUntil) imageProxyFailureCache.delete(target);

  const onClose = () => {
    // The shared upstream fetch may still populate cache for another row.
  };
  req.on("aborted", onClose);
  res.on("close", onClose);

  try {
    let payloadPromise = imageProxyInflight.get(target);
    if (!payloadPromise) {
      payloadPromise = fetchRemoteImagePayload(target);
      imageProxyInflight.set(target, payloadPromise);
    }
    const payload = await payloadPromise;
    if (res.writableEnded || res.destroyed) return;
    if (!payload) {
      imageProxyFailureCache.set(target, Date.now() + IMAGE_PROXY_FAILURE_TTL_MS);
      return sendImageProxyUnavailable(res);
    }
    imageProxyFailureCache.delete(target);
    writeCachedRemoteImage(target, payload).catch((error) => {
      console.warn("image proxy cache write failed:", error?.message || error);
    });
    return sendRemoteImageBuffer(res, payload, "MISS");
  } catch (error) {
    if (res.writableEnded || res.destroyed) return;
    imageProxyFailureCache.set(target, Date.now() + IMAGE_PROXY_FAILURE_TTL_MS);
    return sendImageProxyUnavailable(res);
  } finally {
    imageProxyInflight.delete(target);
    req.off("aborted", onClose);
    res.off("close", onClose);
  }
}

const server = http.createServer(async (req, res) => {
  const startedAt = performance.now();
  try {
    // Attach a per-request abort signal so sync and import flows can stop when
    // the client disconnects.
    const requestAbort = new AbortController();
    req._abortSignal = requestAbort.signal;
    req.on("aborted", () => requestAbort.abort(new Error("客户端已取消本次请求")));
    res.on("close", () => {
      if (!res.writableEnded) requestAbort.abort(new Error("客户端连接已关闭"));
    });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/api/ready") {
      return json(res, {
        ok: runtimeReadiness.ready,
        status: runtimeReadiness.ready ? "ready" : "starting",
        started_at: runtimeReadiness.startedAt,
        ready_at: runtimeReadiness.readyAt || null,
        error: runtimeReadiness.error || null
      }, runtimeReadiness.ready ? 200 : 503);
    }
    trackForegroundApiRequest(req, res, parts);
    if (parts[0] === "api") {
      req._timingMarks = [];
      res._serverTimingStartedAt = startedAt;
      res._serverTimingMarks = req._timingMarks;
    }
    res.on("finish", () => logSlowApiRequest({ req, res, url, startedAt }));

    let localPluginHandled = false;
    try {
      localPluginHandled = await handleLocalPluginRoute(req, res, parts);
    } catch (error) {
      if (parts[0] === "api" && parts[1] === "local-plugin") {
        if (!isRequestCancelledError(error)) console.error("local plugin route failed", error);
        return localPluginJson(req, res, {
          success: false,
          error: error?.message || String(error),
          validation: error?.validation
        }, error?.status || 500);
      }
      throw error;
    }
    if (localPluginHandled !== false) return;

    if ((req.method === "GET" || req.method === "HEAD") && (isPublicListingMediaPath(parts) || isVersionedVueAssetPath(url.pathname))) {
      return serveStatic(url.pathname, req, res);
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "listing" && parts[2] === "media" && parts[3] === "public-upload") {
      const token = String(url.searchParams.get("token") || req.headers["x-local-plugin-token"] || "").trim();
      const expected = String(config.localPluginPublicToken || "").trim();
      if (!token || !expected || !safeEqualText(token, expected)) {
        console.warn(`[forbidden] ${req.method} ${url.pathname} reason=public_upload_token`);
        return json(res, { error: "素材公网同步未授权" }, 403);
      }
      return json(res, await services.uploadListingMedia(req, { skipPublicSync: true, publicUpload: true }));
    }

    if (parts[0] === "api" && parts[1] === "webhooks" && parts[2] === "ozon") {
      if (req.method !== "POST" || parts.length !== 3) return json(res, { error: "仅支持Ozon POST通知" }, 405);
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("application/json")) return json(res, { error: "Ozon通知必须使用application/json" }, 415);
      const contentLength = Number(req.headers["content-length"] || 0);
      if (contentLength > 256 * 1024) return json(res, { error: "Ozon通知请求体过大" }, 413);
      return json(res, await services.receiveOzonWebhook(await readJson(req)));
    }

    if (url.pathname === SITE_ACCESS_SESSION_PATH || url.pathname === SITE_ACCESS_LOGIN_PATH || url.pathname === SITE_ACCESS_LOGOUT_PATH || url.pathname === SITE_ACCESS_API_LOGIN_PATH) {
      if (await handleSiteAccess(req, res, url)) return;
    }

    if (!isSiteAccessAuthorized(req) && !isPublicAuthCallbackPath(req, parts)) {
      if (parts[0] === "api") {
        console.warn(`[forbidden] ${req.method} ${url.pathname} reason=site_access`);
        return json(res, { error: "访问受限，请先通过内部访问验证" }, 403);
      }
      return html(res, renderSiteAccessPage("", `${url.pathname}${url.search || ""}`), 401);
    }

    if (parts[0] === "api" && parts[1] === "auth") {
      const handler = handleAuth(req, url);
      if (handler) {
        const result = await handler();
        if (result?.__redirect) {
          writeHead(res, 302, { Location: result.__redirect });
          res.end();
          return;
        }
        if (Array.isArray(result?.__cookies)) {
          for (const cookie of result.__cookies) {
            setCookie(res, cookie.name, cookie.value, cookie.options || {});
          }
          delete result.__cookies;
        }
        if (result?.__html) {
          return html(res, result.__html, result.__status || 200);
        }
        if (result?.__body) {
          const body = Buffer.isBuffer(result.__body) ? result.__body : Buffer.from(result.__body);
          writeHead(res, result.__status || 200, {
            "Content-Type": result.__contentType || "application/octet-stream",
            "Content-Length": body.length,
            "Cache-Control": "no-store"
          });
          res.end(body);
          return;
        }
        const status = result?.__status || 200;
        if (result && typeof result === "object" && "__status" in result) delete result.__status;
        return json(res, result, status);
      }
      return notFound(res);
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "image") {
      return sendProductImage(res, Number(parts[2]), null, {
        thumbnail: ["1", "true", "yes"].includes(String(url.searchParams.get("thumb") || "").toLowerCase()),
        width: Number(url.searchParams.get("w") || 0),
        version: url.searchParams.get("v") || ""
      });
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "ai" && parts[2] === "file") {
      const aiImageRestHandled = await handleAiImageRestRoute({
        req,
        res,
        parts,
        json,
        notFound,
        writeHead
      });
      if (aiImageRestHandled !== false) return aiImageRestHandled;
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "image-proxy") {
      return sendRemoteImage(req, res, url);
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "asset-variant-engine" && parts[2] === "tail-template-files" && parts[3]) {
      const file = await services.resolveAssetTailTemplateFile(decodeURIComponent(parts[3]));
      if (!file) return notFound(res);
      writeHead(res, 200, {
        "Content-Type": file.mime,
        "Content-Length": file.buffer.length,
        "Cache-Control": "private, max-age=3600"
      });
      return res.end(file.buffer);
    }

    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      return serveStatic("/admin.html", req, res);
    }

    if (parts[0] === "api") {
      markRequestTiming(req, "before_session");
      const bearerToken = extractToken(req);
      const queryToken = allowQueryTokenAuth(req, parts, url) ? url.searchParams.get("token") : "";
      const session = await getSession(bearerToken || queryToken);
      markRequestTiming(req, "after_session");
      if (!session) return json(res, { error: "未登录，请先登录" }, 401);
      req._session = session;
      req.query = Object.fromEntries(url.searchParams.entries());
      const authorization = authorizeApiRequest(req, parts);
      if (!authorization.allowed) {
        console.warn(`[forbidden] ${req.method} ${url.pathname} reason=authorization detail=${authorization.error || "权限不足"}`);
        return json(res, { error: authorization.error || "权限不足" }, authorization.status || 403);
      }
    }

    markRequestTiming(req, "before_rest");
    const restHandled = await handleRestRoute(req, res, url, parts);
    markRequestTiming(req, "after_rest");
    if (restHandled !== false) return;

    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) {
      markRequestTiming(req, "before_route");
      const payload = await routes[key](req, url);
      markRequestTiming(req, "after_route");
      json(res, payload);
      markRequestTiming(req, "after_json");
      return;
    }
    if (parts[0] === "api") return notFound(res);

    return serveStatic(url.pathname, req, res);
  } catch (error) {
    if (!isRequestCancelledError(error)) console.error(error);
    if (res.writableEnded || res.destroyed) return;
    json(res, { error: error.message, validation: error.validation }, error.status || 500);
  }
});

async function prepareRuntimeBeforeListen() {
  try {
    await warmMysqlPool();
    await services.warmCoreInventoryRuntime?.();
    await services.ensureListingAutomationSchema?.();
    console.log("listing automation schema warmup completed");
    runtimeReadiness.ready = true;
    runtimeReadiness.readyAt = new Date().toISOString();
    console.log("database and core runtime warmup completed");
  } catch (error) {
    runtimeReadiness.error = error?.message || String(error);
    console.error("database and core runtime warmup failed", error);
    throw error;
  }
}

await prepareRuntimeBeforeListen();

server.listen(config.port, config.host || undefined, () => {
  const bindHost = config.host || "0.0.0.0";
  console.log(`ozon ERP running at ${config.appBaseUrl} (bind ${bindHost}:${config.port})`);
  const deploymentCandidate = process.env.DEPLOYMENT_CANDIDATE === "1";
  if (!deploymentCandidate) setInterval(() => checkDailyPurchaseNotification(services.all), 60000);
  void (async () => {
    if (config.scheduledJobsEnabled) {
      registerScheduledJobs(scheduledJobDefinitions)
        .then(() => recoverInterruptedScheduledJobRuns())
        .then((recovery) => {
          scheduledJobScheduler.start();
          console.log(`scheduled job scheduler started with ${scheduledJobDefinitions.length} job(s); recovered ${recovery.interruptedRuns} interrupted run(s)`);
        })
        .catch((error) => console.error("scheduled job scheduler startup failed", error));
    } else {
      console.log("scheduled job scheduler disabled for this server; manual runs remain available");
    }
  })();
  if (!deploymentCandidate) setTimeout(recoverGenerationJobs, 3000);
});

let gracefulShutdownStarted = false;
function gracefulShutdown(signal) {
  if (gracefulShutdownStarted) return;
  gracefulShutdownStarted = true;
  runtimeReadiness.ready = false;
  console.log(`received ${signal}; draining HTTP connections`);
  const forceTimer = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(1);
  }, 25000);
  forceTimer.unref();
  server.close((error) => {
    if (error) {
      console.error("HTTP shutdown failed", error);
      process.exitCode = 1;
    }
    process.exit();
  });
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

async function recoverGenerationJobs() {
  await Promise.allSettled([
    recoverAssetVariantJobs(),
    recoverAiGenerationTasks(),
    recoverDirectListingPublishes(),
    recoverInterruptedListingPublishTasks()
  ]);
}

async function recoverInterruptedListingPublishTasks() {
  try {
    const result = await services.recoverInterruptedListingPublishTasksOnStartup?.();
    if (result?.tasks) console.log("listing publish task recovery", result);
  } catch (error) {
    console.error("listing publish task recovery failed", error);
  }
}

async function recoverDirectListingPublishes() {
  try {
    const result = await services.recoverDirectListingPublishesOnStartup?.();
    if (result?.scanned) console.log("direct listing publish recovery", result);
  } catch (error) {
    console.error("direct listing publish recovery failed", error);
  }
}

async function recoverAssetVariantJobs() {
  try {
    const result = await services.recoverAssetVariantJobsOnStartup?.();
    if (result?.queued) console.log(`asset variant job recovery queued ${result.queued} job(s)`);
  } catch (error) {
    console.error("asset variant job recovery failed", error);
  }
}

async function recoverAiGenerationTasks() {
  try {
    const result = await services.recoverAiGenerationTasksOnStartup?.();
    if (result?.ok) console.log("ai generation task worker recovered");
  } catch (error) {
    console.error("ai generation task recovery failed", error);
  }
  try {
    const result = await services.recoverAiVariantLabImageBatchesOnStartup?.();
    if (result?.ok) console.log(`AI variant image batch worker recovered ${result.resumed || 0} batch(es)`);
  } catch (error) {
    console.warn("AI variant image batch recovery skipped:", error?.message || error);
  }
  try {
    const result = await services.recoverAiMaterialOptimizationBatchesOnStartup?.();
    if (result?.ok) console.log("AI material optimization batch worker ready");
  } catch (error) {
    console.warn("AI material optimization batch recovery skipped:", error?.message || error);
  }
  try {
    const result = await services.recoverAiVariantDraftSaveBatchesOnStartup?.();
    if (result?.ok) console.log("AI variant draft save batch worker ready");
  } catch (error) {
    console.warn("AI variant draft save batch recovery skipped:", error?.message || error);
  }
}

async function runBackgroundCustomerMessageDispatch() {
  if (backgroundCustomerMessageRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 60 };
  const laneBusy = claimBackgroundModuleLane("customer_messages", "customer_message_dispatch");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 60 };
  backgroundCustomerMessageRunning = true;
  try {
    const result = await services.processCustomerMessageTasks({ limit: 30 });
    const webhookResult = await services.processOzonWebhookEvents({ limit: 10 });
    console.log(`background customer message dispatch ok: webhooks ${webhookResult.processed || 0}, recovered ${webhookResult.recovered || 0}, tasks ${result.processed || 0}, sending_disabled=${Boolean(result.sending_disabled)}`);
    return { ...result, webhooks_processed: webhookResult.processed || 0, webhooks_recovered: webhookResult.recovered || 0 };
  } finally {
    backgroundCustomerMessageRunning = false;
    releaseBackgroundModuleLane("customer_messages", "customer_message_dispatch");
  }
}

async function runBackgroundOrderStatusSync() {
  if (backgroundOrderSyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 30 };
  const laneBusy = claimBackgroundModuleLane("orders", "order_status_sync");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 30 };
  backgroundOrderSyncRunning = true;
  try {
    const result = await services.syncOzonIncrementalOrders({
      mode: "new",
      fallback_days: BACKGROUND_ORDER_SYNC_DAYS,
      overlap_minutes: 60,
      skip_post_processing: true
    });
    const dashboard = await services.refreshDashboardSnapshot({ forceRefresh: true });
    console.log(`background order status sync ok: fetched ${result.fetched || 0}, updated ${result.updated || 0}, requests ${result.requests || 0}`);
    console.log(`dashboard snapshot refreshed after order sync: ${dashboard?.commerce?.date_key || ""} ${dashboard?.snapshot?.refreshed_at || ""}`);
    return {
      ...result,
      dashboard_refresh: {
        date_key: dashboard?.commerce?.date_key || "",
        refreshed_at: dashboard?.snapshot?.refreshed_at || ""
      }
    };
  } catch (error) {
    console.error("background order status sync failed", error);
    throw error;
  } finally {
    backgroundOrderSyncRunning = false;
    releaseBackgroundModuleLane("orders", "order_status_sync");
  }
}

async function runBackgroundCancelledOrderSync() {
  if (backgroundCancelledOrderSyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 60 };
  const laneBusy = claimBackgroundModuleLane("orders", "cancelled_order_sync");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 60 };
  backgroundCancelledOrderSyncRunning = true;
  try {
    const window = rollingOrderSyncWindow(BACKGROUND_CANCELLED_ORDER_SYNC_DAYS);
    const result = await services.syncDemoOrders({
      from: window.from,
      to: window.to,
      statuses: ["cancelled"],
      skip_post_processing: true
    });
    console.log(`background cancelled order sync ok: ${window.from}~${window.to}, fetched ${result.fetched || 0}, updated ${result.updated || 0}`);
    return { window, ...result };
  } catch (error) {
    console.error("background cancelled order sync failed", error);
    throw error;
  } finally {
    backgroundCancelledOrderSyncRunning = false;
    releaseBackgroundModuleLane("orders", "cancelled_order_sync");
  }
}

async function runBackgroundPostingDetailSync() {
  if (backgroundPostingDetailSyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 60 };
  const laneBusy = claimBackgroundModuleLane("orders", "posting_detail_sync");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 60 };
  backgroundPostingDetailSyncRunning = true;
  try {
    const reconciliationWindow = rollingOrderSyncWindow(BACKGROUND_POSTING_DETAIL_RECONCILIATION_DAYS);
    const reconciliation = await services.syncDemoOrders({
      from: reconciliationWindow.from,
      to: reconciliationWindow.to,
      skip_post_processing: true
    });
    const result = await services.syncKnownOzonPostingDetails({
      mode: "scheduled_hourly",
      days: BACKGROUND_POSTING_DETAIL_SYNC_DAYS,
      limit: BACKGROUND_POSTING_DETAIL_SYNC_LIMIT,
      concurrency: BACKGROUND_POSTING_DETAIL_SYNC_CONCURRENCY
    });
    console.log(`background posting detail sync ok: reconciled ${reconciliation.fetched || 0}, candidates ${result.candidate_orders || 0}, fetched ${result.fetched || 0}, updated ${result.updated || 0}`);
    return { ...result, reconciliation: { window: reconciliationWindow, ...reconciliation } };
  } catch (error) {
    console.error("background posting detail sync failed", error);
    throw error;
  } finally {
    backgroundPostingDetailSyncRunning = false;
    releaseBackgroundModuleLane("orders", "posting_detail_sync");
  }
}

async function runBackgroundPostingDetailDeepSync() {
  if (backgroundPostingDetailSyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 120 };
  const laneBusy = claimBackgroundModuleLane("orders", "posting_detail_deep_sync");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 120 };

  backgroundPostingDetailSyncRunning = true;
  try {
    const result = await services.syncKnownOzonPostingDetails({
      mode: "scheduled_nightly",
      days: BACKGROUND_POSTING_DETAIL_DEEP_SYNC_DAYS,
      limit: BACKGROUND_POSTING_DETAIL_DEEP_SYNC_LIMIT,
      concurrency: BACKGROUND_POSTING_DETAIL_SYNC_CONCURRENCY
    });
    console.log(`background posting detail deep sync ok: candidates ${result.candidate_orders || 0}, fetched ${result.fetched || 0}, updated ${result.updated || 0}`);
    return result;
  } catch (error) {
    console.error("background posting detail deep sync failed", error);
    throw error;
  } finally {
    backgroundPostingDetailSyncRunning = false;
    releaseBackgroundModuleLane("orders", "posting_detail_deep_sync");
  }
}

async function runBackgroundAnalyticsRefresh() {
  if (backgroundAnalyticsRefreshRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 60 };
  const laneBusy = claimBackgroundModuleLane("analytics", "analytics_refresh");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 60 };
  backgroundAnalyticsRefreshRunning = true;
  try {
    const result = await services.refreshProfitAnalyticsSnapshots({});
    console.log(`background analytics refresh ok: product rows ${result.product_rows || 0}, sku rows ${result.sku_rows || 0}`);
    return result;
  } catch (error) {
    console.error("background analytics refresh failed", error);
    throw error;
  } finally {
    backgroundAnalyticsRefreshRunning = false;
    releaseBackgroundModuleLane("analytics", "analytics_refresh");
  }
}

async function runBackgroundDashboardSnapshotRefresh() {
  if (backgroundDashboardSnapshotRefreshRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 30 };
  backgroundDashboardSnapshotRefreshRunning = true;
  try {
    const result = await services.refreshDashboardSnapshot({});
    console.log(`background dashboard snapshot refresh ok: ${result?.commerce?.date_key || ""} ${result?.snapshot?.refreshed_at || ""}`);
    return {
      ok: true,
      date_key: result?.commerce?.date_key || "",
      refreshed_at: result?.snapshot?.refreshed_at || ""
    };
  } catch (error) {
    console.error("background dashboard snapshot refresh failed", error);
    throw error;
  } finally {
    backgroundDashboardSnapshotRefreshRunning = false;
  }
}

function createBackgroundTaskSignal(timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out`)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout)
  };
}

async function listActiveAdvertisingShopIds() {
  const rows = await mysqlQuery(`
    SELECT id
    FROM shops
    WHERE status = 'active'
      AND COALESCE(NULLIF(TRIM(performance_client_id), ''), '') <> ''
      AND COALESCE(NULLIF(TRIM(performance_client_secret), ''), '') <> ''
    ORDER BY id
  `);
  return rows.map((row) => Number(row.id)).filter((id) => id > 0);
}

function getSellerAnalyticsStoreId(shop = {}) {
  return String(
    shop.seller_company_id ||
    shop.sellerCompanyId ||
    shop.ozon_company_id ||
    shop.ozonCompanyId ||
    shop.ozon_client_id ||
    shop.ozonClientId ||
    shop.store_client_id ||
    shop.storeClientId ||
    shop.client_id ||
    shop.clientId ||
    shop.company_id ||
    shop.companyId ||
    ""
  ).trim();
}

async function listActiveSellerAnalyticsShops() {
  const rows = await mysqlQuery(`
    SELECT id, name, ozon_client_id, status
    FROM shops
    WHERE status = 'active'
      AND COALESCE(NULLIF(TRIM(ozon_client_id), ''), '') <> ''
    ORDER BY id
  `);
  return rows
    .map((row) => ({
      id: Number(row.id || 0),
      name: String(row.name || "").trim(),
      storeId: getSellerAnalyticsStoreId(row)
    }))
    .filter((row) => row.id > 0 && row.storeId);
}

async function persistScheduledJobConfigPatch(jobKey, patch = {}) {
  const rows = await mysqlQuery("SELECT config_json FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [String(jobKey || "")]);
  const current = rows[0]?.config_json ? JSON.parse(rows[0].config_json) : {};
  const next = { ...current, ...patch };
  await mysqlExecute("UPDATE scheduled_jobs SET config_json = ? WHERE job_key = ?", [JSON.stringify(next), String(jobKey || "")]);
  return next;
}

function rotateShopIds(shopIds = [], cursor = 0, maxShopsPerRun = 1) {
  const ids = Array.from(new Set((shopIds || []).map((item) => Number(item || 0)).filter((item) => item > 0)));
  if (!ids.length) return { selectedShopIds: [], nextCursor: 0 };
  const size = Math.max(1, Math.min(ids.length, Number(maxShopsPerRun || 1)));
  const start = Math.max(0, Number(cursor || 0)) % ids.length;
  const selectedShopIds = [];
  for (let index = 0; index < size; index += 1) {
    selectedShopIds.push(ids[(start + index) % ids.length]);
  }
  return {
    selectedShopIds,
    nextCursor: (start + size) % ids.length
  };
}

async function runConcurrentAdvertisingShopSyncs(shopIds = [], buildBody, options = {}) {
  const ids = Array.from(new Set(shopIds.map((item) => Number(item || 0)).filter((item) => item > 0)));
  const concurrency = Math.max(1, Math.min(6, Number(options.concurrency || 3)));
  const aggregate = {
    imported: 0,
    totalRows: 0,
    total_rows: 0,
    retry_later_campaigns: 0,
    placeholder_rows: 0,
    results: [],
    errors: []
  };
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const shopId = ids[cursor];
      cursor += 1;
      const result = await services.syncAdvertisingDailyFromOzon(buildBody(shopId), { signal: options.signal });
      aggregate.imported += Number(result.imported || 0);
      aggregate.totalRows += Number(result.totalRows || result.total_rows || 0);
      aggregate.total_rows += Number(result.total_rows || result.totalRows || 0);
      aggregate.retry_later_campaigns += Number(result.retry_later_campaigns || 0);
      aggregate.placeholder_rows += Number(result.placeholder_rows || 0);
      aggregate.results.push(...(result.results || []));
      aggregate.errors.push(...(result.errors || []));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  return aggregate;
}

async function runBackgroundAdvertisingSync(context = {}) {
  if (backgroundAdvertisingSyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 90 };
  const laneBusy = claimBackgroundModuleLane("advertising", "advertising_sync");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 90 };
  backgroundAdvertisingSyncRunning = true;
  const timeoutMinutes = Math.max(1, Number(context?.config?.timeoutMinutes || BACKGROUND_ADVERTISING_SYNC_TIMEOUT_MS / 60000));
  const syncDays = Math.max(1, Number(context?.config?.days || BACKGROUND_ADVERTISING_SYNC_DAYS));
  const campaignChunkSize = Math.max(1, Math.min(3, Number(context?.config?.campaignChunkSize || 1)));
  const reportRetryDelayMs = Math.max(5000, Number(context?.config?.reportRetryDelayMs || 15000));
  const maxShopsPerRun = Math.max(1, Math.min(2, Number(context?.config?.maxShopsPerRun || 1)));
  const maxCampaignsPerRun = Math.max(1, Math.min(5, Number(context?.config?.maxCampaignsPerRun || 2)));
  const campaignCursor = Math.max(0, Number(context?.config?.campaignCursor || 0));
  const taskSignal = createBackgroundTaskSignal(timeoutMinutes * 60 * 1000, "background advertising sync");
  try {
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "advertising_sync",
      stepKey: "job_start",
      status: "info",
      message: "Starting background advertising sync",
      detail: { config: context?.config || {} }
    }).catch(() => {});
    const activeShopIds = await listActiveAdvertisingShopIds();
    const { selectedShopIds, nextCursor } = rotateShopIds(activeShopIds, context?.config?.shopCursor || 0, maxShopsPerRun);
    if (!selectedShopIds.length) return { skipped: true, reason: "no_active_performance_shops", retryDelaySeconds: 300 };
    const window = await advertisingBackfillWindow(selectedShopIds, syncDays);
    const result = await services.syncAdvertisingDailyFromOzon({
      from: window.from,
      to: window.to,
      shop_ids: selectedShopIds,
      campaign_chunk_size: campaignChunkSize,
      max_campaigns_per_shop: maxCampaignsPerRun,
      campaign_cursor: campaignCursor,
      report_retry_delay_ms: reportRetryDelayMs,
      run_id: context?.runId,
      job_key: "advertising_sync"
    }, { signal: taskSignal.signal });
    await persistScheduledJobConfigPatch("advertising_sync", {
      shopCursor: nextCursor,
      maxShopsPerRun,
      maxCampaignsPerRun,
      campaignCursor: campaignCursor + maxCampaignsPerRun
    });
    const okShops = (result.results || []).filter((item) => item.status === "ok").length;
    const nonOkShops = (result.results || []).filter((item) => item.status !== "ok").length;
    const hardErrors = (result.results || []).filter((item) => item.status === "error").length;
    const status = hardErrors > 0 ? "partial" : nonOkShops > 0 ? "partial" : "success";
    const warning = result.errors?.length
      ? result.errors.join("; ")
      : (nonOkShops > 0 ? `${nonOkShops} shop(s) failed or skipped` : "");
    console.log(`background advertising sync ok: ${window.from}~${window.to}, imported ${result.imported || 0}, ok shops ${okShops}, skipped/error shops ${nonOkShops}`);
    if (result.errors?.length) console.warn(`background advertising sync warnings: ${result.errors.join("; ")}`);
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "advertising_sync",
      stepKey: "job_finish",
      status: status === "success" ? "success" : "warning",
      message: warning || "Background advertising sync finished",
      detail: { okShops, nonOkShops, hardErrors, imported: result.imported || 0, window }
    }).catch(() => {});
    return {
      status,
      warning,
      shopIds: selectedShopIds,
      okShops,
      nonOkShops,
      hardErrors,
      window,
      ...result
    };
  } catch (error) {
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "advertising_sync",
      stepKey: "job_error",
      status: "error",
      message: error?.message || "Background advertising sync failed"
    }).catch(() => {});
    console.error("background advertising sync failed", error);
    throw error;
  } finally {
    taskSignal.cleanup();
    backgroundAdvertisingSyncRunning = false;
    releaseBackgroundModuleLane("advertising", "advertising_sync");
  }
}

async function advertisingBackfillWindow(shopIds = [], syncDays = BACKGROUND_ADVERTISING_SYNC_DAYS) {
  const recentWindow = rollingOrderSyncWindow(syncDays);
  const ids = shopIds.map((item) => Number(item || 0)).filter((item) => item > 0);
  if (!ids.length) return recentWindow;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await mysqlQuery(`
    SELECT MIN(date_key) AS earliest_pending_date
    FROM ozon_ad_sku_daily
    WHERE source = 'ozon_performance_pending'
      AND shop_id IN (${placeholders})
      AND date_key >= DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), INTERVAL 89 DAY)
      AND date_key <= DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00'))
  `, ids);
  const earliestPending = String(rows?.[0]?.earliest_pending_date || "").slice(0, 10);
  return {
    from: earliestPending && earliestPending < recentWindow.from ? earliestPending : recentWindow.from,
    to: recentWindow.to
  };
}

async function runBackgroundAdvertisingTodaySync(context = {}) {
  if (backgroundAdvertisingTodaySyncRunning || backgroundAdvertisingSyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 60 };
  const laneBusy = claimBackgroundModuleLane("advertising", "advertising_today_sync");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 60 };
  backgroundAdvertisingTodaySyncRunning = true;
  const timeoutMinutes = Math.max(25, Number(context?.config?.timeoutMinutes || BACKGROUND_ADVERTISING_TODAY_SYNC_TIMEOUT_MS / 60000));
  const campaignChunkSize = Math.max(1, Math.min(3, Number(context?.config?.campaignChunkSize || 1)));
  const reportRetryDelayMs = Math.max(5000, Number(context?.config?.reportRetryDelayMs || 15000));
  const maxShopsPerRunConfig = Number(context?.config?.maxShopsPerRun || 0);
  const maxShopsPerRun = Number.isFinite(maxShopsPerRunConfig) && maxShopsPerRunConfig > 0
    ? Math.max(1, Math.min(1, maxShopsPerRunConfig))
    : 1;
  const maxCampaignsPerRun = Math.max(1, Math.min(3, Number(context?.config?.maxCampaignsPerRun || 3)));
  const shopConcurrency = 1;
  const rollingDays = Math.max(1, Math.min(3, Number(context?.config?.rollingDays || 3)));
  const campaignCursor = Math.max(0, Number(context?.config?.campaignCursor || 0));
  const taskSignal = createBackgroundTaskSignal(timeoutMinutes * 60 * 1000, "background advertising today sync");
  try {
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "advertising_today_sync",
      stepKey: "job_start",
      status: "info",
      message: "Starting background advertising today sync",
      detail: { config: context?.config || {} }
    }).catch(() => {});
    const today = shanghaiDateKey();
    const fromDate = shanghaiDateDaysAgo(rollingDays - 1);
    const activeShopIds = await listActiveAdvertisingShopIds();
    const { selectedShopIds, nextCursor } = rotateShopIds(activeShopIds, context?.config?.shopCursor || 0, maxShopsPerRun);
    if (!selectedShopIds.length) return { skipped: true, reason: "no_active_performance_shops", retryDelaySeconds: 300 };
    const result = await runConcurrentAdvertisingShopSyncs(selectedShopIds, (shopId) => ({
      from: fromDate,
      to: today,
      shop_ids: [shopId],
      campaign_chunk_size: campaignChunkSize,
      max_campaigns_per_shop: maxCampaignsPerRun,
      campaign_cursor: campaignCursor,
      report_retry_delay_ms: reportRetryDelayMs,
      run_id: context?.runId,
      job_key: "advertising_today_sync"
    }), { concurrency: shopConcurrency, signal: taskSignal.signal });
    await persistScheduledJobConfigPatch("advertising_today_sync", {
      shopCursor: nextCursor,
      maxShopsPerRun,
      maxCampaignsPerRun,
      shopConcurrency,
      rollingDays,
      campaignCursor: campaignCursor + maxCampaignsPerRun
    });
    const okShops = (result.results || []).filter((item) => item.status === "ok").length;
    const pendingShops = (result.results || []).filter((item) => item.status === "report_pending").length;
    const nonOkShops = (result.results || []).filter((item) => item.status !== "ok").length;
    const hardErrors = (result.results || []).filter((item) => item.status === "error").length;
    const retryLaterCampaigns = Number(result.retry_later_campaigns || 0);
    const status = hardErrors > 0 ? "partial" : (nonOkShops > 0 || retryLaterCampaigns > 0 ? "partial" : "success");
    const warning = result.errors?.length
      ? result.errors.join("; ")
      : (retryLaterCampaigns > 0
        ? `${retryLaterCampaigns} campaign report(s) are not ready from Ozon`
        : (nonOkShops > 0 ? `${nonOkShops} shop(s) failed or skipped` : ""));
    console.log(`background advertising today sync ok: ${today}, imported ${result.imported || 0}, ok shops ${okShops}, skipped/error shops ${nonOkShops}`);
    if (result.errors?.length) console.warn(`background advertising today sync warnings: ${result.errors.join("; ")}`);
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "advertising_today_sync",
      stepKey: "job_finish",
      status: status === "success" ? "success" : "warning",
      message: warning || "Background advertising today sync finished",
      detail: {
        okShops,
        pendingShops,
        nonOkShops,
        hardErrors,
        imported: result.imported || 0,
        placeholderRows: result.placeholder_rows || 0,
        retryLaterCampaigns,
        from: fromDate,
        to: today
      }
    }).catch(() => {});
    return {
      status,
      warning,
      shopIds: selectedShopIds,
      okShops,
      pendingShops,
      nonOkShops,
      hardErrors,
      retryLaterCampaigns,
      retryDelaySeconds: hardErrors > 0 ? 900 : retryLaterCampaigns > 0 ? 300 : undefined,
      from: fromDate,
      to: today,
      ...result
    };
  } catch (error) {
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "advertising_today_sync",
      stepKey: "job_error",
      status: "error",
      message: error?.message || "Background advertising today sync failed"
    }).catch(() => {});
    console.error("background advertising today sync failed", error);
    throw error;
  } finally {
    taskSignal.cleanup();
    backgroundAdvertisingTodaySyncRunning = false;
    releaseBackgroundModuleLane("advertising", "advertising_today_sync");
  }
}

function waitForBackgroundJob(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function sellerAnalyticsPeriodPayload(days = 7) {
  const normalizedDays = Math.max(1, Number(days || 7));
  if (normalizedDays === 7) return { period_key: "7d" };
  if (normalizedDays === 28) return { period_key: "28d" };
  return {
    period_key: "custom",
    date_from: shanghaiDateDaysAgo(normalizedDays, new Date()),
    date_to: shanghaiDateDaysAgo(1, new Date())
  };
}

async function waitForSellerAnalyticsCollectRun(runId, tenantId = "admin", options = {}) {
  const deadline = Date.now() + Math.max(1000, Number(options.timeoutMs || 60000));
  const pollMs = Math.max(500, Number(options.pollMs || 2000));
  while (Date.now() < deadline) {
    const runs = await services.sellerAnalyticsCollectRuns({ limit: 100 }, tenantId);
    const run = (Array.isArray(runs) ? runs : []).find((item) => item.id === runId);
    if (run && !["pending", "running"].includes(String(run.status || ""))) return { run, timedOut: false };
    await waitForBackgroundJob(pollMs);
  }
  const runs = await services.sellerAnalyticsCollectRuns({ limit: 100 }, tenantId).catch(() => []);
  const run = (Array.isArray(runs) ? runs : []).find((item) => item.id === runId) || null;
  return { run, timedOut: true };
}

function withBackgroundOperationTimeout(promise, timeoutMs, label = "background operation") {
  const normalizedTimeoutMs = Math.max(1000, Number(timeoutMs || 1000));
  let timeoutId = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`${label} timed out after ${normalizedTimeoutMs}ms`);
        error.code = "BACKGROUND_OPERATION_TIMEOUT";
        reject(error);
      }, normalizedTimeoutMs);
      timeoutId.unref?.();
    })
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function syncOneSellerAnalyticsShop(shop, context, options) {
  const tenantId = options.tenantId || "admin";
  const periodKey = options.periodKey || "7d";
  const periodPayload = options.periodPayload || { period_key: periodKey };
  const startedAt = Date.now();
  const baseResult = {
    shop_id: shop.id,
    shop_name: shop.name,
    store_id: shop.storeId,
    status: "pending"
  };
  const binding = await services.sellerAnalyticsAuthBindingStatus({
    store_id: shop.storeId,
    shop_id: shop.id,
    company_id: shop.storeId
  }, tenantId);
  const browserProfile = await services.sellerAnalyticsBrowserProfileStatus({
    store_id: shop.storeId,
    company_id: shop.storeId
  }, tenantId);
  if (!browserProfile?.configured && (!binding?.bound || binding?.stale)) {
    return {
      ...baseResult,
      status: "skipped",
      error_code: binding?.stale ? "auth_binding_stale" : "missing_auth_binding",
      error: binding?.stale ? "店铺分析授权已过期，请在数据分析页重新绑定授权。" : "店铺尚未绑定 Ozon 分析授权。"
    };
  }

  const run = await services.sellerAnalyticsCreateCollectRun({
    ...periodPayload,
    store_id: shop.storeId,
    company_id: shop.storeId,
    full_store: true,
    auto_all_pages: true,
    max_pages: options.maxPages,
    limit: options.requestLimit
  }, tenantId);
  await logScheduledJobEvent({
    runId: context?.runId,
    jobKey: options.jobKey || "seller_analytics_daily_sync",
    stepKey: "shop_run_created",
    status: "info",
    shopId: shop.id,
    shopName: shop.name,
    message: `Created seller analytics collect run ${run.id}`,
    detail: { storeId: shop.storeId, collectRunId: run.id, reused: Boolean(run.reused), periodKey }
  }).catch(() => {});

  const start = await services.sellerAnalyticsStartDirectCollect({
    store_id: shop.storeId,
    company_id: shop.storeId
  }, tenantId);
  if (!start?.started) {
    return {
      ...baseResult,
      status: "error",
      run_id: run.id,
      requestCount: Number(run.request_count || 0),
      error_code: start?.reason || "direct_collect_not_started",
      error: start?.reason || "后台直连同步未启动"
    };
  }

  const { run: finishedRun, timedOut } = await waitForSellerAnalyticsCollectRun(run.id, tenantId, {
    timeoutMs: options.shopTimeoutMs,
    pollMs: options.waitPollMs
  });
  const finalRun = finishedRun || run;
  const status = timedOut ? "timeout" : String(finalRun.status || "unknown");
  const todoResult = status === "success"
    ? await services.sellerAnalyticsRefreshOperationTodos({
        ...periodPayload,
        store_id: shop.storeId,
        focus_limit: 500
      }, tenantId).catch((error) => ({ error: error?.message || String(error) }))
    : null;
  return {
    ...baseResult,
    status,
    run_id: run.id,
    reused: Boolean(run.reused),
    requestCount: Number(finalRun.request_count || run.request_count || 0),
    completed: Number(finalRun.completed_count || 0),
    failed: Number(finalRun.failed_count || 0),
    todoCount: Number(todoResult?.todoCount || todoResult?.data?.todoCount || 0),
    diagnosisCount: Number(todoResult?.diagnosisCount || todoResult?.data?.diagnosisCount || 0),
    elapsedMs: Date.now() - startedAt,
    error_code: timedOut ? "collect_timeout" : (status === "failed" ? "collect_failed" : ""),
    error: timedOut ? "店铺分析同步等待超时，后台队列可能仍在继续。" : ""
  };
}

async function runBackgroundSellerAnalyticsDailySync(context = {}) {
  const jobKey = String(context?.key || "seller_analytics_daily_sync");
  if (backgroundSellerAnalyticsSyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 180 };
  const laneBusy = claimBackgroundModuleLane("analytics", jobKey);
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 180 };
  backgroundSellerAnalyticsSyncRunning = true;
  const tenantId = "admin";
  const days = Math.max(1, Number(context?.config?.days || BACKGROUND_SELLER_ANALYTICS_SYNC_DAYS));
  const periodPayload = sellerAnalyticsPeriodPayload(days);
  const periodKey = periodPayload.period_key;
  const maxShopsPerRun = Math.max(1, Math.min(50, Number(context?.config?.maxShopsPerRun || 12)));
  const shopCursor = Math.max(0, Number(context?.config?.shopCursor || 0));
  const timeoutMinutes = Math.max(1, Number(context?.config?.timeoutMinutes || BACKGROUND_SELLER_ANALYTICS_SYNC_TIMEOUT_MS / 60000));
  const totalTimeoutAt = Date.now() + timeoutMinutes * 60 * 1000;
  const maxPages = Math.max(1, Math.min(1000, Number(context?.config?.maxPages || 500)));
  const requestLimit = Math.max(1, Math.min(100, Number(context?.config?.requestLimit || 30)));
  const waitPollMs = Math.max(500, Number(context?.config?.waitPollMs || 2000));
  const shopConcurrency = Math.max(1, Math.min(6, Number(context?.config?.shopConcurrency || 3)));
  try {
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey,
      stepKey: "job_start",
      status: "info",
      message: "Starting seller analytics daily sync",
      detail: { config: context?.config || {}, periodKey, days }
    }).catch(() => {});
    const shops = await listActiveSellerAnalyticsShops();
    const { selectedShopIds, nextCursor } = rotateShopIds(shops.map((shop) => shop.id), shopCursor, maxShopsPerRun);
    const selected = selectedShopIds.map((id) => shops.find((shop) => shop.id === id)).filter(Boolean);
    if (!selected.length) return { skipped: true, reason: "no_configured_seller_analytics_shops", retryDelaySeconds: 300 };

    const results = [];
    for (let batchStart = 0; batchStart < selected.length; batchStart += shopConcurrency) {
      const batch = selected.slice(batchStart, batchStart + shopConcurrency);
      await Promise.all(batch.map(async (shop) => {
      const remainingMs = totalTimeoutAt - Date.now();
      if (remainingMs <= 0) {
        results.push({
          shop_id: shop.id,
          shop_name: shop.name,
          store_id: shop.storeId,
          status: "timeout",
          error_code: "job_timeout",
          error: "定时任务总超时，剩余店铺未执行。"
        });
        return;
      }
      await logScheduledJobEvent({
        runId: context?.runId,
        jobKey,
        stepKey: "shop_start",
        status: "info",
        shopId: shop.id,
        shopName: shop.name,
        message: `Starting seller analytics sync for ${shop.name || shop.id}`,
        detail: { storeId: shop.storeId, periodKey }
      }).catch(() => {});
      const shopTimeoutMs = Math.min(
        remainingMs,
        5 * 60 * 1000,
        Math.max(60_000, Math.floor((timeoutMinutes * 60_000) / Math.max(1, selected.length)))
      );
      const result = await withBackgroundOperationTimeout(syncOneSellerAnalyticsShop(shop, context, {
        jobKey,
        tenantId,
        periodKey,
        periodPayload,
        maxPages,
        requestLimit,
        waitPollMs,
        shopTimeoutMs
      }), shopTimeoutMs + 5000, `seller analytics shop ${shop.name || shop.id}`).catch((error) => ({
        shop_id: shop.id,
        shop_name: shop.name,
        store_id: shop.storeId,
        status: error?.code === "BACKGROUND_OPERATION_TIMEOUT" ? "timeout" : "error",
        error_code: error?.code === "BACKGROUND_OPERATION_TIMEOUT" ? "shop_operation_timeout" : "unhandled_error",
        error: error?.message || String(error)
      }));
      results.push(result);
      await logScheduledJobEvent({
        runId: context?.runId,
        jobKey,
        stepKey: "shop_finish",
        status: result.status === "success" ? "success" : result.status === "skipped" ? "warning" : "error",
        shopId: shop.id,
        shopName: shop.name,
        message: `Seller analytics sync ${result.status} for ${shop.name || shop.id}`,
        detail: result
      }).catch(() => {});
      }));
    }

    await persistScheduledJobConfigPatch(jobKey, { shopCursor: nextCursor, maxShopsPerRun });
    const retentionDays = Math.max(1, Number(context?.config?.retentionDays || 15));
    await mysqlExecute("DELETE FROM seller_analytics_product_metrics WHERE captured_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)", [retentionDays]);
    await mysqlExecute("DELETE FROM seller_analytics_snapshots WHERE captured_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)", [retentionDays]);
    const okShops = results.filter((item) => item.status === "success").length;
    const nonOkShops = results.length - okShops;
    const skippedNoAuth = results.filter((item) => ["missing_auth_binding", "auth_binding_stale"].includes(item.error_code)).length;
    const timeoutShops = results.filter((item) => item.status === "timeout").length;
    const errors = results.filter((item) => item.error).map((item) => `${item.shop_name || item.shop_id}: ${item.error}`);
    const warning = nonOkShops > 0 ? `${nonOkShops} shop(s) did not finish successfully` : "";
    const status = nonOkShops > 0 ? "partial" : "success";
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey,
      stepKey: "job_finish",
      status: status === "success" ? "success" : "warning",
      message: warning || "Seller analytics daily sync finished",
      detail: { okShops, nonOkShops, skippedNoAuth, timeoutShops, nextCursor, periodKey, shopConcurrency }
    }).catch(() => {});
    return {
      status,
      warning,
      periodKey,
      days,
      totalShops: shops.length,
      selectedShops: selected.length,
      okShops,
      nonOkShops,
      createdRuns: results.filter((item) => item.run_id).length,
      skippedNoAuth,
      timeoutShops,
      shopConcurrency,
      nextCursor,
      results,
      errors
    };
  } catch (error) {
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey,
      stepKey: "job_error",
      status: "error",
      message: error?.message || "Seller analytics daily sync failed"
    }).catch(() => {});
    console.error("background seller analytics sync failed", error);
    throw error;
  } finally {
    backgroundSellerAnalyticsSyncRunning = false;
    releaseBackgroundModuleLane("analytics", jobKey);
  }
}

async function runBackgroundOzonStockSync() {
  if (backgroundOzonStockSyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 60 };
  const laneBusy = claimBackgroundModuleLane("inventory", "ozon_stock_sync");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 60 };
  backgroundOzonStockSyncRunning = true;
  try {
    const result = await services.syncOzonStocks({ mode: "scheduled_fbp" });
    console.log(`background Ozon stock sync ok: fetched ${result.fetched || 0}, upserted ${result.upserted || 0}, status ${result.status || "ok"}`);
    if (result.errors?.length) console.warn(`background Ozon stock sync warnings: ${result.errors.join("; ")}`);
    return result;
  } catch (error) {
    console.error("background Ozon stock sync failed", error);
    throw error;
  } finally {
    backgroundOzonStockSyncRunning = false;
    releaseBackgroundModuleLane("inventory", "ozon_stock_sync");
  }
}

async function runBackgroundOzonCategorySync() {
  if (backgroundOzonCategorySyncRunning) return { skipped: true, reason: "already_running", retryDelaySeconds: 120 };
  const laneBusy = claimBackgroundModuleLane("listing", "ozon_category_sync");
  if (laneBusy) return { skipped: true, reason: laneBusy, retryDelaySeconds: 120 };

  backgroundOzonCategorySyncRunning = true;
  try {
    const result = await services.refreshOzonCategoryCache({
      mode: "scheduled_nightly",
      category_limit: config.backgroundOzonCategorySyncCategoryLimit,
      value_limit: config.backgroundOzonCategorySyncValueLimit,
      language: "ZH_HANS"
    });
    console.log(`background Ozon category sync ok: categories ${result.categories || 0}, attributes ${result.attributes || 0}, values ${result.values || 0}, used categories ${result.usedCategoryCount || 0}`);
    return result;
  } catch (error) {
    console.error("background Ozon category sync failed", error);
    throw error;
  } finally {
    backgroundOzonCategorySyncRunning = false;
    releaseBackgroundModuleLane("listing", "ozon_category_sync");
  }
}

async function runOzonActionCleanupSweep(context = {}) {
  try {
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "ozon_action_cleanup",
      stepKey: "cleanup_start",
      status: "info",
      message: "开始扫描已开启自动清理的 Ozon 活动配置"
    }).catch(() => {});
    const results = await services.runEnabledOzonActionCleanup();
    if (!results.length) {
      await logScheduledJobEvent({
        runId: context?.runId,
        jobKey: "ozon_action_cleanup",
        stepKey: "cleanup_finish",
        status: "info",
        message: "没有店铺开启 Ozon 活动自动清理",
        detail: { stores: 0, removed: 0, failed: 0 }
      }).catch(() => {});
      return { stores: 0, removed: 0, failed: 0, results: [] };
    }
    const removed = results.reduce((sum, item) => sum + Number(item?.count || 0), 0);
    const failed = results.filter((item) => item?.success === false).length;
    for (const item of results) {
      await logScheduledJobEvent({
        runId: context?.runId,
        jobKey: "ozon_action_cleanup",
        stepKey: "store_cleanup",
        status: item?.success === false ? "error" : "success",
        shopId: item?.storeId,
        shopName: item?.storeName,
        message: item?.success === false
          ? `店铺 ${item?.storeName || item?.storeId || "-"} 清理失败：${item?.error || "unknown"}`
          : `店铺 ${item?.storeName || item?.storeId || "-"} 已移除 ${Number(item?.count || 0)} 个自动添加商品`,
        detail: {
          removed: Number(item?.count || 0),
          actionSummaries: item?.actionSummaries || [],
          error: item?.error || ""
        }
      }).catch(() => {});
    }
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "ozon_action_cleanup",
      stepKey: "cleanup_finish",
      status: failed > 0 ? "warning" : "success",
      message: `Ozon 活动自动清理完成：扫描 ${results.length} 个店铺，移除 ${removed} 个商品，失败 ${failed} 个`,
      detail: { stores: results.length, removed, failed }
    }).catch(() => {});
    console.log(`ozon action cleanup sweep ok: stores ${results.length}, removed ${removed}, failed ${failed}`);
    return {
      status: failed > 0 ? "partial" : "success",
      retryDelaySeconds: removed > 0 || failed > 0 ? 120 : undefined,
      stores: results.length,
      removed,
      failed,
      results: results.map((item) => ({
        storeId: item?.storeId,
        storeName: item?.storeName,
        status: item?.success === false ? "error" : "ok",
        removed: Number(item?.count || 0),
        actionSummaries: item?.actionSummaries || [],
        error: item?.error || ""
      }))
    };
  } catch (error) {
    await logScheduledJobEvent({
      runId: context?.runId,
      jobKey: "ozon_action_cleanup",
      stepKey: "cleanup_error",
      status: "error",
      message: error?.message || "Ozon 活动自动清理失败"
    }).catch(() => {});
    console.error("ozon action cleanup sweep failed", error);
    throw error;
  }
}

async function syncExceptionWorkbenchOrders(req = null) {
  // Reuse the same rolling synchronization window for both manual and
  // background refreshes so operators and cron-like jobs see the same scope.
  const window = services.exceptionWorkbenchSyncWindow();
  const result = await services.syncDemoOrders({ from: window.from, to: window.to }, { signal: req?._abortSignal });
  return { window, result };
}

async function syncRollingOrderStatusWindow(req = null) {
  const window = rollingOrderSyncWindow(BACKGROUND_ORDER_SYNC_DAYS);
  const result = await services.syncDemoOrders({ from: window.from, to: window.to }, { signal: req?._abortSignal });
  return { window, result };
}

function rollingOrderSyncWindow(days = 90) {
  const now = new Date();
  const from = new Date(now.getTime() - Number(days || 0) * 24 * 60 * 60 * 1000);
  return {
    from: formatShanghaiDate(from),
    to: formatShanghaiDate(now)
  };
}

function formatShanghaiDate(date) {
  return shanghaiDateKey(date);
}

function shanghaiHourMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  return {
    hour: Number(parts.find((item) => item.type === "hour")?.value || 0),
    minute: Number(parts.find((item) => item.type === "minute")?.value || 0)
  };
}

function isPublicListingMediaPath(parts = []) {
  return parts[0] === "uploads" && parts[1] === "listing-media" && Boolean(parts[2]);
}

function resolveListingMediaStaticRoots() {
  const roots = [];
  const add = (target) => {
    const resolved = path.resolve(target);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  for (const root of resolveUploadSubdirRoots("listing-media")) add(root);
  add(path.resolve("public", "uploads", "listing-media"));
  add(path.resolve("..", "..", "public", "uploads", "listing-media"));
  add(path.resolve(process.env.LISTING_MEDIA_ROOT || "public/uploads/listing-media"));
  return roots;
}

function resolveTeamAttachmentStaticRoots() {
  const roots = [];
  const add = (target) => {
    const resolved = path.resolve(target);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  for (const root of resolveUploadSubdirRoots("team-attachments")) add(root);
  add(path.resolve("public", "uploads", "team-attachments"));
  return roots;
}

function isVersionedVueAssetPath(pathname = "") {
  return /^\/vue-apps\/assets\/[^/]+-[A-Za-z0-9_-]{6,}(?:-\d{12,13})?\.(?:js|css)$/i.test(String(pathname || ""));
}

function isPublicAuthCallbackPath(req, parts = []) {
  if (parts[0] !== "api" || parts[1] !== "auth") return false;
  if (req.method === "GET" && parts[2] === "qr" && parts[3] === "confirm-page") return true;
  if (req.method === "POST" && parts[2] === "qr" && parts[3] === "confirm") return true;
  if (req.method === "GET" && parts[2] === "wechat" && parts[3] === "callback") return true;
  return false;
}

function allowQueryTokenAuth(req, parts = [], url) {
  if (req.method !== "GET") return false;
  if (!url.searchParams.get("token")) return false;
  if (parts[0] !== "api") return false;
  if (parts[1] === "ai" && parts[2] === "file") return true;
  if (parts[1] === "products" && parts[2] && (parts[3] === "image" || parts[3] === "detail-images")) return true;
  if (parts[1] === "system" && parts[2] === "events") return true;
  if (parts[1] === "tools" && parts[2] === "image-cropper") return true;
  if (parts[1] === "asset-variant-engine" && parts[2] === "files") return true;
  return false;
}
