function orderOpsRuntime() {
  const runtime = globalThis.__ozonOrderOpsRuntime;
  if (!runtime) throw new Error("Order ops runtime is not configured");
  return runtime;
}

export function configureOrderOpsRuntime(runtime) {
  globalThis.__ozonOrderOpsRuntime = runtime;
}

export function markOrderLabelsPrinted(body = {}, userId = null) {
  return orderOpsRuntime().markOrderLabelsPrintedImpl(body, userId);
}

export async function orderPackageLabel(body = {}, userId = null) {
  return orderOpsRuntime().orderPackageLabelImpl(body, userId);
}

export async function shipOrders(body = {}, userId = null) {
  return orderOpsRuntime().shipOrdersImpl(body, userId);
}

export function recalculateOrderProfit(orderId) {
  return orderOpsRuntime().recalculateOrderProfitImpl(orderId);
}

export function recalculateAllMappedOrderProfits() {
  return orderOpsRuntime().recalculateAllMappedOrderProfitsImpl();
}

export function recalculateHistoricalOrderProfits(body = {}) {
  return orderOpsRuntime().recalculateHistoricalOrderProfitsImpl(body);
}
