import {
  orderProfitDetailSnapshot as orderProfitDetailSnapshotService,
  refreshOrderProfitDetailSnapshots as refreshOrderProfitDetailSnapshotsService
} from "./order-profit-detail-snapshots.js";

function runtime() {
  const value = globalThis.__ozonOrderProfitDetailSnapshotRuntime;
  if (!value) throw new Error("Order profit detail snapshot runtime is not configured");
  return value;
}

export function configureOrderProfitDetailSnapshotRuntime(value) {
  globalThis.__ozonOrderProfitDetailSnapshotRuntime = value;
}

export function refreshOrderProfitDetailSnapshots(body = {}) {
  const deps = runtime();
  return refreshOrderProfitDetailSnapshotsService({
    chinaDateSql: deps.chinaDateSql,
    db: deps.db,
    execute: deps.execute,
    get: deps.get,
    orderDetail: deps.orderDetail,
    queryAll: deps.queryAll,
    queryOne: deps.queryOne
  }, body);
}

export function orderProfitDetailSnapshot(orderId) {
  const deps = runtime();
  return orderProfitDetailSnapshotService({
    db: deps.db,
    get: deps.get,
    queryOne: deps.queryOne
  }, orderId);
}
