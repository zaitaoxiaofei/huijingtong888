import { apiClient } from "../../admin/utils/api.js";

function navigateTo(path, query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const suffix = params.toString() ? `?${params.toString()}` : "";
  window.location.hash = `#${path}${suffix}`;
  return { ok: true, path, query };
}

export async function submitOrderFilters(filters) {
  return filters;
}

export async function changeOrderStatus(status) {
  return status;
}

export async function changeOrderPrintView(view) {
  return view;
}

export async function changeOrderMarkFilter(value) {
  return value;
}

export async function changeOrderPageSize(pageSize) {
  return pageSize;
}

export async function prevOrderPage() {
  return "prev";
}

export async function nextOrderPage() {
  return "next";
}

export async function syncRecentOrders() {
  return apiClient.post("/api/sync/ozon/incremental", {});
}

export async function syncAllOrders() {
  return apiClient.post("/api/sync/ozon", {});
}

export async function cancelOrderSync() {
  throw new Error("订单同步取消接口尚未接入");
}

export async function openQualityRules() {
  return apiClient.get("/api/order-quality-rules");
}

export async function saveQualityRules(payload = {}) {
  return apiClient.put("/api/order-quality-rules", payload);
}

export async function resetRecentDates() {
  return "reset";
}

export async function bulkPrintOrders(orderIds = []) {
  const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return null;
  const response = await fetch("/api/orders/package-label", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_ids: ids })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  await apiClient.post("/api/orders/package-label-printed", { order_ids: ids });
  return { ok: true, count: ids.length };
}

export async function bulkPrepareOrders(orderIds = []) {
  const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return null;
  return apiClient.post("/api/orders/ship", { order_ids: ids });
}

export async function handleMoreOrderAction(action) {
  throw new Error(`更多操作暂未接入：${action}`);
}

export async function openOrderProfit(orderId) {
  return fetchOrderDetail(orderId);
}

export async function fetchOrderDetail(orderId) {
  return apiClient.get(`/api/orders/${orderId}`);
}

export async function prepareSingleOrder(orderId) {
  return bulkPrepareOrders([orderId]);
}

export async function printSingleOrder(orderId) {
  return bulkPrintOrders([orderId]);
}

export async function recalculateOrderProfit(orderId) {
  return apiClient.post(`/api/orders/${orderId}/recalculate-profit`, {});
}

export async function saveOrderMark(orderId, markType) {
  return apiClient.put(`/api/orders/${orderId}/mark`, { mark_type: markType });
}

export async function openBindProduct(onlineId) {
  return navigateTo("/online-products", { onlineProductId: onlineId, action: "bind" });
}

export async function openBindProductFromOrder(orderId, sku) {
  return navigateTo("/orders", { orderId, sku, action: "bind" });
}

export async function openCreateProduct(onlineId, orderId, sku) {
  return navigateTo("/selection", { onlineProductId: onlineId, orderId, sku, action: "create" });
}

export async function openCreateProductFromOrder(orderId, sku) {
  return navigateTo("/selection", { orderId, sku, action: "create" });
}

export async function jumpToStockProduct(productId) {
  return navigateTo("/inventory/products", { productId });
}

export async function openProcurement(productId) {
  return navigateTo("/procurement", { productId });
}
