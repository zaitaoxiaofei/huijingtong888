import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { initDb, db, hashPassword, verifyPassword, isLegacyHash } from "./db.js";
import { calculateCelFbsPricing } from "./celRates.js";
import {
  all,
  bindOnlineProduct,
  createInboundRecord,
  createInventoryMovement,
  createOnlineProduct,
  createPerson,
  createProduct,
  createProductFromOnlineProduct,
  commitProductCsvImport,
  createProcurementRequest,
  createShop,
  createStockWarehouseRule,
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  dashboard,
  deleteInboundRecord,
  deletePerson,
  deleteProduct,
  deleteProcurementRequest,
  deleteShop,
  deleteSkuMapping,
  deleteStockWarehouseRule,
  hardDeletePerson,
  hiddenProducts,
  inboundRecords,
  inventory,
  inventoryCurrent,
  logisticsRules,
  markOrderLabelsPrinted,
  mappings,
  onlineProducts,
  performOnlineProductAction,
  orderDetail,
  orderExceptions,
  orderPackageLabel,
  ordersPaged,
  orderQualityRules,
  orders,
  outboundRecords,
  people,
  currentExchangeRate,
  exchangeRates,
  exceptionWorkbench,
  updateExceptionTaskState,
  updateExchangeRate,
  profitSummary,
  profitItems,
  productCancelDetails,
  productOrderProfitDetails,
  procurementRequests,
  procurementSummary,
  mergeProcurementRequests,
  pendingInboundItems,
  products,
  previewProductCsvImport,
  purchaseOrderDetail,
  purchaseOrders,
  updatePurchaseOrder,
  deletePurchaseOrder,
  rawOzonOrders,
  recalculateAllMappedOrderProfits,
  recalculateOrderProfit,
  recalculateOrderProfitsForProduct,
  recalculateOrderItemsForMapping,
  restoreProduct,
  shops,
  stockAlerts,
  stockWarehouseRules,
  syncDemoOrders,
  syncOzonFinance,
  syncOzonIncrementalOrders,
  syncOzonOnlineProducts,
  syncOzonStocks,
  ozonFinanceSummary,
  submitProcurementRequests,
  updateProduct,
  updateOnlineProduct,
  updateOrderMark,
  updatePerson,
  updateShop,
  updateStockWarehouseRule,
  updateSkuMapping,
  updateProcurementRequest,
  updateInboundRecord,
  saveOrderQualityRules,
  shipOrders,
  suppliers,
  createSupplier,
  createLogisticsRule,
  updateLogisticsRule,
  deleteLogisticsRule,
  updateSupplier,
  deleteSupplier
} from "./services.js";

initDb();

const publicDir = path.resolve("public");
const execFileAsync = promisify(execFile);

