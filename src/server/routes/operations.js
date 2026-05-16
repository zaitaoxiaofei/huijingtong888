export function createOperationsRoutes({ services, readJson }) {
  return {
    "GET /api/logistics-rules": () => services.logisticsRules(),
    "GET /api/order-cancellation-rules": () => services.orderCancellationRules(),
    "GET /api/inbound-records": () => services.inboundRecords(),
    "GET /api/outbound-records": () => services.outboundRecords(),
    "GET /api/procurement/summary": () => services.procurementSummary(),
    "GET /api/procurement/requests": () => services.procurementRequests(),
    "GET /api/procurement/purchase-orders": () => services.purchaseOrders(),
    "GET /api/procurement/pending-inbound": () => services.pendingInboundItems(),
    "GET /api/shops": () => services.shops(),
    "GET /api/people": () => services.people(),
    "POST /api/people": async (req) => services.createPerson(await readJson(req)) || { ok: true },
    "POST /api/shops": async (req) => services.createShop(await readJson(req)) || { ok: true },
    "POST /api/procurement/requests": async (req) => services.createProcurementRequest(await readJson(req)) || { ok: true },
    "POST /api/procurement/purchase-orders": async (req) => services.mergeProcurementRequests(await readJson(req)),
    "POST /api/inbound-records": async (req) => services.createInboundRecord(await readJson(req)) || { ok: true },
    "POST /api/inventory/movements": async (req) => services.createInventoryMovement(await readJson(req)) || { ok: true },
    "POST /api/logistics-rules": async (req) => services.createLogisticsRule(await readJson(req)),
    "POST /api/order-cancellation-rules": async (req) => services.createOrderCancellationRule(await readJson(req)),
    "POST /api/order-cancellation-rules/test": async (req) => services.testOrderCancellationRule(await readJson(req)),
    "POST /api/stock-warehouse-rules": async (req) => services.createStockWarehouseRule(await readJson(req))
  };
}

export async function handleOperationsRestRoute({ req, res, url, parts, services, readJson, json, notFound }) {
  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-quality-rules") {
    return json(res, services.saveOrderQualityRules(await readJson(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-cancellation-rules" && parts[2]) {
    return json(res, services.updateOrderCancellationRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "order-cancellation-rules" && parts[2]) {
    return json(res, services.deleteOrderCancellationRule(Number(parts[2])));
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
