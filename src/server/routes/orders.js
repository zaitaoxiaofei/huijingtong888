import { serverTransformPdfForPaper } from "../../services/server-print.js";

export function createOrderRoutes({ services, readJson, notFound, writeHead, json }) {
  return {
    "GET /api/orders": (req, url) => url?.searchParams?.get("paged")
      ? services.ordersPaged(Object.fromEntries(url.searchParams.entries()))
      : services.orders(),
    "GET /api/orders/status-history/summary": () => services.orderStatusHistorySummary?.() || { total_history_rows: 0, open_orders: 0 },
    "GET /api/order-quality-rules": () => services.orderQualityRules(),
    "POST /api/orders/recalculate-profits": async () => services.recalculateAllMappedOrderProfits()
  };
}

export async function handleOrderRestRoute({ req, res, url, parts, services, readJson, json, notFound, writeHead }) {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "status-history" && parts[3] === "summary") {
    return json(res, await (services.orderStatusHistorySummary?.() || { total_history_rows: 0, open_orders: 0 }));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "status-history") {
    return json(res, services.orderStatusHistory
      ? await services.orderStatusHistory(Number(parts[2]), Object.fromEntries(url.searchParams.entries()))
      : []);
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "procurement-preview") {
    return json(res, services.previewOrderProcurement
      ? await services.previewOrderProcurement(Number(parts[2]))
      : { ok: true, purchasable_count: 0, total_quantity: 0, product_count: 0, missing_count: 0, products: [], missing_items: [] });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2]) {
    const detail = await services.orderDetail(Number(parts[2]));
    if (detail && !detail.profit_detail_snapshot) {
      if (typeof services.orderProfitDetailSnapshot === "function") {
        detail.profit_detail_snapshot = await services.orderProfitDetailSnapshot(Number(parts[2]));
      }
    }
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "mark") {
    return json(res, services.updateOrderMark(Number(parts[2]), await readJson(req), req._session?.personId));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "package-label") {
    const body = await readJson(req);
    const label = await services.orderPackageLabel(body, req._session?.personId);
    const buffer = await serverTransformPdfForPaper(label.buffer, body);
    writeHead(res, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${label.filename}"`,
      "Content-Length": buffer.length,
      "X-Ozon-Label-Count": String(label.count || 0),
      "X-Ozon-Label-Failures": encodeURIComponent(JSON.stringify(label.failures || [])),
      "X-Ozon-Label-Printed-Ids": encodeURIComponent(JSON.stringify(label.printed_ids || [])),
      "X-Ozon-Label-Stats": encodeURIComponent(JSON.stringify(label.stats || {})),
      "Cache-Control": "no-store"
    });
    res.end(buffer);
    return true;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "package-label-printed") {
    return json(res, services.markOrderLabelsPrinted(await readJson(req), req._session?.personId));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] === "ship") {
    return json(res, await services.shipOrders(await readJson(req), req._session?.personId));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "procurement-requests") {
    return json(res, services.createOrderProcurementRequests
      ? await services.createOrderProcurementRequests(Number(parts[2]), await readJson(req), req._session?.personId)
      : { ok: true, created_count: 0, request_ids: [] });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "orders" && parts[2] && parts[3] === "recalculate-profit") {
    return json(res, services.recalculateOrderProfit(Number(parts[2])));
  }

  return false;
}
