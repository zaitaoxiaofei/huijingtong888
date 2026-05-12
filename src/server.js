import http from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { calculateCelFbsPricing } from "./celRates.js";
import * as services from "./services/index.js";
import { readForm, readJson, isRequestCancelledError } from "./http/request.js";
import { clearCookie, html, json, notFound, setCookie, writeHead } from "./http/response.js";
import { createStaticHandler } from "./http/static.js";
import { cleanExpiredSessions, createAuthHandler, extractToken, getSession } from "./server/session.js";
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

// 保持现有 API 不变，但把“简单直连型接口”集中成一个表；
// server.js 只负责分发、鉴权和极少量路径参数解析。
const routes = {
  "GET /api/system/info": () => systemInfo(),
  "POST /api/system/backup": () => runDataBackup(),
  "POST /api/system/restore": () => startDataRestore(),
  "GET /api/dashboard": () => services.dashboard(),
  "GET /api/exchange-rate/current": () => services.currentExchangeRate(),
  "GET /api/exchange-rates": () => services.exchangeRates(),
  "GET /api/exception-workbench": () => services.exceptionWorkbench(),
  "POST /api/exception-workbench/tasks/state": async (req) => services.updateExceptionTaskState(await readJson(req), req._session?.personId),
  "GET /api/profit-summary": (req, url) => services.profitSummary(url?.searchParams?.get("from") || "", url?.searchParams?.get("to") || ""),
  "GET /api/orders": (req, url) => url?.searchParams?.get("paged") ? services.ordersPaged(Object.fromEntries(url.searchParams.entries())) : services.orders(),
  "GET /api/order-quality-rules": () => services.orderQualityRules(),
  "GET /api/products": () => services.products(),
  "GET /api/products/hidden": () => services.hiddenProducts(),
  "GET /api/online-products": () => services.onlineProducts(),
  "GET /api/mappings": () => services.mappings(),
  "GET /api/inventory": () => services.inventory(),
  "GET /api/stock-alerts": () => services.stockAlerts(),
  "GET /api/stock-warehouse-rules": () => services.stockWarehouseRules(),
  "GET /api/erp/inventory-current": () => services.inventoryCurrent(),
  "GET /api/erp/raw-orders": () => services.rawOzonOrders(),
  "GET /api/erp/profit-items": () => services.profitItems(),
  "GET /api/erp/order-exceptions": () => services.orderExceptions(),
  "GET /api/logistics-rules": () => services.logisticsRules(),
  "GET /api/inbound-records": () => services.inboundRecords(),
  "GET /api/outbound-records": () => services.outboundRecords(),
  "GET /api/procurement/summary": () => services.procurementSummary(),
  "GET /api/procurement/requests": () => services.procurementRequests(),
  "GET /api/procurement/purchase-orders": () => services.purchaseOrders(),
  "GET /api/procurement/pending-inbound": () => services.pendingInboundItems(),
  "GET /api/shops": () => services.shops(),
  "GET /api/people": () => services.people(),
  "POST /api/sync/ozon": async (req) => services.syncDemoOrders(await readJson(req), { signal: req._abortSignal }),
  "POST /api/sync/ozon/incremental": async (req) => services.syncOzonIncrementalOrders(await readJson(req), { signal: req._abortSignal }),
  "POST /api/sync/online-products": async (req) => services.syncOzonOnlineProducts(await readJson(req)),
  "POST /api/sync/ozon-stocks": async (req) => services.syncOzonStocks(await readJson(req), { signal: req._abortSignal }),
  "POST /api/sync/ozon-finance": async (req) => services.syncOzonFinance(await readJson(req), { signal: req._abortSignal }),
  "GET /api/ozon-finance/summary": () => services.ozonFinanceSummary(),
  "POST /api/exchange-rate": async (req) => services.updateExchangeRate(await readJson(req)),
  "POST /api/pricing/cel-fbs": async (req) => calculateCelFbsPricing(await readJson(req)),
  "POST /api/products": async (req) => services.createProduct(await readJson(req)) || { ok: true },
  "POST /api/products/import-preview": async (req) => services.previewProductCsvImport(await readJson(req)),
  "POST /api/products/import-commit": async (req) => services.commitProductCsvImport(await readJson(req)),
  "POST /api/people": async (req) => services.createPerson(await readJson(req)) || { ok: true },
  "POST /api/shops": async (req) => services.createShop(await readJson(req)) || { ok: true },
  "POST /api/online-products": async (req) => services.createOnlineProduct(await readJson(req)) || { ok: true },
  "POST /api/online-products/bind": async (req) => services.bindOnlineProduct(await readJson(req)) || { ok: true },
  "POST /api/online-products/action": async (req) => services.performOnlineProductAction(await readJson(req), req._session?.personId),
  "POST /api/online-products/create-product": async (req) => services.createProductFromOnlineProduct(await readJson(req)),
  "POST /api/orders/recalculate-profits": async () => services.recalculateAllMappedOrderProfits(),
  "POST /api/procurement/requests": async (req) => services.createProcurementRequest(await readJson(req)) || { ok: true },
  "POST /api/procurement/purchase-orders": async (req) => services.mergeProcurementRequests(await readJson(req)),
  "POST /api/inbound-records": async (req) => services.createInboundRecord(await readJson(req)) || { ok: true },
  "POST /api/inventory/movements": async (req) => services.createInventoryMovement(await readJson(req)) || { ok: true },
  "POST /api/logistics-rules": async (req) => services.createLogisticsRule(await readJson(req)),
  "POST /api/stock-warehouse-rules": async (req) => services.createStockWarehouseRule(await readJson(req))
};

