import { apiClient } from "../utils/api";

export function listMaterialAssets(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return apiClient.get(`/api/material-assets${suffix}`, { noCache: true });
}

export function createMaterialAsset(payload) {
  return apiClient.post("/api/material-assets", payload);
}

export function updateMaterialAsset(id, payload) {
  return apiClient.put(`/api/material-assets/${encodeURIComponent(id)}`, payload);
}

export function archiveMaterialAsset(id) {
  return apiClient.post(`/api/material-assets/${encodeURIComponent(id)}/archive`, {});
}
