export function createOperationsRoutes({ services, readJson }) {
  return {
    "GET /api/settings/packaging-fee-rule": () => services.packagingFeeRule(),
    "GET /api/settings/packaging-fee-rule/changes": (req, url) => services.packagingFeeRuleChanges(url?.searchParams?.get("limit") || 20),
    "GET /api/logistics-rules": () => services.logisticsRules(),
    "GET /api/order-cancellation-rules": () => services.orderCancellationRules(),
    "GET /api/inbound-records": (req, url) => services.inboundRecords(Object.fromEntries(url.searchParams.entries())),
    "GET /api/outbound-records": (req, url) => services.outboundRecords(Object.fromEntries(url.searchParams.entries())),
    "GET /api/fbp-transfer-records": (req, url) => services.fbpTransferRecords(Object.fromEntries(url.searchParams.entries())),
    "GET /api/procurement/summary": () => services.procurementSummary(),
    "GET /api/procurement/requests": (req, url) => services.procurementRequests(Object.fromEntries(url.searchParams.entries())),
    "GET /api/procurement/purchase-orders": (req, url) => services.purchaseOrders(Object.fromEntries(url.searchParams.entries())),
    "GET /api/procurement/cost-versions": (req, url) => services.purchaseCostVersions(Object.fromEntries(url.searchParams.entries())),
    "GET /api/procurement/cost-versions/backfill-preview": () => services.previewPurchaseCostBackfill(),
    "GET /api/procurement/pending-inbound": () => services.pendingInboundItems(),
    "GET /api/customer-messages": (req, url) => services.customerMessages(Object.fromEntries(url.searchParams.entries())),
    "GET /api/customer-chats": (req, url) => services.customerChatThreads(Object.fromEntries(url.searchParams.entries())),
    "GET /api/customer-chats/messages": (req, url) => services.customerChatThreadMessages(Object.fromEntries(url.searchParams.entries())),
    "GET /api/customer-message-customer-orders": (req, url) => services.customerMessageCustomerOrders(Object.fromEntries(url.searchParams.entries())),
    "GET /api/customer-message-settings": () => services.customerMessageSettings(),
    "GET /api/user-preferences": (req, url) => services.userPreference(Object.fromEntries(url.searchParams.entries()), req._session?.personId),
    "GET /api/shops": () => services.shops(),
    "GET /api/people": () => services.people(),
    "POST /api/people": async (req) => services.createPerson(await readJson(req)) || { ok: true },
    "POST /api/shops": async (req) => services.createShop(await readJson(req)) || { ok: true },
    "POST /api/procurement/requests": async (req) => services.createProcurementRequest(await readJson(req)) || { ok: true },
    "POST /api/procurement/purchase-orders/confirm-from-requests-async": async (req) => services.startConfirmProcurementRequestsPurchased(await readJson(req)),
    "POST /api/procurement/purchase-orders": async (req) => services.mergeProcurementRequests(await readJson(req)),
    "POST /api/procurement/cost-versions/backfill": async (req) => services.initializePurchaseCostBackfill(await readJson(req), req._session?.personId),
    "POST /api/inbound-records": async (req) => services.createInboundRecord(await readJson(req)) || { ok: true },
    "POST /api/fbp-transfer-records": async (req) => services.createFbpTransferRecord(await readJson(req), req._session?.personId) || { ok: true },
    "POST /api/inbound-records/batch-update-async": async (req) => services.startBatchUpdateInboundRecords(await readJson(req)),
    "POST /api/inbound-records/batch-update": async (req) => services.batchUpdateInboundRecords(await readJson(req)),
    "POST /api/inventory/movements": async (req) => services.createInventoryMovement(await readJson(req), req._session?.personId) || { ok: true },
    "GET /api/inventory/stock-debts": (req, url) => services.inventoryStockDebts(Object.fromEntries(url.searchParams.entries())),
    "POST /api/inventory/stock-debts/adjust": async (req) => services.adjustInventoryStockDebt(await readJson(req), req._session?.personId),
    "POST /api/customer-messages/preview": async (req) => services.previewCustomerMessage(await readJson(req)),
    "POST /api/customer-message-settings/template/test": async (req) => services.testCustomerMessageTemplate(await readJson(req)),
    "POST /api/customer-messages/record": async (req) => services.recordCustomerMessage(await readJson(req)),
    "POST /api/customer-messages/send": async (req) => services.sendCustomerMessage(await readJson(req)),
    "POST /api/customer-messages/manual-test-send": async (req) => services.sendCustomerMessageManualTest(await readJson(req)),
    "POST /api/customer-messages/retry": async (req) => services.retryCustomerMessageTask(await readJson(req)),
    "POST /api/customer-messages/translate-ru": async (req) => services.translateCustomerMessageRu(await readJson(req)),
    "POST /api/customer-chats/sync": async (req) => services.syncCustomerChats(await readJson(req)),
    "POST /api/customer-message-settings/shop/check-capability": async (req) => services.checkCustomerMessageShopCapability(await readJson(req)),
    "POST /api/customer-message-settings/shop": async (req) => services.updateCustomerMessageShopSetting(await readJson(req)),
    "POST /api/customer-message-settings/template": async (req) => services.updateCustomerMessageTemplate(await readJson(req)),
    "POST /api/customer-message-settings/template/translate-zh": async (req) => services.translateCustomerMessageTemplateZh(await readJson(req)),
    "POST /api/user-preferences": async (req) => services.updateUserPreference(await readJson(req), req._session?.personId),
    "POST /api/logistics-rules": async (req) => services.createLogisticsRule(await readJson(req)),
    "POST /api/order-cancellation-rules": async (req) => services.createOrderCancellationRule(await readJson(req)),
    "POST /api/order-cancellation-rules/test": async (req) => services.testOrderCancellationRule(await readJson(req)),
    "POST /api/settings/packaging-fee-rule": async (req) => services.updatePackagingFeeRule(await readJson(req), req._session?.personId),
    "POST /api/stock-warehouse-rules": async (req) => services.createStockWarehouseRule(await readJson(req))
  };
}

