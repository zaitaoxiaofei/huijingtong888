import http from "node:http";
import { Buffer } from "node:buffer";
import path from "node:path";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { calculateCelFbsPricing } from "./celRates.js";
import * as services from "./services/index.js";
import { readForm, readJson, isRequestCancelledError } from "./http/request.js";
import { clearCookie, html, json, notFound, setCookie, text, writeHead } from "./http/response.js";
import { createStaticHandler } from "./http/static.js";
import { cleanExpiredSessions, createAuthHandler, extractToken, getSession } from "./server/session.js";
import { createApiDocumentation, renderApiDocumentationMarkdown } from "./server/api-docs.js";
import { createCatalogRoutes, handleCatalogRestRoute } from "./server/routes/catalog.js";
import { createOrderRoutes, handleOrderRestRoute } from "./server/routes/orders.js";
import { createOperationsRoutes, handleOperationsRestRoute } from "./server/routes/operations.js";
import { createProfitRoutes } from "./server/routes/profit.js";
import { createSyncRoutes } from "./server/routes/sync.js";
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
  isSiteAccessAuthorized,
  normalizeNextPath,
  renderSiteAccessPage,
  siteAccessUsesSecureCookie
} from "./server/access.js";
import { runDataBackup, startDataRestore, systemInfo } from "./server/maintenance.js";
import { checkDailyPurchaseNotification } from "./server/notifications.js";

initDb();

const publicDir = path.resolve("public");
const serveStatic = createStaticHandler(publicDir);
const handleAuth = createAuthHandler(readJson);

const routeModules = {
  ...createCatalogRoutes({ services, readJson }),
  ...createOperationsRoutes({ services, readJson }),
  ...createProfitRoutes({ services, readJson }),
  ...createOrderRoutes({ services, readJson, notFound, writeHead, json }),
  ...createSyncRoutes({ services, readJson, syncExceptionWorkbenchOrders })
};

// 保持现有 API 不变，但把“简单直连型接口”集中成一个表；
// server.js 只负责分发、鉴权和极少量路径参数解析。
// Keep straightforward routes in a single lookup table so server.js stays
// focused on request dispatch, authentication, and transport concerns.
const routes = {
  ...routeModules,
  "GET /api/system/info": () => systemInfo(),
  "POST /api/system/backup": () => runDataBackup(),
  "POST /api/system/restore": () => startDataRestore(),
  "GET /api/dashboard": () => services.dashboard(),
  "GET /api/exchange-rate/current": () => services.currentExchangeRate(),
  "GET /api/exchange-rates": () => services.exchangeRates(),
  "GET /api/inventory": () => services.inventory(),
  "GET /api/stock-alerts": () => services.stockAlerts(),
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

  return false;
}

function sendProductImage(res, productId) {
  const image = services.productImage(productId);
  if (!image) return notFound(res);
  const match = String(image).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return json(res, { error: "Unsupported image" }, 415);
  const buffer = Buffer.from(match[2], "base64");
  writeHead(res, 200, {
    "Content-Type": match[1],
    "Content-Length": buffer.length,
    "Cache-Control": "private, max-age=86400"
  });
  return res.end(buffer);
}

async function sendRemoteImage(req, res, url) {
  const target = String(url.searchParams.get("url") || "").trim();
  if (!/^https?:\/\//i.test(target)) return json(res, { error: "Invalid image url" }, 400);

  const controller = new AbortController();
  const onClose = () => controller.abort(new Error("client disconnected"));
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
    if (!upstream.ok) return json(res, { error: `Upstream image fetch failed: ${upstream.status}` }, 502);
    const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return json(res, { error: "Upstream did not return an image" }, 415);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    writeHead(res, 200, {
      "Content-Type": contentType,
      "Content-Length": buffer.length,
      "Cache-Control": "private, max-age=3600"
    });
    return res.end(buffer);
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

    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      return serveStatic("/admin.html", req, res);
    }

    if (parts[0] === "api") {
      const session = getSession(extractToken(req));
      if (!session) return json(res, { error: "未登录，请先登录" }, 401);
      req._session = session;
    }

    const restHandled = await handleRestRoute(req, res, url, parts);
    if (restHandled !== false) return;

    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return json(res, await routes[key](req, url));

    return serveStatic(url.pathname, req, res);
  } catch (error) {
    if (!isRequestCancelledError(error)) console.error(error);
    if (res.writableEnded || res.destroyed) return;
    json(res, { error: error.message }, 500);
  }
});

server.listen(config.port, config.host || undefined, () => {
  const bindHost = config.host || "0.0.0.0";
  console.log(`ozon ERP running at ${config.appBaseUrl} (bind ${bindHost}:${config.port})`);
  setInterval(() => checkDailyPurchaseNotification(services.all), 60000);
  setInterval(runBackgroundOrderStatusSync, 60 * 60 * 1000);
});

async function runBackgroundOrderStatusSync() {
  if (backgroundOrderSyncRunning) return;
  backgroundOrderSyncRunning = true;
  try {
    const { window, result } = await syncExceptionWorkbenchOrders();
    console.log(`background order status sync ok: ${window.from}~${window.to}, tasks ${window.task_count || 0}, fetched ${result.fetched || 0}, updated ${result.updated || 0}`);
  } catch (error) {
    console.error("background order status sync failed", error);
  } finally {
    backgroundOrderSyncRunning = false;
  }
}

async function syncExceptionWorkbenchOrders(req = null) {
  // Reuse the same rolling synchronization window for both manual and
  // background refreshes so operators and cron-like jobs see the same scope.
  const window = services.exceptionWorkbenchSyncWindow();
  const result = await services.syncDemoOrders({ from: window.from, to: window.to }, { signal: req?._abortSignal });
  return { window, result };
}
