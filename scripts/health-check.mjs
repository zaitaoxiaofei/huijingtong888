import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.js";

const db = new DatabaseSync(config.databasePath);

const session = db.prepare(`
  SELECT token, person_id, name, username, role, expires_at
  FROM sessions
  WHERE expires_at > CURRENT_TIMESTAMP
  ORDER BY created_at DESC
  LIMIT 1
`).get();

if (!session?.token) {
  console.error("health-check: 未找到有效登录 session，无法检查受保护接口。");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${session.token}`
};

const endpoints = [
  ["/api/auth/me", "auth"],
  ["/api/shops", "shops"],
  ["/api/people", "people"],
  ["/api/products", "products"],
  ["/api/online-products", "online_products"],
  ["/api/mappings", "sku_mappings"],
  ["/api/stock-alerts", "stock_alerts"],
  ["/api/inbound-records", "inbound_records"],
  ["/api/outbound-records", "outbound_records"],
  ["/api/procurement/requests", "procurement_requests"],
  ["/api/procurement/purchase-orders", "purchase_orders"],
  ["/api/orders?paged=1&page=1&pageSize=10&status=all&shopId=all&dateFrom=&dateTo=&searchType=order&searchQuery=&markFilter=all&printFilter=all&printView=all&sortMode=ordered", "orders_paged"],
  ["/api/profit-summary?from=2026-05-01&to=2026-05-31", "profit_summary"],
  ["/api/profit-dashboard", "profit_dashboard"],
  ["/api/profit-ranking?dimension=sku&page=1&pageSize=10", "profit_ranking_sku"],
  ["/api/profit-ranking?dimension=shop&page=1&pageSize=10", "profit_ranking_shop"]
];

function summarizePayload(payload) {
  if (Array.isArray(payload)) return { kind: "array", count: payload.length };
  if (!payload || typeof payload !== "object") return { kind: typeof payload };
  if (Array.isArray(payload.rows)) return { kind: "paged", rows: payload.rows.length, total: Number(payload.total || 0) };
  if (payload.summary && (payload.byShop || payload.bySku || payload.byProduct)) {
    return {
      kind: "profit_summary",
      order_count: Number(payload.summary.order_count || 0),
      revenue: Number(payload.summary.revenue || 0)
    };
  }
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
  if (Array.isArray(payload.rows) && payload.meta) return { kind: "rows_meta", rows: payload.rows.length };
  if (Array.isArray(payload.rows)) return { kind: "rows", rows: payload.rows.length };
  return { kind: "object", keys: Object.keys(payload).slice(0, 8) };
}

async function checkEndpoint(path, label) {
  const response = await fetch(`${config.appBaseUrl}${path}`, { headers });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return {
    label,
    path,
    status: response.status,
    ok: response.ok,
    summary: summarizePayload(payload),
    error: payload?.error || null
  };
}

const results = [];
for (const [path, label] of endpoints) {
  try {
    results.push(await checkEndpoint(path, label));
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
  appBaseUrl: config.appBaseUrl,
  databasePath: config.databasePath,
  sessionUser: {
    person_id: session.person_id,
    name: session.name,
    username: session.username,
    role: session.role
  },
  checkedAt: new Date().toISOString(),
  failedCount: failed.length,
  results
}, null, 2));

if (failed.length) process.exit(1);
