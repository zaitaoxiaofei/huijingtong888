import { apiClient, getAuthToken } from "../../utils/api";

export function getVideoGeneratorShops() {
  return apiClient.get("/api/shops", { noCache: true });
}

export function withMediaToken(url) {
  const token = getAuthToken();
  if (!token || !url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
