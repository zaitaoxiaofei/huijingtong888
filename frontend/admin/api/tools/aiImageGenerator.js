import { apiClient, getAuthToken } from "../../utils/api";

export function getAiStatus() {
  return apiClient.get("/api/ai/status");
}

export function generateAiImages(payload) {
  return apiClient.post("/api/ai/generate-images", payload);
}

export function generateAiWorkflow(payload) {
  return apiClient.post("/api/ai/generate-workflow", payload);
}

export function optimizeAiPrompt(payload) {
  return apiClient.post("/api/ai/optimize-prompt", payload);
}

export function withImageToken(url) {
  const token = getAuthToken();
  if (!token || !url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function downloadUrl(url) {
  return withImageToken(url);
}
