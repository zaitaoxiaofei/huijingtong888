import http from "node:http";
import { Buffer } from "node:buffer";
import path from "node:path";
import { config } from "./config.js";
import { calculateCelFbsPricing } from "./celRates.js";
import { mysqlRuntimeServices } from "./services/mysql-runtime-services.js";
import { readForm, readJson, isRequestCancelledError } from "./http/request.js";
import { clearCookie, html, json, notFound, setCookie, text, writeHead } from "./http/response.js";
import { createStaticHandler } from "./http/static.js";
import { cleanExpiredSessions, createAuthHandler, extractToken, getSession } from "./server/session.js";
import { createApiDocumentation, renderApiDocumentationMarkdown } from "./server/api-docs.js";
import { createCatalogRoutes, handleCatalogRestRoute } from "./server/routes/catalog.js";
import { createOrderRoutes, handleOrderRestRoute } from "./server/routes/orders.js";
import { createOperationsRoutes, handleOperationsRestRoute } from "./server/routes/operations.js";
import { createProfitRoutes } from "./server/routes/profit.js";
import { createAdvertisingRoutes } from "./server/routes/advertising.js";
import { createOzonActionRoutes } from "./server/routes/ozonActions.js";
import { createSyncRoutes } from "./server/routes/sync.js";
import { createReviewRoutes, handleReviewRestRoute } from "./server/routes/reviews.js";
import { createListingAutomationRoutes, handleListingAutomationRestRoute, handleMaterialPackageRestRoute } from "./server/routes/listingAutomation.js";
import { createAssetVariantEngineRoutes, handleAssetVariantEngineRestRoute } from "./server/routes/assetVariantEngine.js";
import { createAiPromptTemplateRoutes, handleAiPromptTemplateRestRoute } from "./server/routes/aiPromptTemplates.js";
import { createMaterialAssetRoutes, handleMaterialAssetRestRoute } from "./server/routes/materialAssets.js";
import { createAiImageRoutes, handleAiImageRestRoute } from "./server/routes/aiImageRoutes.js";
import { createImageCropperRoutes, handleImageCropperRestRoute } from "./server/routes/tools/imageCropper.js";
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
import { checkDailyPurchaseNotification } from "./server/notifications.js";
import { shanghaiDateKey } from "./shanghai-time.js";

const services = mysqlRuntimeServices;

const publicDir = path.resolve("public");
const serveStatic = createStaticHandler(publicDir);
const handleAuth = createAuthHandler(readJson);

const routeModules = {
  ...createCatalogRoutes({ services, readJson }),
  ...createOperationsRoutes({ services, readJson }),
  ...createProfitRoutes({ services, readJson }),
  ...createAdvertisingRoutes({ services, readJson }),
  ...createOzonActionRoutes({ services, readJson }),
  ...createReviewRoutes({ services, readJson }),
  ...createOrderRoutes({ services, readJson, notFound, writeHead, json }),
  ...createSyncRoutes({ services, readJson, syncExceptionWorkbenchOrders }),
  ...createListingAutomationRoutes({ services, readJson }),
  ...createAssetVariantEngineRoutes({ services, readJson }),
  ...createAiPromptTemplateRoutes({ services, readJson }),
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
  "GET /api/ai-provider/config": () => services.aiProviderConfig(),
  "GET /api/ai-provider/presets": () => services.aiProviderPresets(),
  "POST /api/ai-provider/config": async (req) => services.updateAiProviderConfig(await readJson(req), req._session?.person_id),
  "POST /api/ai-provider/test": async (req) => services.testAiProviderConfig(await readJson(req)),
  "POST /api/ai-provider/chat": async (req) => services.chatWithAiProvider(await readJson(req)),
  "GET /api/dashboard": () => services.dashboard(),
  "GET /api/exchange-rate/current": () => services.currentExchangeRate(),
  "GET /api/exchange-rates": () => services.exchangeRates(),
  "GET /api/inventory": () => services.inventory(),
  "GET /api/stock-alerts": (req) => services.stockAlerts(req.query || {}),
  "GET /api/stock-warehouse-rules": () => services.stockWarehouseRules(),
  "GET /api/erp/inventory-current": () => services.inventoryCurrent(),
  "GET /api/erp/raw-orders": () => services.rawOzonOrders(),
  "GET /api/erp/profit-items": () => services.profitItems(),
  "GET /api/erp/order-exceptions": () => services.orderExceptions(),
  "POST /api/exchange-rate": async (req) => services.updateExchangeRate(await readJson(req)),
  "POST /api/pricing/cel-fbs": async (req) => calculateCelFbsPricing(await readJson(req)),
};

