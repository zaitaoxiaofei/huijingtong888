import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(".env");

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=");
  }
}

export const config = {
  host: process.env.HOST || "",
  port: Number(process.env.PORT || 8787),
  databasePath: process.env.DATABASE_PATH || "./data/ozon-profit-hub.sqlite",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:8787",
  appSessionTtlHours: Number(process.env.APP_SESSION_TTL_HOURS || 72),
  siteAccessPassword: process.env.SITE_ACCESS_PASSWORD || "",
  siteAccessCookieName: process.env.SITE_ACCESS_COOKIE_NAME || "erp_site_access",
  siteAccessSessionHours: Number(process.env.SITE_ACCESS_SESSION_HOURS || 12),
  authRateLimitWindowMinutes: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES || 15),
  authRateLimitMaxAttempts: Number(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS || 8)
};
