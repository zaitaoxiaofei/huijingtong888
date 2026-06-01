import http from "node:http";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { config } from "./config.js";
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
import { createProfitRoutes } from "./server/routes/profit.js";
import { createAdvertisingRoutes } from "./server/routes/advertising.js";
import { createSellerAnalyticsRoutes, handleSellerAnalyticsRestRoute } from "./server/routes/sellerAnalytics.js";
import { createOzonActionRoutes } from "./server/routes/ozonActions.js";
import { createSyncRoutes } from "./server/routes/sync.js";
import { createReviewRoutes, handleReviewRestRoute } from "./server/routes/reviews.js";
import { createListingAutomationRoutes, handleListingAutomationRestRoute, handleMaterialPackageRestRoute } from "./server/routes/listingAutomation.js";
import { createAssetVariantEngineRoutes, handleAssetVariantEngineRestRoute } from "./server/routes/assetVariantEngine.js";
import { createAiPromptTemplateRoutes, handleAiPromptTemplateRestRoute } from "./server/routes/aiPromptTemplates.js";
import { createAiStrategyRoutes, handleAiStrategyRestRoute } from "./server/routes/aiStrategies.js";
import { createMaterialAssetRoutes, handleMaterialAssetRestRoute } from "./server/routes/materialAssets.js";
import { createAiImageRoutes, handleAiImageRestRoute } from "./server/routes/aiImageRoutes.js";
import { getAiTaskFile } from "./server/services/ai/aiWorkflowService.js";
import { createImageCropperRoutes, handleImageCropperRestRoute } from "./server/routes/tools/imageCropper.js";
import {
  ScheduledJobScheduler,
  listScheduledJobs,
  logScheduledJobEvent,
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
import { checkDailyPurchaseNotification, globalUpdateStatus, updateGlobalUpdateStatus } from "./server/notifications.js";
import { shanghaiDateKey } from "./shanghai-time.js";
import { mysqlExecute, mysqlQuery } from "./mysql-pool.js";

const services = mysqlRuntimeServices;

const publicDir = path.resolve("public");
const serveStatic = createStaticHandler(publicDir);
const handleAuth = createAuthHandler(readJson);
const imageProxyCacheDir = path.resolve("runtime", "image-proxy-cache");
const imageProxyInflight = new Map();
const IMAGE_PROXY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_PROXY_BROWSER_CACHE_SECONDS = 24 * 60 * 60;
const IMAGE_PROXY_PLACEHOLDER_CACHE_SECONDS = 10 * 60;
const IMAGE_PROXY_FETCH_TIMEOUT_MS = 3000;
const IMAGE_PROXY_MAX_CACHE_BYTES = 8 * 1024 * 1024;

const routeModules = {
  ...createCatalogRoutes({ services, readJson }),
  ...createOperationsRoutes({ services, readJson }),
  ...createProfitRoutes({ services, readJson }),
  ...createAdvertisingRoutes({ services, readJson }),
  ...createSellerAnalyticsRoutes({ services, readJson }),
  ...createOzonActionRoutes({ services, readJson }),
  ...createReviewRoutes({ services, readJson }),
  ...createOrderRoutes({ services, readJson, notFound, writeHead, json }),
  ...createPrintRoutes({ services, readJson }),
  ...createSyncRoutes({ services, readJson, syncExceptionWorkbenchOrders }),
  ...createListingAutomationRoutes({ services, readJson }),
  ...createAssetVariantEngineRoutes({ services, readJson }),
  ...createAiPromptTemplateRoutes({ services, readJson }),
  ...createAiStrategyRoutes({ services, readJson }),
  ...createMaterialAssetRoutes({ services, readJson }),
  ...createAiImageRoutes({ readJson }),
  ...createImageCropperRoutes({ readJson })
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
  "GET /api/inventory": () => services.inventory(),
  "GET /api/stock-alerts": (req) => services.stockAlerts(req.query || {}),
  "GET /api/fbp-opportunities": (req) => services.fbpOpportunities(req.query || {}),
  "GET /api/stock-warehouse-rules": () => services.stockWarehouseRules(),
  "GET /api/erp/inventory-current": () => services.inventoryCurrent(),
  "GET /api/erp/raw-orders": () => services.rawOzonOrders(),
  "GET /api/erp/profit-items": () => services.profitItems(),
  "GET /api/erp/order-exceptions": () => services.orderExceptions(),
  "POST /api/exchange-rate": async (req) => services.updateExchangeRate(await readJson(req)),
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
  const message = `[api-performance] ${req.method} ${url.pathname}${query} status=${status} elapsed=${elapsedMs}ms`;
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

cleanExpiredSessions();
setInterval(cleanExpiredSessions, 3600 * 1000);
let backgroundOrderSyncRunning = false;
let backgroundCancelledOrderSyncRunning = false;
let backgroundPostingDetailSyncRunning = false;
let backgroundAnalyticsRefreshRunning = false;
let backgroundDashboardSnapshotRefreshRunning = false;
let backgroundAdvertisingSyncRunning = false;
let backgroundAdvertisingTodaySyncRunning = false;
let backgroundOzonStockSyncRunning = false;
let backgroundOzonCategorySyncRunning = false;
let backgroundHeavyTaskRunning = "";
const BACKGROUND_ORDER_SYNC_INTERVAL_MS = Math.max(1, Number(config.backgroundOrderSyncIntervalMinutes || 30)) * 60 * 1000;
const BACKGROUND_ORDER_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundOrderSyncInitialDelaySeconds || 180)) * 1000;
const BACKGROUND_ORDER_SYNC_DAYS = Math.max(1, Number(config.backgroundOrderSyncDays || 90));
const BACKGROUND_CANCELLED_ORDER_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundCancelledOrderSyncIntervalMinutes || 60)) * 60 * 1000;
const BACKGROUND_CANCELLED_ORDER_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundCancelledOrderSyncInitialDelaySeconds || 360)) * 1000;
const BACKGROUND_CANCELLED_ORDER_SYNC_DAYS = Math.max(1, Number(config.backgroundCancelledOrderSyncDays || 30));
const BACKGROUND_POSTING_DETAIL_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundPostingDetailSyncIntervalMinutes || 60)) * 60 * 1000;
const BACKGROUND_POSTING_DETAIL_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundPostingDetailSyncInitialDelaySeconds || 600)) * 1000;
const BACKGROUND_POSTING_DETAIL_SYNC_DAYS = Math.max(1, Number(config.backgroundPostingDetailSyncDays || 30));
const BACKGROUND_POSTING_DETAIL_SYNC_LIMIT = Math.max(1, Number(config.backgroundPostingDetailSyncLimit || 200));
const BACKGROUND_POSTING_DETAIL_SYNC_CONCURRENCY = Math.min(Math.max(Number(config.backgroundPostingDetailSyncConcurrency || 2), 1), 5);
const BACKGROUND_POSTING_DETAIL_DEEP_SYNC_DAYS = Math.max(1, Number(config.backgroundPostingDetailDeepSyncDays || 90));
const BACKGROUND_POSTING_DETAIL_DEEP_SYNC_LIMIT = Math.max(1, Number(config.backgroundPostingDetailDeepSyncLimit || 1000));
const BACKGROUND_ANALYTICS_REFRESH_INTERVAL_MS = Math.max(1, Number(config.backgroundAnalyticsRefreshIntervalMinutes || 60)) * 60 * 1000;
const BACKGROUND_ANALYTICS_REFRESH_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundAnalyticsRefreshInitialDelaySeconds || 240)) * 1000;
const BACKGROUND_DASHBOARD_SNAPSHOT_INTERVAL_MS = Math.max(1, Number(config.backgroundDashboardSnapshotIntervalMinutes || 3)) * 60 * 1000;
const BACKGROUND_DASHBOARD_SNAPSHOT_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundDashboardSnapshotInitialDelaySeconds || 20)) * 1000;
const BACKGROUND_ADVERTISING_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundAdvertisingSyncIntervalMinutes || 60)) * 60 * 1000;
const BACKGROUND_ADVERTISING_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundAdvertisingSyncInitialDelaySeconds || 420)) * 1000;
const BACKGROUND_ADVERTISING_SYNC_DAYS = Math.max(1, Number(config.backgroundAdvertisingSyncDays || 7));
const BACKGROUND_ADVERTISING_SYNC_TIMEOUT_MS = Math.max(1, Number(config.backgroundAdvertisingSyncTimeoutMinutes || 25)) * 60 * 1000;
const BACKGROUND_ADVERTISING_TODAY_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundAdvertisingTodaySyncIntervalMinutes || 15)) * 60 * 1000;
const BACKGROUND_ADVERTISING_TODAY_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundAdvertisingTodaySyncInitialDelaySeconds || 120)) * 1000;
const BACKGROUND_ADVERTISING_TODAY_SYNC_TIMEOUT_MS = Math.max(1, Number(config.backgroundAdvertisingTodaySyncTimeoutMinutes || 12)) * 60 * 1000;
const BACKGROUND_OZON_STOCK_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundOzonStockSyncIntervalMinutes || 30)) * 60 * 1000;
const BACKGROUND_OZON_STOCK_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundOzonStockSyncInitialDelaySeconds || 480)) * 1000;
const OZON_ACTION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

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
    name: "经营首页快照刷新",
    category: "analytics",
    priority: "normal",
    intervalMinutes: Math.round(BACKGROUND_DASHBOARD_SNAPSHOT_INTERVAL_MS / 60000),
    initialDelaySeconds: Math.round(BACKGROUND_DASHBOARD_SNAPSHOT_INITIAL_DELAY_MS / 1000),
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
      scope: "today_only",
      timeoutMinutes: Math.round(BACKGROUND_ADVERTISING_TODAY_SYNC_TIMEOUT_MS / 60000),
      campaignChunkSize: 1,
      reportRetryDelayMs: 15000
    }
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
    key: "ozon_action_cleanup",
    name: "Ozon 营销动作清理",
    category: "maintenance",
    priority: "normal",
    intervalMinutes: Math.round(OZON_ACTION_CLEANUP_INTERVAL_MS / 60000),
    initialDelaySeconds: 5,
    catchupEnabled: false,
    maxCatchupRuns: 0
  }
];

