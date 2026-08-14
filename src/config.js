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
  const poolQueueLimit = readNumberEnv("DB_POOL_QUEUE_LIMIT", 100);
  const poolAcquireTimeoutMs = readNumberEnv("DB_POOL_ACQUIRE_TIMEOUT_MS", 10000);

  if (poolMin < 0) {
    throw new Error(`DB_POOL_MIN must be >= 0, received ${poolMin}`);
  }

  if (poolMax < 1) {
    throw new Error(`DB_POOL_MAX must be >= 1, received ${poolMax}`);
  }

  if (poolQueueLimit < 0) {
    throw new Error(`DB_POOL_QUEUE_LIMIT must be >= 0, received ${poolQueueLimit}`);
  }

  if (poolAcquireTimeoutMs < 1000) {
    throw new Error(`DB_POOL_ACQUIRE_TIMEOUT_MS must be >= 1000, received ${poolAcquireTimeoutMs}`);
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
    poolMax,
    poolQueueLimit,
    poolAcquireTimeoutMs
  };
}

function readBooleanEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function readEnumEnv(key, allowedValues, fallback) {
  const raw = String(process.env[key] || fallback).trim().toLowerCase();
  if (allowedValues.includes(raw)) return raw;
  throw new Error(`Invalid environment variable: ${key}=${process.env[key]}`);
}

const dbConfig = buildDbConfig();

