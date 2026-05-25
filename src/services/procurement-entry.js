function procurementRuntime() {
  const runtime = globalThis.__ozonProcurementRuntime;
  if (!runtime) throw new Error("Procurement runtime is not configured");
  return runtime;
}

export function configureProcurementRuntime(runtime) {
  globalThis.__ozonProcurementRuntime = runtime;
}

export function procurementSummary() {
  return procurementRuntime().procurementSummaryImpl();
}

export function procurementRequests() {
  return procurementRuntime().procurementRequestsImpl();
}

export function purchaseOrders() {
  return procurementRuntime().purchaseOrdersImpl();
}

export function purchaseOrderDetail(id) {
  return procurementRuntime().purchaseOrderDetailImpl(id);
}

export function pendingInboundItems() {
  return procurementRuntime().pendingInboundItemsImpl();
}

export function createProcurementRequest(body) {
  return procurementRuntime().createProcurementRequestImpl(body);
}

export function updateProcurementRequest(id, body) {
  return procurementRuntime().updateProcurementRequestImpl(id, body);
}

export function submitProcurementRequests(body = {}) {
  return procurementRuntime().submitProcurementRequestsImpl(body);
}

export function deleteProcurementRequest(id) {
  return procurementRuntime().deleteProcurementRequestImpl(id);
}

export function mergeProcurementRequests(body) {
  return procurementRuntime().mergeProcurementRequestsImpl(body);
}

export function confirmPurchaseOrder(id, body = {}) {
  return procurementRuntime().confirmPurchaseOrderImpl(id, body);
}

export function cancelPurchaseOrder(id) {
  return procurementRuntime().cancelPurchaseOrderImpl(id);
}

export function updatePurchaseOrder(id, body) {
  return procurementRuntime().updatePurchaseOrderImpl(id, body);
}

export function deletePurchaseOrder(id) {
  return procurementRuntime().deletePurchaseOrderImpl(id);
}
