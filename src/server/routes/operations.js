import { config } from "../../config.js";
import { hashPassword } from "../../auth-password.js";
import {
  createPersonMysql,
  createShopMysql,
  createProcurementRequestMysql,
  createInboundRecordMysql,
  createInventoryMovementMysql,
  createStockWarehouseRuleMysql,
  inboundRecordsMysql,
  cancelPurchaseOrderMysql,
  confirmPurchaseOrderMysql,
  createLogisticsRuleMysql,
  createOrderCancellationRuleMysql,
  createSupplierMysql,
  deleteInboundRecordMysql,
  deletePersonMysql,
  deleteProcurementRequestMysql,
  deletePurchaseOrderMysql,
  deleteShopMysql,
  deleteStockWarehouseRuleMysql,
  deleteLogisticsRuleMysql,
  deleteOrderCancellationRuleMysql,
  deleteSupplierMysql,
  hardDeletePersonMysql,
  logisticsRulesMysql,
  outboundRecordsMysql,
  orderQualityRulesMysql,
  orderCancellationRulesMysql,
  packagingFeeRuleChangesMysql,
  packagingFeeRuleMysql,
  peopleMysql,
  pendingInboundItemsMysql,
  shopsMysql,
  mergeProcurementRequestsMysql,
  procurementRequestsMysql,
  procurementSummaryMysql,
  purchaseOrderDetailMysql,
  purchaseOrdersMysql,
  stockWarehouseRulesMysql,
  suppliersMysql,
  updatePersonMysql,
  updateInboundRecordMysql,
  updateProcurementRequestMysql,
  updatePurchaseOrderMysql,
  updateShopMysql,
  updateStockWarehouseRuleMysql,
  updateLogisticsRuleMysql,
  updateOrderCancellationRuleMysql,
  updatePackagingFeeRuleMysql,
  submitProcurementRequestsMysql,
  saveOrderQualityRulesMysql,
  updateSupplierMysql
} from "../../services/mysql-cutover.js";

export function createOperationsRoutes({ services, readJson }) {
  return {
    "GET /api/settings/packaging-fee-rule": () => config.dbClient === "mysql" ? packagingFeeRuleMysql() : services.packagingFeeRule(),
    "GET /api/settings/packaging-fee-rule/changes": (req, url) => config.dbClient === "mysql"
      ? packagingFeeRuleChangesMysql(url?.searchParams?.get("limit") || 20)
      : services.packagingFeeRuleChanges(url?.searchParams?.get("limit") || 20),
    "GET /api/logistics-rules": () => config.dbClient === "mysql" ? logisticsRulesMysql() : services.logisticsRules(),
    "GET /api/order-cancellation-rules": () => config.dbClient === "mysql" ? orderCancellationRulesMysql() : services.orderCancellationRules(),
    "GET /api/inbound-records": (req, url) => config.dbClient === "mysql"
      ? inboundRecordsMysql(Object.fromEntries(url.searchParams.entries()))
      : services.inboundRecords(Object.fromEntries(url.searchParams.entries())),
    "GET /api/outbound-records": (req, url) => config.dbClient === "mysql"
      ? outboundRecordsMysql(Object.fromEntries(url.searchParams.entries()))
      : services.outboundRecords(Object.fromEntries(url.searchParams.entries())),
    "GET /api/procurement/summary": () => config.dbClient === "mysql" ? procurementSummaryMysql() : services.procurementSummary(),
    "GET /api/procurement/requests": (req, url) => config.dbClient === "mysql"
      ? procurementRequestsMysql(Object.fromEntries(url.searchParams.entries()))
      : services.procurementRequests(Object.fromEntries(url.searchParams.entries())),
    "GET /api/procurement/purchase-orders": (req, url) => config.dbClient === "mysql"
      ? purchaseOrdersMysql(Object.fromEntries(url.searchParams.entries()))
      : services.purchaseOrders(Object.fromEntries(url.searchParams.entries())),
    "GET /api/procurement/pending-inbound": () => config.dbClient === "mysql" ? pendingInboundItemsMysql() : services.pendingInboundItems(),
    "GET /api/shops": () => config.dbClient === "mysql" ? shopsMysql() : services.shops(),
    "GET /api/people": () => config.dbClient === "mysql" ? peopleMysql() : services.people(),
    "POST /api/people": async (req) => config.dbClient === "mysql"
      ? createPersonMysql(await readJson(req), hashPassword)
      : services.createPerson(await readJson(req)) || { ok: true },
    "POST /api/shops": async (req) => config.dbClient === "mysql"
      ? createShopMysql(await readJson(req))
      : services.createShop(await readJson(req)) || { ok: true },
    "POST /api/procurement/requests": async (req) => config.dbClient === "mysql"
      ? createProcurementRequestMysql(await readJson(req))
      : services.createProcurementRequest(await readJson(req)) || { ok: true },
    "POST /api/procurement/purchase-orders": async (req) => config.dbClient === "mysql"
      ? mergeProcurementRequestsMysql(await readJson(req))
      : services.mergeProcurementRequests(await readJson(req)),
    "POST /api/inbound-records": async (req) => config.dbClient === "mysql"
      ? createInboundRecordMysql(await readJson(req))
      : services.createInboundRecord(await readJson(req)) || { ok: true },
    "POST /api/inventory/movements": async (req) => config.dbClient === "mysql"
      ? createInventoryMovementMysql(await readJson(req))
      : services.createInventoryMovement(await readJson(req)) || { ok: true },
    "POST /api/logistics-rules": async (req) => config.dbClient === "mysql"
      ? createLogisticsRuleMysql(await readJson(req))
      : services.createLogisticsRule(await readJson(req)),
    "POST /api/order-cancellation-rules": async (req) => config.dbClient === "mysql"
      ? createOrderCancellationRuleMysql(await readJson(req))
      : services.createOrderCancellationRule(await readJson(req)),
    "POST /api/order-cancellation-rules/test": async (req) => services.testOrderCancellationRule(await readJson(req)),
    "POST /api/settings/packaging-fee-rule": async (req) => config.dbClient === "mysql"
      ? updatePackagingFeeRuleMysql(await readJson(req), req._session?.personId)
      : services.updatePackagingFeeRule(await readJson(req), req._session?.personId),
    "POST /api/stock-warehouse-rules": async (req) => config.dbClient === "mysql"
      ? createStockWarehouseRuleMysql(await readJson(req))
      : services.createStockWarehouseRule(await readJson(req))
  };
}