cleanExpiredSessions();
setInterval(cleanExpiredSessions, 3600 * 1000);

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
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2]) {
    const detail = services.orderDetail(Number(parts[2]));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "mark") {
    return json(res, services.updateOrderMark(Number(parts[2]), await readJson(req), req._session?.personId));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "package-label") {
    const label = await services.orderPackageLabel(await readJson(req), req._session?.personId);
    writeHead(res, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${label.filename}"`,
      "Content-Length": label.buffer.length,
      "Cache-Control": "no-store"
    });
    res.end(label.buffer);
    return true;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "package-label-printed") {
    return json(res, services.markOrderLabelsPrinted(await readJson(req), req._session?.personId));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "ship") {
    return json(res, await services.shipOrders(await readJson(req), req._session?.personId));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "recalculate-profit") {
    return json(res, services.recalculateOrderProfit(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-quality-rules") {
    return json(res, services.saveOrderQualityRules(await readJson(req)));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "order-profit-details") {
    return json(res, services.productOrderProfitDetails(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "cancel-details") {
    return json(res, services.productCancelDetails(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    services.updateProduct(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "recalculate-profits") {
    return json(res, services.recalculateOrderProfitsForProduct(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
    return json(res, services.updateSkuMapping(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
    return json(res, services.deleteSkuMapping(Number(parts[2])));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    services.deleteProduct(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "restore") {
    services.restoreProduct(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "online-products" && parts[2]) {
    services.updateOnlineProduct(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
    services.updatePerson(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
    if (url.searchParams.get("hard") === "1") services.hardDeletePerson(Number(parts[2]));
    else services.deletePerson(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
    services.updateShop(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
    services.deleteShop(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
    services.updateProcurementRequest(Number(parts[3]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3] === "submit") {
    return json(res, services.submitProcurementRequests(await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
    return json(res, services.deleteProcurementRequest(Number(parts[3])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    const detail = services.purchaseOrderDetail(Number(parts[3]));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "confirm-purchased") {
    return json(res, services.confirmPurchaseOrder(Number(parts[3]), await readJson(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "cancel") {
    return json(res, services.cancelPurchaseOrder(Number(parts[3])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    services.updatePurchaseOrder(Number(parts[3]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    return json(res, services.deletePurchaseOrder(Number(parts[3])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
    services.updateInboundRecord(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
    return json(res, services.deleteInboundRecord(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
    return json(res, services.suppliers());
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
    return json(res, services.createSupplier(await readJson(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
    services.updateSupplier(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
    return json(res, services.deleteSupplier(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "logistics-rules" && parts[2]) {
    return json(res, services.updateLogisticsRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "logistics-rules" && parts[2]) {
    return json(res, services.deleteLogisticsRule(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
    return json(res, services.updateStockWarehouseRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
    return json(res, services.deleteStockWarehouseRule(Number(parts[2])));
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
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

    if (parts[0] === "api") {
      const session = getSession(extractToken(req));
      if (!session) return json(res, { error: "未登录，请先登录" }, 401);
      req._session = session;
    }

    const restHandled = await handleRestRoute(req, res, url, parts);
    if (restHandled !== false) return;

    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return json(res, await routes[key](req, url));

    return serveStatic(url.pathname, res);
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
});