const routes = {
  "GET /api/system/info": () => systemInfo(),
  "POST /api/system/backup": () => runDataBackup(),
  "POST /api/system/restore": () => startDataRestore(),
  "GET /api/dashboard": () => dashboard(),
  "GET /api/exchange-rate/current": () => currentExchangeRate(),
  "GET /api/exchange-rates": () => exchangeRates(),
  "GET /api/exception-workbench": () => exceptionWorkbench(),
  "POST /api/exception-workbench/tasks/state": async (req) => updateExceptionTaskState(await readJson(req), req._session?.personId),
  "GET /api/profit-summary": (req, url) => {
    const from = url?.searchParams?.get("from") || "";
    const to = url?.searchParams?.get("to") || "";
    return profitSummary(from, to);
  },
  "GET /api/orders": (req, url) => url?.searchParams?.get("paged") ? ordersPaged(Object.fromEntries(url.searchParams.entries())) : orders(),
  "GET /api/order-quality-rules": () => orderQualityRules(),
  "GET /api/products": () => products(),
  "GET /api/products/hidden": () => hiddenProducts(),
  "GET /api/online-products": () => onlineProducts(),
  "GET /api/mappings": () => mappings(),
  "GET /api/inventory": () => inventory(),
  "GET /api/stock-alerts": () => stockAlerts(),
  "GET /api/stock-warehouse-rules": () => stockWarehouseRules(),
  "GET /api/erp/inventory-current": () => inventoryCurrent(),
  "GET /api/erp/raw-orders": () => rawOzonOrders(),
  "GET /api/erp/profit-items": () => profitItems(),
  "GET /api/erp/order-exceptions": () => orderExceptions(),
  "GET /api/logistics-rules": () => logisticsRules(),
  "GET /api/inbound-records": () => inboundRecords(),
  "GET /api/outbound-records": () => outboundRecords(),
  "GET /api/procurement/summary": () => procurementSummary(),
  "GET /api/procurement/requests": () => procurementRequests(),
  "GET /api/procurement/purchase-orders": () => purchaseOrders(),
  "GET /api/procurement/pending-inbound": () => pendingInboundItems(),
  "GET /api/shops": () => shops(),
  "GET /api/people": () => people(),
  "POST /api/sync/ozon": async (req) => syncDemoOrders(await readJson(req), { signal: req._abortSignal }),
  "POST /api/sync/ozon/incremental": async (req) => syncOzonIncrementalOrders(await readJson(req), { signal: req._abortSignal }),
  "POST /api/sync/online-products": async (req) => syncOzonOnlineProducts(await readJson(req)),
  "POST /api/sync/ozon-stocks": async (req) => syncOzonStocks(await readJson(req), { signal: req._abortSignal }),
  "POST /api/sync/ozon-finance": async (req) => syncOzonFinance(await readJson(req), { signal: req._abortSignal }),
  "GET /api/ozon-finance/summary": () => ozonFinanceSummary(),
  "POST /api/exchange-rate": async (req) => updateExchangeRate(await readJson(req)),
  "POST /api/pricing/cel-fbs": async (req) => calculateCelFbsPricing(await readJson(req)),
  "POST /api/products": async (req) => createProduct(await readJson(req)) || { ok: true },
  "POST /api/products/import-preview": async (req) => previewProductCsvImport(await readJson(req)),
  "POST /api/products/import-commit": async (req) => commitProductCsvImport(await readJson(req)),
  "POST /api/people": async (req) => createPerson(await readJson(req)) || { ok: true },
  "POST /api/shops": async (req) => createShop(await readJson(req)) || { ok: true },
  "POST /api/online-products": async (req) => createOnlineProduct(await readJson(req)) || { ok: true },
  "POST /api/online-products/bind": async (req) => bindOnlineProduct(await readJson(req)) || { ok: true },
  "POST /api/online-products/action": async (req) => performOnlineProductAction(await readJson(req), req._session?.personId),
  "POST /api/online-products/create-product": async (req) => createProductFromOnlineProduct(await readJson(req)),
  "POST /api/orders/recalculate-profits": async () => recalculateAllMappedOrderProfits(),
  "POST /api/procurement/requests": async (req) => createProcurementRequest(await readJson(req)) || { ok: true },
  "POST /api/procurement/purchase-orders": async (req) => mergeProcurementRequests(await readJson(req)),
  "POST /api/inbound-records": async (req) => createInboundRecord(await readJson(req)) || { ok: true },
  "POST /api/inventory/movements": async (req) => createInventoryMovement(await readJson(req)) || { ok: true },
  "POST /api/logistics-rules": async (req) => createLogisticsRule(await readJson(req)),
  "POST /api/stock-warehouse-rules": async (req) => createStockWarehouseRule(await readJson(req))
};

// ── 认证 / Session（SQLite 持久化）─────────────────────
const SESSION_TTL_HOURS = 72;

function createSession(personId, name, role, username) {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (token, person_id, name, role, username, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, personId, name, role, username || null, expiresAt);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return { personId: row.person_id, name: row.name, role: row.role, username: row.username, createdAt: new Date(row.created_at).getTime() };
}

function destroySession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function cleanExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP").run();
}

// 启动时清理过期 session，之后每小时清理一次
cleanExpiredSessions();
setInterval(cleanExpiredSessions, 3600 * 1000);

const AUTH_ROUTES = new Set(["POST /api/auth/login", "GET /api/auth/me", "POST /api/auth/logout", "POST /api/auth/change-password"]);