cleanExpiredSessions();
setInterval(cleanExpiredSessions, 3600 * 1000);
let backgroundOrderSyncRunning = false;
let backgroundCancelledOrderSyncRunning = false;
let backgroundPostingDetailSyncRunning = false;
let backgroundAnalyticsRefreshRunning = false;
let backgroundAdvertisingSyncRunning = false;
let backgroundOzonStockSyncRunning = false;
let backgroundOzonCategorySyncRunning = false;
let backgroundHeavyTaskRunning = "";
let lastBackgroundOzonCategorySyncDate = "";
let lastBackgroundPostingDetailDeepSyncDate = "";
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
const BACKGROUND_ADVERTISING_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundAdvertisingSyncIntervalMinutes || 60)) * 60 * 1000;
const BACKGROUND_ADVERTISING_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundAdvertisingSyncInitialDelaySeconds || 420)) * 1000;
const BACKGROUND_ADVERTISING_SYNC_DAYS = Math.max(1, Number(config.backgroundAdvertisingSyncDays || 14));
const BACKGROUND_OZON_STOCK_SYNC_INTERVAL_MS = Math.max(5, Number(config.backgroundOzonStockSyncIntervalMinutes || 30)) * 60 * 1000;
const BACKGROUND_OZON_STOCK_SYNC_INITIAL_DELAY_MS = Math.max(0, Number(config.backgroundOzonStockSyncInitialDelaySeconds || 480)) * 1000;
const BACKGROUND_OZON_CATEGORY_SYNC_CHECK_MS = Math.max(1, Number(config.backgroundOzonCategorySyncCheckMinutes || 10)) * 60 * 1000;
const OZON_ACTION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

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

function localPluginCorsHeaders(req) {
  const origin = String(req.headers.origin || "*");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-tenant-id,Authorization",
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

async function handleLocalPluginRoute(req, res, parts) {
  if (parts[0] !== "api" || parts[1] !== "local-plugin") return false;

  if (req.method === "OPTIONS") {
    writeHead(res, 204, localPluginCorsHeaders(req));
    res.end();
    return true;
  }

  if (!isDirectLocalRequest(req)) {
    return localPluginJson(req, res, { success: false, error: "local plugin endpoint only accepts direct localhost requests" }, 403);
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

  return false;
}

async function sendProductImage(res, productId, imageLoader = null) {
  const image = imageLoader ? await imageLoader(productId) : await services.productImage(productId);
  if (!image) return notFound(res);
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
}

function sendImagePlaceholder(res) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" rx="12" fill="#f4f7fb"/><path d="M42 104l25-28 18 20 12-14 21 22H42z" fill="#c9d3e3"/><circle cx="106" cy="55" r="11" fill="#c9d3e3"/><text x="80" y="132" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#7b8798">NO IMG</text></svg>`;
  const buffer = Buffer.from(svg);
  writeHead(res, 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Content-Length": buffer.length,
    "Cache-Control": "private, max-age=600"
  });
  return res.end(buffer);
}

async function sendRemoteImage(req, res, url) {
  const target = String(url.searchParams.get("url") || "").trim();
  if (!/^https?:\/\//i.test(target)) return json(res, { error: "Invalid image url" }, 400);

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded && !controller.signal.aborted) controller.abort();
  };
  req.on("aborted", onClose);
  res.on("close", onClose);

  try {
    const upstream = await fetch(target, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ozon-erp-image-proxy/1.0",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });
    if (!upstream.ok) return sendImagePlaceholder(res);
    const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return sendImagePlaceholder(res);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    writeHead(res, 200, {
      "Content-Type": contentType,
      "Content-Length": buffer.length,
      "Cache-Control": "private, max-age=3600"
    });
    return res.end(buffer);
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") return;
    return sendImagePlaceholder(res);
  } finally {
    req.off("aborted", onClose);
    res.off("close", onClose);
  }
}

