export function createOrderRoutes({ services, readJson, notFound, writeHead, json }) {
  return {
    "GET /api/orders": (req, url) => url?.searchParams?.get("paged")
      ? services.ordersPaged(Object.fromEntries(url.searchParams.entries()))
      : services.orders(),
    "GET /api/order-quality-rules": () => services.orderQualityRules(),
    "POST /api/orders/recalculate-profits": async () => services.recalculateAllMappedOrderProfits()
  };
}

export async function handleOrderRestRoute({ req, res, url, parts, services, readJson, json, notFound, writeHead }) {
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

  return false;
}
