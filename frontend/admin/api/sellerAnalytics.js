import { apiClient } from "../utils/api";

function queryString(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function getSellerAnalyticsAnalysis(params = {}) {
  return apiClient.get(`/api/db/seller-analytics/analysis${queryString(params)}`, { noCache: true });
}

export function getSellerAnalyticsSnapshots(params = {}) {
  return apiClient.get(`/api/db/seller-analytics/snapshots${queryString(params)}`, { noCache: true });
}

export function getSellerAnalyticsCollectRuns(params = {}) {
  return apiClient.get(`/api/db/seller-analytics/collect-runs${queryString(params)}`, { noCache: true });
}

export function getSellerAnalyticsOperationTodos(params = {}) {
  return apiClient.get(`/api/db/seller-analytics/operation-todos${queryString(params)}`, { noCache: true });
}

export function getSellerAnalyticsPluginStatus(params = {}) {
  return apiClient.get(`/api/db/seller-analytics/plugin-status${queryString(params)}`, { noCache: true });
}

export function getSellerAnalyticsAuthBindingStatus(params = {}) {
  return apiClient.get(`/api/db/seller-analytics/auth-binding${queryString(params)}`, { noCache: true });
}

export function getSellerAnalyticsBrowserProfileStatus(params = {}) {
  return apiClient.get(`/api/db/seller-analytics/browser-profile${queryString(params)}`, { noCache: true });
}

export function prepareSellerAnalyticsBrowserProfile(payload = {}) {
  return apiClient.post("/api/db/seller-analytics/browser-profile/prepare", payload);
}

export function confirmSellerAnalyticsBrowserProfile(payload = {}) {
  return apiClient.post("/api/db/seller-analytics/browser-profile/confirm", payload);
}

export function validateSellerAnalyticsPluginStatus(params = {}) {
  return apiClient.get(`/api/db/seller-analytics/plugin-status/validate${queryString(params)}`, { noCache: true });
}

export function prepareSellerAnalyticsPlugin(payload = {}) {
  return apiClient.post("/api/db/seller-analytics/plugin-prepare", payload);
}

export function createSellerAnalyticsCollectRun(payload = {}) {
  return apiClient.post("/api/db/seller-analytics/collect-runs", payload);
}

export function startSellerAnalyticsDirectCollect(payload = {}) {
  return apiClient.post("/api/db/seller-analytics/direct-collect/start", payload);
}

export function refreshSellerAnalyticsOperationTodos(payload = {}) {
  return apiClient.post("/api/db/seller-analytics/operation-todos/refresh", payload);
}

export function retrySellerAnalyticsCollectRun(id) {
  return apiClient.post(`/api/db/seller-analytics/collect-runs/${encodeURIComponent(id)}/retry`);
}

export function deleteSellerAnalyticsCollectRun(id) {
  return apiClient.delete(`/api/db/seller-analytics/collect-runs/${encodeURIComponent(id)}`);
}

export function deleteSellerAnalyticsSnapshot(id) {
  return apiClient.delete(`/api/db/seller-analytics/snapshots/${encodeURIComponent(id)}`);
}

export function batchDeleteSellerAnalyticsSnapshots(ids = []) {
  return apiClient.post("/api/db/seller-analytics/snapshots/batch-delete", { ids });
}
