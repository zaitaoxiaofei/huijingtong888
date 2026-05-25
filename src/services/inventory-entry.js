function inventoryRuntime() {
  const runtime = globalThis.__ozonInventoryRuntime;
  if (!runtime) throw new Error("Inventory runtime is not configured");
  return runtime;
}

export function configureInventoryRuntime(runtime) {
  globalThis.__ozonInventoryRuntime = runtime;
}

export function inventory() {
  return inventoryRuntime().inventoryImpl();
}

export function inboundRecords() {
  return inventoryRuntime().inboundRecordsImpl();
}

export function outboundRecords(query = {}) {
  return inventoryRuntime().outboundRecordsImpl(query);
}

export function createInboundRecord(body) {
  const runtime = inventoryRuntime();
  const result = runtime.createInboundRecordImpl(body);
  runtime.invalidateStockAlertsCacheImpl?.();
  return result;
}

export function updateInboundRecord(id, body) {
  const runtime = inventoryRuntime();
  const result = runtime.updateInboundRecordImpl(id, body);
  runtime.invalidateStockAlertsCacheImpl?.();
  return result;
}

export function deleteInboundRecord(id) {
  const runtime = inventoryRuntime();
  const result = runtime.deleteInboundRecordImpl(id);
  runtime.invalidateStockAlertsCacheImpl?.();
  return result;
}

export function createInventoryMovement(body) {
  const runtime = inventoryRuntime();
  const result = runtime.createInventoryMovementImpl(body);
  runtime.invalidateStockAlertsCacheImpl?.();
  return result;
}

export function inventoryCurrent() {
  return inventoryRuntime().inventoryCurrentImpl();
}

export function rawOzonOrders() {
  return inventoryRuntime().rawOzonOrdersImpl();
}

export function profitItems() {
  return inventoryRuntime().profitItemsImpl();
}

export function orderExceptions() {
  return inventoryRuntime().orderExceptionsImpl();
}