const scheduledJobHandlers = {
  order_status_sync: runBackgroundOrderStatusSync,
  cancelled_order_sync: runBackgroundCancelledOrderSync,
  posting_detail_sync: runBackgroundPostingDetailSync,
  posting_detail_deep_sync: runBackgroundPostingDetailDeepSync,
  analytics_refresh: runBackgroundAnalyticsRefresh,
  dashboard_snapshot_refresh: runBackgroundDashboardSnapshotRefresh,
  advertising_sync: runBackgroundAdvertisingSync,
  advertising_today_sync: runBackgroundAdvertisingTodaySync,
  ozon_stock_sync: runBackgroundOzonStockSync,
  ozon_category_sync: runBackgroundOzonCategorySync,
  ozon_action_cleanup: runOzonActionCleanupSweep
};

const scheduledJobScheduler = new ScheduledJobScheduler({
  handlers: scheduledJobHandlers,
  pollIntervalMs: 60 * 1000,
  maxConcurrent: 1
});

async function handleSiteAccess(req, res, url) {
  const nextPath = normalizeNextPath(url.searchParams.get("next") || "/");

  if (req.method === "GET" && url.pathname === SITE_ACCESS_LOGOUT_PATH) {
    clearCookie(res, getSiteAccessCookieName(), {
      path: "/",
      sameSite: "Lax",
      secure: siteAccessUsesSecureCookie()
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
      secure: siteAccessUsesSecureCookie(),
      maxAge: getSiteAccessCookieMaxAgeSeconds()
    });
    writeHead(res, 302, { Location: formNext });
    res.end();
    return true;
  }

  return false;
}