function handleAuth(req, url) {
  const key = `${req.method} ${url.pathname}`;
  if (key === "POST /api/auth/login") {
    return async () => {
      const body = await readJson(req);
      const row = db.prepare("SELECT id, name, username, role, password_hash, active FROM people WHERE username = ?").get(body.username);
      if (!row || !row.active) return { error: "用户名或密码错误" };
      if (!verifyPassword(body.password || "", row.password_hash)) return { error: "用户名或密码错误" };
      // 旧 SHA-256 密码自动升级为 scrypt
      if (isLegacyHash(row.password_hash)) {
        db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(hashPassword(body.password), row.id);
      }
      const token = createSession(row.id, row.name, row.role, row.username);
      return { ok: true, token, user: { id: row.id, name: row.name, role: row.role, username: row.username } };
    };
  }
  if (key === "GET /api/auth/me") {
    return () => {
      const token = extractToken(req);
      const session = getSession(token);
      if (!session) return null; // returns 404 → frontend treats as not logged in
      const row = db.prepare("SELECT id, name, username, role, active FROM people WHERE id = ?").get(session.personId);
      if (!row || !row.active) return null;
      return { id: row.id, name: row.name, role: row.role, username: row.username };
    };
  }
  if (key === "POST /api/auth/logout") {
    return () => {
      destroySession(extractToken(req));
      return { ok: true };
    };
  }
  if (key === "POST /api/auth/change-password") {
    return async () => {
      const token = extractToken(req);
      const session = getSession(token);
      if (!session) return { error: "未登录" };
      const body = await readJson(req);
      const row = db.prepare("SELECT password_hash FROM people WHERE id = ?").get(session.personId);
      if (!verifyPassword(body.old_password || "", row.password_hash)) return { error: "原密码错误" };
      db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(hashPassword(body.new_password), session.personId);
      return { ok: true };
    };
  }
  return null;
}

function extractToken(req) {
  return req.headers["authorization"]?.replace(/^Bearer\s+/, "") || "";
}

function systemInfo() {
  const databasePath = path.resolve(config.databasePath);
  const databaseExists = fs.existsSync(databasePath);
  const stat = databaseExists ? fs.statSync(databasePath) : null;
  return {
    port: config.port,
    databasePath,
    databaseExists,
    databaseSizeBytes: stat?.size || 0,
    appBaseUrl: config.appBaseUrl
  };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function maintenanceScriptPath(name) {
  const scriptPath = path.resolve("scripts", `${name}-data.ps1`);
  if (!fs.existsSync(scriptPath)) throw new Error(`维护脚本不存在：${scriptPath}`);
  return scriptPath;
}

async function runDataBackup() {
  const scriptPath = maintenanceScriptPath("backup");
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 1024 * 1024 * 4
  });
  return {
    ok: true,
    message: "备份完成，备份包已保存到 backups 目录。",
    stdout: stdout?.slice(-4000) || "",
    stderr: stderr?.slice(-4000) || ""
  };
}

