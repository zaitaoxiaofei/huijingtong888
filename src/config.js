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

function readNumberEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isFinite(value)) return value;
  throw new Error(`Invalid numeric environment variable: ${key}=${raw}`);
}

function normalizeDbClient(rawValue) {
  const normalized = String(rawValue || "mysql").trim().toLowerCase();
  if (normalized === "mysql") return normalized;
  throw new Error(`Unsupported DB_CLIENT: ${rawValue}`);
}

function buildDbConfig() {
  const client = normalizeDbClient(process.env.DB_CLIENT || "mysql");
  const mysqlHost = process.env.DB_HOST || "";
  const mysqlPort = readNumberEnv("DB_PORT", 3306);
  const mysqlName = process.env.DB_NAME || "";
  const mysqlUser = process.env.DB_USER || "";
  const mysqlPassword = process.env.DB_PASSWORD || "";
  const poolMin = readNumberEnv("DB_POOL_MIN", 0);
  const poolMax = readNumberEnv("DB_POOL_MAX", 10);

  if (poolMin < 0) {
    throw new Error(`DB_POOL_MIN must be >= 0, received ${poolMin}`);
  }

  if (poolMax < 1) {
    throw new Error(`DB_POOL_MAX must be >= 1, received ${poolMax}`);
  }

  if (poolMin > poolMax) {
    throw new Error(`DB_POOL_MIN must be <= DB_POOL_MAX, received ${poolMin} > ${poolMax}`);
  }

  const missingKeys = [];
  if (!mysqlHost) missingKeys.push("DB_HOST");
  if (!mysqlName) missingKeys.push("DB_NAME");
  if (!mysqlUser) missingKeys.push("DB_USER");
  if (missingKeys.length) {
    throw new Error(`Missing required MySQL environment variables: ${missingKeys.join(", ")}`);
  }

  return {
    client,
    host: mysqlHost,
    port: mysqlPort,
    name: mysqlName,
    user: mysqlUser,
    password: mysqlPassword,
    poolMin,
    poolMax
  };
}

const dbConfig = buildDbConfig();

export const config = {
  host: process.env.HOST || "",
  port: readNumberEnv("PORT", 8787),
  dbClient: dbConfig.client,
  dbHost: dbConfig.host,
  dbPort: dbConfig.port,
  dbName: dbConfig.name,
  dbUser: dbConfig.user,
  dbPassword: dbConfig.password,
  dbPoolMin: dbConfig.poolMin,
  dbPoolMax: dbConfig.poolMax,
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:8787",
  listingMediaPublicBaseUrl: process.env.LISTING_MEDIA_PUBLIC_BASE_URL || process.env.PUBLIC_MEDIA_BASE_URL || "",
  appSessionTtlHours: readNumberEnv("APP_SESSION_TTL_HOURS", 72),
  siteAccessPassword: process.env.SITE_ACCESS_PASSWORD || "",
  siteAccessCookieName: process.env.SITE_ACCESS_COOKIE_NAME || "erp_site_access",
  siteAccessSessionHours: readNumberEnv("SITE_ACCESS_SESSION_HOURS", 12),
  authRateLimitWindowMinutes: readNumberEnv("AUTH_RATE_LIMIT_WINDOW_MINUTES", 15),
  authRateLimitMaxAttempts: readNumberEnv("AUTH_RATE_LIMIT_MAX_ATTEMPTS", 8),
  backgroundOrderSyncIntervalMinutes: readNumberEnv("BACKGROUND_ORDER_SYNC_INTERVAL_MINUTES", 60),
  backgroundOrderSyncInitialDelaySeconds: readNumberEnv("BACKGROUND_ORDER_SYNC_INITIAL_DELAY_SECONDS", 180),
  backgroundOrderSyncDays: readNumberEnv("BACKGROUND_ORDER_SYNC_DAYS", 90),
  backgroundAnalyticsRefreshIntervalMinutes: readNumberEnv("BACKGROUND_ANALYTICS_REFRESH_INTERVAL_MINUTES", 60),
  backgroundAnalyticsRefreshInitialDelaySeconds: readNumberEnv("BACKGROUND_ANALYTICS_REFRESH_INITIAL_DELAY_SECONDS", 30),
  backgroundAdvertisingSyncIntervalMinutes: readNumberEnv("BACKGROUND_ADVERTISING_SYNC_INTERVAL_MINUTES", 60),
  backgroundAdvertisingSyncInitialDelaySeconds: readNumberEnv("BACKGROUND_ADVERTISING_SYNC_INITIAL_DELAY_SECONDS", 300),
  backgroundAdvertisingSyncDays: readNumberEnv("BACKGROUND_ADVERTISING_SYNC_DAYS", 14),
  backgroundOzonCategorySyncEnabled: String(process.env.BACKGROUND_OZON_CATEGORY_SYNC_ENABLED || "true").toLowerCase() !== "false",
  backgroundOzonCategorySyncHour: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_HOUR", 1),
  backgroundOzonCategorySyncMinute: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_MINUTE", 10),
  backgroundOzonCategorySyncCheckMinutes: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_CHECK_MINUTES", 10),
  backgroundOzonCategorySyncCategoryLimit: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_CATEGORY_LIMIT", 120),
  backgroundOzonCategorySyncValueLimit: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_VALUE_LIMIT", 200)
};
