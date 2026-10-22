import { apiClient } from "../utils/api";

export function getMembership() {
  return apiClient.get("/api/auth/membership", { routeScoped: false, noCache: true });
}

export function activateMembership(code) {
  return apiClient.post("/api/auth/activate", { activation_code: String(code || "").trim() });
}