function startDataRestore() {
  const scriptPath = maintenanceScriptPath("restore");
  const projectRoot = process.cwd();
  const nodePath = process.execPath;
  const serverLog = path.resolve("server.log");
  const serverErrLog = path.resolve("server.err.log");
  const restoreLog = path.resolve("restore-data.log");
  const restoreErrLog = path.resolve("restore-data.err.log");
  const command = [
    "$ErrorActionPreference = 'Continue'",
    "Start-Sleep -Seconds 1",
    `Stop-Process -Id ${process.pid} -Force -ErrorAction SilentlyContinue`,
    `& ${psQuote(scriptPath)} 1>> ${psQuote(restoreLog)} 2>> ${psQuote(restoreErrLog)}`,
    `Start-Process -FilePath ${psQuote(nodePath)} -ArgumentList 'src/server.js' -WorkingDirectory ${psQuote(projectRoot)} -WindowStyle Hidden -RedirectStandardOutput ${psQuote(serverLog)} -RedirectStandardError ${psQuote(serverErrLog)}`
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  return {
    ok: true,
    message: "恢复任务已启动。服务会短暂断开并自动重启，请 5-10 秒后刷新页面。"
  };
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

    // 认证路由（不需要已登录状态）
    if (parts[0] === "api" && parts[1] === "auth") {
      const handler = handleAuth(req, url);
      if (handler) return json(res, await handler());
      return notFound(res);
    }

    // 其他 API 路由需要登录
    if (parts[0] === "api") {
      const session = getSession(extractToken(req));
      if (!session) return json(res, { error: "未登录，请先登录" }, 401);
      // 把当前用户信息注入请求上下文
      req._session = session;
    }

    // GET /api/orders/:id
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2]) {
      const detail = orderDetail(Number(parts[2]));
      return detail ? json(res, detail) : notFound(res);
    }

    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "mark") {
      return json(res, updateOrderMark(Number(parts[2]), await readJson(req), req._session?.personId));
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "package-label") {
      const label = await orderPackageLabel(await readJson(req), req._session?.personId);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${label.filename}"`,
        "Content-Length": label.buffer.length,
        "Cache-Control": "no-store"
      });
      return res.end(label.buffer);
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "package-label-printed") {
      return json(res, markOrderLabelsPrinted(await readJson(req), req._session?.personId));
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "ship") {
      return json(res, await shipOrders(await readJson(req), req._session?.personId));
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "recalculate-profit") {
      return json(res, recalculateOrderProfit(Number(parts[2])));
    }

    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-quality-rules") {
      return json(res, saveOrderQualityRules(await readJson(req)));
    }

    // PUT /api/products/:id
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "order-profit-details") {
      return json(res, productOrderProfitDetails(Number(parts[2])));
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "cancel-details") {
      return json(res, productCancelDetails(Number(parts[2])));
    }

    // PUT /api/products/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
      updateProduct(Number(parts[2]), await readJson(req));
      return json(res, { ok: true });
    }

    // POST /api/products/:id/recalculate-profits
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "recalculate-profits") {
      return json(res, recalculateOrderProfitsForProduct(Number(parts[2])));
    }

    // PUT /api/mappings/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
      return json(res, updateSkuMapping(Number(parts[2]), await readJson(req)));
    }

    // DELETE /api/mappings/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
      return json(res, deleteSkuMapping(Number(parts[2])));
    }

    // DELETE /api/products/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
      deleteProduct(Number(parts[2]));
      return json(res, { ok: true });
    }

    // POST /api/products/:id/restore
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "restore") {
      restoreProduct(Number(parts[2]));
      return json(res, { ok: true });
    }

    // PUT /api/online-products/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "online-products" && parts[2]) {
      updateOnlineProduct(Number(parts[2]), await readJson(req));
      return json(res, { ok: true });
    }

    // PUT /api/people/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
      updatePerson(Number(parts[2]), await readJson(req));
      return json(res, { ok: true });
    }

    // DELETE /api/people/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
      if (url.searchParams.get("hard") === "1") hardDeletePerson(Number(parts[2]));
      else deletePerson(Number(parts[2]));
      return json(res, { ok: true });
    }

    // PUT /api/shops/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
      updateShop(Number(parts[2]), await readJson(req));
      return json(res, { ok: true });
    }

    // DELETE /api/shops/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
      deleteShop(Number(parts[2]));
      return json(res, { ok: true });
    }

    // PUT /api/procurement/requests/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
      updateProcurementRequest(Number(parts[3]), await readJson(req));
      return json(res, { ok: true });
    }

    // POST /api/procurement/requests/submit
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3] === "submit") {
      return json(res, submitProcurementRequests(await readJson(req)));
    }

    // DELETE /api/procurement/requests/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
      return json(res, deleteProcurementRequest(Number(parts[3])));
    }

    // GET /api/procurement/purchase-orders/:id
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
      const detail = purchaseOrderDetail(Number(parts[3]));
      return detail ? json(res, detail) : notFound(res);
    }

    // POST /api/procurement/purchase-orders/:id/confirm-purchased
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "confirm-purchased") {
      return json(res, confirmPurchaseOrder(Number(parts[3]), await readJson(req)));
    }

    // POST /api/procurement/purchase-orders/:id/cancel
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "cancel") {
      return json(res, cancelPurchaseOrder(Number(parts[3])));
    }

    // PUT /api/procurement/purchase-orders/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
      updatePurchaseOrder(Number(parts[3]), await readJson(req));
      return json(res, { ok: true });
    }

    // DELETE /api/procurement/purchase-orders/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
      return json(res, deletePurchaseOrder(Number(parts[3])));
    }

    // PUT /api/inbound-records/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
      updateInboundRecord(Number(parts[2]), await readJson(req));
      return json(res, { ok: true });
    }

    // DELETE /api/inbound-records/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
      return json(res, deleteInboundRecord(Number(parts[2])));
    }

    // ==================== 供应商管理 API ====================

    // GET /api/suppliers
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
      return json(res, suppliers());
    }

    // POST /api/suppliers
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
      return json(res, createSupplier(await readJson(req)));
    }

    // PUT /api/suppliers/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
      updateSupplier(Number(parts[2]), await readJson(req));
      return json(res, { ok: true });
    }

    // DELETE /api/suppliers/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
      return json(res, deleteSupplier(Number(parts[2])));
    }

    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "logistics-rules" && parts[2]) {
      return json(res, updateLogisticsRule(Number(parts[2]), await readJson(req)));
    }

    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "logistics-rules" && parts[2]) {
      return json(res, deleteLogisticsRule(Number(parts[2])));
    }

    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
      return json(res, updateStockWarehouseRule(Number(parts[2]), await readJson(req)));
    }

    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
      return json(res, deleteStockWarehouseRule(Number(parts[2])));
    }

    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return json(res, await routes[key](req, url));
    return serveStatic(url.pathname, res);
  } catch (error) {
    if (!isRequestCancelledError(error)) console.error(error);
    json(res, { error: error.message }, 500);
  }
});