async function handleRestRoute(req, res, url, parts) {
  if (req.method === "GET" && parts[0] === "downloads" && (
    /^ozon-baodan-erp-plugin-[0-9][0-9A-Za-z.-]*\.rar$/.test(parts[1] || "") ||
    parts[1] === "ozon-baodan-erp-plugin.rar" ||
    parts[1] === "ozon-erp-collector-plugin.rar"
  )) {
    let filename = parts[1];
    if (filename === "ozon-baodan-erp-plugin.rar" || filename === "ozon-erp-collector-plugin.rar") {
      const status = globalUpdateStatus();
      filename = status.plugin.package_name || `ozon-baodan-erp-plugin-${status.plugin.version}.rar`;
    }
    const filePath = path.resolve("..", filename);
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

  const catalogRestHandled = await handleCatalogRestRoute({
    req,
    res,
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
    const appUrl = new URL(config.appBaseUrl || "http://localhost:8787");
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

  if (parts[2] === "seller-analytics" && parts[3] === "collect-runs" && parts[4] === "next" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tenantId = String(req.headers["x-tenant-id"] || url.searchParams.get("tenantId") || "admin").trim() || "admin";
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 6), 20));
    const requests = await services.sellerAnalyticsNextCollectRequests(tenantId, limit);
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


async function sendProductImage(res, productId, imageLoader = null) {
  try {
    const image = imageLoader ? await imageLoader(productId) : await services.productImage(productId);
    if (!image) return notFound(res);
    const aiFile = await resolveAiImageFile(String(image));
    if (aiFile) {
      const buffer = await fs.readFile(aiFile.filePath);
      writeHead(res, 200, {
        "Content-Type": aiFile.contentType,
        "Content-Length": buffer.length,
        "Cache-Control": "no-store, must-revalidate",
        "Pragma": "no-cache"
      });
      return res.end(buffer);
    }
    const match = String(image).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return json(res, { error: "Unsupported image" }, 415);
    const buffer = Buffer.from(match[2], "base64");
    writeHead(res, 200, {
      "Content-Type": match[1],
      "Content-Length": buffer.length,
      "Cache-Control": "no-store, must-revalidate",
      "Pragma": "no-cache"
    });
    return res.end(buffer);
  } catch (error) {
    if (Number(error?.status || 0) === 404) return notFound(res);
    console.error("send product image failed:", error);
    return json(res, { error: "Product image unavailable" }, 500);
  }
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
    "Cache-Control": `public, max-age=${IMAGE_PROXY_PLACEHOLDER_CACHE_SECONDS}`,
    "X-Image-Proxy-Cache": "PLACEHOLDER"
  });
  return res.end(buffer);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_PROXY_FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ozon-erp-image-proxy/1.0",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });
    if (!upstream.ok) return null;
    const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return null;
    const buffer = Buffer.from(await upstream.arrayBuffer());
    return { buffer, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendRemoteImage(req, res, url) {
  const target = String(url.searchParams.get("url") || "").trim();
  if (!/^https?:\/\//i.test(target)) return json(res, { error: "Invalid image url" }, 400);

  const cached = await readCachedRemoteImage(target);
  if (cached) return sendRemoteImageBuffer(res, cached, "HIT");

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
    if (!payload) return sendImagePlaceholder(res);
    writeCachedRemoteImage(target, payload).catch((error) => {
      console.warn("image proxy cache write failed:", error?.message || error);
    });
    return sendRemoteImageBuffer(res, payload, "MISS");
  } catch (error) {
    if (res.writableEnded || res.destroyed) return;
    return sendImagePlaceholder(res);
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

    if ((req.method === "GET" || req.method === "HEAD") && isPublicListingMediaPath(parts)) {
      return serveStatic(url.pathname, req, res);
    }

    if (url.pathname === SITE_ACCESS_SESSION_PATH || url.pathname === SITE_ACCESS_LOGIN_PATH || url.pathname === SITE_ACCESS_LOGOUT_PATH) {
      if (await handleSiteAccess(req, res, url)) return;
    }

    if (!isSiteAccessAuthorized(req) && !isPublicAuthCallbackPath(req, parts)) {
      if (parts[0] === "api") return json(res, { error: "访问受限，请先通过内部访问验证" }, 403);
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
      return sendProductImage(res, Number(parts[2]));
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
      if (!authorization.allowed) return json(res, { error: authorization.error || "权限不足" }, authorization.status || 403);
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

server.listen(config.port, config.host || undefined, () => {
  const bindHost = config.host || "0.0.0.0";
  console.log(`ozon ERP running at ${config.appBaseUrl} (bind ${bindHost}:${config.port})`);
  setInterval(() => checkDailyPurchaseNotification(services.all), 60000);
  registerScheduledJobs(scheduledJobDefinitions)
    .then(() => {
      scheduledJobScheduler.start();
      console.log(`scheduled job scheduler started with ${scheduledJobDefinitions.length} job(s)`);
    })
    .catch((error) => console.error("scheduled job scheduler startup failed", error));
  setTimeout(recoverAssetVariantJobs, 3000);
});

async function recoverAssetVariantJobs() {
  try {
    const result = await services.recoverAssetVariantJobsOnStartup?.();
    if (result?.queued) console.log(`asset variant job recovery queued ${result.queued} job(s)`);
  } catch (error) {
    console.error("asset variant job recovery failed", error);
  }
}

async function runBackgroundOrderStatusSync() {
  if (backgroundOrderSyncRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background order status sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning };
  }
  backgroundOrderSyncRunning = true;
  backgroundHeavyTaskRunning = "order_status_sync";
  try {
    const result = await services.syncOzonIncrementalOrders({
      mode: "new",
      fallback_days: BACKGROUND_ORDER_SYNC_DAYS,
      overlap_minutes: 60
    });
    console.log(`background order status sync ok: fetched ${result.fetched || 0}, updated ${result.updated || 0}, requests ${result.requests || 0}`);
    return result;
  } catch (error) {
    console.error("background order status sync failed", error);
    throw error;
  } finally {
    backgroundOrderSyncRunning = false;
    if (backgroundHeavyTaskRunning === "order_status_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundCancelledOrderSync() {
  if (backgroundCancelledOrderSyncRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background cancelled order sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning };
  }
  backgroundCancelledOrderSyncRunning = true;
  backgroundHeavyTaskRunning = "cancelled_order_sync";
  try {
    const window = rollingOrderSyncWindow(BACKGROUND_CANCELLED_ORDER_SYNC_DAYS);
    const result = await services.syncDemoOrders({ from: window.from, to: window.to, statuses: ["cancelled"] });
    console.log(`background cancelled order sync ok: ${window.from}~${window.to}, fetched ${result.fetched || 0}, updated ${result.updated || 0}`);
    return { window, ...result };
  } catch (error) {
    console.error("background cancelled order sync failed", error);
    throw error;
  } finally {
    backgroundCancelledOrderSyncRunning = false;
    if (backgroundHeavyTaskRunning === "cancelled_order_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundPostingDetailSync() {
  if (backgroundPostingDetailSyncRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background posting detail sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning };
  }
  backgroundPostingDetailSyncRunning = true;
  backgroundHeavyTaskRunning = "posting_detail_sync";
  try {
    const result = await services.syncKnownOzonPostingDetails({
      mode: "scheduled_hourly",
      days: BACKGROUND_POSTING_DETAIL_SYNC_DAYS,
      limit: BACKGROUND_POSTING_DETAIL_SYNC_LIMIT,
      concurrency: BACKGROUND_POSTING_DETAIL_SYNC_CONCURRENCY
    });
    console.log(`background posting detail sync ok: candidates ${result.candidate_orders || 0}, fetched ${result.fetched || 0}, updated ${result.updated || 0}`);
    return result;
  } catch (error) {
    console.error("background posting detail sync failed", error);
    throw error;
  } finally {
    backgroundPostingDetailSyncRunning = false;
    if (backgroundHeavyTaskRunning === "posting_detail_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundPostingDetailDeepSync() {
  if (backgroundPostingDetailSyncRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background posting detail deep sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning };
  }

  backgroundPostingDetailSyncRunning = true;
  backgroundHeavyTaskRunning = "posting_detail_deep_sync";
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
    if (backgroundHeavyTaskRunning === "posting_detail_deep_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundAnalyticsRefresh() {
  if (backgroundAnalyticsRefreshRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background analytics refresh skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning };
  }
  backgroundAnalyticsRefreshRunning = true;
  backgroundHeavyTaskRunning = "analytics_refresh";
  try {
    const result = await services.refreshProfitAnalyticsSnapshots({});
    console.log(`background analytics refresh ok: product rows ${result.product_rows || 0}, sku rows ${result.sku_rows || 0}`);
    return result;
  } catch (error) {
    console.error("background analytics refresh failed", error);
    throw error;
  } finally {
    backgroundAnalyticsRefreshRunning = false;
    if (backgroundHeavyTaskRunning === "analytics_refresh") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundDashboardSnapshotRefresh() {
  if (backgroundDashboardSnapshotRefreshRunning) return { skipped: true, reason: "already_running" };
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
  if (backgroundAdvertisingSyncRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background advertising sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning, retryDelaySeconds: 90 };
  }
  backgroundAdvertisingSyncRunning = true;
  backgroundHeavyTaskRunning = "advertising_sync";
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
    const window = rollingOrderSyncWindow(syncDays);
    const activeShopIds = await listActiveAdvertisingShopIds();
    const { selectedShopIds, nextCursor } = rotateShopIds(activeShopIds, context?.config?.shopCursor || 0, maxShopsPerRun);
    if (!selectedShopIds.length) return { skipped: true, reason: "no_active_performance_shops", retryDelaySeconds: 300 };
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
    if (backgroundHeavyTaskRunning === "advertising_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundAdvertisingTodaySync(context = {}) {
  if (backgroundAdvertisingTodaySyncRunning || backgroundAdvertisingSyncRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background advertising today sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning, retryDelaySeconds: 60 };
  }
  backgroundAdvertisingTodaySyncRunning = true;
  backgroundHeavyTaskRunning = "advertising_today_sync";
  const timeoutMinutes = Math.max(1, Number(context?.config?.timeoutMinutes || BACKGROUND_ADVERTISING_TODAY_SYNC_TIMEOUT_MS / 60000));
  const campaignChunkSize = Math.max(1, Math.min(3, Number(context?.config?.campaignChunkSize || 1)));
  const reportRetryDelayMs = Math.max(5000, Number(context?.config?.reportRetryDelayMs || 15000));
  const maxShopsPerRunConfig = Number(context?.config?.maxShopsPerRun || 0);
  const maxShopsPerRun = Number.isFinite(maxShopsPerRunConfig) && maxShopsPerRunConfig > 0
    ? Math.max(1, Math.min(6, maxShopsPerRunConfig))
    : 6;
  const maxCampaignsPerRun = Math.max(2, Math.min(20, Number(context?.config?.maxCampaignsPerRun || 10)));
  const shopConcurrency = Math.max(1, Math.min(6, Number(context?.config?.shopConcurrency || 3)));
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
    const activeShopIds = await listActiveAdvertisingShopIds();
    const { selectedShopIds, nextCursor } = rotateShopIds(activeShopIds, context?.config?.shopCursor || 0, maxShopsPerRun);
    if (!selectedShopIds.length) return { skipped: true, reason: "no_active_performance_shops", retryDelaySeconds: 300 };
    const result = await runConcurrentAdvertisingShopSyncs(selectedShopIds, (shopId) => ({
      from: today,
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
        date: today
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
      retryDelaySeconds: retryLaterCampaigns > 0 ? 300 : undefined,
      date: today,
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
    if (backgroundHeavyTaskRunning === "advertising_today_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundOzonStockSync() {
  if (backgroundOzonStockSyncRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background Ozon stock sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning };
  }
  backgroundOzonStockSyncRunning = true;
  backgroundHeavyTaskRunning = "ozon_stock_sync";
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
    if (backgroundHeavyTaskRunning === "ozon_stock_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundOzonCategorySync() {
  if (backgroundOzonCategorySyncRunning) return { skipped: true, reason: "already_running" };
  if (backgroundHeavyTaskRunning) {
    console.log(`background Ozon category sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return { skipped: true, reason: backgroundHeavyTaskRunning };
  }

  backgroundOzonCategorySyncRunning = true;
  backgroundHeavyTaskRunning = "ozon_category_sync";
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
    if (backgroundHeavyTaskRunning === "ozon_category_sync") backgroundHeavyTaskRunning = "";
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
  if (parts[1] === "tools" && parts[2] === "image-cropper") return true;
  if (parts[1] === "asset-variant-engine" && parts[2] === "files") return true;
  return false;
}