const server = http.createServer(async (req, res) => {
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

    const localPluginHandled = await handleLocalPluginRoute(req, res, parts);
    if (localPluginHandled !== false) return;

    if ((req.method === "GET" || req.method === "HEAD") && isPublicListingMediaPath(parts)) {
      return serveStatic(url.pathname, req, res);
    }

    if (url.pathname === SITE_ACCESS_SESSION_PATH || url.pathname === SITE_ACCESS_LOGIN_PATH || url.pathname === SITE_ACCESS_LOGOUT_PATH) {
      if (await handleSiteAccess(req, res, url)) return;
    }

    if (!isSiteAccessAuthorized(req)) {
      if (parts[0] === "api") return json(res, { error: "访问受限，请先通过内部访问验证" }, 403);
      return html(res, renderSiteAccessPage("", `${url.pathname}${url.search || ""}`), 401);
    }

    if (parts[0] === "api" && parts[1] === "auth") {
      const handler = handleAuth(req, url);
      if (handler) {
        const result = await handler();
        const status = result?.__status || 200;
        if (result && typeof result === "object" && "__status" in result) delete result.__status;
        return json(res, result, status);
      }
      return notFound(res);
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "image") {
      return sendProductImage(res, Number(parts[2]));
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
      const session = await getSession(extractToken(req) || url.searchParams.get("token"));
      if (!session) return json(res, { error: "未登录，请先登录" }, 401);
      req._session = session;
      req.query = Object.fromEntries(url.searchParams.entries());
    }

    const restHandled = await handleRestRoute(req, res, url, parts);
    if (restHandled !== false) return;

    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return json(res, await routes[key](req, url));
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
  setInterval(runBackgroundOrderStatusSync, BACKGROUND_ORDER_SYNC_INTERVAL_MS);
  setInterval(runBackgroundCancelledOrderSync, BACKGROUND_CANCELLED_ORDER_SYNC_INTERVAL_MS);
  setInterval(runBackgroundPostingDetailSync, BACKGROUND_POSTING_DETAIL_SYNC_INTERVAL_MS);
  setInterval(runBackgroundPostingDetailDeepSyncIfDue, 10 * 60 * 1000);
  setInterval(runBackgroundAnalyticsRefresh, BACKGROUND_ANALYTICS_REFRESH_INTERVAL_MS);
  setInterval(runBackgroundAdvertisingSync, BACKGROUND_ADVERTISING_SYNC_INTERVAL_MS);
  if (config.backgroundOzonStockSyncEnabled) {
    setInterval(runBackgroundOzonStockSync, BACKGROUND_OZON_STOCK_SYNC_INTERVAL_MS);
  }
  setInterval(runOzonActionCleanupSweep, OZON_ACTION_CLEANUP_INTERVAL_MS);
  if (config.backgroundOzonCategorySyncEnabled) {
    setInterval(runBackgroundOzonCategorySyncIfDue, BACKGROUND_OZON_CATEGORY_SYNC_CHECK_MS);
  }
  setTimeout(runBackgroundOrderStatusSync, BACKGROUND_ORDER_SYNC_INITIAL_DELAY_MS);
  setTimeout(runBackgroundCancelledOrderSync, BACKGROUND_CANCELLED_ORDER_SYNC_INITIAL_DELAY_MS);
  setTimeout(runBackgroundPostingDetailSync, BACKGROUND_POSTING_DETAIL_SYNC_INITIAL_DELAY_MS);
  setTimeout(runBackgroundPostingDetailDeepSyncIfDue, 12 * 60 * 1000);
  setTimeout(runBackgroundAnalyticsRefresh, BACKGROUND_ANALYTICS_REFRESH_INITIAL_DELAY_MS);
  setTimeout(runBackgroundAdvertisingSync, BACKGROUND_ADVERTISING_SYNC_INITIAL_DELAY_MS);
  if (config.backgroundOzonStockSyncEnabled) {
    setTimeout(runBackgroundOzonStockSync, BACKGROUND_OZON_STOCK_SYNC_INITIAL_DELAY_MS);
  }
  setTimeout(runOzonActionCleanupSweep, 5000);
  if (config.backgroundOzonCategorySyncEnabled) {
    setTimeout(runBackgroundOzonCategorySyncIfDue, 10 * 60 * 1000);
  }
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
  if (backgroundOrderSyncRunning) return;
  if (backgroundHeavyTaskRunning) {
    console.log(`background order status sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return;
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
  } catch (error) {
    console.error("background order status sync failed", error);
  } finally {
    backgroundOrderSyncRunning = false;
    if (backgroundHeavyTaskRunning === "order_status_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundCancelledOrderSync() {
  if (backgroundCancelledOrderSyncRunning) return;
  if (backgroundHeavyTaskRunning) {
    console.log(`background cancelled order sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return;
  }
  backgroundCancelledOrderSyncRunning = true;
  backgroundHeavyTaskRunning = "cancelled_order_sync";
  try {
    const window = rollingOrderSyncWindow(BACKGROUND_CANCELLED_ORDER_SYNC_DAYS);
    const result = await services.syncDemoOrders({ from: window.from, to: window.to, statuses: ["cancelled"] });
    console.log(`background cancelled order sync ok: ${window.from}~${window.to}, fetched ${result.fetched || 0}, updated ${result.updated || 0}`);
  } catch (error) {
    console.error("background cancelled order sync failed", error);
  } finally {
    backgroundCancelledOrderSyncRunning = false;
    if (backgroundHeavyTaskRunning === "cancelled_order_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundPostingDetailSync() {
  if (backgroundPostingDetailSyncRunning) return;
  if (backgroundHeavyTaskRunning) {
    console.log(`background posting detail sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return;
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
  } catch (error) {
    console.error("background posting detail sync failed", error);
  } finally {
    backgroundPostingDetailSyncRunning = false;
    if (backgroundHeavyTaskRunning === "posting_detail_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundPostingDetailDeepSyncIfDue() {
  if (backgroundPostingDetailSyncRunning) return;
  if (backgroundHeavyTaskRunning) {
    console.log(`background posting detail deep sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return;
  }
  const now = new Date();
  const dateKey = shanghaiDateKey(now);
  const shanghaiTime = shanghaiHourMinute(now);
  const targetHour = Math.min(Math.max(Number(config.backgroundPostingDetailDeepSyncHour || 2), 0), 23);
  const targetMinute = Math.min(Math.max(Number(config.backgroundPostingDetailDeepSyncMinute || 30), 0), 59);
  if (lastBackgroundPostingDetailDeepSyncDate === dateKey) return;
  if (shanghaiTime.hour < targetHour || (shanghaiTime.hour === targetHour && shanghaiTime.minute < targetMinute)) return;

  backgroundPostingDetailSyncRunning = true;
  backgroundHeavyTaskRunning = "posting_detail_deep_sync";
  try {
    const result = await services.syncKnownOzonPostingDetails({
      mode: "scheduled_nightly",
      days: BACKGROUND_POSTING_DETAIL_DEEP_SYNC_DAYS,
      limit: BACKGROUND_POSTING_DETAIL_DEEP_SYNC_LIMIT,
      concurrency: BACKGROUND_POSTING_DETAIL_SYNC_CONCURRENCY
    });
    lastBackgroundPostingDetailDeepSyncDate = dateKey;
    console.log(`background posting detail deep sync ok: candidates ${result.candidate_orders || 0}, fetched ${result.fetched || 0}, updated ${result.updated || 0}`);
  } catch (error) {
    console.error("background posting detail deep sync failed", error);
  } finally {
    backgroundPostingDetailSyncRunning = false;
    if (backgroundHeavyTaskRunning === "posting_detail_deep_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundAnalyticsRefresh() {
  if (backgroundAnalyticsRefreshRunning) return;
  if (backgroundHeavyTaskRunning) {
    console.log(`background analytics refresh skipped: ${backgroundHeavyTaskRunning} is running`);
    return;
  }
  backgroundAnalyticsRefreshRunning = true;
  backgroundHeavyTaskRunning = "analytics_refresh";
  try {
    const result = await services.refreshProfitAnalyticsSnapshots({});
    console.log(`background analytics refresh ok: product rows ${result.product_rows || 0}, sku rows ${result.sku_rows || 0}`);
  } catch (error) {
    console.error("background analytics refresh failed", error);
  } finally {
    backgroundAnalyticsRefreshRunning = false;
    if (backgroundHeavyTaskRunning === "analytics_refresh") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundAdvertisingSync() {
  if (backgroundAdvertisingSyncRunning) return;
  if (backgroundHeavyTaskRunning) {
    console.log(`background advertising sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return;
  }
  backgroundAdvertisingSyncRunning = true;
  backgroundHeavyTaskRunning = "advertising_sync";
  try {
    const window = rollingOrderSyncWindow(BACKGROUND_ADVERTISING_SYNC_DAYS);
    const result = await services.syncAdvertisingDailyFromOzon({ from: window.from, to: window.to });
    const okShops = (result.results || []).filter((item) => item.status === "ok").length;
    const skippedShops = (result.results || []).filter((item) => item.status !== "ok").length;
    console.log(`background advertising sync ok: ${window.from}~${window.to}, imported ${result.imported || 0}, ok shops ${okShops}, skipped/error shops ${skippedShops}`);
    if (result.errors?.length) console.warn(`background advertising sync warnings: ${result.errors.join("; ")}`);
  } catch (error) {
    console.error("background advertising sync failed", error);
  } finally {
    backgroundAdvertisingSyncRunning = false;
    if (backgroundHeavyTaskRunning === "advertising_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundOzonStockSync() {
  if (backgroundOzonStockSyncRunning) return;
  if (backgroundHeavyTaskRunning) {
    console.log(`background Ozon stock sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return;
  }
  backgroundOzonStockSyncRunning = true;
  backgroundHeavyTaskRunning = "ozon_stock_sync";
  try {
    const result = await services.syncOzonStocks({ mode: "scheduled_fbp" });
    console.log(`background Ozon stock sync ok: fetched ${result.fetched || 0}, upserted ${result.upserted || 0}, status ${result.status || "ok"}`);
    if (result.errors?.length) console.warn(`background Ozon stock sync warnings: ${result.errors.join("; ")}`);
  } catch (error) {
    console.error("background Ozon stock sync failed", error);
  } finally {
    backgroundOzonStockSyncRunning = false;
    if (backgroundHeavyTaskRunning === "ozon_stock_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runBackgroundOzonCategorySyncIfDue() {
  if (backgroundOzonCategorySyncRunning) return;
  if (backgroundHeavyTaskRunning) {
    console.log(`background Ozon category sync skipped: ${backgroundHeavyTaskRunning} is running`);
    return;
  }
  const now = new Date();
  const dateKey = shanghaiDateKey(now);
  const shanghaiTime = shanghaiHourMinute(now);
  const targetHour = Math.min(Math.max(Number(config.backgroundOzonCategorySyncHour || 1), 0), 23);
  const targetMinute = Math.min(Math.max(Number(config.backgroundOzonCategorySyncMinute || 10), 0), 59);
  if (lastBackgroundOzonCategorySyncDate === dateKey) return;
  if (shanghaiTime.hour < targetHour || (shanghaiTime.hour === targetHour && shanghaiTime.minute < targetMinute)) return;

  backgroundOzonCategorySyncRunning = true;
  backgroundHeavyTaskRunning = "ozon_category_sync";
  try {
    const result = await services.refreshOzonCategoryCache({
      mode: "scheduled_nightly",
      category_limit: config.backgroundOzonCategorySyncCategoryLimit,
      value_limit: config.backgroundOzonCategorySyncValueLimit,
      language: "ZH_HANS"
    });
    lastBackgroundOzonCategorySyncDate = dateKey;
    console.log(`background Ozon category sync ok: categories ${result.categories || 0}, attributes ${result.attributes || 0}, values ${result.values || 0}, used categories ${result.usedCategoryCount || 0}`);
  } catch (error) {
    console.error("background Ozon category sync failed", error);
  } finally {
    backgroundOzonCategorySyncRunning = false;
    if (backgroundHeavyTaskRunning === "ozon_category_sync") backgroundHeavyTaskRunning = "";
  }
}

async function runOzonActionCleanupSweep() {
  try {
    const results = await services.runEnabledOzonActionCleanup();
    if (!results.length) return;
    const removed = results.reduce((sum, item) => sum + Number(item?.count || 0), 0);
    const failed = results.filter((item) => item?.success === false).length;
    console.log(`ozon action cleanup sweep ok: stores ${results.length}, removed ${removed}, failed ${failed}`);
  } catch (error) {
    console.error("ozon action cleanup sweep failed", error);
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