export const config = {
  host: process.env.HOST || "",
  port: readNumberEnv("PORT", 8788),
  dbClient: dbConfig.client,
  dbHost: dbConfig.host,
  dbPort: dbConfig.port,
  dbName: dbConfig.name,
  dbUser: dbConfig.user,
  dbPassword: dbConfig.password,
  dbPoolMin: dbConfig.poolMin,
  dbPoolMax: dbConfig.poolMax,
  dbPoolQueueLimit: dbConfig.poolQueueLimit,
  dbPoolAcquireTimeoutMs: dbConfig.poolAcquireTimeoutMs,
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:8788",
  localPluginSharedSecret: process.env.LOCAL_PLUGIN_SHARED_SECRET || "",
  localPluginPublicToken: process.env.LOCAL_PLUGIN_PUBLIC_TOKEN || "",
  listingMediaPublicBaseUrl: process.env.LISTING_MEDIA_PUBLIC_BASE_URL || process.env.PUBLIC_MEDIA_BASE_URL || "",
  listingMediaOptimizeImages: process.env.LISTING_MEDIA_OPTIMIZE_IMAGES !== "0",
  listingMediaImageMaxBytes: readNumberEnv("LISTING_MEDIA_IMAGE_MAX_BYTES", 2 * 1024 * 1024),
  listingMediaImageMaxDimension: readNumberEnv("LISTING_MEDIA_IMAGE_MAX_DIMENSION", 1800),
  listingMediaImageQuality: readNumberEnv("LISTING_MEDIA_IMAGE_QUALITY", 86),
  listingPublishDraftConcurrency: readNumberEnv("LISTING_PUBLISH_DRAFT_CONCURRENCY", 2),
  listingPublishShopConcurrency: readNumberEnv("LISTING_PUBLISH_SHOP_CONCURRENCY", 2),
  listingPublishBackgroundConcurrency: readNumberEnv("LISTING_PUBLISH_BACKGROUND_CONCURRENCY", 4),
  listingPublishMediaCheckConcurrency: readNumberEnv("LISTING_PUBLISH_MEDIA_CHECK_CONCURRENCY", 4),
  listingPublishMediaPrewarmLimit: readNumberEnv("LISTING_PUBLISH_MEDIA_PREWARM_LIMIT", 50),
  listingMediaPublicSyncTimeoutMs: readNumberEnv("LISTING_MEDIA_PUBLIC_SYNC_TIMEOUT_MS", 60000),
  listingMediaPublicSyncAttempts: readNumberEnv("LISTING_MEDIA_PUBLIC_SYNC_ATTEMPTS", 3),
  listingMediaReachabilityCacheTtlMs: readNumberEnv("LISTING_MEDIA_REACHABILITY_CACHE_TTL_MS", 30 * 60 * 1000),
  appSessionTtlHours: readNumberEnv("APP_SESSION_TTL_HOURS", 72),
  siteAccessPassword: process.env.SITE_ACCESS_PASSWORD || "",
  siteAccessCookieName: process.env.SITE_ACCESS_COOKIE_NAME || "erp_site_access",
  siteAccessSessionHours: readNumberEnv("SITE_ACCESS_SESSION_HOURS", 720),
  wechatLoginAppId: process.env.WECHAT_LOGIN_APP_ID || "",
  wechatLoginAppSecret: process.env.WECHAT_LOGIN_APP_SECRET || "",
  wechatLoginRedirectUri: process.env.WECHAT_LOGIN_REDIRECT_URI || "",
  authRateLimitWindowMinutes: readNumberEnv("AUTH_RATE_LIMIT_WINDOW_MINUTES", 15),
  authRateLimitMaxAttempts: readNumberEnv("AUTH_RATE_LIMIT_MAX_ATTEMPTS", 8),
  httpJsonBodyLimitBytes: readNumberEnv("HTTP_JSON_BODY_LIMIT_BYTES", 25 * 1024 * 1024),
  httpFormBodyLimitBytes: readNumberEnv("HTTP_FORM_BODY_LIMIT_BYTES", 1024 * 1024),
  scheduledJobsEnabled: readBooleanEnv("SCHEDULED_JOBS_ENABLED", Number(process.env.PORT || 8788) === 8788),
  scheduledJobsMaxConcurrent: readNumberEnv("SCHEDULED_JOBS_MAX_CONCURRENT", 5),
  backgroundTaskForegroundIdleSeconds: readNumberEnv("BACKGROUND_TASK_FOREGROUND_IDLE_SECONDS", 20),
  orderHistoryDedupeMode: readEnumEnv("ORDER_HISTORY_DEDUPE_MODE", ["off", "shadow", "enabled"], "off"),
  backgroundCriticalJobMaxDeferralSeconds: readNumberEnv("BACKGROUND_CRITICAL_JOB_MAX_DEFERRAL_SECONDS", 300),
  backgroundOrderSyncIntervalMinutes: readNumberEnv("BACKGROUND_ORDER_SYNC_INTERVAL_MINUTES", 10),
  backgroundOrderSyncInitialDelaySeconds: readNumberEnv("BACKGROUND_ORDER_SYNC_INITIAL_DELAY_SECONDS", 180),
  backgroundOrderSyncDays: readNumberEnv("BACKGROUND_ORDER_SYNC_DAYS", 14),
  backgroundCancelledOrderSyncIntervalMinutes: readNumberEnv("BACKGROUND_CANCELLED_ORDER_SYNC_INTERVAL_MINUTES", 60),
  backgroundCancelledOrderSyncInitialDelaySeconds: readNumberEnv("BACKGROUND_CANCELLED_ORDER_SYNC_INITIAL_DELAY_SECONDS", 360),
  backgroundCancelledOrderSyncDays: readNumberEnv("BACKGROUND_CANCELLED_ORDER_SYNC_DAYS", 30),
  backgroundPostingDetailSyncIntervalMinutes: readNumberEnv("BACKGROUND_POSTING_DETAIL_SYNC_INTERVAL_MINUTES", 60),
  backgroundPostingDetailSyncInitialDelaySeconds: readNumberEnv("BACKGROUND_POSTING_DETAIL_SYNC_INITIAL_DELAY_SECONDS", 600),
  backgroundPostingDetailSyncDays: readNumberEnv("BACKGROUND_POSTING_DETAIL_SYNC_DAYS", 30),
  backgroundPostingDetailReconciliationDays: readNumberEnv("BACKGROUND_POSTING_DETAIL_RECONCILIATION_DAYS", 2),
  backgroundPostingDetailSyncLimit: readNumberEnv("BACKGROUND_POSTING_DETAIL_SYNC_LIMIT", 200),
  backgroundPostingDetailSyncConcurrency: readNumberEnv("BACKGROUND_POSTING_DETAIL_SYNC_CONCURRENCY", 2),
  backgroundPostingDetailDeepSyncHour: readNumberEnv("BACKGROUND_POSTING_DETAIL_DEEP_SYNC_HOUR", 2),
  backgroundPostingDetailDeepSyncMinute: readNumberEnv("BACKGROUND_POSTING_DETAIL_DEEP_SYNC_MINUTE", 30),
  backgroundPostingDetailDeepSyncDays: readNumberEnv("BACKGROUND_POSTING_DETAIL_DEEP_SYNC_DAYS", 90),
  backgroundPostingDetailDeepSyncLimit: readNumberEnv("BACKGROUND_POSTING_DETAIL_DEEP_SYNC_LIMIT", 1000),
  backgroundAnalyticsRefreshIntervalMinutes: readNumberEnv("BACKGROUND_ANALYTICS_REFRESH_INTERVAL_MINUTES", 60),
  backgroundAnalyticsRefreshInitialDelaySeconds: readNumberEnv("BACKGROUND_ANALYTICS_REFRESH_INITIAL_DELAY_SECONDS", 30),
  backgroundDashboardSnapshotIntervalMinutes: readNumberEnv("BACKGROUND_DASHBOARD_SNAPSHOT_INTERVAL_MINUTES", 3),
  backgroundDashboardSnapshotInitialDelaySeconds: readNumberEnv("BACKGROUND_DASHBOARD_SNAPSHOT_INITIAL_DELAY_SECONDS", 20),
  backgroundAdvertisingSyncIntervalMinutes: readNumberEnv("BACKGROUND_ADVERTISING_SYNC_INTERVAL_MINUTES", 15),
  backgroundAdvertisingSyncInitialDelaySeconds: readNumberEnv("BACKGROUND_ADVERTISING_SYNC_INITIAL_DELAY_SECONDS", 300),
  backgroundAdvertisingSyncDays: readNumberEnv("BACKGROUND_ADVERTISING_SYNC_DAYS", 14),
  backgroundAdvertisingSyncTimeoutMinutes: readNumberEnv("BACKGROUND_ADVERTISING_SYNC_TIMEOUT_MINUTES", 12),
  backgroundAdvertisingTodaySyncIntervalMinutes: readNumberEnv("BACKGROUND_ADVERTISING_TODAY_SYNC_INTERVAL_MINUTES", 15),
  backgroundAdvertisingTodaySyncInitialDelaySeconds: readNumberEnv("BACKGROUND_ADVERTISING_TODAY_SYNC_INITIAL_DELAY_SECONDS", 120),
  backgroundAdvertisingTodaySyncTimeoutMinutes: readNumberEnv("BACKGROUND_ADVERTISING_TODAY_SYNC_TIMEOUT_MINUTES", 25),
  backgroundOzonStockSyncEnabled: String(process.env.BACKGROUND_OZON_STOCK_SYNC_ENABLED || "true").toLowerCase() !== "false",
  backgroundOzonStockSyncIntervalMinutes: readNumberEnv("BACKGROUND_OZON_STOCK_SYNC_INTERVAL_MINUTES", 30),
  backgroundOzonStockSyncInitialDelaySeconds: readNumberEnv("BACKGROUND_OZON_STOCK_SYNC_INITIAL_DELAY_SECONDS", 480),
  backgroundOzonCategorySyncEnabled: String(process.env.BACKGROUND_OZON_CATEGORY_SYNC_ENABLED || "true").toLowerCase() !== "false",
  backgroundOzonCategorySyncHour: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_HOUR", 1),
  backgroundOzonCategorySyncMinute: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_MINUTE", 10),
  backgroundOzonCategorySyncCheckMinutes: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_CHECK_MINUTES", 10),
  backgroundOzonCategorySyncCategoryLimit: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_CATEGORY_LIMIT", 120),
  backgroundOzonCategorySyncValueLimit: readNumberEnv("BACKGROUND_OZON_CATEGORY_SYNC_VALUE_LIMIT", 200)
};
