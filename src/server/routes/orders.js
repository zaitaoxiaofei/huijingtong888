import { config } from "../../config.js";
import {
  orderDetailMysql,
  orderProfitDetailSnapshotMysql,
  orderQualityRulesMysql,
  orderStatusHistoryMysql,
  orderStatusHistorySummaryMysql,
  ordersMysql,
  ordersPagedMysql,
  updateOrderMarkMysql
} from "../../services/mysql-cutover.js";

export function createOrderRoutes({ services, readJson, notFound, writeHead, json }) {
  return {
    "GET /api/orders": (req, url) => url?.searchParams?.get("paged")
      ? config.dbClient === "mysql"
        ? ordersPagedMysql(Object.fromEntries(url.searchParams.entries()))
        : services.ordersPaged(Object.fromEntries(url.searchParams.entries()))
      : config.dbClient === "mysql" ? ordersMysql() : services.orders(),
    "GET /api/orders/status-history/summary": () => config.dbClient === "mysql" ? orderStatusHistorySummaryMysql() : { total_history_rows: 0, open_orders: 0 },
    "GET /api/order-quality-rules": () => config.dbClient === "mysql" ? orderQualityRulesMysql() : services.orderQualityRules(),
    "POST /api/orders/recalculate-profits": async () => services.recalculateAllMappedOrderProfits()
  };
}

export async function handleOrderRestRoute({ req, res, url, parts, services, readJson, json, notFound, writeHead }) {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "status-history" && parts[3] === "summary") {
    return json(res, config.dbClient === "mysql" ? await orderStatusHistorySummaryMysql() : { total_history_rows: 0, open_orders: 0 });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "status-history") {
    return json(res, config.dbClient === "mysql"
      ? await orderStatusHistoryMysql(Number(parts[2]), Object.fromEntries(url.searchParams.entries()))
      : []);
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2]) {
    const detail = config.dbClient === "mysql"
      ? await orderDetailMysql(Number(parts[2]))
      : services.orderDetail(Number(parts[2]));
    if (detail && !detail.profit_detail_snapshot) {
      if (config.dbClient === "mysql") detail.profit_detail_snapshot = await orderProfitDetailSnapshotMysql(Number(parts[2]));
      else if (typeof services.orderProfitDetailSnapshot === "function") detail.profit_detail_snapshot = services.orderProfitDetailSnapshot(Number(parts[2]));
    }
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "mark") {
    return json(res, config.dbClient === "mysql"
      ? await updateOrderMarkMysql(Number(parts[2]), await readJson(req), req._session?.personId)
      : services.updateOrderMark(Number(parts[2]), await readJson(req), req._session?.personId));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "package-label") {
    const label = await services.orderPackageLabel(await readJson(req), req._session?.personId);
    writeHead(res, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${label.filename}"`,
      "Content-Length": label.buffer.length,
      "X-Ozon-Label-Count": String(label.count || 0),
      "X-Ozon-Label-Failures": encodeURIComponent(JSON.stringify(label.failures || [])),
      "X-Ozon-Label-Printed-Ids": encodeURIComponent(JSON.stringify(label.printed_ids || [])),
      "X-Ozon-Label-Stats": encodeURIComponent(JSON.stringify(label.stats || {})),
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

  return false;
}
