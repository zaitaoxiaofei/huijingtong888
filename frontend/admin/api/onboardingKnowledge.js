import { apiClient } from "../utils/api";

export const listOnboardingArticles = (query = {}) => {
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value));
  return apiClient.get(`/api/onboarding/articles${params.size ? `?${params}` : ""}`, { noCache: true });
};

export const saveOnboardingArticle = (payload) => apiClient.post("/api/onboarding/articles", payload);
export const getOnboardingArticleHistory = (id) => apiClient.get(`/api/onboarding/articles/${id}/history`, { noCache: true });