server.listen(config.port, () => {
  console.log(`ozon ERP running at http://localhost:${config.port}`);
  // 每分钟检查是否是下午6点，生成采购清单通知
  setInterval(checkDailyPurchaseNotification, 60000);
});

// 每日采购清单通知检查
function checkDailyPurchaseNotification() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  if (hour === 18 && minute === 0) {
    generateDailyPurchaseNotification();
  }
}

// 生成每日采购清单通知
function generateDailyPurchaseNotification() {
  try {
    const pendingRequests = all(`
      SELECT pr.*, p.name AS product_name, p.code AS product_code, p.image_url AS product_image_url,
             pe.name AS person_name
      FROM procurement_requests pr
      JOIN products p ON p.id = pr.product_id
      JOIN people pe ON pe.id = pr.person_id
      WHERE pr.status = 'submitted'
      ORDER BY pr.created_at DESC
    `);
    
    if (!pendingRequests.length) return;
    
    // 按产品合并统计
    const merged = {};
    for (const r of pendingRequests) {
      const key = r.product_id;
      if (!merged[key]) {
        merged[key] = {
          product_name: r.product_name,
          product_code: r.product_code,
          total_quantity: 0,
          total_amount: 0,
          request_count: 0
        };
      }
      merged[key].total_quantity += Number(r.quantity || 0);
      merged[key].total_amount += Number(r.amount || 0) + Number(r.shipping_amount || 0);
      merged[key].request_count++;
    }
    
    const productList = Object.values(merged);
    const totalProducts = productList.length;
    const totalQuantity = productList.reduce((s, m) => s + m.total_quantity, 0);
    const totalAmount = productList.reduce((s, m) => s + m.total_amount, 0);
    
    console.log(`[采购通知] ${new Date().toLocaleString()} - 当日采购清单已生成：${totalProducts} 种产品，${totalQuantity} 件，总金额 ¥${totalAmount.toFixed(2)}`);
    
    // TODO: 后续可接入微信推送
    // 目前仅在控制台输出日志，前端可在 loadAll 时检查是否有新通知
  } catch (error) {
    console.error('[采购通知] 生成失败:', error.message);
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res) {
  json(res, { error: "Not found" }, 404);
}

function isRequestCancelledError(error) {
  const message = String(error?.message || "");
  return message.includes("客户端已取消") || message.includes("客户端连接已关闭") || message.includes("本次拉取已取消");
}

function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, cleanPath);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return notFound(res);
  }
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  const headers = { "Content-Type": types[ext] || "application/octet-stream" };
  if ([".html", ".css", ".js"].includes(ext)) {
    headers["Cache-Control"] = "no-store";
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}
