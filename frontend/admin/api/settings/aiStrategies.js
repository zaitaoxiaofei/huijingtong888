import { apiClient } from "../../utils/api";

export function listAiStrategies(params = {}) {
  return apiClient.get("/api/ai-strategies", { ...params, noCache: true });
}

export function createAiStrategy(payload) {
  return apiClient.post("/api/ai-strategies", payload);
}

export function updateAiStrategy(id, payload) {
  return apiClient.put(`/api/ai-strategies/${encodeURIComponent(id)}`, payload);
}

export function deleteAiStrategy(id) {
  return apiClient.delete(`/api/ai-strategies/${encodeURIComponent(id)}`);
}

export function listAiStrategyLayerRules(params = {}) {
  return apiClient.get("/api/ai-strategy-layer-rules", { ...params, noCache: true });
}

export function listAiStrategyCategoryNodes(params = {}) {
  return apiClient.get("/api/ai-strategy-category-nodes", { ...params, noCache: true });
}

export function createAiStrategyCategoryNode(payload) {
  return apiClient.post("/api/ai-strategy-category-nodes", payload);
}

export function updateAiStrategyCategoryNode(id, payload) {
  return apiClient.put(`/api/ai-strategy-category-nodes/${encodeURIComponent(id)}`, payload);
}

export function listAiStrategyBundles(params = {}) {
  return apiClient.get("/api/ai-strategy-bundles", { ...params, noCache: true });
}

export function createAiStrategyBundle(payload) {
  return apiClient.post("/api/ai-strategy-bundles", payload);
}

export function updateAiStrategyBundle(id, payload) {
  return apiClient.put(`/api/ai-strategy-bundles/${encodeURIComponent(id)}`, payload);
}

export function matchAiStrategyBundles(payload) {
  return apiClient.post("/api/ai-strategy-bundles/match", payload);
}

export function createAiStrategyLayerRule(payload) {
  return apiClient.post("/api/ai-strategy-layer-rules", payload);
}

export function updateAiStrategyLayerRule(id, payload) {
  return apiClient.put(`/api/ai-strategy-layer-rules/${encodeURIComponent(id)}`, payload);
}

export function resolveAiStrategyPlan(payload) {
  return apiClient.post("/api/ai-strategies/resolve", payload);
}