export async function handleOperationsRestRoute({ req, res, url, parts, services, readJson, json, notFound }) {
  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-quality-rules") {
    return json(res, config.dbClient === "mysql"
      ? await saveOrderQualityRulesMysql(await readJson(req))
      : services.saveOrderQualityRules(await readJson(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-cancellation-rules" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await updateOrderCancellationRuleMysql(Number(parts[2]), await readJson(req))
      : services.updateOrderCancellationRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "order-cancellation-rules" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await deleteOrderCancellationRuleMysql(Number(parts[2]))
      : services.deleteOrderCancellationRule(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
    if (config.dbClient === "mysql") await updatePersonMysql(Number(parts[2]), await readJson(req), hashPassword);
    else services.updatePerson(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
    if (config.dbClient === "mysql") {
      if (url.searchParams.get("hard") === "1") await hardDeletePersonMysql(Number(parts[2]));
      else await deletePersonMysql(Number(parts[2]));
    } else if (url.searchParams.get("hard") === "1") services.hardDeletePerson(Number(parts[2]));
    else services.deletePerson(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
    if (config.dbClient === "mysql") await updateShopMysql(Number(parts[2]), await readJson(req));
    else services.updateShop(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
    if (config.dbClient === "mysql") await deleteShopMysql(Number(parts[2]));
    else services.deleteShop(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
    if (config.dbClient === "mysql") await updateProcurementRequestMysql(Number(parts[3]), await readJson(req));
    else services.updateProcurementRequest(Number(parts[3]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3] === "submit") {
    return json(res, config.dbClient === "mysql"
      ? await submitProcurementRequestsMysql(await readJson(req))
      : services.submitProcurementRequests(await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
    return json(res, config.dbClient === "mysql"
      ? await deleteProcurementRequestMysql(Number(parts[3]))
      : services.deleteProcurementRequest(Number(parts[3])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    const detail = config.dbClient === "mysql"
      ? await purchaseOrderDetailMysql(Number(parts[3]))
      : services.purchaseOrderDetail(Number(parts[3]));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "confirm-purchased") {
    return json(res, config.dbClient === "mysql"
      ? await confirmPurchaseOrderMysql(Number(parts[3]), await readJson(req))
      : services.confirmPurchaseOrder(Number(parts[3]), await readJson(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "cancel") {
    return json(res, config.dbClient === "mysql"
      ? await cancelPurchaseOrderMysql(Number(parts[3]))
      : services.cancelPurchaseOrder(Number(parts[3])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    if (config.dbClient === "mysql") await updatePurchaseOrderMysql(Number(parts[3]), await readJson(req));
    else services.updatePurchaseOrder(Number(parts[3]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    return json(res, config.dbClient === "mysql"
      ? await deletePurchaseOrderMysql(Number(parts[3]))
      : services.deletePurchaseOrder(Number(parts[3])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
    if (config.dbClient === "mysql") await updateInboundRecordMysql(Number(parts[2]), await readJson(req));
    else services.updateInboundRecord(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await deleteInboundRecordMysql(Number(parts[2]))
      : services.deleteInboundRecord(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
    return json(res, config.dbClient === "mysql" ? await suppliersMysql(req.query || {}) : services.suppliers(req.query || {}));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await createSupplierMysql(await readJson(req))
      : services.createSupplier(await readJson(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
    if (config.dbClient === "mysql") await updateSupplierMysql(Number(parts[2]), await readJson(req));
    else services.updateSupplier(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await deleteSupplierMysql(Number(parts[2]))
      : services.deleteSupplier(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "logistics-rules" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await updateLogisticsRuleMysql(Number(parts[2]), await readJson(req))
      : services.updateLogisticsRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "logistics-rules" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await deleteLogisticsRuleMysql(Number(parts[2]))
      : services.deleteLogisticsRule(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await updateStockWarehouseRuleMysql(Number(parts[2]), await readJson(req))
      : services.updateStockWarehouseRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await deleteStockWarehouseRuleMysql(Number(parts[2]))
      : services.deleteStockWarehouseRule(Number(parts[2])));
  }

  return false;
}
