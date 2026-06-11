import { apiClient } from "../../utils/api";

export function listAiPromptTemplates(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    query.set(key, String(value));
  });
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return apiClient.get(`/api/ai-prompt-templates${suffix}`, { noCache: true });
}

export function createAiPromptTemplate(payload) {
  return apiClient.post("/api/ai-prompt-templates", payload);
}

export function updateAiPromptTemplate(id, payload) {
  return apiClient.put(`/api/ai-prompt-templates/${encodeURIComponent(id)}`, payload);
}

export function deleteAiPromptTemplate(id) {
  return apiClient.delete(`/api/ai-prompt-templates/${encodeURIComponent(id)}`);
}

export function duplicateAiPromptTemplate(id) {
  return apiClient.post(`/api/ai-prompt-templates/${encodeURIComponent(id)}/duplicate`, {});
}

export function setDefaultAiPromptTemplate(id) {
  return apiClient.post(`/api/ai-prompt-templates/${encodeURIComponent(id)}/set-default`, {});
}

export function renderAiPromptTemplate(payload) {
  return apiClient.post("/api/ai-prompt-templates/render", payload);
}
