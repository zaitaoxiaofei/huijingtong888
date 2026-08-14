import { config } from "../src/config.js";

function parseEnvFile(text = "") {
  const result = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function loadHealthCheckEnvFile() {
  const envFile = String(process.env.HEALTH_CHECK_ENV_FILE || "").trim();
  if (!envFile) return {};
  const fs = await import("node:fs/promises");
  try {
    const text = await fs.readFile(envFile, "utf8");
    return parseEnvFile(text);
  } catch (error) {
    throw new Error(`Failed to read HEALTH_CHECK_ENV_FILE ${envFile}: ${error.message || error}`);
  }
}

const envFileValues = await loadHealthCheckEnvFile();
const username = process.env.HEALTH_CHECK_USERNAME || envFileValues.HEALTH_CHECK_USERNAME || "";
const password = process.env.HEALTH_CHECK_PASSWORD || envFileValues.HEALTH_CHECK_PASSWORD || "";
const requestTimeoutMs = Number(process.env.HEALTH_CHECK_TIMEOUT_MS || 15000);
const baseUrl = process.env.HEALTH_CHECK_BASE_URL || `http://localhost:${config.port}`;
const shanghaiDateTimeFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

if (!username || !password) {
  throw new Error("Missing health check credentials. Set HEALTH_CHECK_USERNAME and HEALTH_CHECK_PASSWORD directly or via HEALTH_CHECK_ENV_FILE.");
}

const endpoints = [
  ["/api/auth/me", "auth"],
  ["/api/shops", "shops"],
  ["/api/people", "people"],
  ["/api/products?paged=1&page=1&pageSize=10", "products_paged"],
  ["/api/online-products?paged=1&page=1&pageSize=10", "online_products_paged"],
  ["/api/mappings?paged=1&page=1&pageSize=10", "sku_mappings_paged"],
  ["/api/stock-alerts?paged=1&page=1&pageSize=30", "stock_alerts_paged"],
  ["/api/stock-alerts?mode=fbp&paged=1&page=1&pageSize=30", "stock_fbp_paged"],
  ["/api/inbound-records?paged=1&page=1&pageSize=30", "inbound_records_paged"],
  ["/api/outbound-records?paged=1&page=1&pageSize=30&dateFrom=&dateTo=&shopId=all&status=all&query=", "outbound_records_paged"],
  ["/api/procurement/requests?grouped=1&paged=1&page=1&pageSize=30", "procurement_grouped_paged"],
  ["/api/procurement/purchase-orders?paged=1&page=1&pageSize=30", "purchase_orders_paged"],
  ["/api/orders?paged=1&page=1&pageSize=30&status=all&shopId=all&dateFrom=&dateTo=&searchType=order&searchQuery=&markFilter=all&printFilter=all&printView=all&sortMode=ordered", "orders_paged"],
  ["/api/profit-ranking?dimension=sku&page=1&pageSize=10", "profit_ranking_sku"],
  ["/api/profit-ranking?dimension=shop&page=1&pageSize=10", "profit_ranking_shop"],
  ["/api/profits/historical-review?limit=10", "historical_profit_review"]
];

function summarizePayload(payload) {
  if (Array.isArray(payload)) return { kind: "array", count: payload.length };
  if (!payload || typeof payload !== "object") return { kind: typeof payload };
  if (Array.isArray(payload.rows)) return { kind: "paged", rows: payload.rows.length, total: Number(payload.total || 0) };
  if (payload.ranges && Array.isArray(payload.dailyTrend14)) {
    return {
      kind: "profit_dashboard",
      today_orders: Number(payload.ranges?.today?.summary?.order_count || 0),
      month_revenue: Number(payload.ranges?.currentMonth?.summary?.revenue || 0),
      daily_trend_rows: payload.dailyTrend14.length
    };
  }
  if (typeof payload.dimension === "string" && Array.isArray(payload.rows)) {
    return {
      kind: "profit_ranking",
      dimension: payload.dimension,
      rows: payload.rows.length,
      total: Number(payload.total || 0)
    };
  }
  return { kind: "object", keys: Object.keys(payload).slice(0, 8) };
}

async function fetchJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  const { response, payload } = await fetchJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (!response.ok || !payload?.token) {
    throw new Error(`health-check login failed: HTTP ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function checkEndpoint(path, label, token) {
  const startedAt = performance.now();
  const { response, payload } = await fetchJson(path, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const summary = summarizePayload(payload);
  const expectsPaged = label.endsWith("_paged") || path.includes("paged=1");
  const contractOk = !expectsPaged || summary.kind === "paged" || summary.kind === "profit_ranking";

  return {
    label,
    path,
    status: response.status,
    ok: response.ok && contractOk,
    durationMs,
    summary,
    error: payload?.error || (contractOk ? null : "Expected paged response contract")
  };
}

const loginPayload = await login();
const results = [];
for (const [path, label] of endpoints) {
  try {
    results.push(await checkEndpoint(path, label, loginPayload.token));
  } catch (error) {
    results.push({
      label,
      path,
      status: 0,
      ok: false,
      error: error.message || String(error)
    });
  }
}

const failed = results.filter((item) => !item.ok);

console.log(JSON.stringify({
  appBaseUrl: baseUrl,
  dbClient: config.dbClient,
  db: { host: config.dbHost, port: config.dbPort, name: config.dbName, user: config.dbUser },
  loginUser: loginPayload.user,
  checkedAt: shanghaiDateTimeFormatter.format(new Date()),
  timeZone: "Asia/Shanghai",
  failedCount: failed.length,
  results
}, null, 2));

if (failed.length) process.exit(1);