export async function handleOperationsRestRoute({ req, res, url, parts, services, readJson, json, notFound }) {
  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "customer-message-settings" && parts[2] === "template" && parts[3]) {
    return json(res, await services.deleteCustomerMessageTemplate(decodeURIComponent(parts[3])));
  }
  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-quality-rules") {
    return json(res, await services.saveOrderQualityRules(await readJson(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-cancellation-rules" && parts[2]) {
    return json(res, await services.updateOrderCancellationRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "order-cancellation-rules" && parts[2]) {
    return json(res, await services.deleteOrderCancellationRule(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
    await services.updatePerson(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inventory" && parts[2] === "movements" && parts[3]) {
    return json(res, await services.updateInventoryMovement(Number(parts[3]), await readJson(req), req._session?.personId));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inventory" && parts[2] === "movements" && parts[3]) {
    return json(res, await services.deleteInventoryMovement(Number(parts[3]), req._session?.personId));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
    if (url.searchParams.get("hard") === "1") await services.hardDeletePerson(Number(parts[2]));
    else await services.deletePerson(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
    await services.updateShop(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
    await services.deleteShop(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
    await services.updateProcurementRequest(Number(parts[3]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3] === "submit") {
    return json(res, await services.submitProcurementRequests(await readJson(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3] === "direct-inbound") {
    return json(res, await services.directInboundProcurementRequests(await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
    return json(res, await services.deleteProcurementRequest(Number(parts[3])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    const detail = await services.purchaseOrderDetail(Number(parts[3]));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "confirm-purchased") {
    return json(res, await services.confirmPurchaseOrder(Number(parts[3]), await readJson(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "cost-versions" && parts[3] && parts[4] === "review") {
    return json(res, await services.reviewPurchaseCostVersion(Number(parts[3]), await readJson(req), req._session?.personId));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "cancel") {
    return json(res, await services.cancelPurchaseOrder(Number(parts[3])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    await services.updatePurchaseOrder(Number(parts[3]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    return json(res, await services.deletePurchaseOrder(Number(parts[3])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
    await services.updateInboundRecord(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
    return json(res, await services.deleteInboundRecord(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
    return json(res, await services.suppliers(Object.fromEntries(url.searchParams.entries())));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
    return json(res, await services.createSupplier(await readJson(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
    await services.updateSupplier(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
    return json(res, await services.deleteSupplier(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "logistics-rules" && parts[2]) {
    return json(res, await services.updateLogisticsRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "logistics-rules" && parts[2]) {
    return json(res, await services.deleteLogisticsRule(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
    return json(res, await services.updateStockWarehouseRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
    return json(res, await services.deleteStockWarehouseRule(Number(parts[2])));
  }

  return false;
}
