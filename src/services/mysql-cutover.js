import { PDFDocument } from "pdf-lib";
import { actualItemProfit, estimateItemProfit } from "../profit.js";
import { archiveOzonProducts, fetchOzonPackageLabel, fetchOzonPostingByNumber, fetchOzonPostings, fetchOzonFinanceTransactions, fetchOzonProducts, fetchOzonProductStocks, shipOzonPosting, updateOzonProductStocks } from "../ozonClient.js";
import { buildOrderOutcomeSql, classifyOrderOutcome, estimateOutcomeReturnLoss, resolveOrderLossProfile } from "./order-outcome.js";
import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { buildOrderProfitDetailSnapshotPayload } from "./order-profit-detail-snapshots.js";
import { calculateSelectionPricing } from "../celRates.js";
import { DEFAULT_ORDER_LOGISTICS_FILTER_RULES, resolveOrderLogisticsRuleValue } from "./order-logistics-filter-rules.js";
import {
  applyStockAlertQuery,
  dateKeyDaysAgo,
  maxTextDate,
  parseWarehouseBreakdown,
  withStockAlertStatus
} from "./inventory-alert-utils.js";

const disabledLegacyMirrorStatement = {
  run: () => ({ changes: 0, lastInsertRowid: null }),
  get: () => null,
  all: () => []
};

const db = {
  prepare: () => disabledLegacyMirrorStatement,
  exec: () => {}
};

function describeCancellation(row = {}) {
  const profile = resolveOrderLossProfile(row);
  return {
    initiator_label: row.cancel_initiator || "",
    reason_label: row.cancel_reason || "",
    reason_code: row.cancel_reason_id || profile.code || "other",
    reason_group_label: profile.label || "",
    accounting_hint: profile.accounting_hint || "",
    loss_profile_code: profile.code || "",
    loss_profile_label: profile.label || "",
    loss_formula_text: profile.formula_text || ""
  };
}

function invalidateOrderCancellationRuleCache() {}

function ensureMysqlCutoverEnabled() {
  if (!isMysqlPrimaryEnabled()) {
    throw new Error("MySQL cutover routes are not enabled");
  }
}

async function ensureMysqlColumns(table, statements = []) {
  for (const sql of statements) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (error?.code === "ER_DUP_FIELDNAME") continue;
      throw error;
    }
  }
}

const MASTER_DATA_CACHE_TTL_MS = 30_000;
const STOCK_ALERT_BASE_CACHE_TTL_MS = 20_000;
const ORDER_COUNTS_CACHE_TTL_MS = 15_000;
const ORDER_LABEL_PREFETCH_INITIAL_DELAY_MS = 5 * 60 * 1000;
const ORDER_LABEL_PREFETCH_RETRY_DELAY_MS = 10 * 60 * 1000;
const ORDER_LABEL_PREFETCH_MAX_ATTEMPTS = 3;
const masterDataCache = new Map();
const pendingOrderLabelPrefetchTimers = new Map();
let orderLabelPrintSchemaReady = false;
let orderPackageLabelCacheSchemaReady = false;
let logisticsRuleFilterCacheMysql = null;
let shopWatermarkSchemaReadyMysql = false;
let shopAdvertisingCredentialSchemaReadyMysql = false;

const FALLBACK_ORDER_LOGISTICS_METHODS_MYSQL = DEFAULT_ORDER_LOGISTICS_FILTER_RULES.map((item) => ({
  value: item.value,
  label: item.label,
  warehousePatterns: item.warehouse_patterns
}));
const DEFAULT_ORDER_LOGISTICS_OPTIONS_MYSQL = FALLBACK_ORDER_LOGISTICS_METHODS_MYSQL.map((item) => ({
  value: item.value,
  label: item.label
}));

function isAwaitingDeliverLikeStatusMysql(statusText = "") {
  const text = String(statusText || "").toLowerCase();
  return [
    "awaiting_deliver",
    "posting_registered",
    "sent_by_seller",
    "posting_ready_for_pickup",
    "posting_transferred_to_courier_service",
    "posting_transferring",
    "posting_in_carriage",
    "posting_transferring_to_delivery"
  ].some((value) => text.includes(value));
}

function normalizeSyncedShippingStateMysql(posting = {}) {
  const text = `${posting.status || ""} ${posting.tracking_stage || ""} ${posting.logistics_status || ""}`.toLowerCase();
  const inTransit = [
    "posting_in_carriage",
    "posting_transferring",
    "posting_transferring_to_delivery",
    "delivering"
  ].some((value) => text.includes(value));
  return {
    status: inTransit ? "delivering" : "awaiting_deliver",
    trackingStage: posting.tracking_stage || posting.status || (inTransit ? "delivering" : "awaiting_deliver"),
    logisticsStatus: posting.logistics_status || posting.tracking_stage || posting.status || (inTransit ? "delivering" : "awaiting_deliver")
  };
}

async function ensureOrderLabelPrintSchemaMysql() {
  if (orderLabelPrintSchemaReady) return;
  const statements = [
    "ALTER TABLE order_label_prints ADD COLUMN print_batch_id VARCHAR(64) NULL",
    "ALTER TABLE order_label_prints ADD COLUMN print_sequence INT NULL",
    "CREATE INDEX idx_order_label_prints_sequence ON order_label_prints (printed_at, print_batch_id, print_sequence, order_id)"
  ];
  for (const sql of statements) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (!["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(error?.code)) throw error;
    }
  }
  orderLabelPrintSchemaReady = true;
}

async function ensureOrderPackageLabelCacheSchemaMysql() {
  if (orderPackageLabelCacheSchemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS order_package_label_cache (
      order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      shop_id BIGINT UNSIGNED NOT NULL,
      posting_number VARCHAR(128) NOT NULL,
      label_pdf LONGBLOB NOT NULL,
      label_size INT NOT NULL DEFAULT 0,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fetch_source VARCHAR(32) NOT NULL DEFAULT 'ozon',
      KEY idx_order_package_label_cache_posting (shop_id, posting_number),
      KEY idx_order_package_label_cache_fetched (fetched_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  orderPackageLabelCacheSchemaReady = true;
}

async function ensureLogisticsRuleFilterSchemaMysql() {
  try {
    await mysqlExecute("ALTER TABLE logistics_fee_rules ADD COLUMN filter_keywords TEXT NULL");
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
  try {
    await mysqlExecute("ALTER TABLE logistics_fee_rules ADD COLUMN usage_count INT NOT NULL DEFAULT 0");
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
  try {
    await mysqlExecute("ALTER TABLE logistics_fee_rules ADD COLUMN last_used_at DATETIME NULL");
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
  try {
    await mysqlExecute("ALTER TABLE products ADD COLUMN logistics_rule_id BIGINT UNSIGNED NULL");
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
}

let selectionCreativeSchemaReadyMysql = false;

async function ensureSelectionCreativeSchemaMysql() {
  if (selectionCreativeSchemaReadyMysql) return;
  const statements = [
    "ALTER TABLE products ADD COLUMN detail_image_urls LONGTEXT NULL",
    "ALTER TABLE products ADD COLUMN material VARCHAR(255) NULL",
    "ALTER TABLE products ADD COLUMN color VARCHAR(255) NULL",
    "ALTER TABLE products ADD COLUMN selling_points TEXT NULL"
  ];
  for (const sql of statements) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    }
  }
  selectionCreativeSchemaReadyMysql = true;
}

async function ensureShopWatermarkSchemaMysql() {
  if (shopWatermarkSchemaReadyMysql) return;
  const statements = [
    "ALTER TABLE shops ADD COLUMN watermark_path TEXT NULL",
    "ALTER TABLE shops ADD COLUMN watermark_name VARCHAR(255) NULL",
    "ALTER TABLE shops ADD COLUMN watermark_position VARCHAR(32) NOT NULL DEFAULT 'bottom-right'",
    "ALTER TABLE shops ADD COLUMN watermark_x_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000",
    "ALTER TABLE shops ADD COLUMN watermark_y_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000",
    "ALTER TABLE shops ADD COLUMN watermark_scale_percent DECIMAL(8,4) NOT NULL DEFAULT 22.0000",
    "ALTER TABLE shops ADD COLUMN watermark_opacity_percent DECIMAL(8,4) NOT NULL DEFAULT 82.0000"
  ];
  for (const sql of statements) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    }
  }
  shopWatermarkSchemaReadyMysql = true;
}

async function ensureShopAdvertisingCredentialSchemaMysql() {
  if (shopAdvertisingCredentialSchemaReadyMysql) return;
  await ensureMysqlColumns("shops", [
    "ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL",
    "ALTER TABLE shops ADD COLUMN performance_client_id VARCHAR(128) NULL",
    "ALTER TABLE shops ADD COLUMN performance_client_secret TEXT NULL",
    "ALTER TABLE shops ADD COLUMN performance_client_secret_hint VARCHAR(255) NULL"
  ]);
  shopAdvertisingCredentialSchemaReadyMysql = true;
}

let productMergeSchemaReadyMysql = false;

async function ensureProductMergeSchemaMysql() {
  if (productMergeSchemaReadyMysql) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_merge_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      target_product_id BIGINT UNSIGNED NOT NULL,
      target_product_name VARCHAR(255) NOT NULL DEFAULT '',
      source_product_ids_json JSON NOT NULL,
      source_product_names_json JSON NOT NULL,
      selected_field_sources_json JSON NOT NULL,
      before_target_json JSON NOT NULL,
      before_sources_json JSON NOT NULL,
      affected_counts_json JSON NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'merged',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      undone_at DATETIME NULL,
      INDEX idx_product_merge_history_created (created_at DESC, id DESC),
      INDEX idx_product_merge_history_status (status, created_at DESC)
    )
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_merge_history_refs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      merge_history_id BIGINT UNSIGNED NOT NULL,
      table_key VARCHAR(64) NOT NULL,
      ref_key_json JSON NOT NULL,
      source_product_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_product_merge_history_refs_merge (merge_history_id, table_key),
      INDEX idx_product_merge_history_refs_source (source_product_id, table_key)
    )
  `);
  productMergeSchemaReadyMysql = true;
}

export function invalidateMasterDataCache(key = "") {
  if (key) {
    masterDataCache.delete(key);
    return;
  }
  masterDataCache.clear();
}

async function getCachedMasterData(key, loader, ttlMs = MASTER_DATA_CACHE_TTL_MS) {
  const cached = masterDataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await loader();
  masterDataCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
  return value;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nullableInteger(value) {
  const numeric = nullableNumber(value);
  return numeric === null ? null : Math.trunc(numeric);
}

function requiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new Error(message);
  return text;
}

function parseJsonOrNull(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonFallback(value, fallback) {
  const parsed = parseJsonOrNull(value);
  return parsed === null ? fallback : parsed;
}

function mysqlDbAdapter(connection = null) {
  const query = connection
    ? (sql, params = []) => connection.query(sql, params).then(([rows]) => rows)
    : mysqlQuery;
  const execute = connection
    ? (sql, params = []) => connection.execute(sql, params).then(([result]) => result)
    : mysqlExecute;
  return {
    prepare(sql) {
      return {
        run: async (...params) => execute(sql, params),
        get: async (...params) => (await query(sql, params))[0] || null,
        all: async (...params) => query(sql, params)
      };
    }
  };
}

const mysqlPoolConnectionAdapter = {
  query: async (sql, params = []) => [await mysqlQuery(sql, params)],
  execute: async (sql, params = []) => [await mysqlExecute(sql, params)]
};

async function mysqlQueryAdapter(sql, params = []) {
  return await mysqlQuery(sql, params);
}

export async function allMysql(sql, params = []) {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(sql, Array.isArray(params) ? params : [params]);
}

async function mysqlQueryOneAdapter(sql, params = []) {
  return await mysqlQueryOne(sql, params);
}

async function mysqlExecuteAdapter(sql, params = []) {
  return await mysqlExecute(sql, params);
}

async function mysqlInsertAndGetId(sql, params = []) {
  const result = await mysqlExecute(sql, params);
  return Number(result.insertId || 0);
}

function withProductImageEndpointMysql(row) {
  if (!row) return row;
  const image = String(row.image_url || "");
  if (!image.startsWith("data:image/")) return row;
  return {
    ...row,
    image_url: `/api/products/${row.id}/image`
  };
}

function compactProductListRowMysql(row) {
  const imageUrl = String(row.image_url || "");
  return {
    id: row.id,
    selection_id: row.selection_id,
    code: row.code,
    inventory_id: row.inventory_id,
    name: row.name,
    image_url: imageUrl.startsWith("data:image/") ? `/api/products/${row.id}/image` : imageUrl,
    owner_person_id: row.owner_person_id,
    owner_name: row.owner_name || "",
    created_by_person_id: row.created_by_person_id,
    creator_name: row.creator_name || "",
    supplier_id: row.supplier_id,
    purchase_url: row.purchase_url || "",
    source_platform: row.source_platform || "",
    shipping_method: row.shipping_method || "",
    purchase_cost: Number(row.purchase_cost || 0),
    domestic_shipping: Number(row.domestic_shipping || 0),
    handling_fee: Number(row.handling_fee || 0),
    purchase_quantity: Number(row.purchase_quantity || 0),
    package_weight_g: Number(row.package_weight_g || 0),
    length_cm: Number(row.length_cm || 0),
    width_cm: Number(row.width_cm || 0),
    height_cm: Number(row.height_cm || 0),
    listing_price_rub: Number(row.listing_price_rub || 0),
    air_sale_price_rmb: Number(row.air_sale_price_rmb || 0),
    exchange_rate: Number(row.exchange_rate || 0),
    desired_profit_mode: row.desired_profit_mode || "",
    desired_profit_value: Number(row.desired_profit_value || 0),
    return_rate: Number(row.return_rate || 0),
    stock: Number(row.stock || 0),
    avg_unit_cost: Number(row.avg_unit_cost || 0),
    total_purchase_amount: Number(row.total_purchase_amount || 0),
    total_purchase_quantity: Number(row.total_purchase_quantity || 0),
    incoming_stock: Number(row.incoming_stock || 0),
    sku_count: Number(row.sku_count || 0),
    mapped_skus: row.mapped_skus || "",
    origin_skus: row.origin_skus || "",
    total_sales_quantity: Number(row.total_sales_quantity || 0),
    total_sales_amount: Number(row.total_sales_amount || 0),
    avg_sale_price: Number(row.avg_sale_price || 0),
    estimated_profit_total: Number(row.estimated_profit_total || 0),
    order_count: Number(row.order_count || 0),
    profit_rate: Number(row.profit_rate || 0),
    active: Number(row.active ?? 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
    shop_ids: row.shop_ids || [],
    shop_names: row.shop_names || [],
    bound_mappings: row.bound_mappings || [],
    bound_sku_count: Number(row.bound_sku_count || 0),
    sku_preview: row.sku_preview || [],
    sku_preview_extra: Number(row.sku_preview_extra || 0),
    pricing: row.pricing || null
  };
}

function selectionSummaryMysql(rows) {
  const quotedRows = rows.filter((row) => row.pricing?.air || row.pricing?.land).length;
  const avgPurchaseCost = rows.length
    ? rows.reduce((sum, row) => sum + Number(row.purchase_cost || 0), 0) / rows.length
    : 0;
  return {
    products: rows.length,
    quotedRows,
    missingQuoteRows: rows.length - quotedRows,
    avgPurchaseCost
  };
}

function normalizeMysqlDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  }
  const normalized = String(value).replace("T", " ").replace("Z", "");
  return normalized.slice(0, 19);
}

function firstJsonItem(value) {
  const parsed = parseJsonOrNull(value);
  if (!Array.isArray(parsed)) return "";
  const first = parsed.find((item) => String(item || "").trim());
  return first ? String(first) : "";
}

function normalizeProductImageUrlMysql(value) {
  const image = String(value || "").trim();
  if (/^\/api\/products\/\d+\/image$/i.test(image)) return "";
  return image;
}

function normalizeProductDetailImagesMysql(value) {
  const list = Array.isArray(value)
    ? value
    : parseJsonOrNull(value) || String(value || "").split(/\r?\n|,/);
  return JSON.stringify(list.map((item) => normalizeProductImageUrlMysql(item)).filter(Boolean));
}

function recommendShippingMysql(body = {}) {
  const weight = Number(body.package_weight_g || 0);
  const length = Number(body.length_cm || 30);
  const width = Number(body.width_cm || 20);
  const height = Number(body.height_cm || 10);
  const longest = Math.max(length, width, height);
  const sum = length + width + height;
  if (weight <= 500 && longest <= 60 && sum <= 90) return "air_land";
  if (weight <= 30000 && longest <= 150 && sum <= 310) return "land";
  return "manual_review";
}

function normalizePurchasePlanMysql(body = {}) {
  const quantity = Math.max(1, Number(body.purchase_quantity || 1));
  const purchaseTotal = Number(body.purchase_total_amount ?? body.purchase_cost ?? 0);
  const domesticTotal = Number(body.domestic_shipping_total ?? body.domestic_shipping ?? 0);
  return {
    quantity,
    purchaseTotal,
    domesticTotal,
    amount: purchaseTotal,
    shippingAmount: domesticTotal,
    unitPurchaseCost: purchaseTotal / quantity,
    unitDomesticShipping: domesticTotal / quantity
  };
}

function onlineProductSpecMysql(online = {}) {
  const attributes = parseJsonFallback(online.attributes_json, []);
  const findValue = (...names) => {
    for (const attr of Array.isArray(attributes) ? attributes : []) {
      const name = String(attr?.name || attr?.attribute_name || attr?.id || "").toLowerCase();
      if (!names.some((item) => name.includes(item))) continue;
      const values = Array.isArray(attr?.values) ? attr.values : [];
      const value = values[0]?.value ?? values[0]?.text ?? attr?.value;
      const numeric = Number(String(value || "").replace(/[^\d.]/g, ""));
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    return 0;
  };
  return {
    weight_g: findValue("weight", "胁械褋"),
    length_cm: findValue("length", "写谢懈薪邪"),
    width_cm: findValue("width", "褕懈褉懈薪邪"),
    height_cm: findValue("height", "胁褘褋芯褌邪")
  };
}

function roundFinanceAmount(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundMoneyMysql(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

const PRODUCT_MERGE_FIELD_DEFS_MYSQL = [
  { key: "name", label: "产品名称", type: "text" },
  { key: "selection_id", label: "选品编号", type: "text" },
  { key: "code", label: "库存编码", type: "text" },
  { key: "image_url", label: "产品图片", type: "image" },
  { key: "purchase_url", label: "采购链接", type: "text" },
  { key: "supplier_note", label: "备注", type: "text" },
  { key: "source_platform", label: "货源平台", type: "text" },
  { key: "supplier_id", label: "供应商", type: "supplier" },
  { key: "shipping_method", label: "物流方式", type: "text" },
  { key: "logistics_rule_id", label: "物流规则", type: "logistics_rule" },
  { key: "purchase_cost", label: "采购成本", type: "number" },
  { key: "domestic_shipping", label: "国内运费", type: "number" },
  { key: "handling_fee", label: "包装/处理费", type: "number" },
  { key: "purchase_quantity", label: "采购数量", type: "number" },
  { key: "package_weight_g", label: "重量(g)", type: "number" },
  { key: "length_cm", label: "长(cm)", type: "number" },
  { key: "width_cm", label: "宽(cm)", type: "number" },
  { key: "height_cm", label: "高(cm)", type: "number" },
  { key: "sale_price_rmb", label: "售价(RMB)", type: "number" },
  { key: "listing_price_rub", label: "上架价(RUB)", type: "number" },
  { key: "air_sale_price_rmb", label: "空运售价(RMB)", type: "number" },
  { key: "exchange_rate", label: "汇率", type: "number" },
  { key: "target_margin", label: "目标利润率", type: "number" },
  { key: "desired_profit_mode", label: "利润模式", type: "text" },
  { key: "desired_profit_value", label: "目标利润值", type: "number" },
  { key: "advertising_rate", label: "广告费率", type: "number" },
  { key: "return_rate", label: "退货率", type: "number" },
  { key: "owner_person_id", label: "负责人", type: "person" },
  { key: "created_by_person_id", label: "创建人", type: "person" },
  { key: "product_type", label: "产品类型", type: "text" },
  { key: "selection_status", label: "库存状态", type: "text" }
];
const PRODUCT_MERGE_REFERENCE_TABLES_MYSQL = [
  { key: "child_products", table: "products", column: "parent_product_id", idColumn: "id", label: "子产品" },
  { key: "online_products", table: "online_products", column: "product_id", idColumn: "id", label: "在线商品" },
  { key: "sku_mappings", table: "sku_mappings", column: "product_id", idColumn: "id", label: "SKU 绑定" },
  { key: "procurement_requests", table: "procurement_requests", column: "product_id", idColumn: "id", label: "采购申请" },
  { key: "inbound_records", table: "inbound_records", column: "product_id", idColumn: "id", label: "入库记录" },
  { key: "outbound_records", table: "outbound_records", column: "product_id", idColumn: "id", label: "出库记录" },
  { key: "inventory_movements", table: "inventory_movements", column: "product_id", idColumn: "id", label: "库存流水" },
  { key: "analytics_product_profit_daily", table: "analytics_product_profit_daily", column: "product_id", idColumn: ["date_key", "shop_id"], label: "产品利润分析" },
  { key: "analytics_sku_profit_daily", table: "analytics_sku_profit_daily", column: "product_id", idColumn: ["date_key", "shop_id", "ozon_sku"], label: "SKU 利润分析" },
  { key: "purchase_order_items", table: "purchase_order_items", column: "product_id", idColumn: "id", label: "采购单明细" },
  { key: "ozon_stock_snapshots", table: "ozon_stock_snapshots", column: "product_id", idColumn: "id", label: "Ozon 库存快照" }
];

function rubToCnyMysql(value, rate) {
  const amount = Number(value || 0);
  const resolvedRate = Number(rate || 0);
  if (!Number.isFinite(amount) || !Number.isFinite(resolvedRate) || resolvedRate <= 0) return 0;
  return roundMoneyMysql(amount / resolvedRate);
}

function parseDateMysql(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fallbackShipDeadlineMysql(orderedAt) {
  const ordered = new Date(orderedAt);
  if (Number.isNaN(ordered.getTime())) return null;
  ordered.setDate(ordered.getDate() + 6);
  return ordered.toISOString();
}

function daysBetweenMysql(from, to) {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

function chinaDateKeyMysql(value) {
  const date = parseDateMysql(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function normalizeSyncDateMysql(value) {
  if (!value) return "";
  const date = new Date(String(value).includes("T") ? value : `${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "";
  return String(value).slice(0, 10);
}

function normalizeMysqlNullableDateTime(value) {
  return value ? normalizeMysqlDateTime(value) : null;
}

function shanghaiDateTimeMysql(date = new Date(), truncateHour = false) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${truncateHour ? "00:00" : `${parts.minute}:${parts.second}`}`;
}

function dateKeyDaysAgoMysql(days) {
  return dateKeyMysql(addDaysMysql(new Date(), -Number(days || 0)));
}

function chinaDateSqlMysql(expr) {
  return `DATE(CONVERT_TZ(${expr}, '+00:00', '+08:00'))`;
}

function chinaDateKeySqlMysql(expr) {
  return `DATE_FORMAT(CONVERT_TZ(${expr}, '+00:00', '+08:00'), '%Y-%m-%d')`;
}

function todayDateKeyMysql() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function detectShippingMethodKeyMysql(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.includes("air_land") || text.includes("air land") || text.includes("air+land")) return "air_land";
  if (text.includes("闄嗚繍") || text.includes("economy") || text.includes("budget") || text.includes("閭斂") || /(^|[^a-z])land([^a-z]|$)/.test(text)) return "land";
  if (text.includes("standard") && (text.includes("extra small") || text.includes("fbp") || text.includes("pudo") || text.includes("courier"))) return "air_land";
  if (text.includes("绌鸿繍") || /(^|[^a-z])air([^a-z]|$)/.test(text)) return "air";
  return "";
}

function logisticsModeKeyMysql(row = {}) {
  const combined = `${row.warehouse_name || ""} ${row.delivery_method_name || ""} ${row.logistics_channel || ""}`.toLowerCase();
  return combined.includes("hun chun") || combined.includes("hunchun") || combined.includes("娣锋槬") || combined.includes("娣峰窛") || combined.includes("鐝叉槬") || combined.includes("椋庤埞") || combined.includes("棰ㄨ埞") || combined.includes("fbp")
    ? "fbp"
    : "fbs";
}

function orderTimestampPagedValueMysql(row) {
  const time = new Date(row.ordered_at || row.created_at || row.updated_at || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function orderInventoryPagedSortKeyMysql(row = {}) {
  const modePrefix = logisticsModeKeyMysql(row) === "fbp" ? "z-fbp" : "a-fbs";
  const key = String(row.inventory_ids || row.product_names || row.product_codes || row.skus || "zz-empty")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh-Hans", { numeric: true }))[0] || "zz-empty";
  return `${modePrefix}-${key}`;
}

function sortPagedOrdersMysql(rows, query = {}) {
  const mode = String(query.sortMode || query.sort_mode || "ordered");
  const status = String(query.status || "all");
  const print = String(query.printFilter || query.print_filter || "all");
  return [...rows].sort((a, b) => {
    if (print === "printed") {
      const printedDiff = orderPrintTimestampPagedValueMysql(b) - orderPrintTimestampPagedValueMysql(a);
      if (printedDiff) return printedDiff;
      const batchKey = String(b.print_batch_id || "").localeCompare(String(a.print_batch_id || ""), "zh-Hans", { numeric: true });
      if (batchKey) return batchKey;
      const seqDiff = orderPrintSequencePagedValueMysql(a) - orderPrintSequencePagedValueMysql(b);
      if (seqDiff) return seqDiff;
    }
    if (mode === "inventory") {
      const key = orderInventoryPagedSortKeyMysql(a).localeCompare(orderInventoryPagedSortKeyMysql(b), "zh-Hans", { numeric: true });
      if (key) return key;
    } else if (status === "awaiting_packaging") {
      const key = logisticsModeKeyMysql(a).localeCompare(logisticsModeKeyMysql(b));
      if (key) return key;
    }
    return orderTimestampPagedValueMysql(b) - orderTimestampPagedValueMysql(a);
  });
}

function orderPrintTimestampPagedValueMysql(row) {
  const time = new Date(row.printed_at || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function orderPrintSequencePagedValueMysql(row) {
  const sequence = Number(row.print_sequence);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : Number.MAX_SAFE_INTEGER;
}

function trimOrderPostingSuffix(value = "") {
  const text = String(value || "").trim();
  const matched = text.match(/^(.*)-\d+$/);
  return matched?.[1] || text;
}

function orderOutcomeLabelMysql(outcome = "") {
  return {
    active: "active",
    cancelled_pre_fulfillment: "cancelled",
    rejected_unclaimed: "rejected",
    after_delivery_return: "returned",
    delivered_signed: "delivered"
  }[String(outcome || "").toLowerCase()] || "active";
}

function orderOutcomeHintMysql(outcome = "") {
  switch (String(outcome || "").toLowerCase()) {
    case "cancelled_pre_fulfillment":
      return "Order cancelled before fulfillment loss.";
    case "rejected_unclaimed":
      return "Order rejected or unclaimed.";
    case "after_delivery_return":
      return "Order returned after delivery.";
    case "delivered_signed":
      return "Order delivered.";
    default:
      return "Order is still active.";
  }
}

function scaleFinanceRowMysql(row = {}, share = 1) {
  const ratio = Number.isFinite(Number(share)) ? Number(share) : 1;
  return {
    ...row,
    amount: roundFinanceAmount(Number(row.amount || 0) * ratio),
    amount_cny: roundFinanceAmount(Number(row.amount_cny || 0) * ratio),
    accruals_for_sale: roundFinanceAmount(Number(row.accruals_for_sale || 0) * ratio),
    accruals_for_sale_cny: roundFinanceAmount(Number(row.accruals_for_sale_cny || 0) * ratio),
    sale_commission: roundFinanceAmount(Number(row.sale_commission || 0) * ratio),
    sale_commission_cny: roundFinanceAmount(Number(row.sale_commission_cny || 0) * ratio),
    fee_amount: roundFinanceAmount(Number(row.fee_amount || 0) * ratio),
    fee_amount_cny: roundFinanceAmount(Number(row.fee_amount_cny || 0) * ratio),
    row_count: Number(row.row_count || 0),
    derived_from_parent_posting: 1
  };
}

function ozonFinanceCategoryMysql(row = {}) {
  const raw = String(row.service_name || row.operation_type_name || row.service_type || row.operation_type || "").trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes("sale_commission") || normalized.includes("commission")) return "commission";
  if (normalized.includes("marketplaceredistributionofacquiringoperation")) return "collecting_fee";
  if (normalized.includes("return_delivery_charge") || normalized.includes("returnflowlogistic") || normalized.includes("returnnotdelivtocustomer")) return "aftersale_loss";
  if (normalized.includes("delivery_charge")) return "platform_delivery";
  if (raw === "袩械褉械胁褘褋褌邪胁谢械薪懈械 褍褋谢褍谐 写芯褋褌邪胁泻懈" || raw.includes("写芯褋褌邪胁")) return "platform_delivery";
  if (raw.includes("屑械卸写褍薪邪褉芯写") || raw.includes("褌褉邪薪褋锌芯褉褌薪芯-褝泻褋锌械写懈褑懈芯薪薪褘褏")) return "international_transport";
  if (raw.includes("效邪褋褌懈褔薪邪褟 泻芯屑锌械薪褋邪褑懈褟 锌芯泻褍锌邪褌械谢褞") || raw.includes("胁芯蟹胁褉邪褌") || raw.includes("薪械写芯胁谢芯卸")) return "aftersale_loss";
  return "other";
}

async function lockProfitItemMysql(orderItemId, reason = "finance_accrued") {
  await mysqlExecute(`
    UPDATE order_profit_items
    SET is_locked = 1,
      locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP),
      lock_reason = COALESCE(lock_reason, ?),
      updated_at = CURRENT_TIMESTAMP
    WHERE order_item_id = ?
  `, [reason, Number(orderItemId)]);
}

function financeRowsForOperationMysql(operation) {
  const rows = [];
  if (Number(operation.sale_commission || 0)) rows.push({ service_type: "sale_commission", service_name: "Ozon sale commission", amount: Number(operation.sale_commission || 0) });
  if (Number(operation.delivery_charge || 0)) rows.push({ service_type: "delivery_charge", service_name: "Ozon delivery charge", amount: Number(operation.delivery_charge || 0) });
  if (Number(operation.return_delivery_charge || 0)) rows.push({ service_type: "return_delivery_charge", service_name: "Ozon return delivery charge", amount: Number(operation.return_delivery_charge || 0) });
  for (const [index, service] of (operation.services || []).entries()) {
    rows.push({ service_type: `service_${index}_${String(service.name || "").slice(0, 48)}`, service_name: service.name || "Ozon service fee", amount: Number(service.price || 0) });
  }
  if (!rows.length) rows.push({ service_type: "operation_total", service_name: operation.operation_type_name || operation.operation_type || "Ozon 璐㈠姟浜ゆ槗", amount: Number(operation.amount || 0) });
  return rows;
}

async function resolveOrderLogisticsRuleMysql(row = {}) {
  const payload = parseJsonOrNull(row.raw_json) || {};
  const raw = payload.raw || payload;
  const deliveryMethod = raw.delivery_method || {};
  const analytics = raw.analytics_data || {};
  const warehouseName = deliveryMethod.warehouse || analytics.warehouse || "";
  const deliveryMethodName = deliveryMethod.name || "";
  const logisticsChannel = deliveryMethod.tpl_provider || analytics.tpl_provider || row.tracking_number || "";
  const logisticsText = `${deliveryMethodName} ${logisticsChannel} ${warehouseName} ${row.raw_json || ""}`;
  const logisticsRule = normalizeResolvedLogisticsRuleMysql(
    await matchOrderLogisticsRuleMysql(logisticsText)
  ) || normalizeResolvedLogisticsRuleMysql(
    await detectOrderLogisticsLabelMysql(logisticsText, {
      delivery_method_name: deliveryMethodName,
      logistics_channel: logisticsChannel,
      warehouse_name: warehouseName
    })
  );
  return {
    rule: logisticsRule,
    warehouseName,
    deliveryMethodName,
    logisticsChannel,
    raw,
    analytics
  };
}

async function enrichOrderLogisticsMysql(row) {
  const resolved = await resolveOrderLogisticsRuleMysql(row);
  const { rule: logisticsRule, warehouseName, deliveryMethodName, logisticsChannel, raw, analytics } = resolved;
  const fallbackFbp = /hunchun|hun chun|fbp|珲春|混春|混川|风船|風船/i.test(`${warehouseName} ${deliveryMethodName} ${logisticsChannel}`);
  const fulfillmentTypeKey = (
    String(logisticsRule?.label || "").toLowerCase().includes("hunchun")
    || String(logisticsRule?.label || "").toLowerCase().includes("fbp")
    || fallbackFbp
  ) ? "fbp" : "fbs";
  const deadline = raw.shipment_date_without_delay || raw.shipment_date || fallbackShipDeadlineMysql(row.ordered_at);
  const remaining = deadline ? daysBetweenMysql(new Date(), new Date(deadline)) : null;
  const finished = ["delivered", "cancelled", "canceled"].includes(String(row.status || "").toLowerCase());
  const cancellation = describeCancellation({
    ...row,
    raw_cancellation_reason: raw.cancellation?.cancel_reason || raw.cancellation?.cancellation_type || ""
  });
  return {
    ...row,
    raw_json: undefined,
    raw_status: raw.status || "",
    raw_substatus: raw.substatus || "",
    raw_tracking_stage: raw.tracking_stage || "",
    raw_cancellation_reason: raw.cancellation?.cancel_reason || raw.cancellation?.cancellation_type || "",
    cancel_initiator_label: cancellation.initiator_label,
    cancel_reason_label: cancellation.reason_label,
    cancel_reason_code: cancellation.reason_code,
    cancel_reason_group_label: cancellation.reason_group_label,
    cancel_accounting_hint: cancellation.accounting_hint,
    loss_profile_code: cancellation.loss_profile_code,
    loss_profile_label: cancellation.loss_profile_label,
    loss_formula_text: cancellation.loss_formula_text,
    pickup_code_verified_at: raw.pickup_code_verified_at || "",
    delivering_date: raw.delivering_date || "",
    in_process_at: raw.in_process_at || "",
    delivery_date_begin: analytics.delivery_date_begin || "",
    delivery_date_end: analytics.delivery_date_end || "",
    delivery_type: analytics.delivery_type || "",
    delivery_city: analytics.city || "",
    delivery_schema: "FBS self-ship",
    warehouse_name: warehouseName,
    delivery_method_name: deliveryMethodName,
    logistics_channel: logisticsChannel,
    resolved_logistics_rule_name: logisticsRule?.label || "",
    resolved_logistics_rule_value: logisticsRule?.value || "",
    fulfillment_type_key: fulfillmentTypeKey,
    fulfillment_type_label: fulfillmentTypeKey.toUpperCase(),
    shipping_method_key: detectShippingMethodKeyMysql(`${deliveryMethodName || ""} ${logisticsChannel || ""} ${analytics.tpl_provider || ""} ${warehouseName || analytics.warehouse || ""}`),
    shipment_deadline_at: deadline,
    ship_days_remaining: remaining,
    is_overdue: !finished && Number.isFinite(remaining) ? remaining < 0 : false
  };
}

const defaultPackagingFeeRule = {
  low_sale_threshold_cny: 50,
  low_fee_cny: 0.5,
  high_fee_cny: 1
};

async function mysqlQueryOne(sql, params = []) {
  const rows = await mysqlQuery(sql, params);
  return rows[0] || null;
}

async function mysqlConnectionQueryOne(connection, sql, params = []) {
  const [rows] = await connection.query(sql, params);
  return rows[0] || null;
}

async function resolveExistingPersonIdMysql(personId) {
  const resolved = nullableInteger(personId);
  if (!resolved) return null;
  const row = await mysqlQueryOne("SELECT id FROM people WHERE id = ? AND active != 0", [resolved]);
  return row ? resolved : null;
}

async function firstActivePersonIdMysql(connection = null) {
  const row = connection
    ? await mysqlConnectionQueryOne(connection, "SELECT id FROM people WHERE active != 0 ORDER BY id LIMIT 1")
    : await mysqlQueryOne("SELECT id FROM people WHERE active != 0 ORDER BY id LIMIT 1");
  return row?.id || null;
}

async function resolvePersonIdOrFirstMysql(personId, connection = null) {
  const resolved = nullableInteger(personId);
  if (resolved) {
    const row = connection
      ? await mysqlConnectionQueryOne(connection, "SELECT id FROM people WHERE id = ? AND active != 0", [resolved])
      : await mysqlQueryOne("SELECT id FROM people WHERE id = ? AND active != 0", [resolved]);
    if (row) return resolved;
  }
  return await firstActivePersonIdMysql(connection);
}

async function resolveAuditPersonId(userId) {
  const personId = nullableNumber(userId);
  if (personId === null) return null;

  const mysqlPerson = await mysqlQueryOne("SELECT id FROM people WHERE id = ?", [personId]);
  return mysqlPerson ? personId : null;
}

async function resolveExistingPersonId(personId) {
  const resolved = await resolveAuditPersonId(personId);
  return resolved === null ? null : resolved;
}

async function orderQualityPrefixesMysql() {
  const rows = await mysqlQuery("SELECT prefix FROM order_quality_rules WHERE active != 0 ORDER BY prefix ASC");
  return rows.map((row) => String(row.prefix || "").trim()).filter(Boolean);
}

function buildOnlineProductPayload(shopId, item = {}) {
  return [
    Number(shopId),
    String(item.ozon_sku || ""),
    String(item.offer_id || ""),
    String(item.ozon_product_id || ""),
    String(item.name || ""),
    String(item.image_url || ""),
    String(item.primary_image || item.image_url || ""),
    Number(item.sale_price || 0),
    String(item.currency_code || "RUB"),
    Number(item.marketing_price || 0),
    Number(item.old_price || 0),
    String(item.status || "online"),
    String(item.visibility || ""),
    Number(item.archived || 0),
    Number(item.is_discounted || 0),
    String(item.images_json || ""),
    String(item.barcodes_json || ""),
    String(item.stocks_json || ""),
    String(item.commissions_json || ""),
    String(item.attributes_json || ""),
    String(item.raw_json || ""),
    normalizeMysqlDateTime(item.ozon_updated_at)
  ];
}

async function upsertOnlineProductDualWrite(shopId, item = {}) {
  const payload = buildOnlineProductPayload(shopId, item);
  await mysqlExecute(`
    INSERT INTO online_products
    (shop_id, ozon_sku, offer_id, ozon_product_id, name, image_url, primary_image, sale_price,
     currency_code, marketing_price, old_price, status, visibility, archived, is_discounted,
     images_json, barcodes_json, stocks_json, commissions_json, attributes_json, raw_json, ozon_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      offer_id = VALUES(offer_id),
      ozon_product_id = VALUES(ozon_product_id),
      name = VALUES(name),
      image_url = VALUES(image_url),
      primary_image = VALUES(primary_image),
      sale_price = VALUES(sale_price),
      currency_code = VALUES(currency_code),
      marketing_price = VALUES(marketing_price),
      old_price = VALUES(old_price),
      status = VALUES(status),
      visibility = VALUES(visibility),
      archived = VALUES(archived),
      is_discounted = VALUES(is_discounted),
      images_json = VALUES(images_json),
      barcodes_json = VALUES(barcodes_json),
      stocks_json = VALUES(stocks_json),
      commissions_json = VALUES(commissions_json),
      attributes_json = VALUES(attributes_json),
      raw_json = VALUES(raw_json),
      ozon_updated_at = VALUES(ozon_updated_at),
      synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `, payload);

  db.prepare(`
    INSERT INTO online_products
    (shop_id, ozon_sku, offer_id, ozon_product_id, name, image_url, primary_image, sale_price,
     currency_code, marketing_price, old_price, status, visibility, archived, is_discounted,
     images_json, barcodes_json, stocks_json, commissions_json, attributes_json, raw_json, ozon_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, ozon_sku) DO UPDATE SET
      offer_id = excluded.offer_id,
      ozon_product_id = excluded.ozon_product_id,
      name = excluded.name,
      image_url = excluded.image_url,
      primary_image = excluded.primary_image,
      sale_price = excluded.sale_price,
      currency_code = excluded.currency_code,
      marketing_price = excluded.marketing_price,
      old_price = excluded.old_price,
      status = excluded.status,
      visibility = excluded.visibility,
      archived = excluded.archived,
      is_discounted = excluded.is_discounted,
      images_json = excluded.images_json,
      barcodes_json = excluded.barcodes_json,
      stocks_json = excluded.stocks_json,
      commissions_json = excluded.commissions_json,
      attributes_json = excluded.attributes_json,
      raw_json = excluded.raw_json,
      ozon_updated_at = excluded.ozon_updated_at,
      synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(...payload);

  return await mysqlQueryOne("SELECT * FROM online_products WHERE shop_id = ? AND ozon_sku = ?", [Number(shopId), String(item.ozon_sku || "")]);
}

export async function currentExchangeRateMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQueryOne(`
    SELECT *
    FROM exchange_rates
    WHERE currency_from = 'CNY' AND currency_to = 'RUB'
    ORDER BY effective_date DESC, id DESC
    LIMIT 1
  `) || {
    currency_from: "CNY",
    currency_to: "RUB",
    rate: 11.32,
    source: "fallback",
    effective_date: todayDateKeyMysql(),
    note: "Fallback rate"
  };
}

async function exchangeRateForDateMysql(dateText = "") {
  ensureMysqlCutoverEnabled();
  const day = String(dateText || "").slice(0, 10);
  return await mysqlQueryOne(`
    SELECT *
    FROM exchange_rates
    WHERE currency_from = 'CNY' AND currency_to = 'RUB'
      AND (? = '' OR effective_date <= ?)
    ORDER BY effective_date DESC, id DESC
    LIMIT 1
  `, [day, day]) || await currentExchangeRateMysql();
}

export async function exchangeRatesMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT *
    FROM exchange_rates
    WHERE currency_from = 'CNY' AND currency_to = 'RUB'
    ORDER BY effective_date DESC, id DESC
    LIMIT 30
  `);
}

export async function updateExchangeRateMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const rate = Number(body.rate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Rate must be greater than 0");

  const effectiveDate = String(body.effective_date || todayDateKeyMysql()).slice(0, 10);
  const source = String(body.source || "manual");
  const note = String(body.note || "");

  const result = await mysqlExecute(`
    INSERT INTO exchange_rates (currency_from, currency_to, rate, source, effective_date, note)
    VALUES ('CNY', 'RUB', ?, ?, ?, ?)
  `, [rate, source, effectiveDate, note]);

  db.prepare(`
    INSERT INTO exchange_rates (id, currency_from, currency_to, rate, source, effective_date, note)
    VALUES (?, 'CNY', 'RUB', ?, ?, ?, ?)
  `).run(Number(result.insertId), rate, source, effectiveDate, note);

  return await currentExchangeRateMysql();
}

export async function packagingFeeRuleMysql() {
  ensureMysqlCutoverEnabled();
  const row = await mysqlQueryOne("SELECT value_json FROM system_settings WHERE `key` = ?", ["profit.packaging_fee_rule"]);
  if (!row?.value_json) return defaultPackagingFeeRule;

  try {
    return { ...defaultPackagingFeeRule, ...JSON.parse(row.value_json) };
  } catch {
    return defaultPackagingFeeRule;
  }
}

async function packagingFeeForSaleAmountMysql(saleAmountCny) {
  const rule = await packagingFeeRuleMysql();
  const threshold = Number(rule.low_sale_threshold_cny || 0);
  const lowFee = Number(rule.low_fee_cny || 0);
  const highFee = Number(rule.high_fee_cny || 0);
  return roundMoneyMysql(Number(saleAmountCny || 0) > threshold ? highFee : lowFee);
}

function resolveProfitSettlementStatusMysql(row = {}) {
  const values = [
    row.settlement_state,
    row.profit_status,
    row.status,
    row.order_status,
    row.tracking_stage,
    row.logistics_status
  ].map((value) => String(value || "").toLowerCase());
  if (Boolean(row.accrued_at) || values.some((value) => value === "accrued" || value.includes("accrued"))) return "accrued";
  if (Boolean(row.delivered_at) || values.some((value) => value === "delivered" || value === "posting_delivered" || value.includes("delivered"))) return "delivered";
  return "pending";
}

async function estimateOrderItemReturnLossMysql({ order, item, product, estimated, quantity, salePrice }) {
  const orderContext = {
    ...order,
    ...item,
    status: order?.status || item?.order_status,
    tracking_stage: order?.tracking_stage || item?.tracking_stage,
    logistics_status: order?.logistics_status || item?.logistics_status,
    delivered_at: order?.delivered_at,
    accrued_at: order?.accrued_at,
    cancelled_after_ship: order?.cancelled_after_ship
  };
  const outcome = classifyOrderOutcome(orderContext);
  const cancellation = describeCancellation({ ...orderContext, outcome_type: outcome });
  const qty = Number(quantity || item?.quantity || 1);
  const saleAmount = Number(salePrice || item?.sale_price || 0) * qty;
  return estimateOutcomeReturnLoss({
    outcome,
    lossProfileCode: cancellation.loss_profile_code,
    quantity: qty,
    purchaseCostPerUnit: Number(product?.purchase_cost || item?.frozen_purchase_cost || 0),
    domesticShippingPerUnit: Number(product?.domestic_shipping || item?.frozen_domestic_shipping || 0),
    internationalShippingPerUnit: Number(estimated?.freight ?? product?.international_shipping ?? item?.frozen_international_shipping ?? 0),
    packagingCostTotal: await packagingFeeForSaleAmountMysql(saleAmount),
    commissionFeeTotal: roundMoneyMysql(Number(estimated?.commission || 0)),
    collectingFeeTotal: roundMoneyMysql(Number(estimated?.paymentFee || 0)),
    finalMileFeeTotal: 0,
    serviceFeeTotal: roundMoneyMysql(Number(estimated?.withdrawalFee || 0)),
    returnRateLossTotal: Number(estimated?.expectedReturnLoss || 0)
  });
}

export async function packagingFeeRuleChangesMysql(limit = 20) {
  ensureMysqlCutoverEnabled();
  const rows = await mysqlQuery(`
    SELECT ssc.*, p.name AS updated_by_name
    FROM system_setting_changes ssc
    LEFT JOIN people p ON p.id = ssc.updated_by_person_id
    WHERE ssc.setting_key = 'profit.packaging_fee_rule'
    ORDER BY ssc.id DESC
    LIMIT ?
  `, [Math.max(1, Number(limit || 20))]);

  return rows.map((row) => ({
    ...row,
    old_value: parseJsonOrNull(row.old_value_json),
    new_value: parseJsonOrNull(row.new_value_json)
  }));
}

export async function updatePackagingFeeRuleMysql(body = {}, personId = null) {
  ensureMysqlCutoverEnabled();
  const previous = await packagingFeeRuleMysql();
  const next = {
    low_sale_threshold_cny: Number(body.low_sale_threshold_cny ?? defaultPackagingFeeRule.low_sale_threshold_cny),
    low_fee_cny: Number(body.low_fee_cny ?? defaultPackagingFeeRule.low_fee_cny),
    high_fee_cny: Number(body.high_fee_cny ?? defaultPackagingFeeRule.high_fee_cny)
  };

  if (!Number.isFinite(next.low_sale_threshold_cny) || next.low_sale_threshold_cny < 0) {
    throw new Error("low_sale_threshold_cny must be >= 0");
  }
  if (!Number.isFinite(next.low_fee_cny) || next.low_fee_cny < 0) {
    throw new Error("low_fee_cny must be >= 0");
  }
  if (!Number.isFinite(next.high_fee_cny) || next.high_fee_cny < 0) {
    throw new Error("high_fee_cny must be >= 0");
  }

  await withMysqlTransaction(async (connection) => {
    await connection.execute(`
      INSERT INTO system_settings (\`key\`, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        value_json = VALUES(value_json),
        updated_at = CURRENT_TIMESTAMP
    `, ["profit.packaging_fee_rule", JSON.stringify(next)]);

    const [changeResult] = await connection.execute(`
      INSERT INTO system_setting_changes (setting_key, old_value_json, new_value_json, updated_by_person_id)
      VALUES (?, ?, ?, ?)
    `, [
      "profit.packaging_fee_rule",
      JSON.stringify(previous),
      JSON.stringify(next),
      personId ? Number(personId) : null
    ]);

    db.prepare(`
      INSERT INTO system_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = CURRENT_TIMESTAMP
    `).run("profit.packaging_fee_rule", JSON.stringify(next));

    db.prepare(`
      INSERT INTO system_setting_changes (id, setting_key, old_value_json, new_value_json, updated_by_person_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      Number(changeResult.insertId),
      "profit.packaging_fee_rule",
      JSON.stringify(previous),
      JSON.stringify(next),
      personId ? Number(personId) : null
    );
  });

  return await packagingFeeRuleMysql();
}

export async function suppliersMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const dateFrom = String(query.dateFrom || query.date_from || "").slice(0, 10);
  const dateTo = String(query.dateTo || query.date_to || "").slice(0, 10);
  const cacheableDictionaryQuery = query.__skipCache !== "1" && paged && page === 1 && pageSize === 100 && !searchText && !dateFrom && !dateTo;
  if (cacheableDictionaryQuery) {
    return getCachedMasterData("suppliers:paged:100", () => suppliersMysql({ ...query, __skipCache: "1" }));
  }
  const where = ["s.status = 'active'"];
  const params = [];
  if (dateFrom) {
    where.push("DATE(COALESCE(s.created_at, s.updated_at)) >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push("DATE(COALESCE(s.created_at, s.updated_at)) <= ?");
    params.push(dateTo);
  }
  if (searchText) {
    const like = `%${searchText}%`;
    where.push("(LOWER(COALESCE(s.name, '')) LIKE ? OR LOWER(COALESCE(s.contact_person, '')) LIKE ? OR LOWER(COALESCE(s.contact_phone, '')) LIKE ? OR LOWER(COALESCE(s.wechat_id, '')) LIKE ? OR LOWER(COALESCE(s.business_note, '')) LIKE ?)");
    params.push(like, like, like, like, like);
  }
  const selectSql = `
    SELECT s.*,
      (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AS product_count
    FROM suppliers s
    WHERE ${where.join(" AND ")}
  `;
  if (!paged) {
    return await mysqlQuery(`
      ${selectSql}
      ORDER BY s.id DESC
    `, params);
  }
  const offset = (page - 1) * pageSize;
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`SELECT COUNT(*) AS total FROM (${selectSql}) supplier_rows`, params),
    mysqlQuery(`
      ${selectSql}
      ORDER BY s.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset])
  ]);
  return {
    rows,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

export async function createSupplierMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const name = requiredText(body.name, "Supplier name is required");
  const contactPerson = String(body.contact_person || "");
  const contactPhone = String(body.contact_phone || "");
  const wechatId = String(body.wechat_id || "");
  const businessNote = String(body.business_note || "");

  const result = await mysqlExecute(`
    INSERT INTO suppliers (name, contact_person, contact_phone, wechat_id, business_note, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `, [name, contactPerson, contactPhone, wechatId, businessNote]);

  db.prepare(`
    INSERT INTO suppliers (id, name, contact_person, contact_phone, wechat_id, business_note, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(Number(result.insertId), name, contactPerson, contactPhone, wechatId, businessNote);

  invalidateMasterDataCache("suppliers:paged:100");
  return { id: Number(result.insertId), name };
}

export async function updateSupplierMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const supplierId = Number(id);
  const existing = await mysqlQueryOne("SELECT * FROM suppliers WHERE id = ?", [supplierId]);
  if (!existing) throw new Error("Supplier not found");

  const payload = [
    String(body.name || existing.name),
    body.contact_person ?? existing.contact_person,
    body.contact_phone ?? existing.contact_phone,
    body.wechat_id ?? existing.wechat_id,
    body.business_note ?? existing.business_note,
    supplierId
  ];

  await mysqlExecute(`
    UPDATE suppliers SET
      name = ?, contact_person = ?, contact_phone = ?,
      wechat_id = ?, business_note = ?
    WHERE id = ?
  `, payload);

  db.prepare(`
    UPDATE suppliers SET
      name = ?, contact_person = ?, contact_phone = ?,
      wechat_id = ?, business_note = ?
    WHERE id = ?
  `).run(...payload);

  invalidateMasterDataCache("suppliers:paged:100");
  return { ok: true };
}

export async function deleteSupplierMysql(id) {
  ensureMysqlCutoverEnabled();
  const supplierId = Number(id);
  const linkedProducts = await mysqlQueryOne(
    "SELECT COUNT(*) AS count FROM products WHERE supplier_id = ? AND active = 1",
    [supplierId]
  );

  if (Number(linkedProducts?.count || 0) > 0) {
    throw new Error(`Supplier still has ${linkedProducts.count} active products`);
  }

  await mysqlExecute("UPDATE suppliers SET status = 'inactive' WHERE id = ?", [supplierId]);
  db.prepare("UPDATE suppliers SET status = 'inactive' WHERE id = ?").run(supplierId);
  invalidateMasterDataCache("suppliers:paged:100");
  return { ok: true };
}

export async function logisticsRulesMysql() {
  ensureMysqlCutoverEnabled();
  await ensureLogisticsRuleFilterSchemaMysql();
  return await mysqlQuery(`
    SELECT l.*,
      COALESCE((
        SELECT COUNT(DISTINCT sm.ozon_sku)
        FROM sku_mappings sm
        JOIN products p ON p.id = sm.product_id
        WHERE sm.active = 1 AND p.active = 1 AND p.logistics_rule_id = l.id
      ), 0) AS usage_count
    FROM logistics_fee_rules l
    ORDER BY l.enabled DESC, usage_count DESC, l.carrier, l.channel, l.min_weight_g, l.id
  `);
}

export async function createLogisticsRuleMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const name = requiredText(body.name, "Rule name is required");
  const payload = [
    name,
    body.carrier || "CEL",
    body.channel || "standard",
    body.mode || "per_gram",
    Number(body.min_weight_g || 0),
    Number(body.max_weight_g || 999999),
    Number(body.min_price_rub || 0),
    Number(body.max_price_rub || 999999999),
    Number(body.base_fee_cny || 0),
    Number(body.per_gram_cny || 0),
    Number(body.per_ticket_cny || 0),
    Number(body.enabled ?? 1),
    body.filter_keywords || "",
    Number(body.usage_count || 0),
    body.note || ""
  ];

  const result = await mysqlExecute(`
    INSERT INTO logistics_fee_rules
    (name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub, base_fee_cny, per_gram_cny, per_ticket_cny, enabled, filter_keywords, usage_count, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, payload);

  db.prepare(`
    INSERT INTO logistics_fee_rules
    (id, name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub, base_fee_cny, per_gram_cny, per_ticket_cny, enabled, filter_keywords, usage_count, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Number(result.insertId), ...payload);

  logisticsRuleFilterCacheMysql = null;
  invalidateMasterDataCache();
  return { id: Number(result.insertId) };
}

export async function updateLogisticsRuleMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const existing = await mysqlQueryOne("SELECT * FROM logistics_fee_rules WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("Logistics rule not found");

  const payload = [
    requiredText(body.name ?? existing.name, "Rule name is required"),
    body.carrier ?? existing.carrier,
    body.channel ?? existing.channel,
    body.mode ?? existing.mode,
    Number(body.min_weight_g ?? existing.min_weight_g),
    Number(body.max_weight_g ?? existing.max_weight_g),
    Number(body.min_price_rub ?? existing.min_price_rub),
    Number(body.max_price_rub ?? existing.max_price_rub),
    Number(body.base_fee_cny ?? existing.base_fee_cny),
    Number(body.per_gram_cny ?? existing.per_gram_cny),
    Number(body.per_ticket_cny ?? existing.per_ticket_cny),
    Number(body.enabled ?? existing.enabled),
    body.filter_keywords ?? existing.filter_keywords ?? "",
    Number(body.usage_count ?? existing.usage_count ?? 0),
    body.note ?? existing.note,
    Number(id)
  ];

  await mysqlExecute(`
    UPDATE logistics_fee_rules
    SET name = ?, carrier = ?, channel = ?, mode = ?, min_weight_g = ?, max_weight_g = ?,
      min_price_rub = ?, max_price_rub = ?, base_fee_cny = ?, per_gram_cny = ?, per_ticket_cny = ?,
      enabled = ?, filter_keywords = ?, usage_count = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, payload);

  db.prepare(`
    UPDATE logistics_fee_rules
    SET name = ?, carrier = ?, channel = ?, mode = ?, min_weight_g = ?, max_weight_g = ?,
      min_price_rub = ?, max_price_rub = ?, base_fee_cny = ?, per_gram_cny = ?, per_ticket_cny = ?,
      enabled = ?, filter_keywords = ?, usage_count = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...payload);

  logisticsRuleFilterCacheMysql = null;
  invalidateMasterDataCache();
  return { ok: true };
}

export async function deleteLogisticsRuleMysql(id) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("UPDATE logistics_fee_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  db.prepare("UPDATE logistics_fee_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id));
  logisticsRuleFilterCacheMysql = null;
  invalidateMasterDataCache();
  return { ok: true };
}

export async function incrementLogisticsRuleUsageMysql(id) {
  ensureMysqlCutoverEnabled();
  const ruleId = Number(id);
  if (!ruleId) return { ok: false };
  await mysqlExecute(`
    UPDATE logistics_fee_rules
    SET usage_count = COALESCE(usage_count, 0) + 1,
      last_used_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [ruleId]);
  db.prepare(`
    UPDATE logistics_fee_rules
    SET usage_count = COALESCE(usage_count, 0) + 1,
      last_used_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(ruleId);
  invalidateMasterDataCache();
  return { ok: true };
}

async function activeOrderLogisticsFilterMethodsMysql() {
  ensureMysqlCutoverEnabled();
  if (logisticsRuleFilterCacheMysql) return logisticsRuleFilterCacheMysql;
  await ensureLogisticsRuleFilterSchemaMysql();
  const rows = await mysqlQuery(`
    SELECT id, name, filter_keywords, carrier, channel, min_weight_g, usage_count
    FROM logistics_fee_rules
    WHERE enabled != 0
    ORDER BY usage_count DESC, carrier ASC, channel ASC, min_weight_g ASC, id ASC
  `);
  const rules = rows
    .map((row) => {
      const keywords = String(row.filter_keywords || "")
        .split(/\r?\n|[|｜]/)
        .map((item) => item.trim())
        .filter(Boolean);
      const fallbackKeywords = [row.name, row.carrier, row.channel]
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      const value = resolveOrderLogisticsRuleValue({
        name: row.name,
        channel: row.channel,
        carrier: row.carrier,
        warehousePatterns: keywords.length ? keywords : fallbackKeywords
      }) || `logistics_rule_${row.id}`;
      return {
        value,
        label: String(row.name || "").trim(),
        warehousePatterns: keywords.length ? keywords : fallbackKeywords,
        carrier: String(row.carrier || "").trim(),
        channel: String(row.channel || "").trim()
      };
    })
    .filter((rule) => rule.label);
  const mergedByValue = new Map(
    FALLBACK_ORDER_LOGISTICS_METHODS_MYSQL.map((rule) => [String(rule.value || "").trim(), { ...rule }])
  );
  for (const rule of rules) {
    const key = String(rule.value || "").trim();
    if (!key) continue;
    const current = mergedByValue.get(key);
    if (!current) {
      mergedByValue.set(key, rule);
      continue;
    }
    mergedByValue.set(key, {
      ...current,
      ...rule,
      warehousePatterns: [...new Set([...(current.warehousePatterns || []), ...(rule.warehousePatterns || [])])]
    });
  }
  logisticsRuleFilterCacheMysql = mergedByValue.size ? [...mergedByValue.values()] : FALLBACK_ORDER_LOGISTICS_METHODS_MYSQL;
  return logisticsRuleFilterCacheMysql;
}

async function activeOrderLogisticsRuleByLabelMysql(label) {
  const normalized = String(label || "").trim().toLowerCase();
  if (!normalized) return null;
  const rules = await activeOrderLogisticsFilterMethodsMysql();
  const exact = rules.find((rule) => String(rule.label || "").trim().toLowerCase() === normalized);
  if (exact) return exact;
  const fallbackValue = resolveOrderLogisticsRuleValue({ label });
  if (!fallbackValue) return null;
  return rules.find((rule) => String(rule.value || "").trim() === fallbackValue) || null;
}

async function matchOrderLogisticsRuleMysql(text) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("guoo economy budget")) {
    return await activeOrderLogisticsRuleByLabelMysql("GUOO 低客单轻小件");
  }
  if (normalized.includes("guoo economy small")) {
    return await activeOrderLogisticsRuleByLabelMysql("GUOO 轻小件");
  }
  if (normalized.includes("guoo economy extra small")) {
    return await activeOrderLogisticsRuleByLabelMysql("GUOO 超级轻小件");
  }
  if (normalized.includes("guoo")) return null;
  if (normalized.includes("hunchun") || normalized.includes("hch-pd") || normalized.includes("hch-cr") || normalized.includes("cel fbp")) {
    return await activeOrderLogisticsRuleByLabelMysql("CEL Hunchun 2");
  }
  if (normalized.includes("china post") || normalized.includes("邮政")) {
    return await activeOrderLogisticsRuleByLabelMysql("中国邮政 500g 以下");
  }
  if (normalized.includes("0.5-30kg")) {
    return await activeOrderLogisticsRuleByLabelMysql("CEL 陆运 0.5-30kg");
  }
  if (normalized.includes("500-25000g")) {
    return await activeOrderLogisticsRuleByLabelMysql("CEL 陆运经济 Budget");
  }
  if (normalized.includes("cel economy big") || normalized.includes("2-30kg")) {
    return await activeOrderLogisticsRuleByLabelMysql("CEL 陆运经济 Big");
  }
  if (normalized.includes("cel economy small")) {
    return await activeOrderLogisticsRuleByLabelMysql("CEL 陆运经济 Small");
  }
  if (normalized.includes("cel economy extra small") || normalized.includes("extra small economy")) {
    return await activeOrderLogisticsRuleByLabelMysql("CEL 陆运经济 Extra Small");
  }
  if (normalized.includes("cel standard extra small") || normalized.includes("extra small standard")) {
    return await activeOrderLogisticsRuleByLabelMysql("CEL 陆空标准 Extra Small");
  }
  const rules = await activeOrderLogisticsFilterMethodsMysql();
  for (const rule of rules) {
    const patterns = Array.isArray(rule.warehousePatterns) ? rule.warehousePatterns : [];
    if (patterns.some((pattern) => normalized.includes(String(pattern || "").toLowerCase()))) {
      return rule;
    }
  }
  return null;
}

function normalizeResolvedLogisticsRuleMysql(rule = null) {
  if (!rule) return null;
  const stableValue = resolveOrderLogisticsRuleValue({
    name: rule.label,
    channel: rule.channel,
    value: rule.value
  });
  return {
    ...rule,
    value: stableValue || rule.value || ""
  };
}
export async function orderCancellationRulesMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery("SELECT * FROM order_cancellation_rules ORDER BY enabled DESC, priority ASC, id ASC");
}

export async function createOrderCancellationRuleMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const payload = [
    requiredText(body.name, "Rule name is required"),
    requiredText(body.match_text, "match_text is required"),
    body.match_mode || "contains",
    body.initiator_label || "",
    body.reason_label || "",
    body.reason_code || "other",
    body.reason_group_label || "Other",
    body.accounting_hint || "",
    Number(body.priority ?? 100),
    Number(body.enabled ?? 1),
    body.note || ""
  ];

  const result = await mysqlExecute(`
    INSERT INTO order_cancellation_rules
    (name, match_text, match_mode, initiator_label, reason_label, reason_code, reason_group_label, accounting_hint, priority, enabled, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, payload);

  db.prepare(`
    INSERT INTO order_cancellation_rules
    (id, name, match_text, match_mode, initiator_label, reason_label, reason_code, reason_group_label, accounting_hint, priority, enabled, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Number(result.insertId), ...payload);

  invalidateOrderCancellationRuleCache();
  return { id: Number(result.insertId) };
}

export async function updateOrderCancellationRuleMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const existing = await mysqlQueryOne("SELECT * FROM order_cancellation_rules WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("Order cancellation rule not found");

  const payload = [
    requiredText(body.name ?? existing.name, "Rule name is required"),
    requiredText(body.match_text ?? existing.match_text, "match_text is required"),
    body.match_mode ?? existing.match_mode,
    body.initiator_label ?? existing.initiator_label,
    body.reason_label ?? existing.reason_label,
    body.reason_code ?? existing.reason_code,
    body.reason_group_label ?? existing.reason_group_label,
    body.accounting_hint ?? existing.accounting_hint,
    Number(body.priority ?? existing.priority),
    Number(body.enabled ?? existing.enabled),
    body.note ?? existing.note,
    Number(id)
  ];

  await mysqlExecute(`
    UPDATE order_cancellation_rules
    SET name = ?, match_text = ?, match_mode = ?, initiator_label = ?, reason_label = ?,
      reason_code = ?, reason_group_label = ?, accounting_hint = ?, priority = ?, enabled = ?, note = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, payload);

  db.prepare(`
    UPDATE order_cancellation_rules
    SET name = ?, match_text = ?, match_mode = ?, initiator_label = ?, reason_label = ?,
      reason_code = ?, reason_group_label = ?, accounting_hint = ?, priority = ?, enabled = ?, note = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...payload);

  invalidateOrderCancellationRuleCache();
  return { ok: true };
}

export async function deleteOrderCancellationRuleMysql(id) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("UPDATE order_cancellation_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  db.prepare("UPDATE order_cancellation_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id));
  invalidateOrderCancellationRuleCache();
  return { ok: true };
}

export async function testOrderCancellationRuleMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const sample = {
    status: body.status || "",
    substatus: body.substatus || "",
    tracking_stage: body.tracking_stage || "",
    logistics_status: body.logistics_status || "",
    cancel_reason: body.cancel_reason || "",
    cancel_type: body.cancel_type || "",
    cancel_initiator: body.cancel_initiator || "",
    raw_cancellation_reason: body.raw_cancellation_reason || "",
    cancel_reason_id: body.cancel_reason_id || "",
    cancelled_after_ship: Number(body.cancelled_after_ship || 0),
    delivered_at: body.delivered_at || "",
    accrued_at: body.accrued_at || ""
  };
  const outcome = classifyOrderOutcome(sample);
  const cancellation = describeCancellation({ ...sample, outcome_type: outcome });
  const text = Object.values(sample).join(" ").toLowerCase();
  const rules = await orderCancellationRulesMysql();
  const rule = rules.find((item) => {
    if (Number(item.enabled ?? 1) === 0) return false;
    const pattern = String(item.match_text || "").trim().toLowerCase();
    if (!pattern) return false;
    const mode = String(item.match_mode || "contains");
    if (mode === "equals") return text === pattern;
    if (mode === "starts_with") return text.startsWith(pattern);
    if (mode === "regex") {
      try {
        return new RegExp(pattern, "i").test(text);
      } catch {
        return false;
      }
    }
    return text.includes(pattern);
  }) || null;
  return {
    sample,
    outcome_type: outcome,
    cancellation,
    matched_rule: rule ? {
      id: Number(rule.id || 0),
      name: rule.name || "",
      match_text: rule.match_text || "",
      match_mode: rule.match_mode || "contains",
      priority: Number(rule.priority || 0)
    } : null
  };
}

export async function shopsMysql() {
  ensureMysqlCutoverEnabled();
  await ensureShopWatermarkSchemaMysql();
  await ensureShopAdvertisingCredentialSchemaMysql();
  return getCachedMasterData("shops", async () => {
    const rows = await mysqlQuery("SELECT * FROM shops WHERE status != 'deleted' ORDER BY id");
    return rows.map((row) => ({
      ...row,
      performance_client_secret: "",
      performance_client_secret_configured: Boolean(row.performance_client_secret)
    }));
  });
}

export async function peopleMysql() {
  ensureMysqlCutoverEnabled();
  return getCachedMasterData("people", () => mysqlQuery("SELECT * FROM people ORDER BY active DESC, id"));
}

export async function stockAlertsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const products = await getCachedMasterData("stock-alerts:base", async () => {
    const rows = await mysqlQuery(`
    SELECT p.id AS product_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0')) END AS inventory_id,
      p.name AS product_name, p.image_url, p.alert_stock, p.created_at,
      COALESCE(ic.available_stock, 0) AS local_stock,
      sm.id AS mapping_id, sm.shop_id, sm.ozon_sku, sm.offer_id, sm.display_name, sm.active,
      s.name AS shop_name,
      op.id AS online_product_id, op.ozon_product_id, op.name AS online_name, op.primary_image AS online_image, op.image_url AS online_image_url,
      COALESCE(stock.fbp_present, 0) AS fbp_present,
      COALESCE(stock.fbp_available, 0) AS fbp_available,
      COALESCE(stock.fbs_present, 0) AS fbs_present,
      COALESCE(stock.fbs_available, 0) AS fbs_available,
      COALESCE(stock.unknown_present, 0) AS unknown_present,
      COALESCE(stock.fbp_snapshot_count, 0) AS fbp_snapshot_count,
      COALESCE(stock.fbs_snapshot_count, 0) AS fbs_snapshot_count,
      stock.last_synced_at,
      stock.warehouse_breakdown,
      COALESCE(sales.recent_3d_qty, 0) AS recent_3d_qty,
      COALESCE(sales.recent_7d_qty, 0) AS recent_7d_qty,
      COALESCE(sales.recent_30d_qty, 0) AS recent_30d_qty,
      COALESCE(sales.prev_7d_qty, 0) AS prev_7d_qty,
      COALESCE(sales.all_time_qty, 0) AS all_time_qty
    FROM products p
    LEFT JOIN inventory_current ic ON ic.real_product_id = p.id
    LEFT JOIN sku_mappings sm ON sm.product_id = p.id AND sm.active = 1
    LEFT JOIN shops s ON s.id = sm.shop_id
    LEFT JOIN online_products op ON op.id = sm.online_product_id OR (op.shop_id = sm.shop_id AND op.ozon_sku = sm.ozon_sku)
    LEFT JOIN (
      SELECT shop_id, ozon_sku,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN available ELSE 0 END) AS fbp_available,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN available ELSE 0 END) AS fbs_available,
        SUM(CASE WHEN stock_type = 'unknown' THEN present ELSE 0 END) AS unknown_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN 1 ELSE 0 END) AS fbp_snapshot_count,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN 1 ELSE 0 END) AS fbs_snapshot_count,
        MAX(synced_at) AS last_synced_at,
        GROUP_CONCAT(CONCAT(warehouse_name, ':', present, '/', available, ':', stock_type) SEPARATOR '||') AS warehouse_breakdown
      FROM ozon_stock_snapshots
      GROUP BY shop_id, ozon_sku
    ) stock ON stock.shop_id = sm.shop_id AND stock.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku,
        SUM(CASE WHEN ${chinaDateSqlMysql("o.ordered_at")} >= ? THEN oi.quantity ELSE 0 END) AS recent_3d_qty,
        SUM(CASE WHEN ${chinaDateSqlMysql("o.ordered_at")} >= ? THEN oi.quantity ELSE 0 END) AS recent_7d_qty,
        SUM(CASE WHEN ${chinaDateSqlMysql("o.ordered_at")} >= ? THEN oi.quantity ELSE 0 END) AS recent_30d_qty,
        SUM(CASE WHEN ${chinaDateSqlMysql("o.ordered_at")} >= ? AND ${chinaDateSqlMysql("o.ordered_at")} < ? THEN oi.quantity ELSE 0 END) AS prev_7d_qty,
        SUM(oi.quantity) AS all_time_qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE LOWER(o.status) NOT LIKE '%cancel%'
        AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
      GROUP BY o.shop_id, oi.ozon_sku
    ) sales ON sales.shop_id = sm.shop_id AND sales.ozon_sku = sm.ozon_sku
    WHERE p.active = 1
    ORDER BY p.id DESC, s.id, sm.ozon_sku
  `, [dateKeyDaysAgoMysql(3), dateKeyDaysAgoMysql(7), dateKeyDaysAgoMysql(30), dateKeyDaysAgoMysql(14), dateKeyDaysAgoMysql(7)]);

    const productsMap = new Map();
    for (const row of rows) {
      const productId = Number(row.product_id);
      if (!productsMap.has(productId)) {
        productsMap.set(productId, {
          product_id: productId,
          inventory_id: row.inventory_id,
          product_name: row.product_name,
          image_url: row.image_url,
          alert_stock: Number(row.alert_stock || 0),
          local_stock: Number(row.local_stock || 0),
          created_at: row.created_at,
          skus: [],
          fbp_total: 0,
          fbs_total: 0,
          unknown_total: 0,
          recent_7d_qty: 0,
          recent_3d_qty: 0,
          recent_30d_qty: 0,
          prev_7d_qty: 0,
          all_time_qty: 0,
          fbp_sku_count: 0,
          fbp_zero_sku_count: 0,
          fbs_zero_sku_count: 0,
          fbs_low_sku_count: 0,
          fbs_low_threshold: 10,
          last_synced_at: row.last_synced_at || ""
        });
      }
      const product = productsMap.get(productId);
      if (!row.mapping_id) continue;
      const sku = {
        mapping_id: row.mapping_id,
        shop_id: row.shop_id,
        shop_name: row.shop_name,
        ozon_sku: row.ozon_sku,
        offer_id: row.offer_id,
        name: row.online_name || row.display_name || row.ozon_sku,
        image_url: row.online_image || row.online_image_url || "",
        fbp_present: Number(row.fbp_present || 0),
        fbp_available: Number(row.fbp_available || 0),
        fbs_present: Number(row.fbs_present || 0),
        fbs_available: Number(row.fbs_available || 0),
        fbs_low_threshold: 10,
        unknown_present: Number(row.unknown_present || 0),
        fbp_snapshot_count: Number(row.fbp_snapshot_count || 0),
        fbs_snapshot_count: Number(row.fbs_snapshot_count || 0),
        recent_3d_qty: Number(row.recent_3d_qty || 0),
        recent_7d_qty: Number(row.recent_7d_qty || 0),
        recent_30d_qty: Number(row.recent_30d_qty || 0),
        prev_7d_qty: Number(row.prev_7d_qty || 0),
        all_time_qty: Number(row.all_time_qty || 0),
        last_synced_at: row.last_synced_at || "",
        warehouses: parseWarehouseBreakdown(row.warehouse_breakdown)
      };
      product.skus.push(sku);
      product.fbp_total += sku.fbp_present;
      product.fbs_total += sku.fbs_present;
      product.unknown_total += sku.unknown_present;
      product.recent_3d_qty += sku.recent_3d_qty;
      product.recent_7d_qty += sku.recent_7d_qty;
      product.recent_30d_qty += sku.recent_30d_qty;
      product.prev_7d_qty += sku.prev_7d_qty;
      product.all_time_qty += sku.all_time_qty;
      if (sku.fbp_snapshot_count > 0) {
        product.fbp_sku_count += 1;
        if (sku.fbp_present <= 0) product.fbp_zero_sku_count += 1;
      }
      if (sku.fbs_snapshot_count > 0) {
        if (sku.fbs_present <= 0) product.fbs_zero_sku_count += 1;
        if (sku.fbs_present < 10) product.fbs_low_sku_count += 1;
      }
      product.last_synced_at = maxTextDate(product.last_synced_at, sku.last_synced_at);
    }

    return [...productsMap.values()].map((product) => withStockAlertStatus(product));
  }, STOCK_ALERT_BASE_CACHE_TTL_MS);

  return applyStockAlertQuery(products, query);
}

export async function createPersonMysql(body = {}, hashPassword) {
  ensureMysqlCutoverEnabled();
  const payload = [
    body.name,
    body.username || null,
    body.role || "operator",
    Number(body.active ?? 1),
    hashPassword(body.password || "123456")
  ];

  const result = await mysqlExecute(
    "INSERT INTO people (name, username, role, active, password_hash) VALUES (?, ?, ?, ?, ?)",
    payload
  );

  db.prepare(`
    INSERT INTO people (id, name, username, role, active, password_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Number(result.insertId), ...payload);

  invalidateMasterDataCache("people");
  return { ok: true, id: Number(result.insertId) };
}

export async function updatePersonMysql(id, body = {}, hashPassword) {
  ensureMysqlCutoverEnabled();
  const personId = Number(id);
  const payload = [
    body.name,
    body.username || null,
    body.role || "operator",
    Number(body.active ?? 1),
    personId
  ];

  await mysqlExecute("UPDATE people SET name = ?, username = ?, role = ?, active = ? WHERE id = ?", payload);
  db.prepare("UPDATE people SET name = ?, username = ?, role = ?, active = ? WHERE id = ?").run(...payload);

  if (String(body.password || "").trim()) {
    const passwordHash = hashPassword(String(body.password));
    await mysqlExecute("UPDATE people SET password_hash = ? WHERE id = ?", [passwordHash, personId]);
    db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(passwordHash, personId);
  }

  invalidateMasterDataCache("people");
  return { ok: true };
}

export async function deletePersonMysql(id) {
  ensureMysqlCutoverEnabled();
  const personId = Number(id);
  await mysqlExecute("UPDATE people SET active = 0 WHERE id = ?", [personId]);
  db.prepare("UPDATE people SET active = 0 WHERE id = ?").run(personId);
  invalidateMasterDataCache("people");
  return { ok: true };
}

export async function hardDeletePersonMysql(id) {
  ensureMysqlCutoverEnabled();
  const personId = Number(id);
  const existing = await mysqlQueryOne("SELECT id FROM people WHERE id = ?", [personId]);
  if (!existing) throw new Error("Person not found");

  await withMysqlTransaction(async (connection) => {
    const cleanupStatements = [
      ["UPDATE products SET owner_person_id = NULL WHERE owner_person_id = ?", [personId]],
      ["UPDATE products SET created_by_person_id = NULL WHERE created_by_person_id = ?", [personId]],
      ["UPDATE sku_mappings SET person_id = NULL WHERE person_id = ?", [personId]],
      ["UPDATE procurement_requests SET person_id = NULL WHERE person_id = ?", [personId]],
      ["UPDATE inbound_records SET person_id = NULL WHERE person_id = ?", [personId]],
      ["UPDATE outbound_records SET person_id = NULL WHERE person_id = ?", [personId]],
      ["UPDATE inventory_movements SET owner_person_id = NULL WHERE owner_person_id = ?", [personId]],
      ["DELETE FROM people WHERE id = ?", [personId]]
    ];

    for (const [sql, params] of cleanupStatements) {
      await connection.execute(sql, params);
      db.prepare(sql).run(...params);
    }
  });

  invalidateMasterDataCache("people");
  return { ok: true };
}

export async function createShopMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureShopWatermarkSchemaMysql();
  await ensureShopAdvertisingCredentialSchemaMysql();
  const performanceSecret = String(body.performance_client_secret || "").trim();
  const payload = [
    body.name,
    body.legal_entity || "",
    body.ozon_client_id || "",
    body.api_key_hint || "",
    body.ozon_api_key || body.api_key_hint || "",
    body.performance_client_id || "",
    performanceSecret,
    performanceSecret ? maskSecret(performanceSecret) : "",
    normalizeWatermarkPosition(body.watermark_position),
    clampMysqlNumber(body.watermark_x_percent, 0, 100, 75),
    clampMysqlNumber(body.watermark_y_percent, 0, 100, 75),
    clampMysqlNumber(body.watermark_scale_percent, 8, 45, 22),
    clampMysqlNumber(body.watermark_opacity_percent, 10, 100, 82),
    Number(body.payout_rate || 0.33)
  ];

  const result = await mysqlExecute(`
    INSERT INTO shops (
      name, legal_entity, ozon_client_id, api_key_hint, ozon_api_key, performance_client_id, performance_client_secret, performance_client_secret_hint,
      watermark_position, watermark_x_percent, watermark_y_percent, watermark_scale_percent, watermark_opacity_percent,
      payout_rate
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, payload);

  db.prepare(`
    INSERT INTO shops (
      id, name, legal_entity, ozon_client_id, api_key_hint, ozon_api_key, performance_client_id, performance_client_secret, performance_client_secret_hint,
      watermark_position, watermark_x_percent, watermark_y_percent, watermark_scale_percent, watermark_opacity_percent,
      payout_rate
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Number(result.insertId), ...payload);

  invalidateMasterDataCache("shops");
  return { ok: true, id: Number(result.insertId) };
}

export async function updateShopMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureShopWatermarkSchemaMysql();
  await ensureShopAdvertisingCredentialSchemaMysql();
  const existing = await mysqlQueryOne("SELECT * FROM shops WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("Shop not found");
  const nextPerformanceSecret = String(body.performance_client_secret || "").trim()
    || String(existing.performance_client_secret || "");

  const payload = [
    body.name,
    body.legal_entity || "",
    body.ozon_client_id || "",
    body.api_key_hint || existing.api_key_hint || "",
    body.ozon_api_key || existing.ozon_api_key || body.api_key_hint || existing.api_key_hint || "",
    body.performance_client_id || "",
    nextPerformanceSecret,
    nextPerformanceSecret ? maskSecret(nextPerformanceSecret) : "",
    body.status || "active",
    normalizeWatermarkPosition(body.watermark_position || existing.watermark_position),
    clampMysqlNumber(body.watermark_x_percent ?? existing.watermark_x_percent, 0, 100, 75),
    clampMysqlNumber(body.watermark_y_percent ?? existing.watermark_y_percent, 0, 100, 75),
    clampMysqlNumber(body.watermark_scale_percent ?? existing.watermark_scale_percent, 8, 45, 22),
    clampMysqlNumber(body.watermark_opacity_percent ?? existing.watermark_opacity_percent, 10, 100, 82),
    Number(body.payout_rate || 0.33),
    Number(id)
  ];

  await mysqlExecute(`
    UPDATE shops SET
      name = ?, legal_entity = ?, ozon_client_id = ?, api_key_hint = ?, ozon_api_key = ?,
      performance_client_id = ?, performance_client_secret = ?, performance_client_secret_hint = ?, status = ?,
      watermark_position = ?, watermark_x_percent = ?, watermark_y_percent = ?, watermark_scale_percent = ?, watermark_opacity_percent = ?,
      payout_rate = ?
    WHERE id = ?
  `, payload);

  db.prepare(`
    UPDATE shops SET
      name = ?, legal_entity = ?, ozon_client_id = ?, api_key_hint = ?, ozon_api_key = ?,
      performance_client_id = ?, performance_client_secret = ?, performance_client_secret_hint = ?, status = ?,
      watermark_position = ?, watermark_x_percent = ?, watermark_y_percent = ?, watermark_scale_percent = ?, watermark_opacity_percent = ?,
      payout_rate = ?
    WHERE id = ?
  `).run(...payload);

  invalidateMasterDataCache("shops");
  return { ok: true };
}

function normalizeWatermarkPosition(value) {
  const position = String(value || "bottom-right");
  return ["top-left", "top-right", "bottom-left", "bottom-right", "center", "custom"].includes(position)
    ? position
    : "bottom-right";
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function clampMysqlNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export async function deleteShopMysql(id) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("UPDATE shops SET status = 'deleted' WHERE id = ?", [Number(id)]);
  db.prepare("UPDATE shops SET status = 'deleted' WHERE id = ?").run(Number(id));
  invalidateMasterDataCache("shops");
  return { ok: true };
}

export async function createSessionMysql(session) {
  ensureMysqlCutoverEnabled();
  const expiresAt = normalizeMysqlDateTime(session.expiresAt);

  await mysqlExecute(`
    INSERT INTO sessions (token, person_id, name, role, username, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [session.token, session.personId, session.name, session.role, session.username || null, expiresAt]);

  db.prepare(`
    INSERT INTO sessions (token, person_id, name, role, username, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(session.token, session.personId, session.name, session.role, session.username || null, expiresAt);

  return session.token;
}

export async function getSessionMysql(token) {
  ensureMysqlCutoverEnabled();
  const row = await mysqlQueryOne("SELECT * FROM sessions WHERE token = ?", [token]);
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await destroySessionMysql(token);
    return null;
  }

  return {
    personId: row.person_id,
    name: row.name,
    role: row.role,
    username: row.username,
    createdAt: new Date(row.created_at).getTime()
  };
}

export async function destroySessionMysql(token) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("DELETE FROM sessions WHERE token = ?", [token]);
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export async function cleanExpiredSessionsMysql() {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP");
  db.prepare("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP").run();
}

export async function findPersonForLoginMysql(username) {
  ensureMysqlCutoverEnabled();
  return await mysqlQueryOne(
    "SELECT id, name, username, role, password_hash, active FROM people WHERE username = ?",
    [username]
  );
}

export async function findPersonByIdMysql(personId) {
  ensureMysqlCutoverEnabled();
  return await mysqlQueryOne(
    "SELECT id, name, username, role, active, password_hash FROM people WHERE id = ?",
    [personId]
  );
}

export async function updatePersonPasswordMysql(personId, passwordHash) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("UPDATE people SET password_hash = ? WHERE id = ?", [passwordHash, personId]);
  db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(passwordHash, personId);
}

export async function stockWarehouseRulesMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT *
    FROM stock_warehouse_rules
    ORDER BY enabled DESC, priority ASC, id ASC
  `);
}

export async function createStockWarehouseRuleMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const pattern = requiredText(body.pattern, "Pattern is required");
  const stockType = String(body.stock_type || "unknown").trim() || "unknown";
  const priority = Number(body.priority || 100);
  const enabled = body.enabled === undefined ? 1 : Number(body.enabled ? 1 : 0);
  const note = String(body.note || "");

  await mysqlExecute(`
    INSERT INTO stock_warehouse_rules (pattern, stock_type, priority, enabled, note)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      stock_type = VALUES(stock_type),
      priority = VALUES(priority),
      enabled = VALUES(enabled),
      note = VALUES(note),
      updated_at = CURRENT_TIMESTAMP
  `, [pattern, stockType, priority, enabled, note]);

  const mysqlRow = await mysqlQueryOne("SELECT id FROM stock_warehouse_rules WHERE pattern = ?", [pattern]);
  const legacyExisting = db.prepare("SELECT id FROM stock_warehouse_rules WHERE pattern = ?").get(pattern);

  if (legacyExisting) {
    db.prepare(`
      UPDATE stock_warehouse_rules
      SET stock_type = ?, priority = ?, enabled = ?, note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(stockType, priority, enabled, note, legacyExisting.id);
  } else {
    db.prepare(`
      INSERT INTO stock_warehouse_rules (id, pattern, stock_type, priority, enabled, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Number(mysqlRow.id), pattern, stockType, priority, enabled, note);
  }

  return { ok: true, id: Number(mysqlRow.id), rules: await stockWarehouseRulesMysql() };
}

export async function updateStockWarehouseRuleMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const existing = await mysqlQueryOne("SELECT * FROM stock_warehouse_rules WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("Stock warehouse rule not found");

  const payload = [
    requiredText(body.pattern ?? existing.pattern, "Pattern is required"),
    String(body.stock_type ?? existing.stock_type ?? "unknown").trim() || "unknown",
    Number(body.priority ?? existing.priority),
    body.enabled === undefined ? Number(existing.enabled) : Number(body.enabled ? 1 : 0),
    body.note ?? existing.note,
    Number(id)
  ];

  await mysqlExecute(`
    UPDATE stock_warehouse_rules
    SET pattern = ?, stock_type = ?, priority = ?, enabled = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, payload);

  db.prepare(`
    UPDATE stock_warehouse_rules
    SET pattern = ?, stock_type = ?, priority = ?, enabled = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...payload);

  return { ok: true, rules: await stockWarehouseRulesMysql() };
}

export async function deleteStockWarehouseRuleMysql(id) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("UPDATE stock_warehouse_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  db.prepare("UPDATE stock_warehouse_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id));
  return { ok: true, rules: await stockWarehouseRulesMysql() };
}

function snapshotStockNumberMysql(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

function normalizeStockTypeMysql(value) {
  const text = String(value || "").trim();
  if (["fbs_virtual", "fbp_real", "unknown"].includes(text)) return text;
  if (text.toLowerCase().includes("fbs")) return "fbs_virtual";
  if (text.toLowerCase().includes("fbp") || text.toLowerCase().includes("fbo")) return "fbp_real";
  return "unknown";
}

function classifyStockSnapshotMysql(stock = {}, warehouseName = "") {
  const text = `${stock.stock_type || ""} ${stock.type || ""} ${stock.delivery_schema || ""} ${stock.source || ""} ${stock.warehouse_name || ""} ${stock.name || ""} ${warehouseName || ""}`.toLowerCase();
  if (text.includes("fbo") || text.includes("fbp") || text.includes("cel") || text.includes("cl ") || text.includes("hunchun") || text.includes("娣锋槬") || text.includes("闄嗙┖")) return "fbp_real";
  if (text.includes("fbs") || text.includes("rfbs") || text.includes("seller") || text.includes("virtual")) return "fbs_virtual";
  return "unknown";
}

function resolveStockTypeMysql(row = {}) {
  const text = `${row.stock_type || ""} ${row.type || ""} ${row.delivery_schema || ""} ${row.source || ""} ${row.warehouse_name || ""} ${row.name || ""} ${row.raw_json || ""}`.toLowerCase();
  const rules = row.rules || [];
  for (const rule of rules) {
    const pattern = String(rule.pattern || "").trim().toLowerCase();
    if (pattern && text.includes(pattern)) return normalizeStockTypeMysql(rule.stock_type);
  }
  return classifyStockSnapshotMysql(row, row.warehouse_name);
}

async function stockWarehouseRulesEnabledMysql() {
  return (await stockWarehouseRulesMysql()).filter((rule) => Number(rule.enabled) !== 0);
}

async function stockSyncFiltersMysql(shopId, productId) {
  if (!productId) return {};
  const rows = await mysqlQuery(`
    SELECT DISTINCT op.ozon_product_id, sm.offer_id
    FROM sku_mappings sm
    LEFT JOIN online_products op ON op.id = sm.online_product_id OR (op.shop_id = sm.shop_id AND op.ozon_sku = sm.ozon_sku)
    WHERE sm.active = 1 AND sm.shop_id = ? AND sm.product_id = ?
  `, [Number(shopId), Number(productId)]);
  return {
    productIds: rows.map((row) => Number(row.ozon_product_id || 0)).filter(Boolean),
    offerIds: rows.map((row) => row.offer_id).filter(Boolean)
  };
}

async function fallbackStockRowsFromOnlineProductsMysql(shopId, productId = null) {
  const params = [Number(shopId)];
  const productWhere = productId ? "AND sm.product_id = ?" : "";
  if (productId) params.push(Number(productId));
  const rows = await mysqlQuery(`
    SELECT op.*, sm.product_id
    FROM online_products op
    LEFT JOIN sku_mappings sm ON sm.shop_id = op.shop_id AND sm.ozon_sku = op.ozon_sku AND sm.active = 1
    WHERE op.shop_id = ? ${productWhere}
  `, params);
  const result = [];
  for (const row of rows) {
    const stocks = parseJsonOrNull(row.stocks_json) || [];
    const list = Array.isArray(stocks) ? stocks : [stocks];
    if (!list.length) continue;
    list.forEach((stock, index) => {
      const warehouseName = String(stock?.warehouse_name || stock?.name || stock?.source || stock?.delivery_schema || stock?.type || "Ozon");
      result.push({
        ozon_product_id: row.ozon_product_id || "",
        offer_id: row.offer_id || "",
        ozon_sku: row.ozon_sku,
        warehouse_id: String(stock?.warehouse_id || stock?.source_id || stock?.id || stock?.type || index),
        warehouse_name: warehouseName,
        stock_type: classifyStockSnapshotMysql(stock, warehouseName),
        present: snapshotStockNumberMysql(stock?.present ?? stock?.stock ?? stock?.quantity ?? stock?.available_stock ?? stock?.available),
        reserved: snapshotStockNumberMysql(stock?.reserved ?? stock?.reserved_stock),
        available: snapshotStockNumberMysql(stock?.available ?? stock?.free_to_sell_amount ?? stock?.present ?? stock?.stock ?? stock?.quantity),
        raw_json: JSON.stringify(stock || {})
      });
    });
  }
  return result;
}

async function upsertStockSnapshotMysql(shopId, row) {
  const online = await mysqlQueryOne(`
    SELECT op.id AS online_product_id, sm.product_id
    FROM online_products op
    LEFT JOIN sku_mappings sm ON sm.shop_id = op.shop_id AND sm.ozon_sku = op.ozon_sku AND sm.active = 1
    WHERE op.shop_id = ? AND (op.ozon_sku = ? OR op.offer_id = ? OR op.ozon_product_id = ?)
    ORDER BY CASE WHEN op.ozon_sku = ? THEN 0 ELSE 1 END, op.id DESC
    LIMIT 1
  `, [
    Number(shopId),
    String(row.ozon_sku || ""),
    String(row.offer_id || ""),
    String(row.ozon_product_id || ""),
    String(row.ozon_sku || "")
  ]) || {};
  const stockType = resolveStockTypeMysql({ ...row, rules: await stockWarehouseRulesEnabledMysql() });
  const normalizedSku = String(row.ozon_sku || row.offer_id || row.ozon_product_id || "");
  const warehouseId = String(row.warehouse_id || row.warehouse_name || "default");
  await mysqlExecute(`
    DELETE FROM ozon_stock_snapshots
    WHERE shop_id = ? AND ozon_sku = ? AND warehouse_id = ? AND stock_type != ?
  `, [Number(shopId), normalizedSku, warehouseId, stockType]);
  await mysqlExecute(`
    INSERT INTO ozon_stock_snapshots
    (shop_id, online_product_id, product_id, ozon_product_id, ozon_sku, offer_id, warehouse_id, warehouse_name, stock_type, present, reserved, available, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      online_product_id = VALUES(online_product_id),
      product_id = VALUES(product_id),
      ozon_product_id = VALUES(ozon_product_id),
      offer_id = VALUES(offer_id),
      warehouse_name = VALUES(warehouse_name),
      present = VALUES(present),
      reserved = VALUES(reserved),
      available = VALUES(available),
      raw_json = VALUES(raw_json),
      synced_at = CURRENT_TIMESTAMP
  `, [
    Number(shopId),
    online.online_product_id || null,
    online.product_id || null,
    String(row.ozon_product_id || ""),
    normalizedSku,
    String(row.offer_id || ""),
    warehouseId,
    String(row.warehouse_name || "Ozon"),
    stockType,
    snapshotStockNumberMysql(row.present),
    snapshotStockNumberMysql(row.reserved),
    snapshotStockNumberMysql(row.available ?? row.present),
    row.raw_json || JSON.stringify(row)
  ]);
}

async function reclassifyStockSnapshotsMysql() {
  const rows = await mysqlQuery("SELECT id, stock_type, warehouse_name, raw_json FROM ozon_stock_snapshots");
  for (const row of rows) {
    const raw = parseJsonOrNull(row.raw_json) || {};
    const nextType = resolveStockTypeMysql({ ...raw, warehouse_name: row.warehouse_name, stock_type: "" });
    if (nextType !== row.stock_type) {
      await mysqlExecute("UPDATE ozon_stock_snapshots SET stock_type = ? WHERE id = ?", [nextType, row.id]);
    }
  }
}

export async function syncOzonStocksMysql(body = {}, options = {}) {
  ensureMysqlCutoverEnabled();
  const targetShopId = nullableNumber(body.shop_id);
  const productId = nullableNumber(body.product_id);
  const activeShops = (await shopsMysql()).filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  let fetched = 0;
  let upserted = 0;
  const errors = [];
  for (const shop of activeShops) {
    try {
      const filters = await stockSyncFiltersMysql(shop.id, productId);
      let rows = await fetchOzonProductStocks(shop, { ...filters, signal: options.signal });
      if (!rows.length) rows = await fallbackStockRowsFromOnlineProductsMysql(shop.id, productId);
      fetched += rows.length;
      for (const row of rows) {
        await upsertStockSnapshotMysql(shop.id, row);
        upserted += 1;
      }
    } catch (error) {
      const fallbackRows = await fallbackStockRowsFromOnlineProductsMysql(shop.id, productId);
      if (fallbackRows.length) {
        fetched += fallbackRows.length;
        for (const row of fallbackRows) {
          await upsertStockSnapshotMysql(shop.id, row);
          upserted += 1;
        }
        errors.push(`${shop.name}: Ozon stock API failed, used local stock cache (${error.message})`);
      } else {
        errors.push(`${shop.name}: ${error.message}`);
      }
    }
  }
  await reclassifyStockSnapshotsMysql();
  invalidateMasterDataCache("stock-alerts:base");
  const status = errors.length ? "partial_error" : "ok";
  const message = `Fetched ${fetched}, upserted ${upserted}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  return { status, fetched, upserted, errors, message, alerts: await stockAlertsMysql() };
}

export async function orderQualityRulesMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery("SELECT * FROM order_quality_rules ORDER BY active DESC, prefix ASC, id ASC");
}

export async function saveOrderQualityRulesMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const prefixes = Array.isArray(body.prefixes)
    ? body.prefixes
    : String(body.prefixes || "").split(/[\s,;，；]+/);
  const cleaned = [...new Set(prefixes.map((item) => String(item || "").trim()).filter(Boolean))];
  const label = "quality_check";
  const note = String(body.note || "Suspected Ozon warehouse quality check order.");

  await mysqlExecute("UPDATE order_quality_rules SET active = 0, updated_at = CURRENT_TIMESTAMP");
  db.prepare("UPDATE order_quality_rules SET active = 0, updated_at = CURRENT_TIMESTAMP").run();

  for (const prefix of cleaned) {
    await mysqlExecute(`
      INSERT INTO order_quality_rules (prefix, label, note, active, updated_at)
      VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        label = VALUES(label),
        note = VALUES(note),
        active = 1,
        updated_at = CURRENT_TIMESTAMP
    `, [prefix, label, note]);

    const mysqlRow = await mysqlQueryOne("SELECT id FROM order_quality_rules WHERE prefix = ?", [prefix]);
    const legacyExisting = db.prepare("SELECT id FROM order_quality_rules WHERE prefix = ?").get(prefix);

    if (legacyExisting) {
      db.prepare(`
        UPDATE order_quality_rules
        SET label = ?, note = ?, active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(label, note, legacyExisting.id);
    } else {
      db.prepare(`
        INSERT INTO order_quality_rules (id, prefix, label, note, active, updated_at)
        VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      `).run(Number(mysqlRow.id), prefix, label, note);
    }
  }

  return { ok: true, rules: await orderQualityRulesMysql() };
}

export async function updateOrderMarkMysql(orderId, body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const id = Number(orderId);
  const order = await mysqlQueryOne("SELECT id FROM orders WHERE id = ?", [id]);
  if (!order) throw new Error("Order not found");
  const auditPersonId = await resolveAuditPersonId(userId);

  const markType = String(body.mark_type || "").trim();
  const note = String(body.note || "").trim();

  if (!markType && !note) {
    await mysqlExecute("DELETE FROM order_marks WHERE order_id = ?", [id]);
    db.prepare("DELETE FROM order_marks WHERE order_id = ?").run(id);
    return { ok: true, id, mark_type: "", note: "" };
  }

  await mysqlExecute(`
    INSERT INTO order_marks (order_id, mark_type, note, updated_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      mark_type = VALUES(mark_type),
      note = VALUES(note),
      updated_by_person_id = VALUES(updated_by_person_id),
      updated_at = CURRENT_TIMESTAMP
  `, [id, markType, note, auditPersonId]);

  db.prepare(`
    INSERT INTO order_marks (order_id, mark_type, note, updated_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(order_id) DO UPDATE SET
      mark_type = excluded.mark_type,
      note = excluded.note,
      updated_by_person_id = excluded.updated_by_person_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, markType, note, auditPersonId);

  return { ok: true, id, mark_type: markType, note };
}

export async function markOrderLabelsPrintedMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  await ensureOrderLabelPrintSchemaMysql();
  const ids = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  if (!ids.length) throw new Error("Select orders to mark as printed");
  const rows = await mysqlQuery(`SELECT id FROM orders WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  if (!rows.length) throw new Error("Order not found");
  const personId = await resolveExistingPersonId(userId);
  const batchId = `print-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const inputOrder = new Map(ids.map((id, index) => [String(id), index + 1]));
  const orderedRows = [...rows].sort((a, b) => (inputOrder.get(String(a.id)) ?? 0) - (inputOrder.get(String(b.id)) ?? 0));
  for (const row of orderedRows) {
    await mysqlExecute(`
      INSERT INTO order_label_prints (order_id, printed_at, print_batch_id, print_sequence, printed_by_person_id)
      VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        printed_at = CURRENT_TIMESTAMP,
        print_batch_id = VALUES(print_batch_id),
        print_sequence = VALUES(print_sequence),
        printed_by_person_id = VALUES(printed_by_person_id)
    `, [row.id, batchId, inputOrder.get(String(row.id)) || null, personId]);
  }
  return { ok: true, count: orderedRows.length, print_batch_id: batchId };
}

function sortRowsByInputMysql(rows, values, key) {
  const order = new Map(values.map((value, index) => [String(value), index]));
  return [...rows].sort((a, b) => (order.get(String(a[key])) ?? 0) - (order.get(String(b[key])) ?? 0));
}

function orderPackageLabelChunksMysql(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.shop_id}||${row.ozon_client_id || ""}||${row.api_key_hint || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        shop: {
          id: row.shop_id,
          name: row.shop_name,
          ozon_client_id: row.ozon_client_id,
          api_key_hint: row.api_key_hint
        },
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }
  const chunks = [];
  for (const group of groups.values()) {
    for (let index = 0; index < group.rows.length; index += 20) {
      chunks.push({ shop: group.shop, rows: group.rows.slice(index, index + 20) });
    }
  }
  return chunks;
}

function orderPackageLabelFailureMysql(row, error) {
  return {
    id: row?.id,
    posting_number: row?.posting_number,
    shop_name: row?.shop_name,
    error: error?.message || "Failed to generate label"
  };
}

function orderPackageLabelShopMysql(row = {}) {
  return {
    id: row.shop_id,
    name: row.shop_name,
    ozon_client_id: row.ozon_client_id,
    api_key_hint: row.api_key_hint
  };
}

function normalizePackageLabelBufferMysql(value) {
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function clearOrderPackageLabelPrefetchTimerMysql(orderId) {
  const key = String(orderId || "");
  const current = pendingOrderLabelPrefetchTimers.get(key);
  if (!current) return;
  clearTimeout(current.timer);
  pendingOrderLabelPrefetchTimers.delete(key);
}

async function cacheOrderPackageLabelMysql(row, buffer, source = "ozon") {
  const normalized = normalizePackageLabelBufferMysql(buffer);
  if (!row?.id || !row?.shop_id || !row?.posting_number || !normalized?.length) return;
  await mysqlExecute(`
    INSERT INTO order_package_label_cache
      (order_id, shop_id, posting_number, label_pdf, label_size, fetched_at, fetch_source)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON DUPLICATE KEY UPDATE
      shop_id = VALUES(shop_id),
      posting_number = VALUES(posting_number),
      label_pdf = VALUES(label_pdf),
      label_size = VALUES(label_size),
      fetched_at = CURRENT_TIMESTAMP,
      fetch_source = VALUES(fetch_source)
  `, [row.id, row.shop_id, row.posting_number, normalized, normalized.length, source]);
  clearOrderPackageLabelPrefetchTimerMysql(row.id);
}

async function loadCachedOrderPackageLabelsMysql(rows = []) {
  if (!rows.length) return new Map();
  const ids = rows.map((row) => Number(row.id)).filter(Boolean);
  if (!ids.length) return new Map();
  const cachedRows = await mysqlQuery(`
    SELECT order_id, posting_number, label_pdf, label_size, fetched_at
    FROM order_package_label_cache
    WHERE order_id IN (${ids.map(() => "?").join(",")})
  `, ids);
  const cache = new Map();
  for (const cached of cachedRows) {
    const buffer = normalizePackageLabelBufferMysql(cached.label_pdf);
    if (!buffer?.length) continue;
    cache.set(String(cached.order_id), { ...cached, buffer });
  }
  return cache;
}

async function fetchAndCacheOrderPackageLabelMysql(row) {
  const buffer = await fetchOzonPackageLabel(orderPackageLabelShopMysql(row), [row.posting_number]);
  await cacheOrderPackageLabelMysql(row, buffer, "ozon");
  return buffer;
}

async function prefetchOrderPackageLabelsMysql(rows = [], options = {}) {
  await ensureOrderPackageLabelCacheSchemaMysql();
  const force = Boolean(options.force);
  const inputRows = rows.filter((row) => row?.id && row?.shop_id && row?.posting_number);
  if (!inputRows.length) return { attempted: 0, fetched: 0, skipped: 0, failures: [] };
  const cached = force ? new Map() : await loadCachedOrderPackageLabelsMysql(inputRows);
  const hasCurrentCachedLabel = (row) => {
    const cachedLabel = cached.get(String(row.id));
    return cachedLabel?.buffer?.length && String(cachedLabel.posting_number || "") === String(row.posting_number || "");
  };
  const targets = force ? inputRows : inputRows.filter((row) => !hasCurrentCachedLabel(row));
  const failures = [];
  let fetched = 0;
  await mapWithConcurrencyMysql(targets, Number(options.concurrency || 3), async (row) => {
    try {
      await fetchAndCacheOrderPackageLabelMysql(row);
      fetched += 1;
    } catch (error) {
      failures.push(orderPackageLabelFailureMysql(row, error));
    }
  });
  return {
    attempted: targets.length,
    fetched,
    skipped: inputRows.length - targets.length,
    failures
  };
}

function scheduleOrderPackageLabelPrefetchMysql(rows = []) {
  const targets = rows.filter((row) => row?.id && row?.shop_id && row?.posting_number);
  if (!targets.length) return;
  for (const row of targets) {
    scheduleSingleOrderPackageLabelPrefetchMysql(row, {
      attempt: 1,
      delayMs: ORDER_LABEL_PREFETCH_INITIAL_DELAY_MS
    });
  }
}

function scheduleSingleOrderPackageLabelPrefetchMysql(row, options = {}) {
  const orderId = String(row?.id || "");
  if (!orderId) return;
  if (pendingOrderLabelPrefetchTimers.has(orderId)) return;
  const attempt = Math.max(1, Number(options.attempt || 1));
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const timer = setTimeout(() => {
    pendingOrderLabelPrefetchTimers.delete(orderId);
    runScheduledOrderPackageLabelPrefetchMysql(row, attempt).catch((error) => {
      console.warn(`Order label prefetch task failed for ${row.posting_number || row.id}:`, error?.message || error);
    });
  }, delayMs);
  pendingOrderLabelPrefetchTimers.set(orderId, { timer, attempt, posting_number: row.posting_number });
}

async function runScheduledOrderPackageLabelPrefetchMysql(row, attempt) {
  await ensureOrderPackageLabelCacheSchemaMysql();
  const cached = await loadCachedOrderPackageLabelsMysql([row]);
  const cachedLabel = cached.get(String(row.id));
  if (cachedLabel?.buffer?.length && String(cachedLabel.posting_number || "") === String(row.posting_number || "")) return;

  const result = await prefetchOrderPackageLabelsMysql([row]);
  if (result.fetched > 0 || result.skipped > 0) return;
  if (attempt >= ORDER_LABEL_PREFETCH_MAX_ATTEMPTS) {
    if (result.failures?.length) {
      console.warn(`Order label prefetch gave up for ${row.posting_number || row.id} after ${attempt} attempt(s).`);
    }
    return;
  }
  scheduleSingleOrderPackageLabelPrefetchMysql(row, {
    attempt: attempt + 1,
    delayMs: ORDER_LABEL_PREFETCH_RETRY_DELAY_MS
  });
}

async function mapWithConcurrencyMysql(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function mergePdfBuffersMysql(buffers) {
  if (buffers.length === 1) return buffers[0];
  const merged = await PDFDocument.create();
  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

export async function orderPackageLabelMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  await ensureOrderPackageLabelCacheSchemaMysql();
  const ids = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  const postingNumbers = Array.isArray(body.posting_numbers) ? body.posting_numbers.map((item) => String(item || "").trim()).filter(Boolean) : [];
  if (!ids.length && !postingNumbers.length) throw new Error("Select orders to print labels");
  const rawRows = ids.length ? await mysqlQuery(`
    SELECT o.id, o.shop_id, o.posting_number, s.name AS shop_name, s.ozon_client_id, s.api_key_hint
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    WHERE o.id IN (${ids.map(() => "?").join(",")})
  `, ids) : await mysqlQuery(`
    SELECT o.id, o.shop_id, o.posting_number, s.name AS shop_name, s.ozon_client_id, s.api_key_hint
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    WHERE o.posting_number IN (${postingNumbers.map(() => "?").join(",")})
  `, postingNumbers);
  const rows = ids.length
    ? sortRowsByInputMysql(rawRows, ids, "id")
    : sortRowsByInputMysql(rawRows, postingNumbers, "posting_number");
  if (!rows.length) throw new Error("Select orders to print labels");
  if (rows.length > 80) throw new Error("Print at most 80 labels per batch");

  const startedAt = Date.now();
  let ozonRequests = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const orderedResults = [];
  const failures = [];
  const cachedLabels = body.refresh_cache ? new Map() : await loadCachedOrderPackageLabelsMysql(rows);
  for (const row of rows) {
    const cached = cachedLabels.get(String(row.id));
    if (cached?.buffer?.length && String(cached.posting_number || "") === String(row.posting_number || "")) {
      cacheHits += 1;
      orderedResults.push({ row, buffer: cached.buffer, cached: true });
      continue;
    }
    cacheMisses += 1;
    try {
      ozonRequests += 1;
      orderedResults.push({
        row,
        buffer: await fetchAndCacheOrderPackageLabelMysql(row),
        cached: false
      });
    } catch (error) {
      failures.push(orderPackageLabelFailureMysql(row, error));
    }
  }
  if (!orderedResults.length) {
    const suffix = failures.slice(0, 3).map((item) => item.posting_number || item.id).filter(Boolean).join("、");
    throw new Error(suffix ? `Label generation failed: ${suffix}` : "Label generation failed");
  }
  const successfulRows = orderedResults.map((item) => item.row);
  const suffix = successfulRows.length === 1 ? successfulRows[0].posting_number : `${successfulRows.length}-orders`;
  return {
    buffer: await mergePdfBuffersMysql(orderedResults.map((item) => item.buffer)),
    filename: `ozon-labels-${suffix}.pdf`,
    count: successfulRows.length,
    requested: rows.length,
    printed_ids: successfulRows.map((row) => row.id),
    failures,
    stats: {
      duration_ms: Date.now() - startedAt,
      ozon_requests: ozonRequests,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      chunks: orderedResults.length
    }
  };
}

function shippingProductItemsFromRawPayloadMysql(rawJson) {
  const payload = parseJsonFallback(rawJson, {});
  const payloadItems = Array.isArray(payload.items) ? payload.items : [];
  const raw = payload.raw || payload;
  const rawProducts = Array.isArray(raw.products) ? raw.products : [];
  const financialProducts = Array.isArray(raw.financial_data?.products) ? raw.financial_data.products : [];
  const items = rawProducts.map((product, index) => {
    const financialProduct = financialProducts[index] || {};
    return {
      ozon_sku: String(product.sku || product.offer_id || ""),
      offer_id: String(product.offer_id || ""),
      ozon_product_id: String(product.product_id || product.id || financialProduct.product_id || financialProduct.id || "")
    };
  });
  if (items.some((item) => Number(item.ozon_product_id || 0))) return items;
  return payloadItems.map((item) => ({
    ozon_sku: String(item.ozon_sku || item.sku || item.offer_id || ""),
    offer_id: String(item.offer_id || ""),
    ozon_product_id: String(item.ozon_product_id || item.product_id || item.id || "")
  }));
}

function resolveShippingProductIdMysql(item, index, rawItems = []) {
  const orderProductId = Number(item.order_product_id || 0);
  if (orderProductId > 0) return orderProductId;
  const rawBySku = rawItems.find((rawItem) => String(rawItem.ozon_sku || "") === String(item.ozon_sku || ""));
  const rawProductId = Number(rawBySku?.ozon_product_id || rawItems[index]?.ozon_product_id || 0);
  if (rawProductId > 0) return rawProductId;
  const onlineProductId = Number(item.online_product_id || 0);
  return onlineProductId > 0 ? onlineProductId : 0;
}

async function syncOrderShippingStateFromOzonMysql(shop, order) {
  const posting = await fetchOzonPostingByNumber(shop, order.posting_number);
  if (!posting) return { ok: false, reason: "posting_not_found" };
  const statusText = `${posting.status || ""} ${posting.tracking_stage || ""} ${posting.logistics_status || ""}`;
  if (!isAwaitingDeliverLikeStatusMysql(statusText)) {
    return { ok: false, reason: "status_not_shipped", posting };
  }
  const normalized = normalizeSyncedShippingStateMysql(posting);
  await mysqlExecute(`
    UPDATE orders
    SET status = ?,
        logistics_status = ?,
        tracking_stage = ?,
        tracking_number = COALESCE(?, tracking_number),
        external_tracking_url = COALESCE(?, external_tracking_url),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    normalized.status,
    normalized.logisticsStatus,
    normalized.trackingStage,
    posting.tracking_number || null,
    posting.external_tracking_url || null,
    order.id
  ]);
  await mysqlExecute(`
    INSERT INTO ozon_orders_raw (store_id, posting_number, order_id, status, substatus, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      order_id = VALUES(order_id),
      status = VALUES(status),
      substatus = VALUES(substatus),
      raw_json = VALUES(raw_json),
      fetched_at = CURRENT_TIMESTAMP
  `, [
    shop.id,
    posting.posting_number,
    posting.order_id || posting.order_number || "",
    posting.status || "",
    posting.substatus || posting.logistics_status || "",
    JSON.stringify(posting)
  ]);
  await mysqlExecute(
    "INSERT INTO sync_logs (job, status, message) VALUES ('ozon_ship_compensation', ?, ?)",
    [
      "ok",
      `Compensated external ship state for order ${order.id}, posting ${order.posting_number}, shop ${shop.name || shop.id}; local ${order.status || ""}/${order.tracking_stage || ""} -> ozon ${posting.status || ""}/${posting.tracking_stage || ""}`
    ]
  );
  return { ok: true, posting };
}

export async function shipOrdersMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const ids = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  if (!ids.length) throw new Error("Select orders to ship");
  const ordersToShip = await mysqlQuery(`
    SELECT o.id, o.shop_id, o.posting_number, o.status, o.tracking_stage,
      s.name AS shop_name, s.ozon_client_id, s.api_key_hint
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    WHERE o.id IN (${ids.map(() => "?").join(",")})
  `, ids);
  if (!ordersToShip.length) throw new Error("Order not found");
  const shipped = [];
  const alreadyShipped = [];
  const updatedOrders = [];
  const shippedLabelRows = [];
  for (const order of sortRowsByInputMysql(ordersToShip, ids, "id")) {
    const statusText = `${order.status || ""} ${order.tracking_stage || ""}`.toLowerCase();
    if (statusText.includes("awaiting_deliver") || statusText.includes("delivering") || statusText.includes("delivered")) {
      throw new Error("This order may already be shipped. Refresh the order list and try again.");
    }
    const rawPosting = await mysqlQueryOne(`
      SELECT raw_json
      FROM ozon_orders_raw
      WHERE store_id = ? AND posting_number = ?
      ORDER BY id DESC
      LIMIT 1
    `, [order.shop_id, order.posting_number]);
    const rawProductItems = shippingProductItemsFromRawPayloadMysql(rawPosting?.raw_json);
    const items = (await mysqlQuery(`
      SELECT oi.id, oi.ozon_sku, oi.quantity, oi.ozon_product_id AS order_product_id,
        op.ozon_product_id AS online_product_id
      FROM order_items oi
      LEFT JOIN sku_mappings sm ON (
        sm.id = oi.sku_mapping_id
        OR (sm.shop_id = ? AND sm.ozon_sku = oi.ozon_sku AND sm.active = 1)
      )
      LEFT JOIN online_products op ON (
        op.id = sm.online_product_id
        OR (op.shop_id = ? AND op.ozon_sku = oi.ozon_sku)
      )
      WHERE oi.order_id = ?
    `, [order.shop_id, order.shop_id, order.id])).map((item, index) => ({
      ...item,
      product_id: resolveShippingProductIdMysql(item, index, rawProductItems)
    }));
    if (!items.length) throw new Error(`Order ${order.posting_number} has no shippable items`);
    const missingProductId = items.find((item) => !Number(item.product_id || 0));
    if (missingProductId) throw new Error(`Order ${order.posting_number} SKU ${missingProductId.ozon_sku} is missing Ozon product id`);
    const shop = {
      id: order.shop_id,
      name: order.shop_name,
      ozon_client_id: order.ozon_client_id,
      api_key_hint: order.api_key_hint
    };
    const livePosting = await fetchOzonPostingByNumber(shop, order.posting_number).catch(() => null);
    if (livePosting && isAwaitingDeliverLikeStatusMysql(`${livePosting.status || ""} ${livePosting.tracking_stage || ""} ${livePosting.logistics_status || ""}`)) {
      const syncResult = await syncOrderShippingStateFromOzonMysql(shop, order);
      if (syncResult.ok) {
        shipped.push(order.id);
        alreadyShipped.push(order.id);
        shippedLabelRows.push(order);
        updatedOrders.push({
          id: order.id,
          status: syncResult.posting?.status || "awaiting_deliver",
          tracking_stage: syncResult.posting?.tracking_stage || syncResult.posting?.status || "awaiting_deliver",
          logistics_status: syncResult.posting?.logistics_status || syncResult.posting?.tracking_stage || syncResult.posting?.status || "awaiting_deliver",
          tracking_number: syncResult.posting?.tracking_number || order.posting_number || ""
        });
        continue;
      }
    }
    try {
      await shipOzonPosting(shop, order.posting_number, items);
    } catch (error) {
      const rawMessage = String(error?.message || error || "");
      if (rawMessage.includes("UNKNOWN_PRODUCT_DEFINED")) {
        const submittedProducts = items.map((item) => `${item.ozon_sku}:${item.product_id}`).join(", ");
        throw new Error(`Order ${order.posting_number} shipping failed: Ozon did not recognize product ids. Submitted ${submittedProducts}. Original error: ${rawMessage}`);
      }
      if (rawMessage.includes("HAS_INCORRECT_STATUS")) {
        const syncResult = await syncOrderShippingStateFromOzonMysql(shop, order);
        if (syncResult.ok) {
          shipped.push(order.id);
          alreadyShipped.push(order.id);
          shippedLabelRows.push(order);
          updatedOrders.push({
            id: order.id,
            status: syncResult.posting?.status || "awaiting_deliver",
            tracking_stage: syncResult.posting?.tracking_stage || syncResult.posting?.status || "awaiting_deliver",
            logistics_status: syncResult.posting?.logistics_status || syncResult.posting?.tracking_stage || syncResult.posting?.status || "awaiting_deliver",
            tracking_number: syncResult.posting?.tracking_number || order.posting_number || ""
          });
          continue;
        }
      }
      throw error;
    }
    await mysqlExecute(`
      UPDATE orders
      SET status = 'awaiting_deliver',
          logistics_status = 'awaiting_deliver',
          tracking_stage = 'awaiting_deliver',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [order.id]);
    shipped.push(order.id);
    shippedLabelRows.push(order);
    updatedOrders.push({
      id: order.id,
      status: "awaiting_deliver",
      tracking_stage: "awaiting_deliver",
      logistics_status: "awaiting_deliver",
      tracking_number: order.posting_number || ""
    });
  }
  scheduleOrderPackageLabelPrefetchMysql(shippedLabelRows);
  return {
    ok: true,
    count: shipped.length,
    order_ids: shipped,
    already_shipped_ids: alreadyShipped,
    already_shipped_count: alreadyShipped.length,
    updated_orders: updatedOrders
  };
}

export async function updateExceptionTaskStateMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const taskId = String(body.task_id || body.id || "").trim();
  if (!taskId) throw new Error("task_id is required");
  const auditPersonId = await resolveAuditPersonId(userId);

  const status = String(body.status || "handled").trim();
  if (!["open", "handled", "ignored"].includes(status)) {
    throw new Error("Invalid exception task status");
  }

  if (status === "open") {
    await mysqlExecute("DELETE FROM exception_task_states WHERE task_id = ?", [taskId]);
    db.prepare("DELETE FROM exception_task_states WHERE task_id = ?").run(taskId);
    return { ok: true, task_id: taskId, status };
  }

  await mysqlExecute(`
    INSERT INTO exception_task_states (task_id, status, note, updated_by_person_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      note = VALUES(note),
      updated_by_person_id = VALUES(updated_by_person_id),
      updated_at = CURRENT_TIMESTAMP
  `, [taskId, status, String(body.note || ""), auditPersonId]);

  db.prepare(`
    INSERT INTO exception_task_states (task_id, status, note, updated_by_person_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_by_person_id = excluded.updated_by_person_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(taskId, status, String(body.note || ""), auditPersonId);

  return { ok: true, task_id: taskId, status };
}

function exceptionTaskMysql(values) {
  return { id: [values.type, values.orderId || values.productId || values.subject || "", values.title || ""].join(":"), ...values };
}

async function exceptionTaskStateMapMysql(taskIds = []) {
  const ids = [...new Set(taskIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await mysqlQuery(`
    SELECT task_id, status, note, updated_at
    FROM exception_task_states
    WHERE task_id IN (${ids.map(() => "?").join(",")})
  `, ids);
  return new Map(rows.map((row) => [row.task_id, row]));
}

function exceptionPriorityValueMysql(task) {
  const level = { danger: 3, warning: 2, info: 1 }[task.level] || 0;
  const typeBoost = task.type === "order_binding" ? 0.4 : task.type === "profit" ? 0.3 : 0;
  return level + typeBoost;
}

function firstDelimitedValueMysql(value, delimiter = ",") {
  return String(value || "").split(delimiter).map((item) => item.trim()).filter(Boolean)[0] || "";
}

function firstMappedValueMysql(value) {
  const first = firstDelimitedValueMysql(value, "||");
  const index = first.indexOf(":");
  return index >= 0 ? first.slice(index + 1).trim() : first;
}

function exceptionOrderContextMysql(row = {}) {
  const productName = firstDelimitedValueMysql(row.product_names) || firstMappedValueMysql(row.sku_names) || row.posting_number || "";
  return {
    image_url: firstDelimitedValueMysql(row.image_urls) || firstMappedValueMysql(row.sku_images),
    product_name: productName === "Unbound product" ? "Unbound inventory product" : productName,
    sku_text: firstDelimitedValueMysql(row.skus || row.unbound_skus),
    inventory_id: firstDelimitedValueMysql(row.inventory_ids || row.product_codes),
    productId: Number(firstDelimitedValueMysql(row.product_ids)) || undefined
  };
}

function stockAlertSkuTextMysql(row = {}) {
  const skus = Array.isArray(row.skus) ? row.skus : [];
  return skus.slice(0, 3).map((item) => [item.shop_name, item.ozon_sku, item.name].filter(Boolean).join(" / ")).join(", ");
}

export async function exceptionWorkbenchMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const tasks = [];
  const [orderPayload, stockPayload] = await Promise.all([
    ordersPagedMysql({
      paged: "1",
      page: 1,
      pageSize: Math.min(Math.max(Number(query.orderPageSize || 200), 50), 500),
      status: "all",
      sortMode: "ordered"
    }),
    stockAlertsMysql({ ...query, paged: "1", page: 1, pageSize: Math.min(Math.max(Number(query.stockPageSize || 300), 50), 500) })
  ]);

  for (const row of orderPayload.rows || []) {
    const context = exceptionOrderContextMysql(row);
    const profitValue = Number(row.actual_profit || row.estimated_profit || 0);
    const hasUnbound = Number(row.unbound_count || 0) > 0 || String(row.product_codes || "").includes("UNBOUND");
    const hasStockIssue = Number(row.local_stock_shortage_count || row.stock_shortage_count || 0) > 0;
    const subject = row.posting_number || row.order_number || `Order ${row.id}`;
    const meta = `${row.shop_name || ""} / ${normalizeMysqlDateTime(row.ordered_at) || ""}`;
    if (hasUnbound || hasStockIssue) {
      tasks.push(exceptionTaskMysql({
        type: hasStockIssue ? "order_stock_shortage" : "order_binding",
        level: hasStockIssue ? "danger" : "warning",
        title: hasStockIssue ? "Order stock shortage" : "Order has unbound inventory",
        subject,
        meta,
        detail: hasStockIssue ? "Bound inventory is insufficient." : "This order still has unbound SKUs.",
        action: hasStockIssue ? "order-stock" : "order-unbound",
        orderId: row.id,
        ...context
      }));
    }
    if (profitValue < 0 && !hasUnbound) {
      tasks.push(exceptionTaskMysql({
        type: "profit",
        level: "danger",
        title: "Order profit is negative",
        subject,
        meta: `${row.shop_name || ""} / ${profitValue.toFixed(2)}`,
        detail: "Usually caused by inventory binding, weight, fee, or logistics rule issues.",
        action: "order-profit",
        orderId: row.id,
        ...context
      }));
    }
  }

  for (const row of stockPayload.rows || []) {
    for (const warning of row.warnings || []) {
      if (!["local", "fbp", "fbs", "mapping"].includes(warning.type)) continue;
      tasks.push(exceptionTaskMysql({
        type: `stock_${warning.type}`,
        level: warning.level || "warning",
        title: warning.text || "搴撳瓨棰勮",
        subject: row.product_name || row.inventory_id || `搴撳瓨 ${row.product_id}`,
        meta: `${row.inventory_id || ""} / 鏈湴 ${row.local_stock ?? 0}`,
        detail: row.suggestion || "Manual review required for inventory binding and SKU mapping.",
        action: `stock-${warning.type}`,
        productId: row.product_id,
        image_url: row.image_url || "",
        product_name: row.product_name || row.inventory_id || "",
        inventory_id: row.inventory_id || "",
        sku_text: stockAlertSkuTextMysql(row)
      }));
    }
  }

  tasks.sort((a, b) => exceptionPriorityValueMysql(b) - exceptionPriorityValueMysql(a));
  const stateMap = await exceptionTaskStateMapMysql(tasks.map((task) => task.id));
  const visibleTasks = tasks.filter((task) => !["handled", "ignored"].includes(stateMap.get(task.id)?.status));
  return {
    rows: visibleTasks,
    total: visibleTasks.length,
    hidden_total: tasks.length - visibleTasks.length,
    counts: {
      danger: visibleTasks.filter((item) => item.level === "danger").length,
      warning: visibleTasks.filter((item) => item.level === "warning").length,
      info: visibleTasks.filter((item) => item.level === "info").length,
      order: visibleTasks.filter((item) => item.type.startsWith("order") || ["print", "profit", "deadline"].includes(item.type)).length,
      stock: visibleTasks.filter((item) => item.type.startsWith("stock")).length
    },
    generated_at: new Date().toISOString()
  };
}

export async function syncOzonOnlineProductsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const targetShopId = nullableNumber(body.shop_id);
  const selectedIds = Array.isArray(body.online_product_ids)
    ? body.online_product_ids.map(Number).filter(Boolean)
    : [];

  const selectedRows = selectedIds.length
    ? await mysqlQuery(
      `SELECT id, shop_id, ozon_product_id, ozon_sku, offer_id FROM online_products WHERE id IN (${selectedIds.map(() => "?").join(",")})`,
      selectedIds
    )
    : [];

  const selectedProductIds = new Set(selectedRows.map((row) => String(row.ozon_product_id || "")).filter(Boolean));
  const selectedSkus = new Set(selectedRows.map((row) => String(row.ozon_sku || "")).filter(Boolean));
  const selectedOffers = new Set(selectedRows.map((row) => String(row.offer_id || "")).filter(Boolean));
  const selectedShopIds = new Set(selectedRows.map((row) => Number(row.shop_id)).filter(Boolean));
  const activeShops = await mysqlQuery(
    "SELECT * FROM shops WHERE status = 'active' AND (? IS NULL OR id = ?) ORDER BY id",
    [targetShopId, targetShopId]
  );

  let fetched = 0;
  let upserted = 0;
  const errors = [];

  for (const shop of activeShops) {
    if (selectedRows.length && !selectedShopIds.has(Number(shop.id))) continue;
    try {
      const items = await fetchOzonProducts(shop);
      fetched += items.length;
      for (const item of items) {
        if (
          selectedRows.length &&
          !selectedProductIds.has(String(item.ozon_product_id || "")) &&
          !selectedSkus.has(String(item.ozon_sku || "")) &&
          !selectedOffers.has(String(item.offer_id || ""))
        ) {
          continue;
        }
        await upsertOnlineProductDualWrite(shop.id, item);
        upserted += 1;
      }
    } catch (error) {
      errors.push(`${shop.name}: ${error.message}`);
    }
  }

  const status = errors.length ? "partial_error" : "ok";
  const message = `Fetched ${fetched}, upserted ${upserted}${errors.length ? `; ${errors.join(" | ")}` : ""}`;

  const logResult = await mysqlExecute(
    "INSERT INTO sync_logs (job, status, message) VALUES ('ozon_online_products', ?, ?)",
    [status, message]
  );
  db.prepare("INSERT INTO sync_logs (id, job, status, message) VALUES (?, 'ozon_online_products', ?, ?)")
    .run(Number(logResult.insertId), status, message);

  if (errors.length && upserted === 0) throw new Error(errors.join(" | "));
  return { fetched, upserted, errors };
}

async function upsertFinanceOperationMysql(shopId, operation) {
  const rows = financeRowsForOperationMysql(operation);
  const rateRow = await exchangeRateForDateMysql(operation.operation_date);
  const rate = Number(rateRow?.rate || 11.32);
  let count = 0;
  for (const row of rows) {
    const amountRub = Number(row.amount || 0);
    const accrualsRub = Number(operation.accruals_for_sale || 0);
    const saleCommissionRub = Number(operation.sale_commission || 0);
    const deliveryChargeRub = Number(operation.delivery_charge || 0);
    const returnDeliveryChargeRub = Number(operation.return_delivery_charge || 0);
    await mysqlExecute(`
      INSERT INTO ozon_finance_items
      (shop_id, operation_id, posting_number, order_number, operation_type, operation_type_name, operation_date,
       service_type, service_name, amount, accruals_for_sale, sale_commission, delivery_charge, return_delivery_charge,
       currency_code, raw_json, amount_cny, accruals_for_sale_cny, sale_commission_cny, delivery_charge_cny, return_delivery_charge_cny, exchange_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        posting_number = VALUES(posting_number),
        order_number = VALUES(order_number),
        operation_type = VALUES(operation_type),
        operation_type_name = VALUES(operation_type_name),
        operation_date = VALUES(operation_date),
        service_name = VALUES(service_name),
        amount = VALUES(amount),
        accruals_for_sale = VALUES(accruals_for_sale),
        sale_commission = VALUES(sale_commission),
        delivery_charge = VALUES(delivery_charge),
        return_delivery_charge = VALUES(return_delivery_charge),
        currency_code = VALUES(currency_code),
        amount_cny = VALUES(amount_cny),
        accruals_for_sale_cny = VALUES(accruals_for_sale_cny),
        sale_commission_cny = VALUES(sale_commission_cny),
        delivery_charge_cny = VALUES(delivery_charge_cny),
        return_delivery_charge_cny = VALUES(return_delivery_charge_cny),
        exchange_rate = VALUES(exchange_rate),
        raw_json = VALUES(raw_json),
        synced_at = CURRENT_TIMESTAMP
    `, [
      shopId,
      operation.operation_id || `${operation.posting_number}-${operation.operation_date}`,
      operation.posting_number || "",
      operation.order_number || "",
      operation.operation_type || "",
      operation.operation_type_name || "",
      normalizeMysqlNullableDateTime(operation.operation_date),
      row.service_type,
      row.service_name,
      amountRub,
      accrualsRub,
      saleCommissionRub,
      deliveryChargeRub,
      returnDeliveryChargeRub,
      operation.currency_code || "",
      operation.raw_json || "",
      rubToCnyMysql(amountRub, rate),
      rubToCnyMysql(accrualsRub, rate),
      rubToCnyMysql(saleCommissionRub, rate),
      rubToCnyMysql(deliveryChargeRub, rate),
      rubToCnyMysql(returnDeliveryChargeRub, rate),
      rate
    ]);
    count += 1;
  }
  return count;
}

async function applyOzonFinanceToOrdersMysql({ from = "", to = "" } = {}) {
  const rows = await mysqlQuery(`
    SELECT o.id AS order_id,
      MAX(o.status) AS order_status,
      MAX(o.tracking_stage) AS tracking_stage,
      MAX(o.logistics_status) AS logistics_status,
      MAX(o.delivered_at) AS delivered_at,
      MAX(o.accrued_at) AS accrued_at,
      MAX(o.cancel_reason) AS cancel_reason,
      MAX(o.cancel_reason_id) AS cancel_reason_id,
      MAX(o.cancel_initiator) AS cancel_initiator,
      MAX(o.cancel_type) AS cancel_type,
      MAX(o.cancelled_after_ship) AS cancelled_after_ship,
      COALESCE(SUM(CASE WHEN ofi.amount_cny < 0 THEN -ofi.amount_cny ELSE 0 END), 0) AS fee_amount_cny,
      COALESCE(MAX(CASE WHEN ABS(COALESCE(ofi.accruals_for_sale_cny, 0)) > 0 THEN ABS(ofi.accruals_for_sale_cny) ELSE 0 END), 0) AS sale_accrual_cny,
      COALESCE(SUM(CASE WHEN ofi.service_type = 'sale_commission' THEN ABS(ofi.amount_cny) ELSE 0 END), 0) AS commission_fee_cny,
      COALESCE(SUM(CASE WHEN ofi.service_type = 'sale_commission' THEN ABS(ofi.amount) ELSE 0 END), 0) AS commission_fee_rub,
      COALESCE(SUM(CASE WHEN ofi.service_type = 'sale_commission' THEN ABS(COALESCE(ofi.accruals_for_sale, 0)) ELSE 0 END), 0) AS commission_sale_rub
    FROM orders o
    JOIN ozon_finance_items ofi ON ofi.shop_id = o.shop_id AND ofi.posting_number = o.posting_number
    WHERE (? = '' OR DATE(ofi.operation_date) >= ?)
      AND (? = '' OR DATE(ofi.operation_date) <= ?)
    GROUP BY o.id
  `, [from, from, to, to]);

  let updated = 0;
  const appliedOrderIds = new Set();
  for (const row of rows) {
    const financeRows = await mysqlQuery(`
      SELECT service_type, service_name,
        COALESCE(SUM(amount_cny), 0) AS amount_cny,
        COALESCE(SUM(CASE WHEN amount_cny < 0 THEN -amount_cny ELSE 0 END), 0) AS fee_amount_cny
      FROM ozon_finance_items
      WHERE shop_id = (SELECT shop_id FROM orders WHERE id = ?)
        AND posting_number = (SELECT posting_number FROM orders WHERE id = ?)
        AND (? = '' OR DATE(operation_date) >= ?)
        AND (? = '' OR DATE(operation_date) <= ?)
      GROUP BY service_type, service_name
    `, [row.order_id, row.order_id, from, from, to, to]);
    const categoryTotals = financeRows.reduce((acc, item) => {
      const key = ozonFinanceCategoryMysql(item);
      const rawAmount = Number(item.amount_cny || 0);
      const feeAmount = Number(item.fee_amount_cny || 0);
      const amount = feeAmount > 0 ? feeAmount : rawAmount < 0 ? Math.abs(rawAmount) : 0;
      acc[key] = roundMoneyMysql(Number(acc[key] || 0) + amount);
      return acc;
    }, {});
    const items = await mysqlQuery(`
      SELECT oi.*, opi.sale_amount_cny, opi.purchase_cost_cny, opi.domestic_shipping_cny, opi.international_shipping_cny,
        opi.packaging_cost_cny, opi.return_loss_cny, opi.advertising_cost_cny, opi.other_fee_cny
      FROM order_items oi
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      WHERE oi.order_id = ?
    `, [row.order_id]);
    const totalSale = items.reduce((sum, item) => sum + Number(item.sale_amount_cny || (Number(item.sale_price || 0) * Number(item.quantity || 1))), 0);
    const commissionRate = Number(row.commission_sale_rub || 0) > 0
      ? Number(row.commission_fee_rub || 0) / Number(row.commission_sale_rub || 0)
      : 0;
    const orderOutcome = classifyOrderOutcome({
      status: row.order_status,
      tracking_stage: row.tracking_stage,
      logistics_status: row.logistics_status,
      delivered_at: row.delivered_at,
      accrued_at: row.accrued_at,
      cancel_reason: row.cancel_reason,
      cancel_reason_id: row.cancel_reason_id,
      cancel_initiator: row.cancel_initiator,
      cancel_type: row.cancel_type,
      cancelled_after_ship: row.cancelled_after_ship
    });
    const cancellation = describeCancellation({ ...row, outcome_type: orderOutcome });
    const orderLossProfile = resolveOrderLossProfile({
      ...row,
      outcome_type: orderOutcome,
      ...cancellation
    });
    const hasFinalFinanceBasis = Number(row.sale_accrual_cny || 0) > 0.005 || orderOutcome !== "active";
    if (!hasFinalFinanceBasis) continue;
    for (const item of items) {
      const itemSale = Number(item.sale_amount_cny || (Number(item.sale_price || 0) * Number(item.quantity || 1)));
      const share = totalSale > 0 ? itemSale / totalSale : (items.length ? 1 / items.length : 0);
      const commissionFeeCny = commissionRate > 0
        ? roundMoneyMysql(itemSale * commissionRate)
        : roundMoneyMysql(Number(row.commission_fee_cny || 0) * share);
      const serviceFeeCny = roundMoneyMysql(Number(categoryTotals.other || 0) * share);
      const collectingFee = roundMoneyMysql(Number(categoryTotals.collecting_fee || 0) * share);
      const totalFinanceFeeCny = roundMoneyMysql(Number(row.fee_amount_cny || 0) * share);
      const purchaseCost = Number(item.purchase_cost_cny || (Number(item.frozen_purchase_cost || 0) * Number(item.quantity || 1)));
      const domesticShipping = Number(item.domestic_shipping_cny || (Number(item.frozen_domestic_shipping || 0) * Number(item.quantity || 1)));
      const actualInternationalShipping = roundMoneyMysql(Number(categoryTotals.platform_delivery || 0) * share + Number(categoryTotals.international_transport || 0) * share);
      const packagingCost = await packagingFeeForSaleAmountMysql(itemSale);
      const returnLoss = estimateOutcomeReturnLoss({
        outcome: orderOutcome,
        lossProfileCode: orderLossProfile.code,
        quantity: Number(item.quantity || 1),
        purchaseCostPerUnit: Number(item.purchase_cost_cny || item.frozen_purchase_cost || 0) / Math.max(Number(item.quantity || 1), 1),
        domesticShippingPerUnit: Number(item.domestic_shipping_cny || item.frozen_domestic_shipping || 0) / Math.max(Number(item.quantity || 1), 1),
        internationalShippingPerUnit: actualInternationalShipping / Math.max(Number(item.quantity || 1), 1),
        packagingCostTotal: packagingCost,
        commissionFeeTotal: commissionFeeCny,
        collectingFeeTotal: collectingFee,
        finalMileFeeTotal: 0,
        serviceFeeTotal: serviceFeeCny,
        returnRateLossTotal: roundMoneyMysql(Number(categoryTotals.aftersale_loss || 0) * share) || Number(item.return_loss_cny || item.aftersale_loss || 0)
      });
      const advertisingCost = Number(item.advertising_cost_cny || 0);
      const otherFee = Number(item.other_fee_cny || 0);
      const actualProfit = roundMoneyMysql(itemSale - purchaseCost - domesticShipping - actualInternationalShipping - packagingCost - commissionFeeCny - serviceFeeCny - collectingFee - returnLoss - advertisingCost - otherFee);
      await mysqlExecute("UPDATE order_items SET platform_fee_actual = ?, actual_profit = ?, settlement_state = 'accrued' WHERE id = ?", [totalFinanceFeeCny, actualProfit, item.id]);
      await mysqlExecute(`
        UPDATE order_profit_items
        SET international_shipping_cny = ?, packaging_cost_cny = ?, commission_fee_cny = ?, commission_rate = ?, ozon_service_fee_cny = ?, return_loss_cny = ?, other_fee_cny = ?, net_profit_cny = ?, profit_status = 'accrued', updated_at = CURRENT_TIMESTAMP
        WHERE order_item_id = ?
      `, [actualInternationalShipping, packagingCost, commissionFeeCny, commissionRate, serviceFeeCny, returnLoss, otherFee, actualProfit, item.id]);
      await lockProfitItemMysql(item.id, "finance_accrued");
      updated += 1;
      appliedOrderIds.add(Number(row.order_id));
    }
  }
  if (appliedOrderIds.size) {
    await refreshOrderProfitDetailSnapshotsMysql({ order_ids: [...appliedOrderIds], final_only: 0 });
  }
  return { orders: rows.length, items: updated };
}

export async function syncOzonFinanceMysql(body = {}, options = {}) {
  ensureMysqlCutoverEnabled();
  const targetShopId = nullableNumber(body.shop_id);
  const activeShops = (await shopsMysql()).filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  const from = body.from || dateKeyDaysAgoMysql(30);
  const to = body.to || todayDateKeyMysql();
  let fetched = 0;
  let upserted = 0;
  const errors = [];
  for (const shop of activeShops) {
    try {
      const result = await fetchOzonFinanceTransactions(shop, { from, to, signal: options.signal });
      fetched += result.fetched || 0;
      for (const operation of result.operations || []) {
        upserted += await upsertFinanceOperationMysql(shop.id, operation);
      }
    } catch (error) {
      errors.push(`${shop.name}: ${error.message}`);
    }
  }
  const applied = await applyOzonFinanceToOrdersMysql({ from, to });
  const status = errors.length ? "partial_error" : "ok";
  const message = `Fetched ${fetched}, upserted ${upserted}, applied ${applied.items}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  await mysqlExecute("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_finance', ?, ?)", [status, message]);
  if (errors.length && upserted === 0) throw new Error(errors.join(" | "));
  return { fetched, upserted, applied, errors, db: "mysql" };
}

export async function onlineProductsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const shopId = String(query.shopId || query.shop_id || "all");
  const status = String(query.status || "all");
  const nameText = String(query.name || query.query || "").trim().toLowerCase();
  const offerText = String(query.offer || query.sku || "").trim().toLowerCase();
  const where = [];
  const params = [];
  if (shopId !== "all") {
    where.push("op.shop_id = ?");
    params.push(Number(shopId));
  }
  if (nameText) {
    where.push("LOWER(COALESCE(op.name, '')) LIKE ?");
    params.push(`%${nameText}%`);
  }
  if (offerText) {
    where.push("(LOWER(COALESCE(op.offer_id, '')) LIKE ? OR LOWER(COALESCE(op.ozon_sku, '')) LIKE ?)");
    params.push(`%${offerText}%`, `%${offerText}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const selectSql = `
    SELECT
      op.id, op.shop_id, op.ozon_sku, op.offer_id, op.ozon_product_id, op.name, op.image_url, op.primary_image,
      op.sale_price, op.currency_code, op.marketing_price, op.old_price, op.status, op.visibility, op.archived,
      op.is_discounted, op.images_json, op.barcodes_json, op.stocks_json, op.commissions_json, op.attributes_json, op.raw_json,
      CASE WHEN op.raw_json IS NOT NULL AND op.raw_json != '' THEN 1 ELSE 0 END AS has_raw_json,
      op.ozon_updated_at, op.product_id, op.synced_at, op.updated_at,
      s.name AS shop_name,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END AS product_code,
      p.name AS product_name
    FROM online_products op
    JOIN shops s ON s.id = op.shop_id
    LEFT JOIN products p ON p.id = op.product_id
    ${whereSql}
  `;
  if (paged) {
    const allIds = await mysqlQuery(`
      SELECT op.id, op.status, op.visibility, op.archived
      FROM online_products op
      JOIN shops s ON s.id = op.shop_id
      LEFT JOIN products p ON p.id = op.product_id
      ${whereSql}
      ORDER BY op.synced_at DESC, op.id DESC
    `, params);
    const statusCounts = onlineStatusCountsMysql(allIds);
    const filteredIds = status === "all" ? allIds : allIds.filter((row) => onlineStatusKeyMysql(row) === status);
    const pageIds = filteredIds.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map((row) => Number(row.id));
    if (!pageIds.length) {
      return { rows: [], total: filteredIds.length, statusCounts, page, pageSize, mode: "paged" };
    }
    const placeholders = pageIds.map(() => "?").join(", ");
    const idWhereSql = where.length ? `AND op.id IN (${placeholders})` : `WHERE op.id IN (${placeholders})`;
    const orderSql = pageIds.map((id, index) => `WHEN ${Number(id)} THEN ${index}`).join(" ");
    const rows = await mysqlQuery(`
      ${selectSql}
      ${idWhereSql}
      ORDER BY CASE op.id ${orderSql} END
    `, [...params, ...pageIds]);
    const mappedRows = rows.map((row) => {
      const fallbackImage = String(row.primary_image || row.image_url || firstJsonItem(row.images_json) || "").trim();
      return { ...row, primary_image: fallbackImage, image_url: fallbackImage };
    });
    return {
      rows: mappedRows,
      total: filteredIds.length,
      statusCounts,
      page,
      pageSize,
      mode: "paged"
    };
  }
  const rows = await mysqlQuery(`
    ${selectSql}
    ORDER BY op.synced_at DESC, op.id DESC
  `, params);

  const mappedRows = rows.map((row) => {
    const fallbackImage = String(row.primary_image || row.image_url || firstJsonItem(row.images_json) || "").trim();
    return {
      ...row,
      primary_image: fallbackImage,
      image_url: fallbackImage
    };
  });
  return mappedRows;
}

function onlineStatusKeyMysql(row) {
  const status = String(row.status || "").toLowerCase();
  const visibility = String(row.visibility || "").toLowerCase();
  if (Number(row.archived || 0) || status.includes("archive")) return "archived";
  if (status.includes("error") || status.includes("fail") || visibility.includes("failed") || visibility.includes("banned")) return "error";
  if (status.includes("moder") || status.includes("edit") || status.includes("validation") || visibility.includes("pending")) return "moderation";
  if (status.includes("ready") || status.includes("created") || visibility.includes("ready_to_supply") || visibility.includes("empty_stock")) return "ready";
  if (visibility.includes("hidden") || visibility.includes("blocked") || visibility.includes("removed_from_sale") || status.includes("hidden") || status.includes("offline")) return "hidden";
  if (status.includes("online") || status.includes("active") || status.includes("sell") || visibility.includes("in_sale") || visibility.includes("visible") || visibility.includes("moderated")) return "selling";
  return "other";
}

function onlineStatusCountsMysql(rows) {
  const counts = { all: rows.length, selling: 0, ready: 0, error: 0, moderation: 0, hidden: 0, archived: 0, other: 0 };
  for (const row of rows) counts[onlineStatusKeyMysql(row)] = Number(counts[onlineStatusKeyMysql(row)] || 0) + 1;
  return counts;
}

export async function bindOnlineProductMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const onlineProductId = Number(body.online_product_id);
  const productId = Number(body.product_id);
  if (!onlineProductId) throw new Error("online_product_id is required");
  if (!productId) throw new Error("product_id is required");

  const online = await mysqlQueryOne("SELECT * FROM online_products WHERE id = ?", [onlineProductId]);
  if (!online) throw new Error("Online product not found");

  const product = await mysqlQueryOne("SELECT id FROM products WHERE id = ? AND active = 1", [productId]);
  if (!product) throw new Error("Product not found");

  const personId = await resolveExistingPersonId(body.person_id);
  const existingMapping = await mysqlQueryOne(
    "SELECT * FROM sku_mappings WHERE shop_id = ? AND ozon_sku = ?",
    [Number(online.shop_id), String(online.ozon_sku || "")]
  );

  await mysqlExecute("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [productId, onlineProductId]);
  db.prepare("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(productId, onlineProductId);

  let mappingId = null;
  if (existingMapping) {
    mappingId = Number(existingMapping.id);
    const payload = [productId, personId, onlineProductId, online.offer_id || "", online.name || "", mappingId];
    await mysqlExecute(`
      UPDATE sku_mappings
      SET product_id = ?, person_id = ?, online_product_id = ?, offer_id = ?, display_name = ?, active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, payload);
    db.prepare(`
      UPDATE sku_mappings
      SET product_id = ?, person_id = ?, online_product_id = ?, offer_id = ?, display_name = ?, active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...payload);
  } else {
    const payload = [
      Number(online.shop_id),
      productId,
      personId,
      onlineProductId,
      String(online.ozon_sku || ""),
      String(online.offer_id || ""),
      String(online.name || "")
    ];
    const result = await mysqlExecute(`
      INSERT INTO sku_mappings
      (shop_id, product_id, person_id, online_product_id, ozon_sku, offer_id, display_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, payload);
    mappingId = Number(result.insertId);
    const legacyExisting = db.prepare("SELECT id FROM sku_mappings WHERE shop_id = ? AND ozon_sku = ?").get(Number(online.shop_id), String(online.ozon_sku || ""));
    if (legacyExisting) {
      db.prepare(`
        UPDATE sku_mappings
        SET product_id = ?, person_id = ?, online_product_id = ?, offer_id = ?, display_name = ?, active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(productId, personId, onlineProductId, online.offer_id || "", online.name || "", legacyExisting.id);
    } else {
      db.prepare(`
        INSERT INTO sku_mappings
        (id, shop_id, product_id, person_id, online_product_id, ozon_sku, offer_id, display_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(mappingId, ...payload);
    }
  }

  return { ok: true, mapping_id: mappingId, product_id: productId };
}

export async function createOnlineProductMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const shopId = Number(body.shop_id);
  if (!shopId) throw new Error("shop_id is required");

  const row = await upsertOnlineProductDualWrite(shopId, {
    ozon_sku: body.ozon_sku,
    offer_id: body.offer_id,
    ozon_product_id: body.ozon_product_id,
    name: body.name,
    image_url: body.image_url,
    primary_image: body.primary_image,
    sale_price: body.sale_price,
    currency_code: body.currency_code,
    marketing_price: body.marketing_price,
    old_price: body.old_price,
    status: body.status,
    visibility: body.visibility,
    archived: body.archived,
    is_discounted: body.is_discounted,
    images_json: body.images_json,
    barcodes_json: body.barcodes_json,
    stocks_json: body.stocks_json,
    commissions_json: body.commissions_json,
    attributes_json: body.attributes_json,
    raw_json: body.raw_json,
    ozon_updated_at: body.ozon_updated_at
  });

  if (body.product_id !== undefined) {
    const productId = nullableNumber(body.product_id);
    await mysqlExecute("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [productId, Number(row.id)]);
    db.prepare("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(productId, Number(row.id));
  }

  return { ok: true, id: Number(row.id) };
}

export async function updateOnlineProductMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const onlineProductId = Number(id);
  const existing = await mysqlQueryOne("SELECT * FROM online_products WHERE id = ?", [onlineProductId]);
  if (!existing) throw new Error("Online product not found");

  const row = await upsertOnlineProductDualWrite(existing.shop_id, {
    ozon_sku: body.ozon_sku ?? existing.ozon_sku,
    offer_id: body.offer_id ?? existing.offer_id,
    ozon_product_id: body.ozon_product_id ?? existing.ozon_product_id,
    name: body.name ?? existing.name,
    image_url: body.image_url ?? existing.image_url,
    primary_image: body.primary_image ?? existing.primary_image,
    sale_price: body.sale_price ?? existing.sale_price,
    currency_code: body.currency_code ?? existing.currency_code,
    marketing_price: body.marketing_price ?? existing.marketing_price,
    old_price: body.old_price ?? existing.old_price,
    status: body.status ?? existing.status,
    visibility: body.visibility ?? existing.visibility,
    archived: body.archived ?? existing.archived,
    is_discounted: body.is_discounted ?? existing.is_discounted,
    images_json: body.images_json ?? existing.images_json,
    barcodes_json: body.barcodes_json ?? existing.barcodes_json,
    stocks_json: body.stocks_json ?? existing.stocks_json,
    commissions_json: body.commissions_json ?? existing.commissions_json,
    attributes_json: body.attributes_json ?? existing.attributes_json,
    raw_json: body.raw_json ?? existing.raw_json,
    ozon_updated_at: body.ozon_updated_at ?? existing.ozon_updated_at
  });

  const productId = body.product_id === undefined ? nullableNumber(existing.product_id) : nullableNumber(body.product_id);
  await mysqlExecute("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [productId, Number(row.id)]);
  db.prepare("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(productId, Number(row.id));

  if (Number(row.id) !== onlineProductId) {
    await mysqlExecute("DELETE FROM online_products WHERE id = ?", [onlineProductId]);
    db.prepare("DELETE FROM online_products WHERE id = ?").run(onlineProductId);
  }

  return { ok: true, id: Number(row.id) };
}

async function resolveOnlineProductZeroStockTargetsMysql(online = {}, body = {}) {
  const explicitWarehouseId = String(body.warehouse_id || "").trim();
  const snapshotRows = online.shop_id && online.ozon_sku
    ? await mysqlQuery(`
      SELECT DISTINCT warehouse_id
      FROM ozon_stock_snapshots
      WHERE shop_id = ? AND ozon_sku = ?
      ORDER BY warehouse_id ASC
    `, [Number(online.shop_id), String(online.ozon_sku || "")])
    : [];
  const warehouseIds = explicitWarehouseId
    ? [explicitWarehouseId]
    : snapshotRows.map((row) => String(row.warehouse_id || "").trim()).filter(Boolean);
  const normalized = warehouseIds.length ? warehouseIds : [""];
  return normalized.map((warehouseId) => ({
    offer_id: String(online.offer_id || ""),
    product_id: Number(online.ozon_product_id || 0),
    stock: 0,
    warehouse_id: warehouseId
  }));
}

async function recordOnlineProductActionMysql({ online, action, status, request, userId }) {
  const result = await mysqlExecute(`
    INSERT INTO online_product_actions
    (online_product_id, shop_id, action_type, status, request_json, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [online.id, online.shop_id, action, status, JSON.stringify(request || {}), await resolveExistingPersonId(userId)]);
  return Number(result.insertId || 0);
}

async function finishOnlineProductActionMysql(actionId, status, response, errorMessage) {
  if (!actionId) return;
  await mysqlExecute(`
    UPDATE online_product_actions
    SET status = ?, response_json = ?, error_message = ?
    WHERE id = ?
  `, [status, JSON.stringify(response || {}), errorMessage || "", Number(actionId)]);
}

export async function performOnlineProductActionMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const onlineProductId = Number(body.online_product_id || body.id || 0);
  const action = String(body.action || "").trim();
  if (!onlineProductId) throw new Error("Missing online product id");
  if (!["archive", "zero_stock", "zero_then_archive"].includes(action)) throw new Error("Unsupported online product action");
  const online = await mysqlQueryOne("SELECT * FROM online_products WHERE id = ?", [onlineProductId]);
  if (!online) throw new Error("Online product not found");
  const shop = await mysqlQueryOne("SELECT * FROM shops WHERE id = ?", [online.shop_id]);
  if (!shop) throw new Error("Shop not found");
  const actionId = await recordOnlineProductActionMysql({ online, action, status: "pending", request: body, userId });
  const result = { ok: true, action, online_product_id: onlineProductId, steps: [] };
  try {
    if (action === "zero_stock" || action === "zero_then_archive") {
      const stockTargets = await resolveOnlineProductZeroStockTargetsMysql(online, body);
      const stockResult = await updateOzonProductStocks(shop, stockTargets);
      result.steps.push({ action: "zero_stock", ok: true, result: stockResult, targets: stockTargets });
    }
    if (action === "archive" || action === "zero_then_archive") {
      const archiveResult = await archiveOzonProducts(shop, [Number(online.ozon_product_id || 0)]);
      await mysqlExecute("UPDATE online_products SET archived = 1, status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [onlineProductId]);
      result.steps.push({ action: "archive", ok: true, result: archiveResult });
    }
    await finishOnlineProductActionMysql(actionId, "success", result, "");
    return result;
  } catch (error) {
    result.ok = false;
    result.error = error.message || String(error);
    await finishOnlineProductActionMysql(actionId, "failed", result, result.error);
    throw error;
  }
}

export async function mappingsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const shopId = String(query.shopId || query.shop_id || "all");
  const productId = Number(query.productId || query.product_id || 0);
  const dateFrom = String(query.dateFrom || query.date_from || "").slice(0, 10);
  const dateTo = String(query.dateTo || query.date_to || "").slice(0, 10);
  const where = ["COALESCE(sm.active, 1) != 0"];
  const params = [];
  if (productId) {
    where.push("sm.product_id = ?");
    params.push(productId);
  }
  if (shopId !== "all") {
    where.push("sm.shop_id = ?");
    params.push(Number(shopId));
  }
  if (dateFrom) {
    where.push("DATE(COALESCE(sm.created_at, sm.updated_at)) >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push("DATE(COALESCE(sm.created_at, sm.updated_at)) <= ?");
    params.push(dateTo);
  }
  if (searchText) {
    const like = `%${searchText}%`;
    where.push(`(
      LOWER(COALESCE(p.name, '')) LIKE ?
      OR LOWER(COALESCE(p.code, '')) LIKE ?
      OR LOWER(COALESCE(s.name, '')) LIKE ?
      OR LOWER(COALESCE(sm.ozon_sku, '')) LIKE ?
      OR LOWER(COALESCE(sm.offer_id, '')) LIKE ?
      OR LOWER(COALESCE(op.name, '')) LIKE ?
      OR LOWER(COALESCE(pe.name, '')) LIKE ?
    )`);
    params.push(like, like, like, like, like, like, like);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const selectSql = `
    SELECT
      sm.*,
      s.name AS shop_name,
      p.code AS product_code,
      p.name AS product_name,
      p.image_url AS product_image_url,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS inventory_id,
      pe.name AS person_name,
      op.name AS online_name,
      op.primary_image AS online_primary_image,
      op.image_url AS online_image_url
    FROM sku_mappings sm
    JOIN shops s ON s.id = sm.shop_id
    JOIN products p ON p.id = sm.product_id
    LEFT JOIN people pe ON pe.id = sm.person_id
    LEFT JOIN online_products op ON op.id = sm.online_product_id
    ${whereSql}
  `;
  if (!paged) {
    return await mysqlQuery(`
      ${selectSql}
      ORDER BY p.id DESC, sm.shop_id ASC, sm.ozon_sku ASC, sm.id DESC
    `, params);
  }
  const offset = (page - 1) * pageSize;
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`SELECT COUNT(*) AS total FROM (${selectSql}) mapping_rows`, params),
    mysqlQuery(`
      ${selectSql}
      ORDER BY p.id DESC, sm.shop_id ASC, sm.ozon_sku ASC, sm.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset])
  ]);
  return {
    rows,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

export async function productsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const shopId = String(query.shopId || query.shop_id || "all");
  const dateFrom = String(query.dateFrom || query.date_from || "").slice(0, 10);
  const dateTo = String(query.dateTo || query.date_to || "").slice(0, 10);
  const where = ["p.active = 1", "NOT (COALESCE(p.product_type, 'main') = 'selection' AND COALESCE(p.selection_status, 'draft') = 'draft')"];
  const params = [];

  if (dateFrom) {
    where.push("DATE(p.created_at) >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push("DATE(p.created_at) <= ?");
    params.push(dateTo);
  }
  if (shopId !== "all") {
    where.push("EXISTS (SELECT 1 FROM sku_mappings sm_filter WHERE sm_filter.product_id = p.id AND sm_filter.active = 1 AND sm_filter.shop_id = ?)");
    params.push(Number(shopId));
  }
  if (searchText) {
    const like = `%${searchText}%`;
    where.push(`(
      LOWER(COALESCE(p.name, '')) LIKE ?
      OR LOWER(COALESCE(p.code, '')) LIKE ?
      OR LOWER(COALESCE(pe.name, '')) LIKE ?
      OR EXISTS (
        SELECT 1
        FROM sku_mappings sm_search
        LEFT JOIN shops s_search ON s_search.id = sm_search.shop_id
        LEFT JOIN online_products op_search ON op_search.id = sm_search.online_product_id
        WHERE sm_search.product_id = p.id
          AND sm_search.active = 1
          AND (
            LOWER(COALESCE(sm_search.ozon_sku, '')) LIKE ?
            OR LOWER(COALESCE(sm_search.offer_id, '')) LIKE ?
            OR LOWER(COALESCE(op_search.name, '')) LIKE ?
            OR LOWER(COALESCE(s_search.name, '')) LIKE ?
          )
      )
    )`);
    params.push(like, like, like, like, like, like, like);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  if (paged) {
    const offset = (page - 1) * pageSize;
    const totalRow = await mysqlQueryOne(`
      SELECT COUNT(*) AS total
      FROM products p
      LEFT JOIN people pe ON pe.id = p.owner_person_id
      ${whereSql}
    `, params);
    const rows = await mysqlQuery(`
      WITH page_products AS (
        SELECT p.id
        FROM products p
        LEFT JOIN people pe ON pe.id = p.owner_person_id
        ${whereSql}
        ORDER BY p.id DESC
        LIMIT ? OFFSET ?
      )
      SELECT p.*,
        CASE
          WHEN p.code LIKE 'P-%' THEN p.code
          ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        END AS inventory_id,
        pe.name AS owner_name,
        creator.name AS creator_name,
        COALESCE(stock.stock, 0) AS stock,
        COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost) AS avg_unit_cost,
        COALESCE(proc.total_purchase_amount, stock.total_purchase_amount, 0) AS total_purchase_amount,
        COALESCE(proc.total_purchase_quantity, 0) AS total_purchase_quantity,
        COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
        COALESCE(skus.sku_count, 0) AS sku_count,
        COALESCE(skus.skus, '') AS mapped_skus,
        COALESCE(skus.origin_skus, '') AS origin_skus,
        COALESCE(sales.total_sales_quantity, 0) AS total_sales_quantity,
        COALESCE(sales.total_sales_amount, 0) AS total_sales_amount,
        CASE WHEN COALESCE(sales.total_sales_quantity, 0) > 0
          THEN COALESCE(sales.total_sales_amount, 0) / sales.total_sales_quantity
          ELSE 0 END AS avg_sale_price,
        COALESCE(sales.estimated_profit_total, 0) AS estimated_profit_total,
        COALESCE(sales.order_count, 0) AS order_count,
        CASE WHEN COALESCE(sales.total_sales_amount, 0) > 0
          THEN COALESCE(sales.estimated_profit_total, 0) / sales.total_sales_amount
          ELSE 0 END AS profit_rate
      FROM page_products pp
      JOIN products p ON p.id = pp.id
      LEFT JOIN people pe ON pe.id = p.owner_person_id
      LEFT JOIN people creator ON creator.id = p.created_by_person_id
      LEFT JOIN (
        SELECT im.product_id,
          SUM(im.quantity_delta) AS stock,
          CASE WHEN SUM(CASE WHEN im.quantity_delta > 0 THEN im.quantity_delta ELSE 0 END) > 0
            THEN SUM(CASE WHEN im.quantity_delta > 0 THEN im.amount ELSE 0 END) /
                 SUM(CASE WHEN im.quantity_delta > 0 THEN im.quantity_delta ELSE 0 END)
            ELSE NULL END AS avg_unit_cost,
          SUM(CASE WHEN im.quantity_delta > 0 THEN im.amount ELSE 0 END) AS total_purchase_amount
        FROM inventory_movements im
        JOIN page_products pp_stock ON pp_stock.id = im.product_id
        WHERE im.status = 'posted'
        GROUP BY im.product_id
      ) stock ON stock.product_id = p.id
      LEFT JOIN (
        SELECT pr.product_id,
          SUM(pr.quantity) AS total_purchase_quantity,
          SUM(pr.amount + COALESCE(pr.shipping_amount, 0)) AS total_purchase_amount,
          CASE WHEN SUM(pr.quantity) > 0 THEN SUM(pr.amount + COALESCE(pr.shipping_amount, 0)) / SUM(pr.quantity) ELSE NULL END AS avg_unit_cost
        FROM procurement_requests pr
        JOIN page_products pp_proc ON pp_proc.id = pr.product_id
        WHERE pr.status != 'cancelled'
        GROUP BY pr.product_id
      ) proc ON proc.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS incoming_stock
        FROM (
          SELECT ir.product_id, ir.quantity
          FROM inbound_records ir
          JOIN page_products pp_inbound ON pp_inbound.id = ir.product_id
          WHERE ir.status = 'pending_arrival'
          UNION ALL
          SELECT pr.product_id, pr.quantity
          FROM procurement_requests pr
          JOIN page_products pp_submitted ON pp_submitted.id = pr.product_id
          WHERE pr.status = 'submitted'
        ) incoming_rows
        GROUP BY product_id
      ) incoming ON incoming.product_id = p.id
      LEFT JOIN (
        SELECT sm.product_id, COUNT(*) AS sku_count,
          GROUP_CONCAT(sm.ozon_sku ORDER BY sm.id DESC SEPARATOR ', ') AS skus,
          GROUP_CONCAT(CONCAT(COALESCE(s.name, ''), ' / ', COALESCE(sm.ozon_sku, '')) ORDER BY sm.id DESC SEPARATOR '||') AS origin_skus
        FROM sku_mappings sm
        JOIN page_products pp_skus ON pp_skus.id = sm.product_id
        LEFT JOIN shops s ON s.id = sm.shop_id
        WHERE sm.active = 1
        GROUP BY sm.product_id
      ) skus ON skus.product_id = p.id
      LEFT JOIN (
        SELECT sm.product_id,
          SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END) AS total_sales_amount,
          SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END) AS total_sales_quantity,
          SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit) ELSE 0 END) AS estimated_profit_total,
          COUNT(DISTINCT CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.order_id END) AS order_count
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
        JOIN page_products pp_sales ON pp_sales.id = sm.product_id
        GROUP BY sm.product_id
      ) sales ON sales.product_id = p.id
      ORDER BY p.id DESC
    `, [...params, pageSize, offset]);

    const mappingSummaries = await productMappingSummariesMysql(rows.map((row) => Number(row.id)));
    const enriched = rows.map((row) => compactProductListRowMysql({
      ...row,
      ...(mappingSummaries.get(Number(row.id)) || {
        shop_ids: [],
        shop_names: [],
        bound_mappings: [],
        bound_sku_count: 0,
        sku_preview: [],
        sku_preview_extra: 0
      }),
      pricing: null
    }));
    return {
      rows: enriched,
      total: Number(totalRow?.total || 0),
      page,
      pageSize,
      mode: "paged"
    };
  }

  const selectSql = `
    SELECT p.*,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS inventory_id,
      pe.name AS owner_name,
      creator.name AS creator_name,
      COALESCE(stock.stock, 0) AS stock,
      COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost) AS avg_unit_cost,
      COALESCE(proc.total_purchase_amount, stock.total_purchase_amount, 0) AS total_purchase_amount,
      COALESCE(proc.total_purchase_quantity, 0) AS total_purchase_quantity,
      COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
      COALESCE(skus.sku_count, 0) AS sku_count,
      COALESCE(skus.skus, '') AS mapped_skus,
      COALESCE(skus.origin_skus, '') AS origin_skus,
      COALESCE(sales.total_sales_quantity, 0) AS total_sales_quantity,
      COALESCE(sales.total_sales_amount, 0) AS total_sales_amount,
      CASE WHEN COALESCE(sales.total_sales_quantity, 0) > 0
        THEN COALESCE(sales.total_sales_amount, 0) / sales.total_sales_quantity
        ELSE 0 END AS avg_sale_price,
      COALESCE(sales.estimated_profit_total, 0) AS estimated_profit_total,
      COALESCE(sales.order_count, 0) AS order_count,
      CASE WHEN COALESCE(sales.total_sales_amount, 0) > 0
        THEN COALESCE(sales.estimated_profit_total, 0) / sales.total_sales_amount
        ELSE 0 END AS profit_rate
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    LEFT JOIN (
      SELECT product_id,
        SUM(quantity_delta) AS stock,
        CASE WHEN SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) > 0
          THEN SUM(CASE WHEN quantity_delta > 0 THEN amount ELSE 0 END) /
               SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END)
          ELSE NULL END AS avg_unit_cost,
        SUM(CASE WHEN quantity_delta > 0 THEN amount ELSE 0 END) AS total_purchase_amount
      FROM inventory_movements
      WHERE status = 'posted'
      GROUP BY product_id
    ) stock ON stock.product_id = p.id
    LEFT JOIN (
      SELECT product_id,
        SUM(quantity) AS total_purchase_quantity,
        SUM(amount + COALESCE(shipping_amount, 0)) AS total_purchase_amount,
        CASE WHEN SUM(quantity) > 0 THEN SUM(amount + COALESCE(shipping_amount, 0)) / SUM(quantity) ELSE NULL END AS avg_unit_cost
      FROM procurement_requests
      WHERE status != 'cancelled'
      GROUP BY product_id
    ) proc ON proc.product_id = p.id
    LEFT JOIN (
      SELECT product_id, SUM(quantity) AS incoming_stock
      FROM (
        SELECT product_id, quantity FROM inbound_records WHERE status = 'pending_arrival'
        UNION ALL
        SELECT product_id, quantity FROM procurement_requests WHERE status = 'submitted'
      ) incoming_rows
      GROUP BY product_id
    ) incoming ON incoming.product_id = p.id
    LEFT JOIN (
      SELECT sm.product_id, COUNT(*) AS sku_count,
        GROUP_CONCAT(sm.ozon_sku ORDER BY sm.id DESC SEPARATOR ', ') AS skus,
        GROUP_CONCAT(CONCAT(COALESCE(s.name, ''), ' / ', COALESCE(sm.ozon_sku, '')) ORDER BY sm.id DESC SEPARATOR '||') AS origin_skus
      FROM sku_mappings sm
      LEFT JOIN shops s ON s.id = sm.shop_id
      WHERE sm.active = 1
      GROUP BY sm.product_id
    ) skus ON skus.product_id = p.id
    LEFT JOIN (
      SELECT sm.product_id,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END) AS total_sales_amount,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END) AS total_sales_quantity,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit) ELSE 0 END) AS estimated_profit_total,
        COUNT(DISTINCT CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.order_id END) AS order_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
      GROUP BY sm.product_id
    ) sales ON sales.product_id = p.id
    ${whereSql}
  `;

  const totalRow = paged ? await mysqlQueryOne(`SELECT COUNT(*) AS total FROM (${selectSql}) product_rows`, params) : null;
  const rows = await mysqlQuery(`
    ${selectSql}
    ORDER BY p.id DESC
    ${paged ? "LIMIT ? OFFSET ?" : ""}
  `, paged ? [...params, pageSize, (page - 1) * pageSize] : params);

  const mappingSummaries = await productMappingSummariesMysql(rows.map((row) => Number(row.id)));
  const enriched = rows.map((row) => compactProductListRowMysql({
    ...row,
    ...(mappingSummaries.get(Number(row.id)) || {
      shop_ids: [],
      shop_names: [],
      bound_mappings: [],
      bound_sku_count: 0,
      sku_preview: [],
      sku_preview_extra: 0
    }),
    pricing: null
  }));

  if (!paged) return enriched;
  return {
    rows: enriched,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

export async function hiddenProductsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const shopId = String(query.shopId || query.shop_id || "all");
  const dateFrom = String(query.dateFrom || query.date_from || "").slice(0, 10);
  const dateTo = String(query.dateTo || query.date_to || "").slice(0, 10);
  const removedFromInventorySql = "(p.active = 1 AND COALESCE(p.product_type, 'main') = 'selection' AND COALESCE(p.selection_status, 'draft') = 'draft')";
  const where = [`(p.active = 0 OR ${removedFromInventorySql})`];
  const params = [];
  if (dateFrom) {
    where.push("DATE(COALESCE(p.updated_at, p.created_at)) >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push("DATE(COALESCE(p.updated_at, p.created_at)) <= ?");
    params.push(dateTo);
  }
  if (shopId !== "all") {
    where.push("EXISTS (SELECT 1 FROM sku_mappings sm_filter WHERE sm_filter.product_id = p.id AND sm_filter.active = 1 AND sm_filter.shop_id = ?)");
    params.push(Number(shopId));
  }
  if (searchText) {
    const like = `%${searchText}%`;
    where.push(`(
      LOWER(COALESCE(p.name, '')) LIKE ?
      OR LOWER(COALESCE(p.code, '')) LIKE ?
      OR LOWER(COALESCE(p.selection_id, '')) LIKE ?
      OR LOWER(COALESCE(p.purchase_url, '')) LIKE ?
      OR LOWER(COALESCE(pe.name, '')) LIKE ?
      OR EXISTS (
        SELECT 1
        FROM sku_mappings sm_search
        LEFT JOIN shops sh_search ON sh_search.id = sm_search.shop_id
        WHERE sm_search.product_id = p.id
          AND sm_search.active = 1
          AND (
            LOWER(COALESCE(sm_search.ozon_sku, '')) LIKE ?
            OR LOWER(COALESCE(sm_search.offer_id, '')) LIKE ?
            OR LOWER(COALESCE(sm_search.display_name, '')) LIKE ?
            OR LOWER(COALESCE(sh_search.name, '')) LIKE ?
          )
      )
    )`);
    params.push(like, like, like, like, like, like, like, like, like);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const selectSql = `
    SELECT p.id, p.selection_id, p.code,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS inventory_id,
      CASE WHEN p.active = 0 THEN 'deleted' ELSE 'removed_from_inventory' END AS hidden_reason,
      p.name, p.image_url, p.purchase_url, p.supplier_note, p.source_platform, p.supplier_id, p.shipping_method,
      p.purchase_cost, p.domestic_shipping, p.handling_fee, p.purchase_quantity,
      p.package_weight_g, p.length_cm, p.width_cm, p.height_cm,
      p.listing_price_rub, p.air_sale_price_rmb, p.exchange_rate,
      p.target_margin, p.desired_profit_mode, p.desired_profit_value, p.return_rate, p.product_type, p.selection_status,
      p.owner_person_id, p.created_by_person_id, p.created_at, p.updated_at,
      pe.name AS owner_name, creator.name AS creator_name,
      supplier.name AS supplier_name
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    LEFT JOIN suppliers supplier ON supplier.id = p.supplier_id
    ${whereSql}
  `;
  if (!paged) {
    return (await mysqlQuery(`${selectSql} ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC`, params))
      .map(withProductImageEndpointMysql);
  }
  const offset = (page - 1) * pageSize;
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`SELECT COUNT(*) AS total FROM (${selectSql}) hidden_product_rows`, params),
    mysqlQuery(`${selectSql} ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset])
  ]);
  return {
    rows: rows.map(withProductImageEndpointMysql),
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

export async function selectionProductsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureSelectionCreativeSchemaMysql();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const ownerPersonId = String(query.ownerPersonId || query.owner_person_id || "all");
  const quoteStatus = String(query.quoteStatus || query.quote_status || "all");
  const where = [
    "p.active = 1",
    "COALESCE(p.product_type, 'main') = 'selection'",
    "COALESCE(p.selection_status, 'draft') = 'draft'"
  ];
  const params = [];

  if (ownerPersonId !== "all") {
    where.push("p.owner_person_id = ?");
    params.push(Number(ownerPersonId));
  }
  if (searchText) {
    const like = `%${searchText}%`;
    where.push(`(
      LOWER(COALESCE(p.name, '')) LIKE ?
      OR LOWER(COALESCE(p.code, '')) LIKE ?
      OR LOWER(COALESCE(p.selection_id, '')) LIKE ?
      OR LOWER(COALESCE(p.purchase_url, '')) LIKE ?
      OR LOWER(COALESCE(p.supplier_note, '')) LIKE ?
      OR LOWER(COALESCE(p.material, '')) LIKE ?
      OR LOWER(COALESCE(p.color, '')) LIKE ?
      OR LOWER(COALESCE(p.selling_points, '')) LIKE ?
      OR LOWER(COALESCE(p.source_platform, '')) LIKE ?
      OR LOWER(COALESCE(pe.name, '')) LIKE ?
      OR LOWER(COALESCE(creator.name, '')) LIKE ?
      OR LOWER(COALESCE(supplier.name, '')) LIKE ?
    )`);
    params.push(like, like, like, like, like, like, like, like, like, like, like, like);
  }

  const selectSql = `
    SELECT p.id, p.selection_id, p.code,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS inventory_id,
      p.name, p.image_url, p.detail_image_urls, p.material, p.color, p.selling_points,
      p.purchase_url, p.supplier_note, p.source_platform, p.supplier_id, p.shipping_method,
      p.purchase_cost, p.domestic_shipping, p.handling_fee, p.purchase_quantity,
      p.package_weight_g, p.length_cm, p.width_cm, p.height_cm,
      p.listing_price_rub, p.air_sale_price_rmb, p.exchange_rate,
      p.target_margin, p.desired_profit_mode, p.desired_profit_value, p.return_rate, p.selection_status,
      p.owner_person_id, p.created_by_person_id, p.created_at, p.updated_at,
      pe.name AS owner_name, creator.name AS creator_name,
      supplier.name AS supplier_name
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    LEFT JOIN suppliers supplier ON supplier.id = p.supplier_id
    WHERE ${where.join(" AND ")}
  `;
  const rows = await mysqlQuery(`
    ${selectSql}
    ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC
  `, params);
  const enriched = rows.map((row) => ({
    ...withProductImageEndpointMysql(row),
    pricing: calculateSelectionPricing(row)
  }));
  const filtered = quoteStatus === "all"
    ? enriched
    : enriched.filter((row) => {
      const hasQuote = Boolean(row.pricing?.air || row.pricing?.land);
      return quoteStatus === "quoted" ? hasQuote : !hasQuote;
    });

  if (!paged) return filtered;

  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    mode: "paged",
    summary: selectionSummaryMysql(filtered)
  };
}

export async function selectionProductMysql(id) {
  ensureMysqlCutoverEnabled();
  await ensureSelectionCreativeSchemaMysql();
  const row = await mysqlQueryOne(`
    SELECT p.id, p.selection_id, p.code,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS inventory_id,
      p.name, p.image_url, p.detail_image_urls, p.material, p.color, p.selling_points,
      p.purchase_url, p.supplier_note, p.source_platform, p.supplier_id, p.shipping_method,
      p.purchase_cost, p.domestic_shipping, p.handling_fee, p.purchase_quantity,
      p.package_weight_g, p.length_cm, p.width_cm, p.height_cm,
      p.listing_price_rub, p.air_sale_price_rmb, p.exchange_rate,
      p.target_margin, p.desired_profit_mode, p.desired_profit_value, p.return_rate,
      p.owner_person_id, p.created_by_person_id, p.created_at, p.updated_at,
      pe.name AS owner_name, creator.name AS creator_name
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    WHERE p.active = 1 AND p.id = ?
  `, [Number(id)]);
  return row ? { ...withProductImageEndpointMysql(row), pricing: calculateSelectionPricing(row) } : null;
}

export async function productImageMysql(id) {
  ensureMysqlCutoverEnabled();
  const row = await mysqlQueryOne("SELECT image_url FROM products WHERE id = ? AND active = 1", [Number(id)]);
  const image = String(row?.image_url || "").trim();
  if (/^\/api\/products\/\d+\/image$/i.test(image)) return "";
  return image;
}

async function productOrderDetailRowsMysql(productId, cancelled) {
  const cancelCondition = cancelled
    ? "(LOWER(order_status) LIKE '%cancel%' OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%')"
    : "(LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%')";
  return await mysqlQuery(`
    WITH mapped_items AS (
      SELECT
        oi.id AS order_item_id,
        oi.order_id,
        oi.ozon_sku,
        oi.ozon_name,
        oi.quantity,
        oi.sale_price,
        oi.estimated_profit,
        oi.actual_profit,
        oi.settlement_state,
        oi.frozen_purchase_cost,
        oi.frozen_domestic_shipping,
        oi.frozen_international_shipping,
        oi.frozen_handling_fee,
        oi.estimated_commission,
        oi.platform_fee_actual,
        oi.aftersale_loss,
        opi.sale_amount_cny,
        opi.purchase_cost_cny,
        opi.domestic_shipping_cny,
        opi.international_shipping_cny,
        opi.packaging_cost_cny,
        opi.commission_fee_cny,
        opi.ozon_service_fee_cny,
        opi.return_loss_cny,
        opi.advertising_cost_cny,
        opi.other_fee_cny,
        opi.net_profit_cny,
        o.posting_number,
        o.order_number,
        o.status AS order_status,
        o.tracking_stage,
        COALESCE(o.cancel_loss_applies, 0) AS cancel_loss_applies,
        o.cancel_reason,
        o.cancel_initiator,
        o.ordered_at,
        o.created_at,
        s.name AS shop_name,
        sm.product_id,
        sm.id AS sku_mapping_id,
        sm.offer_id,
        sm.display_name AS mapping_display_name,
        sm.commission_low,
        sm.commission_high,
        p.name AS product_name,
        p.purchase_cost AS product_purchase_cost,
        p.domestic_shipping AS product_domestic_shipping,
        p.handling_fee AS product_handling_fee,
        p.purchase_quantity AS product_purchase_quantity,
        p.package_weight_g,
        p.length_cm,
        p.width_cm,
        p.height_cm,
        p.return_rate,
        p.withdrawal_fee_rate,
        p.exchange_rate,
        p.shipping_method,
        COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost + p.domestic_shipping) AS avg_unit_cost,
        ROW_NUMBER() OVER (PARTITION BY oi.id ORDER BY CASE WHEN sm.id = oi.sku_mapping_id THEN 0 ELSE 1 END, sm.id) AS rn
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN shops s ON s.id = o.shop_id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      JOIN sku_mappings sm ON (
        (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
        AND sm.active = 1
      )
      JOIN products p ON p.id = sm.product_id
      LEFT JOIN (
        SELECT product_id,
          CASE WHEN SUM(quantity_delta) > 0 THEN SUM(amount) / SUM(quantity_delta) ELSE NULL END AS avg_unit_cost
        FROM inventory_movements
        WHERE status = 'posted' AND quantity_delta > 0
        GROUP BY product_id
      ) stock ON stock.product_id = p.id
      LEFT JOIN (
        SELECT product_id,
          CASE WHEN SUM(quantity) > 0 THEN SUM(amount + COALESCE(shipping_amount, 0)) / SUM(quantity) ELSE NULL END AS avg_unit_cost
        FROM procurement_requests
        WHERE status != 'cancelled'
        GROUP BY product_id
      ) proc ON proc.product_id = p.id
      WHERE sm.product_id = ?
    )
    SELECT *
    FROM mapped_items
    WHERE rn = 1 AND ${cancelCondition}
    ORDER BY COALESCE(ordered_at, created_at) DESC, order_item_id DESC
    LIMIT 500
  `, [Number(productId)]);
}

function positiveNumberMysql(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function computeProductOrderDetailMysql(row = {}) {
  const quantity = Number(row.quantity || 0);
  const salePrice = Number(row.sale_price || 0);
  const purchaseCost = positiveNumberMysql(row.purchase_cost_cny) && quantity
    ? Number(row.purchase_cost_cny) / quantity
    : (positiveNumberMysql(row.frozen_purchase_cost) || positiveNumberMysql(row.avg_unit_cost) || positiveNumberMysql(row.product_purchase_cost));
  const domesticShipping = positiveNumberMysql(row.domestic_shipping_cny) && quantity
    ? Number(row.domestic_shipping_cny) / quantity
    : (positiveNumberMysql(row.frozen_domestic_shipping) || positiveNumberMysql(row.product_domestic_shipping));
  const internationalShipping = positiveNumberMysql(row.international_shipping_cny) && quantity
    ? Number(row.international_shipping_cny) / quantity
    : positiveNumberMysql(row.frozen_international_shipping);
  const handlingFee = positiveNumberMysql(row.packaging_cost_cny) && quantity
    ? Number(row.packaging_cost_cny) / quantity
    : positiveNumberMysql(row.product_handling_fee);
  const commission = positiveNumberMysql(row.commission_fee_cny) || positiveNumberMysql(row.estimated_commission);
  const ozonServiceFee = positiveNumberMysql(row.ozon_service_fee_cny) || positiveNumberMysql(row.platform_fee_actual);
  const returnLoss = positiveNumberMysql(row.return_loss_cny);
  const advertisingCost = positiveNumberMysql(row.advertising_cost_cny);
  const otherFee = positiveNumberMysql(row.other_fee_cny) + positiveNumberMysql(row.aftersale_loss);
  const storedProfit = Number(row.settlement_state === "accrued" ? (row.actual_profit || row.estimated_profit || 0) : (row.estimated_profit || row.actual_profit || 0));
  const calculatedProfit =
    salePrice * quantity -
    (purchaseCost + domesticShipping + internationalShipping + handlingFee) * quantity -
    commission -
    ozonServiceFee -
    returnLoss -
    advertisingCost -
    otherFee;
  const cancelLossApplies = Number(row.cancel_loss_applies || 0) > 0;
  const lossBase = cancelLossApplies ? (purchaseCost + domesticShipping + internationalShipping) * quantity : 0;
  return {
    ...row,
    revenue: roundMoneyMysql(salePrice * quantity),
    purchase_cost_total: roundMoneyMysql(purchaseCost * quantity),
    domestic_shipping_total: roundMoneyMysql(domesticShipping * quantity),
    international_shipping_total: roundMoneyMysql(internationalShipping * quantity),
    handling_fee_total: roundMoneyMysql(handlingFee * quantity),
    commission_total: roundMoneyMysql(commission),
    final_mile_bank_fee: 0,
    ozon_service_fee_total: roundMoneyMysql(ozonServiceFee),
    return_loss_total: roundMoneyMysql(returnLoss),
    advertising_cost_total: roundMoneyMysql(advertisingCost),
    other_fee_total: roundMoneyMysql(otherFee),
    cost_total: roundMoneyMysql((purchaseCost + domesticShipping + internationalShipping + handlingFee) * quantity),
    stored_profit_value: roundMoneyMysql(storedProfit),
    calculated_profit_value: roundMoneyMysql(calculatedProfit),
    profit_value: roundMoneyMysql(calculatedProfit),
    cancel_loss_base: roundMoneyMysql(lossBase),
    cancel_loss: roundMoneyMysql(lossBase),
    cost_source: positiveNumberMysql(row.frozen_purchase_cost) || positiveNumberMysql(row.frozen_domestic_shipping)
      ? "涓嬪崟鍐荤粨鎴愭湰"
      : positiveNumberMysql(row.avg_unit_cost) ? "骞冲潎閲囪喘鎴愭湰" : "浜у搧褰撳墠鎴愭湰"
  };
}

export async function productOrderProfitDetailsMysql(productId) {
  ensureMysqlCutoverEnabled();
  return (await productOrderDetailRowsMysql(productId, false)).map(computeProductOrderDetailMysql);
}

export async function productCancelDetailsMysql(productId) {
  ensureMysqlCutoverEnabled();
  return (await productOrderDetailRowsMysql(productId, true)).map(computeProductOrderDetailMysql);
}

async function nextProductCodeMysql(connection) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const row = await mysqlConnectionQueryOne(connection, "SELECT COUNT(*) AS count FROM products WHERE code LIKE ?", [`P-${stamp}-%`]);
  return `P-${stamp}-${String(Number(row?.count || 0) + 1).padStart(3, "0")}`;
}

async function nextSelectionCodeMysql(connection, prefix) {
  const date = todayDateKeyMysql().replaceAll("-", "");
  const row = await mysqlConnectionQueryOne(connection, "SELECT COUNT(*) AS count FROM products WHERE selection_id LIKE ?", [`${prefix}-${date}-%`]);
  return `${prefix}-${date}-${String(Number(row?.count || 0) + 1).padStart(3, "0")}`;
}

async function currentExchangeRateValueMysql() {
  const row = await mysqlQueryOne("SELECT rate FROM exchange_rates ORDER BY effective_date DESC, id DESC LIMIT 1");
  return Number(row?.rate || 11.32);
}

async function maybeCreateProcurementForProductMysql(connection, productId, body = {}, plan = normalizePurchasePlanMysql(body)) {
  if (!["1", "true", "yes"].includes(String(body.create_procurement_request || "").toLowerCase())) return null;
  const personId = await resolvePersonIdOrFirstMysql(body.person_id || body.owner_person_id, connection);
  const [result] = await connection.execute(`
    INSERT INTO procurement_requests
    (product_id, person_id, quantity, amount, shipping_amount, purchase_url, approval_status, status, needed_by, note, urgency, source_type, supplier_id)
    VALUES (?, ?, ?, ?, ?, ?, 'submitted', 'submitted', ?, ?, ?, ?, ?)
  `, [
    Number(productId),
    personId,
    plan.quantity,
    plan.amount,
    plan.shippingAmount,
    body.purchase_url || "",
    body.needed_by || null,
    body.note || body.supplier_note || "Created from product creation",
    body.urgency || "normal",
    body.source_type || body.source_platform || "1688",
    nullableInteger(body.supplier_id)
  ]);
  return { id: Number(result.insertId), ...plan };
}

async function incrementLogisticsRuleUsageMysqlTx(connection, ruleId) {
  const logisticsRuleId = Number(ruleId || 0);
  if (!logisticsRuleId) return;
  await connection.execute(`
    UPDATE logistics_fee_rules
    SET usage_count = COALESCE(usage_count, 0) + 1,
      last_used_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [logisticsRuleId]);
  db.prepare(`
    UPDATE logistics_fee_rules
    SET usage_count = COALESCE(usage_count, 0) + 1,
      last_used_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(logisticsRuleId);
}

export async function createProductMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureSelectionCreativeSchemaMysql();
  const name = String(body.name || "").trim();
  if (!name) throw new Error("Product name is required");
  const exchangeRate = Number(body.exchange_rate || await currentExchangeRateValueMysql() || 11.32);
  return await withMysqlTransaction(async (connection) => {
    const shouldCreateProcurement = ["1", "true", "yes"].includes(String(body.create_procurement_request || "").toLowerCase());
    const purchasePlan = shouldCreateProcurement ? normalizePurchasePlanMysql(body) : null;
    const selectionId = body.selection_id || await nextSelectionCodeMysql(connection, "SEL");
    const code = body.code || await nextProductCodeMysql(connection);
    const ownerPersonId = await resolvePersonIdOrFirstMysql(body.owner_person_id, connection);
    const logisticsRuleId = nullableInteger(body.logistics_rule_id);
    const shippingMethod = body.shipping_method || recommendShippingMysql(body);
    const desiredProfitValue = Number(body.desired_profit_value || 20);
    const targetMargin = Number(body.desired_profit_mode === "margin" ? (desiredProfitValue > 1 ? desiredProfitValue / 100 : desiredProfitValue) : 0.2);
    const [result] = await connection.execute(`
      INSERT INTO products
      (selection_id, code, name, image_url, detail_image_urls, material, color, selling_points,
       purchase_url, supplier_note, source_platform, supplier_id, shipping_method,
       logistics_rule_id, recommended_shipping_method, purchase_cost, domestic_shipping, handling_fee, purchase_quantity,
       package_weight_g, length_cm, width_cm, height_cm, listing_price_rub, air_sale_price_rmb, exchange_rate,
       target_margin, desired_profit_mode, desired_profit_value, return_rate, owner_person_id, created_by_person_id, product_type, selection_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      selectionId,
      code,
      name,
      normalizeProductImageUrlMysql(body.image_url),
      normalizeProductDetailImagesMysql(body.detail_image_urls),
      body.material || "",
      body.color || "",
      body.selling_points || "",
      body.purchase_url || "",
      body.supplier_note || "",
      body.source_platform || "1688",
      nullableInteger(body.supplier_id),
      shippingMethod,
      logisticsRuleId,
      recommendShippingMysql(body),
      purchasePlan ? purchasePlan.unitPurchaseCost : Number(body.purchase_cost || 0),
      purchasePlan ? purchasePlan.unitDomesticShipping : Number(body.domestic_shipping || 0),
      Number(body.handling_fee || 0),
      Number(body.purchase_quantity || 1),
      Number(body.package_weight_g || 0),
      Number(body.length_cm || 30),
      Number(body.width_cm || 20),
      Number(body.height_cm || 10),
      Number(body.listing_price_rub || 0),
      Number(body.air_sale_price_rmb || 0),
      exchangeRate,
      targetMargin,
      body.desired_profit_mode || "margin",
      desiredProfitValue,
      Number(body.return_rate || 0.05),
      ownerPersonId,
      ownerPersonId,
      body.product_type || "main",
      body.selection_status || "listed"
    ]);
    const productId = Number(result.insertId);
    if (logisticsRuleId) await incrementLogisticsRuleUsageMysqlTx(connection, logisticsRuleId);
    const procurement = await maybeCreateProcurementForProductMysql(connection, productId, body, purchasePlan || normalizePurchasePlanMysql(body));
    return { id: productId, code, procurement_request_id: procurement?.id || null };
  });
}

export async function addSelectionToInventoryMysql(id) {
  ensureMysqlCutoverEnabled();
  const productId = Number(id);
  const existing = await mysqlQueryOne("SELECT id, selection_status FROM products WHERE id = ? AND active = 1", [productId]);
  if (!existing) throw new Error("选品不存在或已删除");
  if (String(existing.selection_status || "") === "listed") {
    return { ok: true, id: productId, already_inventory: true };
  }
  await mysqlExecute(`
    UPDATE products
    SET selection_status = 'listed', product_type = 'main', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND active = 1
  `, [productId]);
  return { ok: true, id: productId, already_inventory: false };
}

function parseCsvMysql(csv) {
  const text = String(csv || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim() !== "")) rows.push(row);
  const headers = (rows.shift() || []).map(normalizeHeaderMysql);
  return { headers, rows: rows.filter((item) => item.some((value) => String(value).trim() !== "")) };
}

function normalizeHeaderMysql(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().replace(/\s+/g, "");
}

function cleanCellMysql(value) {
  return String(value ?? "").trim();
}

function numberCellMysql(value, fallback = 0) {
  const text = cleanCellMysql(value).replace(/[￥¥,\s]/g, "");
  if (!text) return fallback;
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function rateCellMysql(value, fallback = 0) {
  const text = cleanCellMysql(value);
  if (!text) return fallback;
  const number = numberCellMysql(text.replace("%", ""), fallback);
  return text.includes("%") || number > 1 ? number / 100 : number;
}

async function personIdByNameMysql(name) {
  const text = cleanCellMysql(name);
  if (!text) return null;
  const row = await mysqlQueryOne("SELECT id FROM people WHERE name = ? OR username = ? ORDER BY active DESC, id LIMIT 1", [text, text]);
  return row?.id || null;
}

function normalizeSourcePlatformMysql(value) {
  const text = cleanCellMysql(value).toLowerCase();
  if (text.includes("1688")) return "1688";
  if (text.includes("pdd") || text.includes("拼多多")) return "pdd";
  return text || "supplier";
}

function normalizeShippingMethodMysql(value) {
  const text = cleanCellMysql(value);
  if (text.includes("陆空")) return "air_land";
  if (text.includes("陆运")) return "land";
  if (text.includes("空运")) return "air";
  return text || "manual_review";
}

async function mapCsvProductRowMysql(headers, row, index) {
  const value = (name) => row[headers.indexOf(normalizeHeaderMysql(name))] ?? "";
  const warnings = [];
  const errors = [];
  const name = cleanCellMysql(value("商品名称"));
  if (!name) errors.push("Product name is empty");
  const exchangeRate = numberCellMysql(value("汇率"), Number((await currentExchangeRateMysql())?.rate || 11.32));
  const saleRmb = numberCellMysql(value("售价")) || numberCellMysql(value("上架价格"));
  const listingRmb = numberCellMysql(value("上架价格")) || saleRmb;
  const imageUrl = cleanCellMysql(value("商品图片"));
  if (imageUrl && !/^https?:\/\//i.test(imageUrl) && !imageUrl.startsWith("data:image/")) warnings.push("Product image is not an accessible URL");
  const personName = cleanCellMysql(value("人员"));
  const ownerPersonId = personName ? await personIdByNameMysql(personName) : await firstActivePersonIdMysql();
  if (personName && !ownerPersonId) warnings.push(`Person not found: ${personName}; using default owner`);
  const productNote = cleanCellMysql(value("商品备注"));
  const accessories = cleanCellMysql(value("配件"));
  const supplierNote = [productNote, accessories ? `Accessories: ${accessories}` : ""].filter(Boolean).join("; ");
  const data = {
    name,
    image_url: imageUrl,
    purchase_url: cleanCellMysql(value("货源")),
    supplier_note: supplierNote,
    source_platform: normalizeSourcePlatformMysql(value("货源平台")),
    shipping_method: normalizeShippingMethodMysql(value("配送方式")),
    purchase_cost: numberCellMysql(value("采购单价")),
    domestic_shipping: numberCellMysql(value("国内运费")),
    purchase_quantity: Math.max(1, Math.round(numberCellMysql(value("采购数"), 1))),
    package_weight_g: numberCellMysql(value("包装克重")),
    length_cm: numberCellMysql(value("长"), 30),
    width_cm: numberCellMysql(value("宽"), 20),
    height_cm: numberCellMysql(value("高"), 10),
    air_sale_price_rmb: saleRmb,
    listing_price_rub: listingRmb && exchangeRate ? listingRmb * exchangeRate : 0,
    exchange_rate: exchangeRate,
    return_rate: rateCellMysql(value("退货率"), 0.05),
    owner_person_id: ownerPersonId || await firstActivePersonIdMysql(),
    desired_profit_mode: "margin",
    desired_profit_value: 20,
    product_type: "main"
  };
  return { index, ok: errors.length === 0, errors, warnings, data, raw: Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ""])) };
}

export async function previewProductCsvImportMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const parsed = parseCsvMysql(String(body.csv || ""));
  const rows = [];
  for (let index = 0; index < parsed.rows.length; index += 1) {
    rows.push(await mapCsvProductRowMysql(parsed.headers, parsed.rows[index], index + 2));
  }
  return {
    total: rows.length,
    valid: rows.filter((row) => row.ok).length,
    invalid: rows.filter((row) => !row.ok).length,
    rows
  };
}

export async function commitProductCsvImportMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const rows = Array.isArray(body.rows)
    ? body.rows.map((data, index) => ({ ok: Boolean(data?.name), data, index: index + 1, errors: data?.name ? [] : ["Product name is empty"] }))
    : (await previewProductCsvImportMysql(body)).rows;
  const result = { inserted: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    if (!row.ok) {
      result.skipped += 1;
      result.errors.push({ index: row.index, message: row.errors?.join("; ") || "Incomplete data" });
      continue;
    }
    try {
      await createProductMysql(row.data);
      result.inserted += 1;
    } catch (error) {
      result.skipped += 1;
      result.errors.push({ index: row.index, message: error.message });
    }
  }
  return result;
}

export async function updateProductMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureSelectionCreativeSchemaMysql();
  const productId = Number(id);
  const existing = await mysqlQueryOne("SELECT id, updated_at FROM products WHERE id = ? AND active = 1", [productId]);
  if (!existing) throw new Error("Product not found or archived");
  if (body.updated_at && normalizeMysqlDateTime(body.updated_at) !== normalizeMysqlDateTime(existing.updated_at)) {
    throw new Error("Product was modified by someone else. Refresh before editing.");
  }
  const exchangeRate = Number(body.exchange_rate || await currentExchangeRateValueMysql() || 11.32);
  const desiredProfitValue = Number(body.desired_profit_value || 20);
  const targetMargin = Number(body.desired_profit_mode === "margin" ? (desiredProfitValue > 1 ? desiredProfitValue / 100 : desiredProfitValue) : 0.2);
  await mysqlExecute(`
    UPDATE products SET
      name = ?, image_url = ?,
      detail_image_urls = COALESCE(?, detail_image_urls),
      material = COALESCE(?, material),
      color = COALESCE(?, color),
      selling_points = COALESCE(?, selling_points),
      purchase_url = ?, supplier_note = ?, source_platform = ?, supplier_id = ?, shipping_method = ?,
      purchase_cost = ?, domestic_shipping = ?, handling_fee = ?, purchase_quantity = ?,
      package_weight_g = ?, length_cm = ?, width_cm = ?, height_cm = ?,
      listing_price_rub = ?, air_sale_price_rmb = ?, exchange_rate = ?, target_margin = ?,
      desired_profit_mode = ?, desired_profit_value = ?, return_rate = ?, owner_person_id = ?, created_by_person_id = ?,
      product_type = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    body.name,
    normalizeProductImageUrlMysql(body.image_url),
    body.detail_image_urls === undefined ? null : normalizeProductDetailImagesMysql(body.detail_image_urls),
    body.material === undefined ? null : body.material || "",
    body.color === undefined ? null : body.color || "",
    body.selling_points === undefined ? null : body.selling_points || "",
    body.purchase_url || "",
    body.supplier_note || "",
    body.source_platform || "1688",
    nullableInteger(body.supplier_id),
    body.shipping_method || recommendShippingMysql(body),
    Number(body.purchase_cost || 0),
    Number(body.domestic_shipping || 0),
    Number(body.handling_fee || 0),
    Number(body.purchase_quantity || 1),
    Number(body.package_weight_g || 0),
    Number(body.length_cm || 30),
    Number(body.width_cm || 20),
    Number(body.height_cm || 10),
    Number(body.listing_price_rub || 0),
    Number(body.air_sale_price_rmb || 0),
    exchangeRate,
    targetMargin,
    body.desired_profit_mode || "margin",
    desiredProfitValue,
    Number(body.return_rate || 0.05),
    nullableInteger(body.owner_person_id) || await firstActivePersonIdMysql(),
    nullableInteger(body.created_by_person_id) || nullableInteger(body.owner_person_id) || await firstActivePersonIdMysql(),
    body.product_type || "main",
    productId
  ]);
  return { ok: true };
}

async function loadProductsForMergeMysql(productIds = []) {
  const ids = [...new Set((productIds || []).map((item) => Number(item || 0)).filter(Boolean))];
  if (ids.length < 2) throw new Error("请至少选择两个库存产品进行合并");
  const placeholders = ids.map(() => "?").join(",");
  const rows = await mysqlQuery(`
    SELECT p.*,
      pe.name AS owner_name,
      creator.name AS creator_name,
      supplier.name AS supplier_name,
      rule.name AS logistics_rule_name
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    LEFT JOIN suppliers supplier ON supplier.id = p.supplier_id
    LEFT JOIN logistics_fee_rules rule ON rule.id = p.logistics_rule_id
    WHERE p.active = 1 AND p.id IN (${placeholders})
    ORDER BY p.id ASC
  `, ids);
  if (rows.length !== ids.length) throw new Error("所选产品中存在已隐藏或不存在的数据，请刷新后重试");
  return rows;
}

function mergeFieldDisplayValueMysql(field, row) {
  const raw = row?.[field.key];
  if (field.type === "person") return raw ? (row?.owner_name || row?.creator_name || `人员ID ${raw}`) : "未设置";
  if (field.type === "supplier") return raw ? (row?.supplier_name || `供应商ID ${raw}`) : "未设置";
  if (field.type === "logistics_rule") return raw ? (row?.logistics_rule_name || `规则ID ${raw}`) : "未设置";
  if (field.type === "image") return String(raw || "").trim() || "未设置";
  if (field.type === "number") return Number(raw || 0);
  return String(raw || "").trim() || "未设置";
}

function mergeFieldComparableValueMysql(field, row) {
  const raw = row?.[field.key];
  if (field.type === "number") return Number(raw || 0);
  if (field.type === "image") return String(raw || "").trim();
  return raw === null || raw === undefined ? "" : String(raw).trim();
}

function mysqlRefKeySelect(def) {
  const columns = Array.isArray(def.idColumn) ? def.idColumn : [def.idColumn];
  return columns.map((column) => `${column} AS __ref_${column}`).join(", ");
}

function mysqlRefKeyFromRow(def, row = {}) {
  const columns = Array.isArray(def.idColumn) ? def.idColumn : [def.idColumn];
  return Object.fromEntries(columns.map((column) => [column, row[`__ref_${column}`]]));
}

function mysqlRefWhereClause(refKey = {}) {
  const entries = Object.entries(refKey || {});
  return {
    clause: entries.map(([column]) => `${column} = ?`).join(" AND "),
    params: entries.map(([, value]) => value)
  };
}

async function loadMergeReferenceRowsMysql(productIds = []) {
  const ids = [...new Set((productIds || []).map((item) => Number(item || 0)).filter(Boolean))];
  if (!ids.length) return {};
  const placeholders = ids.map(() => "?").join(",");
  const entries = [];
  for (const def of PRODUCT_MERGE_REFERENCE_TABLES_MYSQL) {
    const rows = await mysqlQuery(`
      SELECT ${mysqlRefKeySelect(def)}, ${def.column} AS source_product_id
      FROM ${def.table}
      WHERE ${def.column} IN (${placeholders})
    `, ids);
    entries.push([def.key, rows.map((row) => ({
      refKey: mysqlRefKeyFromRow(def, row),
      sourceProductId: Number(row.source_product_id || 0)
    }))]);
  }
  return Object.fromEntries(entries);
}

async function mergeAffectedCountsMysql(productIds = []) {
  const ids = [...new Set((productIds || []).map((item) => Number(item || 0)).filter(Boolean))];
  if (!ids.length) return {};
  const refs = await loadMergeReferenceRowsMysql(ids);
  return Object.fromEntries(PRODUCT_MERGE_REFERENCE_TABLES_MYSQL.map((def) => {
    const rows = Array.isArray(refs[def.key]) ? refs[def.key] : [];
    const perProduct = {};
    for (const row of rows) {
      const productId = Number(row.sourceProductId || 0);
      if (!productId) continue;
      perProduct[productId] = Number(perProduct[productId] || 0) + 1;
    }
    return [def.key, {
      label: def.label,
      total: rows.length,
      per_product: perProduct
    }];
  }));
}

function mergeCountsSummaryMysql(affectedCounts = {}, targetProductId = 0) {
  const targetId = Number(targetProductId || 0);
  return Object.fromEntries(Object.entries(affectedCounts || {}).map(([key, value]) => {
    const perProduct = value?.per_product || {};
    const total = Object.entries(perProduct).reduce((sum, [productId, count]) => (
      Number(productId) === targetId ? sum : sum + Number(count || 0)
    ), 0);
    return [key, {
      label: value?.label || key,
      total
    }];
  }));
}

async function createProductMergeHistoryRecordMysql(connection, { targetProduct, sourceProducts, fieldSources, affectedCounts }) {
  const [result] = await connection.execute(`
    INSERT INTO product_merge_history (
      target_product_id,
      target_product_name,
      source_product_ids_json,
      source_product_names_json,
      selected_field_sources_json,
      before_target_json,
      before_sources_json,
      affected_counts_json,
      status
    ) VALUES (?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), 'merged')
  `, [
    Number(targetProduct.id),
    String(targetProduct.name || ""),
    JSON.stringify(sourceProducts.map((row) => Number(row.id))),
    JSON.stringify(sourceProducts.map((row) => String(row.name || ""))),
    JSON.stringify(fieldSources || {}),
    JSON.stringify(targetProduct || {}),
    JSON.stringify(sourceProducts || []),
    JSON.stringify(affectedCounts || {})
  ]);
  return Number(result.insertId || 0);
}

async function createProductMergeHistoryRefsMysql(connection, mergeHistoryId, referenceRows = {}) {
  for (const def of PRODUCT_MERGE_REFERENCE_TABLES_MYSQL) {
    for (const row of referenceRows[def.key] || []) {
      await connection.execute(`
        INSERT INTO product_merge_history_refs (merge_history_id, table_key, ref_key_json, source_product_id)
        VALUES (?, ?, CAST(? AS JSON), ?)
      `, [
        Number(mergeHistoryId),
        def.key,
        JSON.stringify(row.refKey || {}),
        Number(row.sourceProductId || 0)
      ]);
    }
  }
}

async function mergeAnalyticsRowsMysql(connection, targetProductId, sourceProductIds = []) {
  const ids = [Number(targetProductId), ...sourceProductIds.map((item) => Number(item || 0)).filter(Boolean)];
  if (!sourceProductIds.length) return;
  const placeholders = ids.map(() => "?").join(",");
  await connection.execute(`
    INSERT INTO analytics_product_profit_daily (
      date_key,
      product_id,
      shop_id,
      order_count,
      item_quantity,
      revenue,
      estimated_profit,
      confirmed_profit,
      current_profit,
      refreshed_at
    )
    SELECT
      date_key,
      ? AS product_id,
      shop_id,
      SUM(order_count) AS order_count,
      SUM(item_quantity) AS item_quantity,
      SUM(revenue) AS revenue,
      SUM(estimated_profit) AS estimated_profit,
      SUM(confirmed_profit) AS confirmed_profit,
      SUM(current_profit) AS current_profit,
      MAX(refreshed_at) AS refreshed_at
    FROM analytics_product_profit_daily
    WHERE product_id IN (${placeholders})
    GROUP BY date_key, shop_id
    ON DUPLICATE KEY UPDATE
      order_count = VALUES(order_count),
      item_quantity = VALUES(item_quantity),
      revenue = VALUES(revenue),
      estimated_profit = VALUES(estimated_profit),
      confirmed_profit = VALUES(confirmed_profit),
      current_profit = VALUES(current_profit),
      refreshed_at = VALUES(refreshed_at)
  `, [Number(targetProductId), ...ids]);
  await connection.execute(`
    DELETE FROM analytics_product_profit_daily
    WHERE product_id IN (${sourceProductIds.map(() => "?").join(",")})
  `, sourceProductIds);

  await connection.execute(`
    INSERT INTO analytics_sku_profit_daily (
      date_key,
      shop_id,
      ozon_sku,
      product_id,
      order_count,
      item_quantity,
      revenue,
      estimated_profit,
      confirmed_profit,
      current_profit,
      cancelled_orders,
      cancelled_quantity,
      cancelled_revenue,
      return_orders,
      return_quantity,
      return_revenue,
      refreshed_at
    )
    SELECT
      date_key,
      shop_id,
      ozon_sku,
      ? AS product_id,
      SUM(order_count) AS order_count,
      SUM(item_quantity) AS item_quantity,
      SUM(revenue) AS revenue,
      SUM(estimated_profit) AS estimated_profit,
      SUM(confirmed_profit) AS confirmed_profit,
      SUM(current_profit) AS current_profit,
      SUM(cancelled_orders) AS cancelled_orders,
      SUM(cancelled_quantity) AS cancelled_quantity,
      SUM(cancelled_revenue) AS cancelled_revenue,
      SUM(return_orders) AS return_orders,
      SUM(return_quantity) AS return_quantity,
      SUM(return_revenue) AS return_revenue,
      MAX(refreshed_at) AS refreshed_at
    FROM analytics_sku_profit_daily
    WHERE product_id IN (${placeholders})
    GROUP BY date_key, shop_id, ozon_sku
    ON DUPLICATE KEY UPDATE
      product_id = VALUES(product_id),
      order_count = VALUES(order_count),
      item_quantity = VALUES(item_quantity),
      revenue = VALUES(revenue),
      estimated_profit = VALUES(estimated_profit),
      confirmed_profit = VALUES(confirmed_profit),
      current_profit = VALUES(current_profit),
      cancelled_orders = VALUES(cancelled_orders),
      cancelled_quantity = VALUES(cancelled_quantity),
      cancelled_revenue = VALUES(cancelled_revenue),
      return_orders = VALUES(return_orders),
      return_quantity = VALUES(return_quantity),
      return_revenue = VALUES(return_revenue),
      refreshed_at = VALUES(refreshed_at)
  `, [Number(targetProductId), ...ids]);
  await connection.execute(`
    DELETE FROM analytics_sku_profit_daily
    WHERE product_id IN (${sourceProductIds.map(() => "?").join(",")})
  `, sourceProductIds);
}

function scheduleMergePostProcessingMysql(targetProductId, sourceProductIds = []) {
  const targetId = Number(targetProductId || 0);
  const sourceIds = [...new Set((sourceProductIds || []).map((item) => Number(item || 0)).filter(Boolean))];
  setTimeout(async () => {
    try {
      await recalculateOrderProfitsForProductMysql(targetId);
      for (const sourceId of sourceIds) {
        try {
          await recalculateOrderProfitsForProductMysql(sourceId);
        } catch (error) {
          console.error("merge post-processing source recalc failed", { sourceId, error });
        }
      }
      await refreshProfitAnalyticsSnapshotsMysql({});
      invalidateMasterDataCache();
    } catch (error) {
      console.error("merge post-processing failed", { targetId, sourceIds, error });
    }
  }, 0);
}

export async function productMergeHistoryMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProductMergeSchemaMysql();
  const limit = Math.max(1, Math.min(100, Number(body.limit || 20)));
  const rows = await mysqlQuery(`
    SELECT *
    FROM product_merge_history
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `, [limit]);
  return rows.map((row) => ({
    id: Number(row.id),
    target_product_id: Number(row.target_product_id || 0),
    target_product_name: row.target_product_name || "",
    source_product_ids: parseJsonFallback(row.source_product_ids_json, []),
    source_product_names: parseJsonFallback(row.source_product_names_json, []),
    selected_field_sources: parseJsonFallback(row.selected_field_sources_json, {}),
    affected_counts: parseJsonFallback(row.affected_counts_json, {}),
    status: row.status || "merged",
    created_at: row.created_at || "",
    undone_at: row.undone_at || ""
  }));
}

export async function undoMergeProductHistoryMysql(id) {
  ensureMysqlCutoverEnabled();
  await ensureProductMergeSchemaMysql();
  const mergeHistoryId = Number(id || 0);
  if (!mergeHistoryId) throw new Error("缺少合并记录 ID");
  let resultPayload = null;
  await withMysqlTransaction(async (connection) => {
    const history = await mysqlConnectionQueryOne(connection, "SELECT * FROM product_merge_history WHERE id = ? FOR UPDATE", [mergeHistoryId]);
    if (!history) throw new Error("未找到该合并记录");
    if (String(history.status || "") === "undone") throw new Error("该合并记录已撤销");
    const targetSnapshot = parseJsonFallback(history.before_target_json, null);
    const sourceSnapshots = parseJsonFallback(history.before_sources_json, []);
    if (!targetSnapshot || !Array.isArray(sourceSnapshots) || !sourceSnapshots.length) throw new Error("该合并记录缺少可恢复快照");
    const targetProductId = Number(history.target_product_id || targetSnapshot.id || 0);
    const sourceProductIds = sourceSnapshots.map((row) => Number(row.id || 0)).filter(Boolean);
    await connection.execute(`
      UPDATE products SET
        name = ?, selection_id = ?, code = ?, image_url = ?, purchase_url = ?, supplier_note = ?, source_platform = ?,
        supplier_id = ?, shipping_method = ?, logistics_rule_id = ?, purchase_cost = ?, domestic_shipping = ?,
        handling_fee = ?, purchase_quantity = ?, package_weight_g = ?, length_cm = ?, width_cm = ?, height_cm = ?,
        listing_price_rub = ?, air_sale_price_rmb = ?, exchange_rate = ?, target_margin = ?,
        desired_profit_mode = ?, desired_profit_value = ?, return_rate = ?, owner_person_id = ?,
        created_by_person_id = ?, product_type = ?, selection_status = ?, active = ?, parent_product_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      targetSnapshot.name,
      targetSnapshot.selection_id,
      targetSnapshot.code,
      normalizeProductImageUrlMysql(targetSnapshot.image_url),
      targetSnapshot.purchase_url || "",
      targetSnapshot.supplier_note || "",
      targetSnapshot.source_platform || "1688",
      nullableInteger(targetSnapshot.supplier_id),
      targetSnapshot.shipping_method || "air_land",
      nullableInteger(targetSnapshot.logistics_rule_id),
      Number(targetSnapshot.purchase_cost || 0),
      Number(targetSnapshot.domestic_shipping || 0),
      Number(targetSnapshot.handling_fee || 0),
      Number(targetSnapshot.purchase_quantity || 1),
      Number(targetSnapshot.package_weight_g || 0),
      Number(targetSnapshot.length_cm || 0),
      Number(targetSnapshot.width_cm || 0),
      Number(targetSnapshot.height_cm || 0),
      Number(targetSnapshot.listing_price_rub || 0),
      Number(targetSnapshot.air_sale_price_rmb || 0),
      Number(targetSnapshot.exchange_rate || 0),
      Number(targetSnapshot.target_margin || 0),
      targetSnapshot.desired_profit_mode || "margin",
      Number(targetSnapshot.desired_profit_value || 0),
      Number(targetSnapshot.return_rate || 0),
      nullableInteger(targetSnapshot.owner_person_id),
      nullableInteger(targetSnapshot.created_by_person_id),
      targetSnapshot.product_type || "main",
      targetSnapshot.selection_status || "listed",
      Number(targetSnapshot.active ?? 1),
      nullableInteger(targetSnapshot.parent_product_id),
      targetProductId
    ]);
    for (const source of sourceSnapshots) {
      await connection.execute(`
        UPDATE products SET
          name = ?, selection_id = ?, code = ?, image_url = ?, purchase_url = ?, supplier_note = ?, source_platform = ?,
          supplier_id = ?, shipping_method = ?, logistics_rule_id = ?, purchase_cost = ?, domestic_shipping = ?,
          handling_fee = ?, purchase_quantity = ?, package_weight_g = ?, length_cm = ?, width_cm = ?, height_cm = ?,
          listing_price_rub = ?, air_sale_price_rmb = ?, exchange_rate = ?, target_margin = ?,
          desired_profit_mode = ?, desired_profit_value = ?, return_rate = ?, owner_person_id = ?,
          created_by_person_id = ?, product_type = ?, selection_status = ?, active = ?, parent_product_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        source.name,
        source.selection_id,
        source.code,
        normalizeProductImageUrlMysql(source.image_url),
        source.purchase_url || "",
        source.supplier_note || "",
        source.source_platform || "1688",
        nullableInteger(source.supplier_id),
        source.shipping_method || "air_land",
        nullableInteger(source.logistics_rule_id),
        Number(source.purchase_cost || 0),
        Number(source.domestic_shipping || 0),
        Number(source.handling_fee || 0),
        Number(source.purchase_quantity || 1),
        Number(source.package_weight_g || 0),
        Number(source.length_cm || 0),
        Number(source.width_cm || 0),
        Number(source.height_cm || 0),
        Number(source.listing_price_rub || 0),
        Number(source.air_sale_price_rmb || 0),
        Number(source.exchange_rate || 0),
        Number(source.target_margin || 0),
        source.desired_profit_mode || "margin",
        Number(source.desired_profit_value || 0),
        Number(source.return_rate || 0),
        nullableInteger(source.owner_person_id),
        nullableInteger(source.created_by_person_id),
        source.product_type || "main",
        source.selection_status || "listed",
        Number(source.active ?? 1),
        nullableInteger(source.parent_product_id),
        Number(source.id)
      ]);
    }
    const refRows = await mysqlQuery(`
      SELECT table_key, ref_key_json, source_product_id
      FROM product_merge_history_refs
      WHERE merge_history_id = ?
      ORDER BY id ASC
    `, [mergeHistoryId]);
    for (const refRow of refRows) {
      const def = PRODUCT_MERGE_REFERENCE_TABLES_MYSQL.find((item) => item.key === refRow.table_key);
      if (!def) continue;
      const refKey = parseJsonFallback(refRow.ref_key_json, {});
      const { clause, params } = mysqlRefWhereClause(refKey);
      if (!clause) continue;
      await connection.execute(`UPDATE ${def.table} SET ${def.column} = ? WHERE ${clause}`, [
        Number(refRow.source_product_id || 0),
        ...params
      ]);
    }
    await connection.execute(`
      UPDATE product_merge_history
      SET status = 'undone',
          undone_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [mergeHistoryId]);
    await rebuildInventoryCurrentForProductMysql(connection, targetProductId);
    for (const sourceProductId of sourceProductIds) {
      await rebuildInventoryCurrentForProductMysql(connection, sourceProductId);
    }
    resultPayload = {
      ok: true,
      id: mergeHistoryId,
      target_product_id: targetProductId,
      source_product_ids: sourceProductIds
    };
  });
  await recalculateOrderProfitsForProductMysql(resultPayload.target_product_id);
  for (const sourceProductId of resultPayload.source_product_ids) {
    await recalculateOrderProfitsForProductMysql(sourceProductId);
  }
  await refreshProfitAnalyticsSnapshotsMysql({});
  invalidateMasterDataCache();
  return resultPayload;
}

function buildMergePreviewMysql(products) {
  const ids = products.map((row) => Number(row.id || 0)).filter(Boolean);
  void ids;
  return {
    products: products.map((row) => ({
      id: Number(row.id),
      name: row.name || "",
      inventory_id: row.code || "",
      image_url: withProductImageEndpointMysql({ id: row.id, image_url: row.image_url })?.image_url || "",
      owner_name: row.owner_name || "",
      supplier_name: row.supplier_name || ""
    })),
    conflicts: PRODUCT_MERGE_FIELD_DEFS_MYSQL
      .map((field) => {
        const options = products.map((row) => ({
          sourceId: Number(row.id),
          label: row.name || `产品 ${row.id}`,
          value: row[field.key],
          displayValue: mergeFieldDisplayValueMysql(field, row)
        }));
        const uniqueValues = [...new Set(products.map((row) => JSON.stringify(mergeFieldComparableValueMysql(field, row))))];
        return {
          key: field.key,
          label: field.label,
          type: field.type,
          conflict: uniqueValues.length > 1,
          options
        };
      })
      .filter((field) => field.conflict),
    affected_counts: {},
    move_counts_summary: {}
  };
}

export async function previewMergeProductsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProductMergeSchemaMysql();
  const products = await loadProductsForMergeMysql(body.product_ids);
  const preview = buildMergePreviewMysql(products);
  preview.affected_counts = await mergeAffectedCountsMysql(products.map((row) => row.id));
  preview.move_counts_summary = mergeCountsSummaryMysql(preview.affected_counts, preview.products[0]?.id || 0);
  return preview;
}

function resolveMergeFieldValueMysql(productsById, fieldKey, sourceId, fallbackProductId) {
  const field = PRODUCT_MERGE_FIELD_DEFS_MYSQL.find((item) => item.key === fieldKey);
  if (!field) throw new Error(`不支持的合并字段：${fieldKey}`);
  const sourceProduct = productsById.get(Number(sourceId || 0)) || productsById.get(Number(fallbackProductId || 0));
  if (!sourceProduct) throw new Error(`字段 ${field.label} 未找到可用来源`);
  return sourceProduct[field.key];
}

export async function mergeProductsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProductMergeSchemaMysql();
  const products = await loadProductsForMergeMysql(body.product_ids);
  const productsById = new Map(products.map((row) => [Number(row.id), row]));
  const targetProductId = Number(body.target_product_id || products[0]?.id || 0);
  if (!productsById.has(targetProductId)) throw new Error("主产品不在本次合并选择范围内");
  const sourceProductIds = products.map((row) => Number(row.id)).filter((id) => id !== targetProductId);
  if (!sourceProductIds.length) throw new Error("请至少选择一个待并入产品");
  const mergeSelections = body.field_sources && typeof body.field_sources === "object" ? body.field_sources : {};
  const targetSnapshot = productsById.get(targetProductId);
  const sourceSnapshots = products.filter((row) => Number(row.id) !== targetProductId);
  const referenceRows = await loadMergeReferenceRowsMysql(sourceProductIds);
  const affectedCounts = await mergeAffectedCountsMysql(sourceProductIds);
  const mergedValues = {};
  for (const field of PRODUCT_MERGE_FIELD_DEFS_MYSQL) {
    const selectedSourceId = Number(mergeSelections[field.key] || targetProductId);
    mergedValues[field.key] = resolveMergeFieldValueMysql(productsById, field.key, selectedSourceId, targetProductId);
  }
  if (!String(mergedValues.name || "").trim()) throw new Error("合并后的产品名称不能为空");
  let mergeHistoryId = 0;
  await withMysqlTransaction(async (connection) => {
    if (mergedValues.selection_id) {
      const duplicate = await mysqlConnectionQueryOne(connection, `
        SELECT id FROM products
        WHERE selection_id = ? AND active = 1 AND id != ? AND id NOT IN (${sourceProductIds.map(() => "?").join(",")})
        LIMIT 1
      `, [mergedValues.selection_id, targetProductId, ...sourceProductIds]);
      if (duplicate) throw new Error("所选选品编号已被其他产品占用");
    }
    if (mergedValues.code) {
      const duplicate = await mysqlConnectionQueryOne(connection, `
        SELECT id FROM products
        WHERE code = ? AND active = 1 AND id != ? AND id NOT IN (${sourceProductIds.map(() => "?").join(",")})
        LIMIT 1
      `, [mergedValues.code, targetProductId, ...sourceProductIds]);
      if (duplicate) throw new Error("所选库存编码已被其他产品占用");
    }
    mergeHistoryId = await createProductMergeHistoryRecordMysql(connection, {
      targetProduct: targetSnapshot,
      sourceProducts: sourceSnapshots,
      fieldSources: mergeSelections,
      affectedCounts
    });
    await createProductMergeHistoryRefsMysql(connection, mergeHistoryId, referenceRows);
    await connection.execute(`
      UPDATE products SET
        name = ?, selection_id = ?, code = ?, image_url = ?, purchase_url = ?, supplier_note = ?, source_platform = ?,
        supplier_id = ?, shipping_method = ?, logistics_rule_id = ?, purchase_cost = ?, domestic_shipping = ?,
        handling_fee = ?, purchase_quantity = ?, package_weight_g = ?, length_cm = ?, width_cm = ?, height_cm = ?,
        listing_price_rub = ?, air_sale_price_rmb = ?, exchange_rate = ?, target_margin = ?,
        desired_profit_mode = ?, desired_profit_value = ?, return_rate = ?, owner_person_id = ?,
        created_by_person_id = ?, product_type = ?, selection_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      mergedValues.name,
      mergedValues.selection_id,
      mergedValues.code,
      normalizeProductImageUrlMysql(mergedValues.image_url),
      mergedValues.purchase_url || "",
      mergedValues.supplier_note || "",
      mergedValues.source_platform || "1688",
      nullableInteger(mergedValues.supplier_id),
      mergedValues.shipping_method || "air_land",
      nullableInteger(mergedValues.logistics_rule_id),
      Number(mergedValues.purchase_cost || 0),
      Number(mergedValues.domestic_shipping || 0),
      Number(mergedValues.handling_fee || 0),
      Number(mergedValues.purchase_quantity || 1),
      Number(mergedValues.package_weight_g || 0),
      Number(mergedValues.length_cm || 0),
      Number(mergedValues.width_cm || 0),
      Number(mergedValues.height_cm || 0),
      Number(mergedValues.listing_price_rub || 0),
      Number(mergedValues.air_sale_price_rmb || 0),
      Number(mergedValues.exchange_rate || 0),
      Number(mergedValues.target_margin || 0),
      mergedValues.desired_profit_mode || "margin",
      Number(mergedValues.desired_profit_value || 0),
      Number(mergedValues.return_rate || 0),
      nullableInteger(mergedValues.owner_person_id),
      nullableInteger(mergedValues.created_by_person_id),
      mergedValues.product_type || "main",
      mergedValues.selection_status || "listed",
      targetProductId
    ]);
    const refParams = [targetProductId, ...sourceProductIds];
    const placeholders = sourceProductIds.map(() => "?").join(",");
    await connection.execute(`UPDATE products SET parent_product_id = ? WHERE parent_product_id IN (${placeholders})`, refParams);
    await connection.execute(`UPDATE online_products SET product_id = ? WHERE product_id IN (${placeholders})`, refParams);
    await connection.execute(`UPDATE sku_mappings SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id IN (${placeholders})`, refParams);
    await connection.execute(`UPDATE procurement_requests SET product_id = ? WHERE product_id IN (${placeholders})`, refParams);
    await connection.execute(`UPDATE inbound_records SET product_id = ? WHERE product_id IN (${placeholders})`, refParams);
    await connection.execute(`UPDATE outbound_records SET product_id = ? WHERE product_id IN (${placeholders})`, refParams);
    await connection.execute(`UPDATE inventory_movements SET product_id = ? WHERE product_id IN (${placeholders})`, refParams);
    await connection.execute(`UPDATE purchase_order_items SET product_id = ? WHERE product_id IN (${placeholders})`, refParams);
    await connection.execute(`UPDATE ozon_stock_snapshots SET product_id = ? WHERE product_id IN (${placeholders})`, refParams);
    await mergeAnalyticsRowsMysql(connection, targetProductId, sourceProductIds);
    await connection.execute(`DELETE FROM inventory_current WHERE real_product_id IN (${placeholders})`, sourceProductIds);
    await connection.execute(`
      UPDATE products
      SET active = 0,
          selection_status = 'merged',
          parent_product_id = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `, [targetProductId, ...sourceProductIds]);
    await rebuildInventoryCurrentForProductMysql(connection, targetProductId);
  });
  scheduleMergePostProcessingMysql(targetProductId, sourceProductIds);
  return {
    ok: true,
    merge_history_id: mergeHistoryId,
    target_product_id: targetProductId,
    merged_product_ids: sourceProductIds
  };
}

export async function deleteProductMysql(id) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("UPDATE products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  invalidateMasterDataCache();
  return { ok: true };
}

export async function removeProductFromInventoryMysql(id) {
  ensureMysqlCutoverEnabled();
  const productId = Number(id);
  const existing = await mysqlQueryOne("SELECT id FROM products WHERE id = ? AND active = 1", [productId]);
  if (!existing) throw new Error("产品不存在或已隐藏");
  await mysqlExecute(`
    UPDATE products
    SET product_type = 'selection', selection_status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND active = 1
  `, [productId]);
  invalidateMasterDataCache();
  return { ok: true, id: productId };
}

export async function restoreProductMysql(id) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute(`
    UPDATE products
    SET active = 1,
        product_type = 'main',
        selection_status = 'listed',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [Number(id)]);
  invalidateMasterDataCache();
  return { ok: true };
}

export async function createProductFromOnlineProductMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const onlineProductId = Number(body.online_product_id);
  const online = await mysqlQueryOne("SELECT * FROM online_products WHERE id = ?", [onlineProductId]);
  if (!online) throw new Error("Online product not found");
  const existingMapping = await mysqlQueryOne(`
    SELECT sm.*, p.code, p.name
    FROM sku_mappings sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.shop_id = ? AND sm.ozon_sku = ? AND sm.active = 1
    LIMIT 1
  `, [online.shop_id, online.ozon_sku]);
  if (existingMapping) {
    await mysqlExecute("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [existingMapping.product_id, online.id]);
    return {
      id: existingMapping.product_id,
      code: existingMapping.code,
      reused: true,
      reason: "sku_already_bound",
      procurement_request_id: null
    };
  }

  if (online.product_id) {
    const product = await mysqlQueryOne("SELECT id, code FROM products WHERE id = ? AND active = 1", [online.product_id]);
    if (product) {
      await bindOnlineProductMysql({
        online_product_id: online.id,
        product_id: product.id,
        person_id: body.person_id || body.owner_person_id
      });
      return {
        id: product.id,
        code: product.code,
        reused: true,
        reason: "online_product_already_linked",
        procurement_request_id: null
      };
    }
  }

  const spec = onlineProductSpecMysql(online);
  const exchangeRate = Number(body.exchange_rate || await currentExchangeRateValueMysql() || 11.32);
  const salePriceRmb = Number(body.air_sale_price_rmb || 0) ||
    (exchangeRate ? Number(online.sale_price || 0) / exchangeRate : Number(online.sale_price || 0));
  const purchasePlan = normalizePurchasePlanMysql(body);
  const purchaseUrl = body.purchase_url || online.purchase_url || "";
  const supplierNote = body.supplier_note || `From Ozon SKU ${online.ozon_sku}${online.offer_id ? ` / Offer ${online.offer_id}` : ""}`;
  const shouldCreateProcurement = ["1", "true", "yes"].includes(String(body.create_procurement_request || "").toLowerCase());
  const logisticsRuleId = nullableInteger(body.logistics_rule_id);
  const product = await createProductMysql({
    name: body.name || online.name,
    image_url: body.image_url || online.primary_image || online.image_url || firstJsonItem(online.images_json),
    purchase_url: purchaseUrl,
    supplier_note: supplierNote,
    source_platform: body.source_platform || "supplier",
    shipping_method: body.shipping_method || "air_land",
    purchase_cost: purchasePlan.unitPurchaseCost,
    domestic_shipping: purchasePlan.unitDomesticShipping,
    handling_fee: 0,
    purchase_quantity: body.purchase_quantity || 1,
    package_weight_g: body.package_weight_g || spec.weight_g,
    length_cm: body.length_cm || spec.length_cm || 30,
    width_cm: body.width_cm || spec.width_cm || 20,
    height_cm: body.height_cm || spec.height_cm || 10,
    air_sale_price_rmb: salePriceRmb,
    listing_price_rub: Number(body.listing_price_rub || online.sale_price || 0),
    exchange_rate: exchangeRate,
    desired_profit_mode: body.desired_profit_mode || "margin",
    desired_profit_value: body.desired_profit_value || 20,
    return_rate: body.return_rate ?? 0.05,
    owner_person_id: body.owner_person_id || body.person_id,
    product_type: "main",
    create_procurement_request: shouldCreateProcurement ? "1" : "",
    purchase_total_amount: body.purchase_total_amount,
    domestic_shipping_total: body.domestic_shipping_total,
    needed_by: body.needed_by,
    note: body.note || supplierNote,
    supplier_id: body.supplier_id,
    logistics_rule_id: logisticsRuleId
  });
  await bindOnlineProductMysql({
    online_product_id: online.id,
    product_id: product.id,
    person_id: body.person_id || body.owner_person_id
  });
  return product;
}

async function productMappingSummariesMysql(productIds = []) {
  const ids = [...new Set(productIds.map((id) => Number(id || 0)).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await mysqlQuery(`
    SELECT sm.id, sm.product_id, sm.shop_id, s.name AS shop_name,
      sm.ozon_sku, sm.offer_id,
      COALESCE(sm.display_name, op.name, '') AS online_name
    FROM sku_mappings sm
    LEFT JOIN shops s ON s.id = sm.shop_id
    LEFT JOIN online_products op ON op.id = sm.online_product_id
    WHERE sm.active = 1 AND sm.product_id IN (${placeholders})
    ORDER BY sm.id DESC
  `, ids);
  const summaries = new Map();
  for (const row of rows) {
    const productId = Number(row.product_id || 0);
    if (!summaries.has(productId)) {
      summaries.set(productId, {
        shop_ids: [],
        shop_names: [],
        bound_mappings: []
      });
    }
    const summary = summaries.get(productId);
    if (row.shop_id && !summary.shop_ids.includes(String(row.shop_id))) summary.shop_ids.push(String(row.shop_id));
    if (row.shop_name && !summary.shop_names.includes(row.shop_name)) summary.shop_names.push(row.shop_name);
    summary.bound_mappings.push({
      id: row.id,
      shop_id: row.shop_id,
      shop_name: row.shop_name || "",
      ozon_sku: row.ozon_sku || "",
      offer_id: row.offer_id || "",
      online_name: row.online_name || ""
    });
  }
  for (const summary of summaries.values()) {
    summary.bound_sku_count = summary.bound_mappings.length;
    summary.sku_preview = summary.bound_mappings.slice(0, 2);
    summary.sku_preview_extra = Math.max(summary.bound_mappings.length - 2, 0);
  }
  return summaries;
}

export async function inventoryCurrentMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT ic.*, p.code AS product_code, p.name AS product_name, p.alert_stock
    FROM inventory_current ic
    JOIN products p ON p.id = ic.real_product_id
    ORDER BY ic.available_stock ASC, p.id DESC
  `);
}

export async function inboundRecordsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const { whereSql, params } = inboundRecordsWhereMysql(query);
  const selectSql = `
    SELECT ir.*, p.code AS product_code, p.name AS product_name, p.image_url AS product_image_url,
      pe.name AS person_name, po.order_no AS purchase_order_no
    FROM inbound_records ir
    JOIN products p ON p.id = ir.product_id
    LEFT JOIN people pe ON pe.id = ir.person_id
    LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
    ${whereSql}
  `;

  if (!paged) {
    return await mysqlQuery(`
      ${selectSql}
      ORDER BY ir.created_at DESC, ir.id DESC
    `, params);
  }

  const offset = (page - 1) * pageSize;
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`
      SELECT COUNT(*) AS total
      FROM inbound_records ir
      JOIN products p ON p.id = ir.product_id
      LEFT JOIN people pe ON pe.id = ir.person_id
      LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
      ${whereSql}
    `, params),
    mysqlQuery(`
      ${selectSql}
      ORDER BY ir.created_at DESC, ir.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset])
  ]);

  return {
    rows,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

function inboundRecordsWhereMysql(query = {}) {
  const status = String(query.status || "all");
  const searchText = String(query.query || query.search || "").trim();
  const params = [];
  const where = [];

  if (status !== "all") {
    where.push("ir.status = ?");
    params.push(status);
  }
  if (searchText) {
    const like = `%${searchText.toLowerCase()}%`;
    where.push(`(
      LOWER(COALESCE(po.order_no, '')) LIKE ?
      OR LOWER(COALESCE(p.name, '')) LIKE ?
      OR LOWER(COALESCE(p.code, '')) LIKE ?
      OR LOWER(COALESCE(pe.name, '')) LIKE ?
      OR LOWER(COALESCE(ir.note, '')) LIKE ?
      OR LOWER(COALESCE(ir.purchase_url, '')) LIKE ?
    )`);
    params.push(like, like, like, like, like, like);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params
  };
}

export async function procurementSummaryMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT p.id AS product_id,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS code,
      p.name, p.image_url, p.purchase_url, p.supplier_note,
      SUM(pr.quantity) AS total_quantity,
      SUM(pr.amount + COALESCE(pr.shipping_amount, 0)) AS total_amount,
      GROUP_CONCAT(CONCAT(pe.name, ':', pr.quantity, '浠?锟?, pr.amount) SEPARATOR '||') AS requesters,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(pr.purchase_url, ''), NULLIF(p.purchase_url, ''))) AS purchase_links,
      MIN(pr.created_at) AS earliest_created_at,
      MAX(CASE WHEN TIMESTAMPDIFF(DAY, pr.created_at, CURRENT_TIMESTAMP) >= 3 THEN 1 ELSE 0 END) AS overdue
    FROM procurement_requests pr
    JOIN products p ON p.id = pr.product_id
    LEFT JOIN people pe ON pe.id = pr.person_id
    WHERE pr.status = 'submitted'
    GROUP BY p.id
    ORDER BY earliest_created_at ASC, total_quantity DESC
  `);
}

export async function procurementRequestsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const rows = await mysqlQuery(`
    SELECT pr.*,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS product_code,
      p.name AS product_name, p.image_url AS product_image_url, p.alert_stock,
      COALESCE(stock.stock, 0) AS stock,
      COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
      COALESCE(skus.skus, '') AS mapped_skus,
      COALESCE(p.purchase_url, '') AS product_purchase_url, p.source_platform AS product_source_platform,
      pe.name AS person_name,
      COALESCE(s.name, ps.name, '') AS supplier_name,
      po.order_no AS purchase_order_no,
      CASE WHEN pr.status = 'pending' AND TIMESTAMPDIFF(DAY, pr.created_at, CURRENT_TIMESTAMP) >= 3 THEN 1 ELSE 0 END AS overdue
    FROM procurement_requests pr
    JOIN products p ON p.id = pr.product_id
    LEFT JOIN people pe ON pe.id = pr.person_id
    LEFT JOIN suppliers s ON s.id = pr.supplier_id
    LEFT JOIN suppliers ps ON ps.id = p.supplier_id
    LEFT JOIN purchase_orders po ON po.id = pr.purchase_order_id
    LEFT JOIN (
      SELECT product_id, SUM(quantity_delta) AS stock
      FROM inventory_movements
      WHERE status = 'posted'
      GROUP BY product_id
    ) stock ON stock.product_id = p.id
    LEFT JOIN (
      SELECT product_id, SUM(quantity) AS incoming_stock
      FROM (
        SELECT product_id, quantity FROM inbound_records WHERE status = 'pending_arrival'
        UNION ALL
        SELECT product_id, quantity FROM procurement_requests WHERE status = 'submitted'
      ) incoming_rows
      GROUP BY product_id
    ) incoming ON incoming.product_id = p.id
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(ozon_sku SEPARATOR ', ') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
    WHERE pr.status NOT IN ('purchased', 'done')
      AND COALESCE(po.status, '') NOT IN ('purchased', 'partial_inbound', 'inbound_done')
    ORDER BY pr.created_at DESC
  `);
  if (String(query.grouped || "") !== "1") return filterProcurementRequestsMysql(rows, query);
  return groupProcurementRequestsMysql(rows, query);
}

function filterProcurementRequestsMysql(rows = [], query = {}) {
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const status = String(query.status || "all");
  const urgency = String(query.urgency || "all");
  const personId = String(query.personId || query.person_id || "all");

  const filtered = rows.filter((row) => {
    if (status !== "all" && String(row.status || "") !== status) return false;
    if (urgency !== "all" && String(row.urgency || "") !== urgency) return false;
    if (personId !== "all" && String(row.person_id || "") !== personId) return false;
    if (!searchText) return true;
    return [
      row.product_name,
      row.product_code,
      row.person_name,
      row.supplier_name,
      row.purchase_url,
      row.note,
      row.mapped_skus
    ].some((item) => String(item || "").toLowerCase().includes(searchText));
  });

  if (!paged) return filtered;
  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    mode: "paged"
  };
}

function groupProcurementRequestsMysql(rows = [], query = {}) {
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const grouped = new Map();

  for (const row of rows.filter((item) => item.status === "submitted")) {
    const productId = Number(row.product_id || 0);
    if (!productId) continue;
    if (!grouped.has(productId)) {
      grouped.set(productId, {
        product_id: productId,
        product_name: row.product_name || "",
        product_code: row.product_code || "",
        product_image_url: row.product_image_url || row.image_url || "",
        mapped_skus: row.mapped_skus || "",
        supplier_names: [],
        requester_names: [],
        purchase_links: [],
        link_1688: "",
        link_pdd: "",
        other_source: "",
        total_quantity: 0,
        total_amount: 0,
        total_shipping: 0,
        request_count: 0,
        earliest_created_at: row.created_at || "",
        overdue: false,
        requests: []
      });
    }
    const target = grouped.get(productId);
    target.total_quantity += Number(row.quantity || 0);
    target.total_amount += Number(row.amount || 0);
    target.total_shipping += Number(row.shipping_amount || 0);
    target.request_count += 1;
    target.requests.push(row);
    addUniqueMysql(target.requester_names, row.person_name);
    addUniqueMysql(target.supplier_names, row.supplier_name);
    addUniqueMysql(target.purchase_links, row.purchase_url);
    addUniqueMysql(target.purchase_links, row.product_purchase_url);
    target.overdue = target.overdue || Boolean(row.overdue);
    if (!target.earliest_created_at || String(row.created_at || "") < String(target.earliest_created_at)) {
      target.earliest_created_at = row.created_at || "";
    }
    const source = String(row.source_type || row.product_source_platform || "1688").toLowerCase();
    const sourceUrl = row.purchase_url || row.product_purchase_url || "";
    if (source === "1688" && sourceUrl && !target.link_1688) target.link_1688 = sourceUrl;
    else if (source === "pdd" && sourceUrl && !target.link_pdd) target.link_pdd = sourceUrl;
    else if (!target.other_source) target.other_source = row.source_type || row.product_source_platform || "鍏朵粬";
  }

  const filtered = Array.from(grouped.values())
    .filter((row) => {
      if (!searchText) return true;
      return [
        row.product_code,
        row.product_name,
        row.mapped_skus,
        row.requester_names.join(" "),
        row.supplier_names.join(" "),
        row.purchase_links.join(" ")
      ].some((item) => String(item || "").toLowerCase().includes(searchText));
    })
    .sort((a, b) => String(a.earliest_created_at || "").localeCompare(String(b.earliest_created_at || "")));

  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    mode: "grouped"
  };
}

function addUniqueMysql(target, value) {
  const text = String(value || "").trim();
  if (text && !target.includes(text)) target.push(text);
}

async function nextPurchaseOrderNoMysql(connection) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const row = await mysqlConnectionQueryOne(
    connection,
    "SELECT COUNT(*) AS count FROM purchase_orders WHERE order_no LIKE ?",
    [`PO-${date}-%`]
  );
  return `PO-${date}-${String(Number(row?.count || 0) + 1).padStart(3, "0")}`;
}

function inventoryDeltasMysql(movementType, quantityDelta) {
  const qty = Number(quantityDelta || 0);
  switch (movementType) {
    case "ORDER_RESERVED":
      return { available: 0, reserved: Math.abs(qty), damaged: 0, inTransit: 0 };
    case "ORDER_SHIPPED":
      return { available: qty < 0 ? qty : -Math.abs(qty), reserved: 0, damaged: 0, inTransit: 0 };
    case "CANCEL_RESTORE":
      return { available: 0, reserved: -Math.abs(qty), damaged: 0, inTransit: 0 };
    case "RETURN_LOSS":
      return { available: 0, reserved: 0, damaged: Math.abs(qty), inTransit: 0 };
    case "RETURN_IN":
      return { available: Math.abs(qty), reserved: 0, damaged: 0, inTransit: 0 };
    case "PURCHASE_IN":
    case "MANUAL_ADJUST":
    default:
      return { available: qty, reserved: 0, damaged: 0, inTransit: 0 };
  }
}

function movementTypeFromSourceMysql(sourceType, quantityDelta) {
  if (sourceType === "purchase_inbound") return "PURCHASE_IN";
  if (sourceType === "order_outbound") return "ORDER_SHIPPED";
  if (sourceType === "return_loss") return "RETURN_LOSS";
  if (sourceType === "return_in") return "RETURN_IN";
  return Number(quantityDelta || 0) >= 0 ? "MANUAL_ADJUST" : "ORDER_SHIPPED";
}

async function applyInventoryCurrentMysql(connection, productId, movementType, quantityDelta) {
  await connection.execute(`
    INSERT INTO inventory_current (real_product_id, available_stock, reserved_stock, damaged_stock, in_transit_stock)
    VALUES (?, 0, 0, 0, 0)
    ON DUPLICATE KEY UPDATE real_product_id = VALUES(real_product_id)
  `, [Number(productId)]);
  const deltas = inventoryDeltasMysql(movementType, quantityDelta);
  await connection.execute(`
    UPDATE inventory_current SET
      available_stock = available_stock + ?,
      reserved_stock = reserved_stock + ?,
      damaged_stock = damaged_stock + ?,
      in_transit_stock = in_transit_stock + ?,
      last_updated_at = CURRENT_TIMESTAMP
    WHERE real_product_id = ?
  `, [deltas.available, deltas.reserved, deltas.damaged, deltas.inTransit, Number(productId)]);
}

async function rebuildInventoryCurrentForProductMysql(connection, productId) {
  const targetProductId = Number(productId || 0);
  if (!targetProductId) return;
  const row = await mysqlConnectionQueryOne(connection, `
    SELECT COALESCE(SUM(quantity_delta), 0) AS available_stock
    FROM inventory_movements
    WHERE product_id = ? AND status = 'posted'
  `, [targetProductId]);
  await connection.execute(`
    INSERT INTO inventory_current (real_product_id, available_stock, last_updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      available_stock = VALUES(available_stock),
      last_updated_at = CURRENT_TIMESTAMP
  `, [targetProductId, Number(row?.available_stock || 0)]);
}

async function postInventoryMysql(connection, body = {}) {
  const quantityDelta = Number(body.quantity_delta || 0);
  const movementType = body.movement_type || movementTypeFromSourceMysql(body.source_type, quantityDelta);
  const [result] = await connection.execute(`
    INSERT INTO inventory_movements
    (product_id, shop_id, sku_mapping_id, owner_person_id, source_type, source_ref, quantity_delta, unit_cost, amount,
     status, note, movement_type, related_posting_number, related_order_item_id, operator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    Number(body.product_id),
    nullableInteger(body.shop_id),
    nullableInteger(body.sku_mapping_id),
    nullableInteger(body.owner_person_id) || nullableInteger(body.person_id),
    body.source_type || "manual_adjustment",
    body.source_ref || null,
    quantityDelta,
    Number(body.unit_cost || 0),
    Number(body.amount || 0),
    body.status || "posted",
    body.note || "",
    movementType,
    body.related_posting_number || body.source_ref || null,
    nullableInteger(body.related_order_item_id),
    body.operator || null
  ]);
  if ((body.status || "posted") === "posted") {
    await applyInventoryCurrentMysql(connection, Number(body.product_id), movementType, quantityDelta);
  }
  return Number(result.insertId);
}

async function recordOrderExceptionMysql(body = {}) {
  await mysqlExecute(`
    INSERT INTO order_exceptions (store_id, order_item_id, posting_number, ozon_sku, exception_type, message)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      order_item_id = VALUES(order_item_id),
      message = VALUES(message),
      status = 'open'
  `, [
    nullableInteger(body.store_id),
    nullableInteger(body.order_item_id),
    body.posting_number || "",
    body.ozon_sku || "",
    body.exception_type,
    body.message
  ]);
}

async function saveProfitItemMysql({ orderItemId, product, estimated, quantity, salePrice, settlement, order = null, item = null }) {
  const existing = await mysqlQueryOne("SELECT is_locked, profit_status FROM order_profit_items WHERE order_item_id = ?", [orderItemId]);
  if (existing && (Number(existing.is_locked || 0) === 1 || String(existing.profit_status || "") === "accrued") && settlement !== "accrued") return;
  const qty = Number(quantity || 1);
  const saleAmount = Number(salePrice || 0) * qty;
  const purchaseCost = Number(product.purchase_cost || 0) * qty;
  const domesticShipping = Number(product.domestic_shipping || 0) * qty;
  const internationalShipping = Number(estimated.freight ?? product.international_shipping ?? 0) * qty;
  const packagingCost = await packagingFeeForSaleAmountMysql(saleAmount);
  const commission = Number(estimated.commission || 0);
  const ozonServiceFee = Number(estimated.paymentFee || 0) + Number(estimated.withdrawalFee || 0);
  const returnLoss = await estimateOrderItemReturnLossMysql({ order, item, product, estimated, quantity: qty, salePrice });
  const advertisingCost = Number(estimated.advertisingCost || 0);
  const grossProfit = saleAmount - purchaseCost - domesticShipping - internationalShipping - packagingCost - commission;
  const netProfit = roundMoneyMysql(saleAmount - purchaseCost - domesticShipping - internationalShipping - packagingCost - commission - ozonServiceFee - returnLoss - advertisingCost);
  const commissionRate = saleAmount ? commission / saleAmount : 0;

  await mysqlExecute(`
    INSERT INTO order_profit_items
    (order_item_id, sale_amount_cny, purchase_cost_cny, domestic_shipping_cny, international_shipping_cny,
     packaging_cost_cny, commission_rate, commission_fee_cny, ozon_service_fee_cny, return_loss_cny,
     advertising_cost_cny, other_fee_cny, gross_profit_cny, net_profit_cny, profit_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      sale_amount_cny = VALUES(sale_amount_cny),
      purchase_cost_cny = VALUES(purchase_cost_cny),
      domestic_shipping_cny = VALUES(domestic_shipping_cny),
      international_shipping_cny = VALUES(international_shipping_cny),
      packaging_cost_cny = VALUES(packaging_cost_cny),
      commission_rate = VALUES(commission_rate),
      commission_fee_cny = VALUES(commission_fee_cny),
      ozon_service_fee_cny = VALUES(ozon_service_fee_cny),
      return_loss_cny = VALUES(return_loss_cny),
      advertising_cost_cny = VALUES(advertising_cost_cny),
      gross_profit_cny = VALUES(gross_profit_cny),
      net_profit_cny = VALUES(net_profit_cny),
      profit_status = VALUES(profit_status),
      updated_at = CURRENT_TIMESTAMP
  `, [
    orderItemId,
    saleAmount,
    purchaseCost,
    domesticShipping,
    internationalShipping,
    packagingCost,
    commissionRate,
    commission,
    ozonServiceFee,
    returnLoss,
    advertisingCost,
    grossProfit,
    netProfit,
    settlement === "accrued" ? "accrued" : "estimated"
  ]);
}

async function syncOrderItemProfitFromBreakdownMysql(orderItemId, settlement) {
  const row = await mysqlQueryOne("SELECT net_profit_cny, is_locked, profit_status FROM order_profit_items WHERE order_item_id = ?", [orderItemId]);
  if (!row) return;
  if ((Number(row.is_locked || 0) === 1 || String(row.profit_status || "") === "accrued") && settlement !== "accrued") return;
  const profit = roundMoneyMysql(row.net_profit_cny || 0);
  if (settlement === "accrued") {
    await mysqlExecute("UPDATE order_items SET estimated_profit = ?, actual_profit = ?, settlement_state = 'accrued' WHERE id = ?", [profit, profit, orderItemId]);
  } else {
    await mysqlExecute("UPDATE order_items SET estimated_profit = ?, actual_profit = 0, settlement_state = ? WHERE id = ?", [profit, settlement || "pending", orderItemId]);
  }
}

async function syncOutboundForOpenOrdersMysql() {
  const cancelledRows = await mysqlQuery(`
    SELECT oi.id AS order_item_id, oi.quantity, o.posting_number, o.shop_id,
      sm.id AS mapping_id, sm.product_id, sm.person_id, sm.online_product_id,
      p.purchase_cost
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id
    WHERE LOWER(o.status) LIKE '%cancel%'
       OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%'
  `);
  for (const row of cancelledRows) {
    const outboundMovement = await mysqlQueryOne(`
      SELECT id, product_id, shop_id, sku_mapping_id, owner_person_id, quantity_delta, unit_cost, status
      FROM inventory_movements
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
      LIMIT 1
    `, [row.order_item_id]);
    if (!outboundMovement) continue;
    const restoreProductId = outboundMovement.product_id || row.product_id;
    if (!restoreProductId) continue;
    const restoreShopId = outboundMovement.shop_id || row.shop_id;
    const restoreMappingId = outboundMovement.sku_mapping_id || row.mapping_id;
    const restorePersonId = outboundMovement.owner_person_id || row.person_id;
    const restoreUnitCost = Number(outboundMovement.unit_cost || row.purchase_cost || 0);
    const restoreQuantity = Math.abs(Number(outboundMovement.quantity_delta || row.quantity || 1));
    await mysqlExecute(`
      UPDATE outbound_records
      SET status = 'cancelled', reason = 'cancelled_order', note = 'Order cancelled, inventory restored'
      WHERE order_item_id = ? OR (order_item_id IS NULL AND order_ref = ? AND product_id = ?)
    `, [row.order_item_id, row.posting_number, restoreProductId]);
    await mysqlExecute(`
      UPDATE inventory_movements
      SET status = 'posted', note = 'Cancelled order outbound, restored by return movement'
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
    `, [row.order_item_id]);
    const returnSourceRef = `cancel_${row.order_item_id}`;
    const existingReturn = await mysqlQueryOne(`
      SELECT id, product_id
      FROM inventory_movements
      WHERE source_type = 'return_in' AND source_ref = ?
      LIMIT 1
    `, [returnSourceRef]);
    if (existingReturn) {
      await mysqlExecute(`
        UPDATE inventory_movements
        SET product_id = ?, shop_id = ?, sku_mapping_id = ?, owner_person_id = ?,
          quantity_delta = ?, unit_cost = ?, amount = ?, status = 'posted', note = 'Order cancelled, inventory restored'
        WHERE id = ?
      `, [
        restoreProductId,
        restoreShopId,
        restoreMappingId,
        restorePersonId,
        restoreQuantity,
        restoreUnitCost,
        restoreQuantity * restoreUnitCost,
        existingReturn.id
      ]);
      await rebuildInventoryCurrentForProductMysql(mysqlPoolConnectionAdapter, existingReturn.product_id);
    } else {
      await postInventoryMysql(mysqlPoolConnectionAdapter, {
        product_id: restoreProductId,
        shop_id: restoreShopId,
        sku_mapping_id: restoreMappingId,
        owner_person_id: restorePersonId,
        source_type: "return_in",
        source_ref: returnSourceRef,
        quantity_delta: restoreQuantity,
        unit_cost: restoreUnitCost,
        amount: restoreQuantity * restoreUnitCost,
        related_order_item_id: row.order_item_id,
        note: "Order cancelled, inventory restored"
      });
    }
    await rebuildInventoryCurrentForProductMysql(mysqlPoolConnectionAdapter, restoreProductId);
  }

  const rows = await mysqlQuery(`
    SELECT oi.*, o.shop_id, o.posting_number, o.status AS order_status, o.tracking_stage,
      sm.id AS mapping_id, sm.product_id, sm.person_id, sm.online_product_id,
      p.purchase_cost
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id
    WHERE LOWER(o.status) NOT LIKE '%cancel%'
      AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
  `);
  let deducted = 0;
  let pending = 0;
  for (const row of rows) {
    if (!row.mapping_id || !row.product_id) {
      await recordOrderExceptionMysql({
        store_id: row.shop_id,
        order_item_id: row.id,
        posting_number: row.posting_number,
        ozon_sku: row.ozon_sku,
        exception_type: "OUTBOUND_UNBOUND_SKU",
        message: `Order is waiting for outbound, but Ozon SKU ${row.ozon_sku} is not bound to an inventory product`
      });
      pending += 1;
      continue;
    }
    if (Number(row.sku_mapping_id || 0) !== Number(row.mapping_id)) {
      await mysqlExecute("UPDATE order_items SET sku_mapping_id = ? WHERE id = ?", [row.mapping_id, row.id]);
    }
    const existed = await mysqlQueryOne(`
      SELECT id, status, product_id FROM inventory_movements
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
      LIMIT 1
    `, [row.id]);
    if (existed) {
      if (existed.status !== "posted" || Number(existed.product_id) !== Number(row.product_id)) {
        await mysqlExecute(`
          UPDATE inventory_movements
          SET product_id = ?, shop_id = ?, sku_mapping_id = ?, owner_person_id = ?,
            quantity_delta = ?, unit_cost = ?, amount = ?, status = 'posted', note = 'Restored by outbound sync'
          WHERE id = ?
        `, [
          row.product_id,
          row.shop_id,
          row.mapping_id,
          row.person_id,
          -Math.abs(Number(row.quantity || 1)),
          row.purchase_cost || row.frozen_purchase_cost || 0,
          Math.abs(Number(row.quantity || 1)) * Number(row.purchase_cost || row.frozen_purchase_cost || 0),
          existed.id
        ]);
        await rebuildInventoryCurrentForProductMysql(mysqlPoolConnectionAdapter, existed.product_id);
        await rebuildInventoryCurrentForProductMysql(mysqlPoolConnectionAdapter, row.product_id);
      }
      continue;
    }
    const qty = -Math.abs(Number(row.quantity || 1));
    await postInventoryMysql(mysqlPoolConnectionAdapter, {
      product_id: row.product_id,
      shop_id: row.shop_id,
      sku_mapping_id: row.mapping_id,
      owner_person_id: row.person_id,
      source_type: "order_outbound",
      source_ref: row.posting_number,
      quantity_delta: qty,
      unit_cost: row.purchase_cost || row.frozen_purchase_cost || 0,
      amount: Math.abs(qty) * Number(row.purchase_cost || row.frozen_purchase_cost || 0),
      related_posting_number: row.posting_number,
      related_order_item_id: row.id,
      note: "Created by outbound sync"
    });
    const outboundExists = await mysqlQueryOne(`
      SELECT id FROM outbound_records
      WHERE (order_item_id = ? OR (order_item_id IS NULL AND order_ref = ? AND product_id = ? AND (COALESCE(ozon_sku, '') = '' OR ozon_sku = ?)))
        AND status != 'cancelled'
      LIMIT 1
    `, [row.id, row.posting_number, row.product_id, row.ozon_sku || ""]);
    if (outboundExists) {
      await mysqlExecute(`
        UPDATE outbound_records
        SET shop_id = ?, online_product_id = ?, order_item_id = ?, ozon_sku = ?, person_id = ?, quantity = ?, reason = 'order', status = 'deducted', note = 'Updated by outbound sync'
        WHERE id = ?
      `, [row.shop_id, row.online_product_id, row.id, row.ozon_sku, row.person_id, Math.abs(Number(row.quantity || 1)), outboundExists.id]);
    } else {
      await mysqlExecute(`
        INSERT INTO outbound_records (product_id, shop_id, online_product_id, order_ref, order_item_id, ozon_sku, person_id, quantity, reason, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'order', 'deducted', ?)
      `, [row.product_id, row.shop_id, row.online_product_id, row.posting_number, row.id, row.ozon_sku, row.person_id, Math.abs(Number(row.quantity || 1)), "Created by outbound sync"]);
    }
    await mysqlExecute(`
      UPDATE order_exceptions SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND posting_number = ? AND ozon_sku = ? AND exception_type IN ('UNMAPPED_SKU', 'OUTBOUND_UNBOUND_SKU')
    `, [row.shop_id, row.posting_number, row.ozon_sku]);
    deducted += 1;
  }
  return { deducted, pending };
}

async function upsertOnlineProductFromOrderItemMysql(shop, item) {
  if (!item?.ozon_sku) return null;
  const existing = await mysqlQueryOne("SELECT * FROM online_products WHERE shop_id = ? AND ozon_sku = ?", [shop.id, item.ozon_sku]);
  if (existing) {
    await mysqlExecute(`
      UPDATE online_products
      SET offer_id = COALESCE(NULLIF(?, ''), offer_id),
        ozon_product_id = COALESCE(NULLIF(?, ''), ozon_product_id),
        name = CASE WHEN name = '' OR name LIKE 'Ozon product %' THEN COALESCE(NULLIF(?, ''), name) ELSE name END,
        image_url = COALESCE(NULLIF(?, ''), image_url),
        primary_image = COALESCE(NULLIF(?, ''), primary_image),
        sale_price = CASE WHEN sale_price = 0 THEN ? ELSE sale_price END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [item.offer_id || "", item.ozon_product_id || "", item.name || "", item.image_url || "", item.image_url || "", Number(item.sale_price || 0), existing.id]);
    return existing;
  }
  const result = await mysqlExecute(`
    INSERT INTO online_products
    (shop_id, ozon_sku, offer_id, ozon_product_id, name, image_url, primary_image, sale_price, currency_code, status, visibility, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUB', 'historical', 'order_snapshot', ?)
  `, [
    shop.id,
    item.ozon_sku,
    item.offer_id || "",
    item.ozon_product_id || "",
    item.name || `Ozon SKU ${item.ozon_sku}`,
    item.image_url || "",
    item.image_url || "",
    Number(item.sale_price || 0),
    JSON.stringify(item)
  ]);
  return { id: Number(result.insertId), shop_id: shop.id, ozon_sku: item.ozon_sku };
}

function orderLifecycleMysql(posting) {
  const statusText = `${posting.status || ""} ${posting.substatus || ""} ${posting.tracking_stage || ""}`.toLowerCase();
  const orderedAt = new Date(posting.ordered_at);
  const safeOrderedAt = Number.isNaN(orderedAt.getTime()) ? new Date() : orderedAt;
  const ageDays = Math.floor((Date.now() - safeOrderedAt.getTime()) / (24 * 60 * 60 * 1000));
  const isCancelled = statusText.includes("cancel");
  const isDelivered = statusText.includes("delivered") || statusText.includes("绛炬敹");
  if (isCancelled) return { syncState: "final", finalizedAt: new Date().toISOString(), note: "cancelled order archived" };
  if (isDelivered && ageDays >= 45) return { syncState: "final", finalizedAt: new Date().toISOString(), note: "delivered order older than 45 days archived" };
  if (!isDelivered && ageDays >= 60) return { syncState: "exception", finalizedAt: null, note: "open logistics order older than 60 days" };
  return { syncState: "open", finalizedAt: null, note: "" };
}

function textValueMysql(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function parseOzonPostingRawMysql(posting = {}) {
  if (posting.raw && typeof posting.raw === "object") return posting.raw;
  if (posting.raw_json && typeof posting.raw_json === "object") return posting.raw_json;
  if (typeof posting.raw_json === "string") {
    const parsed = parseJsonOrNull(posting.raw_json) || {};
    return parsed.raw && typeof parsed.raw === "object" ? parsed.raw : parsed;
  }
  return posting;
}

function orderStatusHistoryPayloadMysql(shop, posting = {}, orderId, lifecycle = {}) {
  const raw = parseOzonPostingRawMysql(posting);
  const customer = raw.customer || posting.customer || {};
  const address = customer.address || raw.address || posting.address || {};
  const analytics = raw.analytics_data || posting.analytics_data || {};
  const financial = raw.financial_data || posting.financial_data || {};
  const deliveryMethod = raw.delivery_method || posting.delivery_method || {};
  const observedAt = shanghaiDateTimeMysql();
  return {
    order_id: Number(orderId),
    shop_id: Number(shop.id),
    posting_number: textValueMysql(posting.posting_number, raw.posting_number),
    order_number: textValueMysql(posting.order_number, raw.order_number),
    status: textValueMysql(posting.status, raw.status),
    substatus: textValueMysql(posting.substatus, raw.substatus),
    logistics_status: textValueMysql(posting.logistics_status, posting.substatus, raw.substatus),
    tracking_stage: textValueMysql(posting.tracking_stage, posting.status, raw.status),
    sync_state: textValueMysql(lifecycle.syncState, posting.sync_state),
    ordered_at: normalizeMysqlNullableDateTime(posting.ordered_at || raw.in_process_at || raw.created_at),
    delivered_at: normalizeMysqlNullableDateTime(posting.delivered_at || raw.delivered_at),
    customer_id: textValueMysql(customer.customer_id, customer.id, raw.customer_id),
    customer_name: textValueMysql(customer.name, raw.customer_name),
    buyer_city: textValueMysql(address.city, analytics.city, posting.buyer_city),
    buyer_region: textValueMysql(address.region, analytics.region, posting.buyer_region),
    buyer_country: textValueMysql(address.country, posting.buyer_country),
    buyer_district: textValueMysql(address.district, posting.buyer_district),
    buyer_zip_code: textValueMysql(address.zip_code, address.zipCode, posting.buyer_zip_code),
    buyer_address_tail: textValueMysql(address.address_tail, address.tail, posting.buyer_address_tail),
    delivery_type: textValueMysql(analytics.delivery_type, raw.delivery_type, posting.delivery_type),
    delivery_city: textValueMysql(analytics.city, address.city),
    delivery_region: textValueMysql(analytics.region, address.region),
    delivery_date_begin: normalizeMysqlNullableDateTime(analytics.delivery_date_begin || raw.delivery_date_begin),
    delivery_date_end: normalizeMysqlNullableDateTime(analytics.delivery_date_end || raw.delivery_date_end),
    warehouse_name: textValueMysql(deliveryMethod.warehouse, deliveryMethod.name, raw.warehouse_name),
    tpl_provider: textValueMysql(deliveryMethod.tpl_provider, raw.tpl_provider),
    cluster_to: textValueMysql(financial.cluster_to, raw.cluster_to),
    observed_at: observedAt,
    observed_hour: shanghaiDateTimeMysql(new Date(), true),
    raw_status_json: JSON.stringify({
      status: posting.status || raw.status || "",
      substatus: posting.substatus || raw.substatus || "",
      logistics_status: posting.logistics_status || "",
      tracking_stage: posting.tracking_stage || "",
      sync_state: lifecycle.syncState || ""
    })
  };
}

async function recordOrderStatusHistoryMysql(shop, posting, orderId, lifecycle, source = "sync") {
  if (!orderId || !posting?.posting_number) return { inserted: 0 };
  const payload = orderStatusHistoryPayloadMysql(shop, posting, orderId, lifecycle);
  await mysqlExecute(`
    INSERT INTO order_status_history (
      order_id, shop_id, posting_number, order_number, status, substatus, logistics_status, tracking_stage, sync_state,
      ordered_at, delivered_at, last_status_changed_at,
      customer_id, customer_name, buyer_city, buyer_region, buyer_country, buyer_district, buyer_zip_code, buyer_address_tail,
      delivery_type, delivery_city, delivery_region, delivery_date_begin, delivery_date_end, warehouse_name, tpl_provider, cluster_to,
      snapshot_source, observed_at, observed_hour, raw_status_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      substatus = VALUES(substatus),
      ordered_at = COALESCE(VALUES(ordered_at), ordered_at),
      delivered_at = COALESCE(VALUES(delivered_at), delivered_at),
      customer_id = COALESCE(NULLIF(VALUES(customer_id), ''), customer_id),
      customer_name = COALESCE(NULLIF(VALUES(customer_name), ''), customer_name),
      buyer_city = COALESCE(NULLIF(VALUES(buyer_city), ''), buyer_city),
      buyer_region = COALESCE(NULLIF(VALUES(buyer_region), ''), buyer_region),
      buyer_country = COALESCE(NULLIF(VALUES(buyer_country), ''), buyer_country),
      buyer_district = COALESCE(NULLIF(VALUES(buyer_district), ''), buyer_district),
      buyer_zip_code = COALESCE(NULLIF(VALUES(buyer_zip_code), ''), buyer_zip_code),
      buyer_address_tail = COALESCE(NULLIF(VALUES(buyer_address_tail), ''), buyer_address_tail),
      delivery_type = COALESCE(NULLIF(VALUES(delivery_type), ''), delivery_type),
      delivery_city = COALESCE(NULLIF(VALUES(delivery_city), ''), delivery_city),
      delivery_region = COALESCE(NULLIF(VALUES(delivery_region), ''), delivery_region),
      delivery_date_begin = COALESCE(VALUES(delivery_date_begin), delivery_date_begin),
      delivery_date_end = COALESCE(VALUES(delivery_date_end), delivery_date_end),
      warehouse_name = COALESCE(NULLIF(VALUES(warehouse_name), ''), warehouse_name),
      tpl_provider = COALESCE(NULLIF(VALUES(tpl_provider), ''), tpl_provider),
      cluster_to = COALESCE(NULLIF(VALUES(cluster_to), ''), cluster_to),
      raw_status_json = VALUES(raw_status_json)
  `, [
    payload.order_id,
    payload.shop_id,
    payload.posting_number,
    payload.order_number,
    payload.status,
    payload.substatus,
    payload.logistics_status,
    payload.tracking_stage,
    payload.sync_state,
    payload.ordered_at,
    payload.delivered_at,
    payload.customer_id,
    payload.customer_name,
    payload.buyer_city,
    payload.buyer_region,
    payload.buyer_country,
    payload.buyer_district,
    payload.buyer_zip_code,
    payload.buyer_address_tail,
    payload.delivery_type,
    payload.delivery_city,
    payload.delivery_region,
    payload.delivery_date_begin,
    payload.delivery_date_end,
    payload.warehouse_name,
    payload.tpl_provider,
    payload.cluster_to,
    source,
    payload.observed_at,
    payload.observed_hour,
    payload.raw_status_json
  ]);
  return { inserted: 1 };
}

async function orderCancelLossAppliesMysql(posting) {
  const postingNumber = String(posting.posting_number || posting.order_number || "").trim();
  const prefixes = postingNumber ? await orderQualityPrefixesMysql() : [];
  if (prefixes.some((prefix) => postingNumber.startsWith(prefix))) return false;
  const outcome = classifyOrderOutcome(posting);
  const cancellation = describeCancellation({ ...posting, outcome_type: outcome });
  const profile = resolveOrderLossProfile({ ...posting, outcome_type: outcome, ...cancellation });
  return profile.code !== "none";
}

function estimatedProfitValueMysql({ item, product, estimated, returnLossEstimate }) {
  return roundMoneyMysql(
    Number(item.sale_price || 0) * Number(item.quantity || 1)
    - (Number(product.purchase_cost || 0) + Number(product.domestic_shipping || 0) + Number(estimated.freight || product.international_shipping || 0)) * Number(item.quantity || 1)
    - (Number(item.sale_price || 0) * Number(item.quantity || 1) > 0 ? 0 : 0)
    - Number(estimated.commission || 0)
    - Number(estimated.paymentFee || 0)
    - Number(estimated.withdrawalFee || 0)
    - returnLossEstimate
    - Number(estimated.advertisingCost || 0)
  );
}

function persistedPlatformFeeMysql(estimated, returnLossEstimate) {
  return (estimated.commission || 0) + (estimated.paymentFee || 0) + (estimated.withdrawalFee || 0) + returnLossEstimate;
}

async function persistRecalculatedItemMysql({ itemId, mapping, product, estimated, settlement, returnLossEstimate, estimatedProfit, quantity, salePrice, order = null, item = null }) {
  await mysqlExecute(`
    UPDATE order_items SET
      sku_mapping_id = ?,
      estimated_commission = ?,
      platform_fee_actual = CASE WHEN ? = 'accrued' AND COALESCE(actual_profit, 0) = 0 THEN ? ELSE platform_fee_actual END,
      aftersale_loss = ?,
      estimated_profit = ?,
      actual_profit = CASE WHEN ? = 'accrued' AND COALESCE(actual_profit, 0) = 0 THEN ? ELSE actual_profit END,
      settlement_state = ?
    WHERE id = ?
  `, [
    mapping.id,
    estimated.commission || 0,
    settlement,
    persistedPlatformFeeMysql(estimated, returnLossEstimate),
    returnLossEstimate,
    estimatedProfit,
    settlement,
    estimatedProfit,
    settlement,
    itemId
  ]);
  await saveProfitItemMysql({ orderItemId: itemId, product, estimated, quantity, salePrice, settlement, order, item });
  await syncOrderItemProfitFromBreakdownMysql(itemId, settlement);
}

export async function recalculateOrderItemsForMappingMysql(mappingId) {
  ensureMysqlCutoverEnabled();
  const mapping = await mysqlQueryOne(`
    SELECT sm.*, op.commissions_json AS commissions_json
    FROM sku_mappings sm
    LEFT JOIN online_products op ON op.id = sm.online_product_id
    WHERE sm.id = ? AND sm.active = 1
  `, [Number(mappingId)]);
  if (!mapping) return { updated: 0 };
  const product = await mysqlQueryOne("SELECT * FROM products WHERE id = ?", [mapping.product_id]);
  if (!product) return { updated: 0 };
  const rows = await mysqlQuery(`
    SELECT oi.*, o.shop_id, o.status AS order_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.shop_id = ? AND oi.ozon_sku = ?
      AND COALESCE(o.sync_state, 'open') != 'final'
  `, [mapping.shop_id, mapping.ozon_sku]);
  let updated = 0;
  for (const item of rows) {
    const estimated = estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping });
    const settlement = resolveProfitSettlementStatusMysql(item);
    const returnLossEstimate = await estimateOrderItemReturnLossMysql({ order: null, item, product, estimated, quantity: item.quantity, salePrice: item.sale_price });
    const estimatedProfit = estimatedProfitValueMysql({ item, product, estimated, returnLossEstimate });
    await persistRecalculatedItemMysql({
      itemId: item.id,
      mapping,
      product,
      estimated,
      settlement,
      returnLossEstimate,
      estimatedProfit,
      quantity: item.quantity,
      salePrice: item.sale_price,
      item
    });
    updated += 1;
  }
  return { updated };
}

async function accrueDeliveredItemsMysql(orderId) {
  const order = await mysqlQueryOne("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order || order.status !== "delivered") return;
  const items = await mysqlQuery("SELECT * FROM order_items WHERE order_id = ?", [orderId]);
  for (const item of items) {
    const profitItem = await mysqlQueryOne("SELECT commission_fee_cny, ozon_service_fee_cny, return_loss_cny, advertising_cost_cny, other_fee_cny, purchase_cost_cny, domestic_shipping_cny, international_shipping_cny, packaging_cost_cny, net_profit_cny, profit_status FROM order_profit_items WHERE order_item_id = ?", [item.id]);
    if (profitItem && (Number(profitItem.commission_fee_cny || 0) > 0 || Number(profitItem.ozon_service_fee_cny || 0) > 0 || String(profitItem.profit_status || "") === "accrued")) {
      await mysqlExecute("UPDATE order_items SET actual_profit = ?, settlement_state = 'accrued' WHERE id = ?", [Number(profitItem.net_profit_cny || 0), item.id]);
      await mysqlExecute(`
        UPDATE order_profit_items
        SET profit_status = 'accrued', updated_at = CURRENT_TIMESTAMP
        WHERE order_item_id = ?
      `, [item.id]);
      continue;
    }
    const actualProfit = actualItemProfit(item, profitItem);
    await mysqlExecute("UPDATE order_items SET actual_profit = ?, settlement_state = 'accrued' WHERE id = ?", [actualProfit, item.id]);
    await mysqlExecute(`
      UPDATE order_profit_items
      SET net_profit_cny = ?, profit_status = 'accrued', updated_at = CURRENT_TIMESTAMP
      WHERE order_item_id = ?
    `, [actualProfit, item.id]);
  }
}

async function saveRawPostingMysql(shop, posting) {
  await mysqlExecute(`
    INSERT INTO ozon_orders_raw (store_id, posting_number, order_id, status, substatus, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      order_id = VALUES(order_id),
      status = VALUES(status),
      substatus = VALUES(substatus),
      raw_json = VALUES(raw_json),
      fetched_at = CURRENT_TIMESTAMP
  `, [
    shop.id,
    posting.posting_number,
    posting.order_id || posting.order_number || "",
    posting.status || "",
    posting.substatus || posting.logistics_status || "",
    JSON.stringify(posting)
  ]);
}

async function upsertPostingMysql(shop, posting) {
  await saveRawPostingMysql(shop, posting);
  const exists = await mysqlQueryOne("SELECT * FROM orders WHERE shop_id = ? AND posting_number = ?", [shop.id, posting.posting_number])
    || await mysqlQueryOne("SELECT * FROM orders WHERE posting_number = ?", [posting.posting_number]);
  let orderId = exists?.id;
  const lifecycle = orderLifecycleMysql(posting);
  const cancelLossApplies = await orderCancelLossAppliesMysql(posting);
  let inserted = 0;
  let updated = 0;
  if (!orderId) {
    const result = await mysqlExecute(`
      INSERT INTO orders
      (shop_id, posting_number, order_number, status, logistics_status, tracking_stage, ordered_at, delivered_at, accrued_at,
       buyer_region, tracking_number, external_tracking_url, cancel_reason_id, cancel_reason, cancel_initiator, cancel_type,
       cancelled_after_ship, cancel_loss_applies, sync_state, finalized_at, last_synced_at, last_status_changed_at, sync_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
    `, [
      shop.id,
      posting.posting_number,
      posting.order_number,
      posting.status,
      posting.logistics_status,
      posting.tracking_stage || posting.status,
      normalizeMysqlNullableDateTime(posting.ordered_at),
      normalizeMysqlNullableDateTime(posting.delivered_at),
      posting.status === "delivered" ? normalizeMysqlNullableDateTime(posting.delivered_at) : null,
      posting.buyer_region,
      posting.tracking_number,
      posting.external_tracking_url || null,
      posting.cancel_reason_id || null,
      posting.cancel_reason || "",
      posting.cancel_initiator || "",
      posting.cancel_type || "",
      Number(posting.cancelled_after_ship || 0),
      cancelLossApplies ? 1 : 0,
      lifecycle.syncState,
      normalizeMysqlNullableDateTime(lifecycle.finalizedAt),
      lifecycle.note
    ]);
    orderId = Number(result.insertId);
    inserted = 1;
  } else {
    const statusChanged = String(exists.status || "") !== String(posting.status || "") || String(exists.tracking_stage || "") !== String(posting.tracking_stage || posting.status || "");
    await mysqlExecute(`
      UPDATE orders SET
        shop_id = ?, order_number = ?, status = ?, logistics_status = ?, tracking_stage = ?,
        delivered_at = COALESCE(?, delivered_at), buyer_region = ?, tracking_number = ?,
        external_tracking_url = ?, cancel_reason_id = ?, cancel_reason = ?, cancel_initiator = ?, cancel_type = ?,
        cancelled_after_ship = ?, cancel_loss_applies = ?, sync_state = ?, finalized_at = COALESCE(finalized_at, ?),
        last_synced_at = CURRENT_TIMESTAMP,
        last_status_changed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_status_changed_at END,
        sync_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      shop.id,
      posting.order_number,
      posting.status,
      posting.logistics_status,
      posting.tracking_stage || posting.status,
      normalizeMysqlNullableDateTime(posting.delivered_at),
      posting.buyer_region,
      posting.tracking_number,
      posting.external_tracking_url || null,
      posting.cancel_reason_id || null,
      posting.cancel_reason || "",
      posting.cancel_initiator || "",
      posting.cancel_type || "",
      Number(posting.cancelled_after_ship || 0),
      cancelLossApplies ? 1 : 0,
      lifecycle.syncState,
      normalizeMysqlNullableDateTime(lifecycle.finalizedAt),
      statusChanged ? 1 : 0,
      lifecycle.note,
      orderId
    ]);
    updated = 1;
  }
  await recordOrderStatusHistoryMysql(shop, posting, orderId, lifecycle);

  let insertedItems = 0;
  for (const item of posting.items || []) {
    await upsertOnlineProductFromOrderItemMysql(shop, item);
    const existingItem = await mysqlQueryOne("SELECT id FROM order_items WHERE order_id = ? AND ozon_sku = ?", [orderId, item.ozon_sku]);
    if (existingItem) {
      await mysqlExecute(`
        UPDATE order_items
        SET ozon_name = COALESCE(NULLIF(?, ''), ozon_name),
          ozon_image_url = COALESCE(NULLIF(?, ''), ozon_image_url),
          ozon_product_id = COALESCE(NULLIF(?, ''), ozon_product_id)
        WHERE id = ?
      `, [item.name || "", item.image_url || "", item.ozon_product_id || "", existingItem.id]);
      continue;
    }
    const mapping = await mysqlQueryOne(`
      SELECT sm.*, op.commissions_json AS commissions_json
      FROM sku_mappings sm
      LEFT JOIN online_products op ON op.id = sm.online_product_id
      WHERE sm.shop_id = ? AND sm.ozon_sku = ? AND sm.active = 1
    `, [shop.id, item.ozon_sku]);
    const product = mapping ? await mysqlQueryOne("SELECT * FROM products WHERE id = ?", [mapping.product_id]) : null;
    const estimated = product && mapping ? estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping }) : { commission: 0, profit: 0 };
    const settlement = resolveProfitSettlementStatusMysql(posting);
    const returnLossEstimate = product && mapping
      ? await estimateOrderItemReturnLossMysql({ order: posting, item, product, estimated, quantity: item.quantity, salePrice: item.sale_price })
      : 0;
    const estimatedProfit = product && mapping ? estimatedProfitValueMysql({ item, product, estimated, returnLossEstimate }) : 0;
    const itemResult = await mysqlExecute(`
      INSERT INTO order_items
      (order_id, sku_mapping_id, ozon_sku, ozon_name, ozon_image_url, ozon_product_id, quantity, sale_price, frozen_purchase_cost, frozen_domestic_shipping,
       frozen_international_shipping, frozen_handling_fee, estimated_commission, platform_fee_actual, aftersale_loss,
        estimated_profit, actual_profit, settlement_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      orderId,
      mapping?.id || null,
      item.ozon_sku,
      item.name || "",
      item.image_url || "",
      item.ozon_product_id || "",
      item.quantity,
      item.sale_price,
      product?.purchase_cost || 0,
      product?.domestic_shipping || 0,
      estimated.freight || product?.international_shipping || 0,
      product?.handling_fee || 0,
      estimated.commission,
      settlement === "accrued" ? estimated.commission + (estimated.paymentFee || 0) + (estimated.withdrawalFee || 0) + returnLossEstimate : 0,
      0,
      estimatedProfit,
      settlement === "accrued" ? estimatedProfit : 0,
      settlement
    ]);
    const orderItemId = Number(itemResult.insertId);
    if (!mapping) {
      await recordOrderExceptionMysql({
        store_id: shop.id,
        order_item_id: orderItemId,
        posting_number: posting.posting_number,
        ozon_sku: item.ozon_sku,
        exception_type: "UNMAPPED_SKU",
        message: `Ozon SKU ${item.ozon_sku} is not bound to a real product`
      });
    }
    if (product && mapping) {
      await saveProfitItemMysql({ orderItemId, product, estimated, quantity: item.quantity, salePrice: item.sale_price, settlement, order: posting, item });
      await syncOrderItemProfitFromBreakdownMysql(orderItemId, settlement);
      const qty = -Number(item.quantity);
      await postInventoryMysql(mysqlPoolConnectionAdapter, {
        product_id: product.id,
        shop_id: shop.id,
        sku_mapping_id: mapping.id,
        owner_person_id: mapping.person_id,
        source_type: "order_outbound",
        source_ref: posting.posting_number,
        quantity_delta: qty,
        unit_cost: product.purchase_cost,
        amount: Math.abs(qty) * product.purchase_cost,
        related_posting_number: posting.posting_number,
        related_order_item_id: orderItemId,
        note: "Ozon order outbound"
      });
      await mysqlExecute(`
        INSERT INTO outbound_records (product_id, shop_id, online_product_id, order_ref, order_item_id, ozon_sku, person_id, quantity, reason, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'order', 'deducted', ?)
      `, [product.id, shop.id, mapping.online_product_id, posting.posting_number, orderItemId, item.ozon_sku, mapping.person_id, item.quantity, "Created by Ozon sync"]);
    }
    insertedItems += 1;
  }
  await accrueDeliveredItemsMysql(orderId);
  return { inserted, updated, insertedItems };
}

function throwIfAbortedMysql(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(reason || "Sync request was cancelled");
}

function normalizeSyncDateTimeMysql(value) {
  if (!value) return "";
  const raw = String(value);
  const date = new Date(raw.includes("T") ? raw : `${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function emptySyncAggregateMysql(mode, from, to) {
  return { mode, inserted: 0, updated: 0, fetched: 0, requests: 0, from, to, shops: [], errors: [] };
}

function mergeSyncAggregateMysql(target, result, reason) {
  target.inserted += Number(result.inserted || 0);
  target.updated += Number(result.updated || 0);
  target.fetched += Number(result.fetched || 0);
  target.requests += Number(result.requests || 0);
  target.errors.push(...(result.errors || []));
  for (const shop of result.shops || []) target.shops.push({ ...shop, reason });
}

async function latestOrderSyncStartMysql(shopId, fallbackFrom, overlapMinutes = 15) {
  const latest = await mysqlQueryOne("SELECT ordered_at FROM orders WHERE shop_id = ? ORDER BY ordered_at DESC LIMIT 1", [shopId]);
  const latestDate = latest?.ordered_at ? new Date(latest.ordered_at) : null;
  if (!latestDate || Number.isNaN(latestDate.getTime())) return fallbackFrom;
  const overlapMs = Math.min(Math.max(Number(overlapMinutes || 0), 0), 24 * 60) * 60 * 1000;
  return new Date(latestDate.getTime() - overlapMs).toISOString();
}

export async function syncDemoOrdersMysql(body = {}, options = {}) {
  ensureMysqlCutoverEnabled();
  const targetShopId = nullableInteger(body.shop_id);
  const activeShops = (await shopsMysql()).filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  const rawFrom = body.from || body.date_from || body.dateFrom;
  const rawTo = body.to || body.date_to || body.dateTo;
  const rawFromDateTime = body.from_datetime || body.fromDateTime || "";
  const rawToDateTime = body.to_datetime || body.toDateTime || "";
  const from = normalizeSyncDateMysql(rawFromDateTime || rawFrom);
  const to = normalizeSyncDateMysql(rawToDateTime || rawTo);
  const fetchFrom = normalizeSyncDateTimeMysql(rawFromDateTime) || from;
  const fetchTo = normalizeSyncDateTimeMysql(rawToDateTime) || to;
  if (from && to && from > to) throw new Error("End date cannot be earlier than start date");
  throwIfAbortedMysql(options.signal);
  let inserted = 0;
  let updated = 0;
  let fetched = 0;
  let requests = 0;
  const shopResults = [];
  const errors = [];
  for (const shop of activeShops) {
    try {
      throwIfAbortedMysql(options.signal);
      const result = await fetchOzonPostings(shop, { from: fetchFrom, to: fetchTo, chunkDays: 14, signal: options.signal });
      throwIfAbortedMysql(options.signal);
      const postings = Array.isArray(result) ? result : result.postings || [];
      const shopStats = {
        shop_id: shop.id,
        shop_name: shop.name,
        fetched: postings.length,
        inserted: 0,
        updated: 0,
        inserted_items: 0,
        requests: result.requests || 0,
        ranges: result.ranges || 0
      };
      fetched += postings.length;
      requests += result.requests || 0;
      for (const posting of postings) {
        throwIfAbortedMysql(options.signal);
        const stats = await upsertPostingMysql(shop, posting);
        shopStats.inserted += stats.inserted;
        shopStats.updated += stats.updated;
        shopStats.inserted_items += stats.insertedItems;
      }
      inserted += shopStats.inserted_items;
      updated += shopStats.updated;
      shopResults.push(shopStats);
      invalidateMasterDataCache();
    } catch (error) {
      const message = `${shop.name}: ${error.message}`;
      errors.push(message);
      shopResults.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, inserted: 0, updated: 0, inserted_items: 0, requests: 0, ranges: 0, error: error.message });
    }
  }
  const status = errors.length ? "partial_error" : "ok";
  const message = `Range ${from || "last_30_days"}~${to || "now"}; fetched ${fetched}, inserted item(s) ${inserted}, updated order(s) ${updated}, requests ${requests}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  await mysqlExecute("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_orders', ?, ?)", [status, message]);
  await syncOutboundForOpenOrdersMysql();
  await refreshProfitAnalyticsSnapshotsMysql({ from: from || "", to: to || "" });
  if (errors.length && fetched === 0) throw new Error(errors.join(" | "));
  return { inserted, updated, fetched, requests, from: from || "", to: to || "", shops: shopResults, errors };
}

export async function syncOzonIncrementalOrdersMysql(body = {}, options = {}) {
  ensureMysqlCutoverEnabled();
  const targetShopId = nullableInteger(body.shop_id);
  const activeShops = (await shopsMysql()).filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  const fromLatest = body.from_latest === true || body.fromLatest === true || body.mode === "new";
  const recentDays = Math.min(Math.max(Number(body.recent_days || body.fallback_days || 7), 1), 60);
  const overlapMinutes = Math.min(Math.max(Number(body.overlap_minutes || 15), 0), 24 * 60);
  const to = todayDateKeyMysql();
  const recentFrom = dateKeyDaysAgoMysql(recentDays);
  const aggregate = emptySyncAggregateMysql(fromLatest ? "new_orders" : "incremental", fromLatest ? "latest_local_order" : recentFrom, to);
  for (const shop of activeShops) {
    throwIfAbortedMysql(options.signal);
    const start = fromLatest ? await latestOrderSyncStartMysql(shop.id, recentFrom, overlapMinutes) : recentFrom;
    const ranges = [{ from: start, to, reason: fromLatest ? "latest" : "recent" }];
    const seen = new Set();
    for (const range of ranges) {
      throwIfAbortedMysql(options.signal);
      const key = `${range.from}~${range.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const result = await syncDemoOrdersMysql(fromLatest ? {
          shop_id: shop.id,
          from_datetime: start,
          to,
          to_datetime: `${to}T23:59:59.999Z`
        } : {
          shop_id: shop.id,
          from: range.from,
          to: range.to
        }, options);
        mergeSyncAggregateMysql(aggregate, result, range.reason || "open");
      } catch (error) {
        aggregate.errors.push(`${shop.name} ${range.from}~${range.to}: ${error.message}`);
        aggregate.shops.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, inserted: 0, updated: 0, inserted_items: 0, requests: 0, ranges: 0, error: error.message, reason: range.reason || "open" });
      }
    }
  }
  const status = aggregate.errors.length ? "partial_error" : "ok";
  const message = `Incremental sync; fetched ${aggregate.fetched}, inserted item(s) ${aggregate.inserted}, updated order(s) ${aggregate.updated}, requests ${aggregate.requests}${aggregate.errors.length ? `; ${aggregate.errors.join(" | ")}` : ""}`;
  await mysqlExecute("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_orders_incremental', ?, ?)", [status, message]);
  if (aggregate.errors.length && aggregate.fetched === 0) throw new Error(aggregate.errors.join(" | "));
  return aggregate;
}

export function exceptionWorkbenchSyncWindowMysql() {
  return {
    from: dateKeyDaysAgoMysql(30),
    to: todayDateKeyMysql()
  };
}

export async function refreshProfitAnalyticsSnapshotsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const rangeFrom = String(body.from || "2000-01-01").trim() || "2000-01-01";
  const rangeTo = String(body.to || "9999-12-31").trim() || "9999-12-31";
  const outcome = buildOrderOutcomeSql("o");
  await mysqlExecute("DELETE FROM analytics_shop_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);
  await mysqlExecute("DELETE FROM analytics_product_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);
  await mysqlExecute("DELETE FROM analytics_sku_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);

  await mysqlExecute(`
    INSERT INTO analytics_shop_daily (
      date_key, shop_id, order_count, item_quantity, revenue, estimated_profit, confirmed_profit, current_profit,
      cancelled_orders, cancelled_revenue, return_orders, return_quantity, return_revenue, refreshed_at
    )
    SELECT
      ${chinaDateSqlMysql("o.ordered_at")} AS date_key,
      o.shop_id,
      COUNT(DISTINCT CASE WHEN ${outcome.effectiveSale} THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END ELSE 0 END), 0) AS current_profit,
      COUNT(DISTINCT CASE WHEN ${outcome.cancelledPreFulfillment} THEN o.id END) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN o.id END) AS return_orders,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS return_revenue,
      CURRENT_TIMESTAMP
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE ${chinaDateSqlMysql("o.ordered_at")} >= ?
      AND ${chinaDateSqlMysql("o.ordered_at")} <= ?
    GROUP BY ${chinaDateSqlMysql("o.ordered_at")}, o.shop_id
  `, [rangeFrom, rangeTo]);

  await mysqlExecute(`
    INSERT INTO analytics_product_profit_daily (
      date_key, product_id, shop_id, order_count, item_quantity, revenue, estimated_profit, confirmed_profit, current_profit, refreshed_at
    )
    SELECT
      ${chinaDateSqlMysql("o.ordered_at")} AS date_key,
      sm.product_id,
      o.shop_id,
      COUNT(DISTINCT CASE WHEN ${outcome.effectiveSale} THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END ELSE 0 END), 0) AS current_profit,
      CURRENT_TIMESTAMP
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.active = 1
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE ${chinaDateSqlMysql("o.ordered_at")} >= ?
      AND ${chinaDateSqlMysql("o.ordered_at")} <= ?
    GROUP BY ${chinaDateSqlMysql("o.ordered_at")}, sm.product_id, o.shop_id
  `, [rangeFrom, rangeTo]);

  await mysqlExecute(`
    INSERT INTO analytics_sku_profit_daily (
      date_key, shop_id, ozon_sku, product_id, order_count, item_quantity, revenue, estimated_profit, confirmed_profit, current_profit,
      cancelled_orders, cancelled_quantity, cancelled_revenue, return_orders, return_quantity, return_revenue, refreshed_at
    )
    SELECT
      ${chinaDateSqlMysql("o.ordered_at")} AS date_key,
      o.shop_id,
      oi.ozon_sku,
      MAX(sm.product_id) AS product_id,
      COUNT(DISTINCT CASE WHEN ${outcome.effectiveSale} THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END ELSE 0 END), 0) AS current_profit,
      COUNT(DISTINCT CASE WHEN ${outcome.cancelledPreFulfillment} THEN o.id END) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN oi.quantity ELSE 0 END), 0) AS cancelled_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN o.id END) AS return_orders,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS return_revenue,
      CURRENT_TIMESTAMP
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.active = 1
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE ${chinaDateSqlMysql("o.ordered_at")} >= ?
      AND ${chinaDateSqlMysql("o.ordered_at")} <= ?
    GROUP BY ${chinaDateSqlMysql("o.ordered_at")}, o.shop_id, oi.ozon_sku
  `, [rangeFrom, rangeTo]);

  const [shopRows, productRows, skuRows] = await Promise.all([
    mysqlQueryOne("SELECT COUNT(*) AS count FROM analytics_shop_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]),
    mysqlQueryOne("SELECT COUNT(*) AS count FROM analytics_product_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]),
    mysqlQueryOne("SELECT COUNT(*) AS count FROM analytics_sku_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo])
  ]);
  return {
    ok: true,
    from: rangeFrom,
    to: rangeTo,
    shop_rows: Number(shopRows?.count || 0),
    product_rows: Number(productRows?.count || 0),
    sku_rows: Number(skuRows?.count || 0),
    db: "mysql"
  };
}

export async function recalculateOrderProfitMysql(orderId) {
  ensureMysqlCutoverEnabled();
  const order = await mysqlQueryOne("SELECT * FROM orders WHERE id = ?", [Number(orderId)]);
  if (!order) throw new Error("Order not found");
  const rows = await mysqlQuery(`
    SELECT oi.*, o.shop_id, o.status AS order_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.order_id = ?
  `, [Number(orderId)]);
  let updated = 0;
  let unbound = 0;
  for (const item of rows) {
    const mapping = await mysqlQueryOne(`
      SELECT sm.*, op.commissions_json AS commissions_json
      FROM sku_mappings sm
      LEFT JOIN online_products op ON op.id = sm.online_product_id
      WHERE sm.active = 1
        AND sm.shop_id = ?
        AND sm.ozon_sku = ?
      ORDER BY CASE WHEN sm.id = ? THEN 0 ELSE 1 END, sm.id DESC
      LIMIT 1
    `, [order.shop_id, item.ozon_sku, Number(item.sku_mapping_id || 0)]);
    if (!mapping) {
      unbound += 1;
      continue;
    }
    const product = await mysqlQueryOne("SELECT * FROM products WHERE id = ? AND active = 1", [mapping.product_id]);
    if (!product) {
      unbound += 1;
      continue;
    }
    const estimated = estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping });
    const settlement = resolveProfitSettlementStatusMysql({ ...order, ...item });
    const returnLossEstimate = await estimateOrderItemReturnLossMysql({ order, item, product, estimated, quantity: item.quantity, salePrice: item.sale_price });
    const estimatedProfit = estimatedProfitValueMysql({ item, product, estimated, returnLossEstimate });
    await persistRecalculatedItemMysql({
      itemId: item.id,
      mapping,
      product,
      estimated,
      settlement,
      returnLossEstimate,
      estimatedProfit,
      quantity: item.quantity,
      salePrice: item.sale_price,
      order,
      item
    });
    updated += 1;
  }
  await syncOutboundForOpenOrdersMysql();
  const orderedDateKey = chinaDateKeyMysql(order.ordered_at);
  if (orderedDateKey) await refreshProfitAnalyticsSnapshotsMysql({ from: orderedDateKey, to: orderedDateKey });
  return { ok: true, updated, unbound };
}

export async function recalculateAllMappedOrderProfitsMysql() {
  ensureMysqlCutoverEnabled();
  const mappings = await mysqlQuery("SELECT id FROM sku_mappings WHERE active = 1");
  let updated = 0;
  for (const mapping of mappings) {
    updated += Number((await recalculateOrderItemsForMappingMysql(mapping.id)).updated || 0);
  }
  const eligible = await mysqlQueryOne(`
    SELECT COUNT(*) AS count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE COALESCE(o.sync_state, 'open') != 'final'
  `);
  return { updated, mappings: mappings.length, scope: "open_orders_only", eligible_items: Number(eligible?.count || 0) };
}

export async function recalculateHistoricalOrderProfitsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  const onlyFinal = Number(body.only_final ?? 1) !== 0;
  const onlyWithFinance = Number(body.only_with_finance ?? 1) !== 0;
  const filters = [];
  const params = [];
  if (from) {
    filters.push(`${chinaDateSqlMysql("o.ordered_at")} >= ?`);
    params.push(from);
  }
  if (to) {
    filters.push(`${chinaDateSqlMysql("o.ordered_at")} <= ?`);
    params.push(to);
  }
  if (onlyFinal) filters.push("COALESCE(o.sync_state, 'open') = 'final'");
  if (onlyWithFinance) {
    filters.push(`EXISTS (
      SELECT 1
      FROM ozon_finance_items ofi
      WHERE ofi.shop_id = o.shop_id
        AND ofi.posting_number = o.posting_number
    )`);
  }
  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const orders = await mysqlQuery(`
    SELECT o.id, ${chinaDateSqlMysql("o.ordered_at")} AS order_date
    FROM orders o
    ${whereSql}
    ORDER BY ${chinaDateSqlMysql("o.ordered_at")} ASC, o.id ASC
  `, params);
  let updatedOrders = 0;
  let updatedItems = 0;
  let unbound = 0;
  const dateKeys = new Set();
  for (const order of orders) {
    const result = await recalculateOrderProfitMysql(order.id);
    updatedOrders += 1;
    updatedItems += Number(result.updated || 0);
    unbound += Number(result.unbound || 0);
    if (order.order_date) dateKeys.add(order.order_date);
  }
  const applied = await applyOzonFinanceToOrdersMysql({ from, to });
  if (dateKeys.size) {
    const sortedDates = [...dateKeys].sort();
    await refreshProfitAnalyticsSnapshotsMysql({
      from: from || sortedDates[0],
      to: to || sortedDates[sortedDates.length - 1]
    });
  } else if (from || to) {
    await refreshProfitAnalyticsSnapshotsMysql({ from, to });
  }
  return {
    ok: true,
    scope: onlyFinal ? "final_orders" : "all_orders",
    only_with_finance: onlyWithFinance,
    from,
    to,
    orders: orders.length,
    updated_orders: updatedOrders,
    updated_items: updatedItems,
    unbound,
    finance_reapplied: applied
  };
}

export async function recalculateOrderProfitsForProductMysql(productId) {
  ensureMysqlCutoverEnabled();
  const product = await mysqlQueryOne("SELECT id FROM products WHERE id = ? AND active = 1", [Number(productId)]);
  if (!product) throw new Error("Inventory product not found or archived");
  const mappings = await mysqlQuery("SELECT id FROM sku_mappings WHERE product_id = ? AND active = 1", [Number(productId)]);
  let updated = 0;
  for (const mapping of mappings) {
    updated += Number((await recalculateOrderItemsForMappingMysql(mapping.id)).updated || 0);
  }
  await syncOutboundForOpenOrdersMysql();
  await refreshProfitAnalyticsSnapshotsMysql({});
  const eligible = await mysqlQueryOne(`
    SELECT COUNT(*) AS count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    WHERE sm.product_id = ?
      AND sm.active = 1
      AND COALESCE(o.sync_state, 'open') != 'final'
  `, [Number(productId)]);
  return { ok: true, product_id: Number(productId), updated, mappings: mappings.length, scope: "open_orders_only", eligible_items: Number(eligible?.count || 0) };
}

function historicalReviewBucketMysql(row = {}) {
  const financeRows = Number(row.finance_rows || 0);
  const financeAftersaleRows = Number(row.finance_aftersale_rows || 0);
  if (financeAftersaleRows > 0) return "finance_aftersale_present";
  if (financeRows > 0) return "finance_present_without_aftersale";
  if (String(row.profit_status || "") === "accrued" || String(row.status || "") === "delivered") return "delivered_without_finance";
  return "status_mismatch";
}

function historicalReviewBucketLabelMysql(bucket = "") {
  return {
    finance_aftersale_present: "Finance aftersale present",
    finance_present_without_aftersale: "Finance present without aftersale item",
    delivered_without_finance: "Delivered without finance aftersale",
    status_mismatch: "Needs manual review"
  }[bucket] || "Needs manual review";
}

function historicalReviewOrderItemIdsMysql(body = {}) {
  const list = Array.isArray(body.order_item_ids) ? body.order_item_ids : [];
  return [...new Set(list.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
}

function recalculateNetProfitWithoutReturnLossMysql(row = {}) {
  return roundMoneyMysql(
    Number(row.sale_amount_cny || 0)
    - Number(row.purchase_cost_cny || 0)
    - Number(row.domestic_shipping_cny || 0)
    - Number(row.international_shipping_cny || 0)
    - Number(row.packaging_cost_cny || 0)
    - Number(row.commission_fee_cny || 0)
    - Number(row.ozon_service_fee_cny || 0)
    - Number(row.advertising_cost_cny || 0)
    - Number(row.other_fee_cny || 0)
  );
}

async function upsertHistoricalProfitReviewMysql(orderItemId, reviewStatus, note = "", userId = null) {
  await mysqlExecute(`
    INSERT INTO historical_profit_reviews (order_item_id, review_status, note, updated_by_person_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      review_status = VALUES(review_status),
      note = VALUES(note),
      updated_by_person_id = VALUES(updated_by_person_id),
      updated_at = CURRENT_TIMESTAMP
  `, [Number(orderItemId), reviewStatus, String(note || "").trim(), await resolveExistingPersonId(userId)]);
}

function historicalReviewFiltersMysql({ from = "", to = "", onlyFinal = true, reviewStatus = "all", cleanup = false } = {}) {
  const filters = [
    "COALESCE(opi.return_loss_cny, 0) > 0",
    "COALESCE(o.cancel_reason, '') = ''",
    "COALESCE(o.cancel_type, '') = ''",
    "COALESCE(o.cancel_initiator, '') = ''",
    "(COALESCE(o.status, '') = 'delivered' OR COALESCE(o.delivered_at, '') != '' OR COALESCE(o.accrued_at, '') != '' OR COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued')"
  ];
  const params = [];
  if (cleanup) {
    filters.push(`NOT EXISTS (
      SELECT 1
      FROM ozon_finance_items ofi
      WHERE ofi.shop_id = o.shop_id
        AND ofi.posting_number = o.posting_number
        AND (
          LOWER(COALESCE(ofi.service_type, '')) LIKE '%return%'
          OR LOWER(COALESCE(ofi.service_name, '')) LIKE '%return%'
        )
    )`);
    filters.push(`NOT EXISTS (
      SELECT 1
      FROM historical_profit_reviews hpr_keep
      WHERE hpr_keep.order_item_id = oi.id
        AND hpr_keep.review_status = 'kept'
    )`);
  }
  if (from) {
    filters.push(`${chinaDateSqlMysql("o.ordered_at")} >= ?`);
    params.push(from);
  }
  if (to) {
    filters.push(`${chinaDateSqlMysql("o.ordered_at")} <= ?`);
    params.push(to);
  }
  if (onlyFinal) filters.push("COALESCE(o.sync_state, 'open') = 'final'");
  if (reviewStatus === "pending") filters.push("COALESCE(hpr.review_status, 'pending') = 'pending'");
  if (reviewStatus === "kept") filters.push("COALESCE(hpr.review_status, 'pending') = 'kept'");
  if (reviewStatus === "cleared") filters.push("COALESCE(hpr.review_status, 'pending') = 'cleared'");
  return { filters, params };
}

function historicalReviewRowsSqlMysql(whereSql, limitSql = "") {
  return `
    SELECT
      o.id AS order_id,
      oi.id AS order_item_id,
      ${chinaDateSqlMysql("o.ordered_at")} AS order_date,
      o.ordered_at,
      o.delivered_at,
      o.accrued_at,
      o.posting_number,
      o.status,
      o.tracking_stage,
      COALESCE(o.sync_state, 'open') AS sync_state,
      s.name AS shop_name,
      oi.ozon_sku,
      COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), 'Unnamed product') AS ozon_name,
      oi.quantity,
      COALESCE(NULLIF(p.name, ''), '') AS product_name,
      COALESCE(NULLIF(p.code, ''), '') AS product_code,
      COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), NULLIF(p.image_url, ''), '') AS image_url,
      COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) AS sale_amount_cny,
      COALESCE(opi.return_loss_cny, 0) AS return_loss_cny,
      COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) AS net_profit_cny,
      COALESCE(opi.profit_status, oi.settlement_state, 'estimated') AS profit_status,
      COALESCE(hpr.review_status, 'pending') AS review_status,
      COALESCE(hpr.note, '') AS review_note,
      hpr.updated_at AS review_updated_at,
      COALESCE(fin.finance_rows, 0) AS finance_rows,
      COALESCE(fin.finance_aftersale_rows, 0) AS finance_aftersale_rows,
      COALESCE(fin.finance_service_names, '') AS finance_service_names
    FROM order_profit_items opi
    JOIN order_items oi ON oi.id = opi.order_item_id
    JOIN orders o ON o.id = oi.order_id
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN historical_profit_reviews hpr ON hpr.order_item_id = oi.id
    LEFT JOIN (
      SELECT
        shop_id,
        posting_number,
        COUNT(*) AS finance_rows,
        SUM(CASE WHEN LOWER(COALESCE(service_type, '')) LIKE '%return%' OR LOWER(COALESCE(service_name, '')) LIKE '%return%' THEN 1 ELSE 0 END) AS finance_aftersale_rows,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(service_name, ''), service_type)) AS finance_service_names
      FROM ozon_finance_items
      GROUP BY shop_id, posting_number
    ) fin ON fin.shop_id = o.shop_id AND fin.posting_number = o.posting_number
    ${whereSql}
    ORDER BY
      CASE COALESCE(hpr.review_status, 'pending')
        WHEN 'pending' THEN 0
        WHEN 'kept' THEN 1
        WHEN 'cleared' THEN 2
        ELSE 3
      END ASC,
      COALESCE(opi.return_loss_cny, 0) DESC,
      o.ordered_at DESC,
      oi.id DESC
    ${limitSql}
  `;
}

function refreshHistoricalReviewDerivedFieldsMysql(rows = []) {
  return rows.map((row) => {
    const bucket = historicalReviewBucketMysql(row);
    return { ...row, bucket, bucket_label: historicalReviewBucketLabelMysql(bucket) };
  });
}

export async function historicalProfitReviewMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const from = String(query.from || "").trim();
  const to = String(query.to || "").trim();
  const onlyFinal = Number(query.only_final ?? 1) !== 0;
  const reviewStatus = String(query.review_status || "all").trim() || "all";
  const limit = Math.min(Math.max(Number(query.limit || 200), 1), 1000);
  const { filters, params } = historicalReviewFiltersMysql({ from, to, onlyFinal, reviewStatus });
  const whereSql = `WHERE ${filters.join(" AND ")}`;
  const summary = await mysqlQueryOne(`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT o.id) AS order_count,
      COALESCE(SUM(opi.return_loss_cny), 0) AS total_return_loss_cny,
      SUM(CASE WHEN COALESCE(hpr.review_status, 'pending') = 'pending' THEN 1 ELSE 0 END) AS pending_rows,
      SUM(CASE WHEN COALESCE(hpr.review_status, 'pending') = 'kept' THEN 1 ELSE 0 END) AS kept_rows,
      SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM ozon_finance_items ofi
        WHERE ofi.shop_id = o.shop_id
          AND ofi.posting_number = o.posting_number
      ) THEN 1 ELSE 0 END) AS finance_rows
    FROM order_profit_items opi
    JOIN order_items oi ON oi.id = opi.order_item_id
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN historical_profit_reviews hpr ON hpr.order_item_id = oi.id
    ${whereSql}
  `, params) || {};
  const rows = refreshHistoricalReviewDerivedFieldsMysql(
    await mysqlQuery(historicalReviewRowsSqlMysql(whereSql, "LIMIT ?"), [...params, limit])
  );
  const bucketSummary = rows.reduce((acc, row) => {
    acc[row.bucket] = Number(acc[row.bucket] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    from,
    to,
    only_final: onlyFinal,
    review_status: reviewStatus,
    limit,
    summary: {
      total_rows: Number(summary.total_rows || 0),
      order_count: Number(summary.order_count || 0),
      total_return_loss_cny: roundMoneyMysql(summary.total_return_loss_cny || 0),
      pending_rows: Number(summary.pending_rows || 0),
      kept_rows: Number(summary.kept_rows || 0),
      finance_rows: Number(summary.finance_rows || 0),
      bucket_summary: bucketSummary
    },
    rows
  };
}

export async function cleanupHistoricalDeliveredReturnLossMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  const onlyFinal = Number(body.only_final ?? 1) !== 0;
  const { filters, params } = historicalReviewFiltersMysql({ from, to, onlyFinal, cleanup: true });
  const rows = await mysqlQuery(`
    SELECT o.id AS order_id,
      ${chinaDateSqlMysql("o.ordered_at")} AS order_date,
      oi.id AS order_item_id,
      COALESCE(opi.sale_amount_cny, 0) AS sale_amount_cny,
      COALESCE(opi.purchase_cost_cny, 0) AS purchase_cost_cny,
      COALESCE(opi.domestic_shipping_cny, 0) AS domestic_shipping_cny,
      COALESCE(opi.international_shipping_cny, 0) AS international_shipping_cny,
      COALESCE(opi.packaging_cost_cny, 0) AS packaging_cost_cny,
      COALESCE(opi.commission_fee_cny, 0) AS commission_fee_cny,
      COALESCE(opi.ozon_service_fee_cny, 0) AS ozon_service_fee_cny,
      COALESCE(opi.advertising_cost_cny, 0) AS advertising_cost_cny,
      COALESCE(opi.other_fee_cny, 0) AS other_fee_cny,
      COALESCE(opi.return_loss_cny, 0) AS return_loss_cny,
      COALESCE(opi.profit_status, oi.settlement_state, 'estimated') AS settlement_state
    FROM order_profit_items opi
    JOIN order_items oi ON oi.id = opi.order_item_id
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN historical_profit_reviews hpr ON hpr.order_item_id = oi.id
    WHERE ${filters.join(" AND ")}
    ORDER BY ${chinaDateSqlMysql("o.ordered_at")} ASC, o.id ASC, oi.id ASC
  `, params);
  if (!rows.length) return { ok: true, from, to, only_final: onlyFinal, updated_items: 0, updated_orders: 0, cleared_return_loss_cny: 0 };
  let updatedItems = 0;
  let clearedReturnLoss = 0;
  const updatedOrders = new Set();
  const dateKeys = new Set();
  await withMysqlTransaction(async (connection) => {
    for (const row of rows) {
      const nextProfit = recalculateNetProfitWithoutReturnLossMysql(row);
      await connection.execute(`
        UPDATE order_profit_items
        SET return_loss_cny = 0,
          net_profit_cny = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE order_item_id = ?
      `, [nextProfit, row.order_item_id]);
      if (String(row.settlement_state || "") === "accrued") {
        await connection.execute(`
          UPDATE order_items
          SET estimated_profit = ?,
            actual_profit = ?,
            aftersale_loss = 0,
            settlement_state = 'accrued'
          WHERE id = ?
        `, [nextProfit, nextProfit, row.order_item_id]);
      } else {
        await connection.execute(`
          UPDATE order_items
          SET estimated_profit = ?,
            actual_profit = 0,
            aftersale_loss = 0,
            settlement_state = ?
          WHERE id = ?
        `, [nextProfit, row.settlement_state || "estimated", row.order_item_id]);
      }
      await connection.execute(`
        INSERT INTO historical_profit_reviews (order_item_id, review_status, note, updated_by_person_id, created_at, updated_at)
        VALUES (?, 'cleared', 'system_cleanup', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          review_status = VALUES(review_status),
          note = VALUES(note),
          updated_by_person_id = VALUES(updated_by_person_id),
          updated_at = CURRENT_TIMESTAMP
      `, [row.order_item_id]);
      updatedItems += 1;
      clearedReturnLoss += Number(row.return_loss_cny || 0);
      updatedOrders.add(Number(row.order_id));
      if (row.order_date) dateKeys.add(row.order_date);
    }
  });
  if (dateKeys.size) {
    const sortedDates = [...dateKeys].sort();
    await refreshProfitAnalyticsSnapshotsMysql({ from: from || sortedDates[0], to: to || sortedDates[sortedDates.length - 1] });
  } else if (from || to) {
    await refreshProfitAnalyticsSnapshotsMysql({ from, to });
  }
  return {
    ok: true,
    from,
    to,
    only_final: onlyFinal,
    updated_items: updatedItems,
    updated_orders: updatedOrders.size,
    cleared_return_loss_cny: roundMoneyMysql(clearedReturnLoss)
  };
}

export async function applyHistoricalProfitReviewActionMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const action = String(body.action || "").trim();
  const orderItemIds = historicalReviewOrderItemIdsMysql(body);
  if (!action) throw new Error("Missing review action");
  if (!orderItemIds.length) throw new Error("Select historical review rows first");
  const placeholders = orderItemIds.map(() => "?").join(",");
  const rows = await mysqlQuery(`
    SELECT
      o.id AS order_id,
      oi.id AS order_item_id,
      ${chinaDateSqlMysql("o.ordered_at")} AS order_date,
      COALESCE(opi.sale_amount_cny, 0) AS sale_amount_cny,
      COALESCE(opi.purchase_cost_cny, 0) AS purchase_cost_cny,
      COALESCE(opi.domestic_shipping_cny, 0) AS domestic_shipping_cny,
      COALESCE(opi.international_shipping_cny, 0) AS international_shipping_cny,
      COALESCE(opi.packaging_cost_cny, 0) AS packaging_cost_cny,
      COALESCE(opi.commission_fee_cny, 0) AS commission_fee_cny,
      COALESCE(opi.ozon_service_fee_cny, 0) AS ozon_service_fee_cny,
      COALESCE(opi.advertising_cost_cny, 0) AS advertising_cost_cny,
      COALESCE(opi.other_fee_cny, 0) AS other_fee_cny,
      COALESCE(opi.return_loss_cny, 0) AS return_loss_cny,
      COALESCE(opi.profit_status, oi.settlement_state, 'estimated') AS settlement_state
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE oi.id IN (${placeholders})
  `, orderItemIds);
  if (!rows.length) throw new Error("No reviewable order items found");
  if (action === "keep") {
    for (const row of rows) await upsertHistoricalProfitReviewMysql(row.order_item_id, "kept", "manual_keep", userId);
    return { ok: true, action, updated_items: rows.length };
  }
  if (action === "reset") {
    await mysqlExecute(`DELETE FROM historical_profit_reviews WHERE order_item_id IN (${placeholders})`, orderItemIds);
    return { ok: true, action, updated_items: rows.length };
  }
  if (action === "clear") {
    let clearedReturnLoss = 0;
    const dateKeys = [];
    await withMysqlTransaction(async (connection) => {
      for (const row of rows) {
        const nextProfit = recalculateNetProfitWithoutReturnLossMysql(row);
        await connection.execute(`
          UPDATE order_profit_items
          SET return_loss_cny = 0,
            net_profit_cny = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE order_item_id = ?
        `, [nextProfit, row.order_item_id]);
        const accrued = String(row.settlement_state || "") === "accrued";
        await connection.execute(`
          UPDATE order_items
          SET estimated_profit = ?,
            actual_profit = ?,
            aftersale_loss = 0,
            settlement_state = ?
          WHERE id = ?
        `, [nextProfit, accrued ? nextProfit : 0, accrued ? "accrued" : (row.settlement_state || "estimated"), row.order_item_id]);
        await connection.execute(`
          INSERT INTO historical_profit_reviews (order_item_id, review_status, note, updated_by_person_id, created_at, updated_at)
          VALUES (?, 'cleared', 'manual_clear', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON DUPLICATE KEY UPDATE
            review_status = VALUES(review_status),
            note = VALUES(note),
            updated_by_person_id = VALUES(updated_by_person_id),
            updated_at = CURRENT_TIMESTAMP
        `, [row.order_item_id, await resolveExistingPersonId(userId)]);
        clearedReturnLoss += Number(row.return_loss_cny || 0);
        if (row.order_date) dateKeys.push(row.order_date);
      }
    });
    if (dateKeys.length) {
      const sortedDates = [...new Set(dateKeys)].sort();
      await refreshProfitAnalyticsSnapshotsMysql({ from: sortedDates[0], to: sortedDates[sortedDates.length - 1] });
    }
    return {
      ok: true,
      action,
      updated_items: rows.length,
      updated_orders: new Set(rows.map((row) => Number(row.order_id))).size,
      cleared_return_loss_cny: roundMoneyMysql(clearedReturnLoss)
    };
  }
  if (action === "recalculate") {
    const uniqueOrders = [...new Set(rows.map((row) => Number(row.order_id)).filter(Boolean))];
    let updatedItems = 0;
    let unbound = 0;
    for (const orderId of uniqueOrders) {
      const result = await recalculateOrderProfitMysql(orderId);
      updatedItems += Number(result.updated || 0);
      unbound += Number(result.unbound || 0);
    }
    const dateKeys = rows.map((row) => row.order_date).filter(Boolean);
    const sortedDates = [...new Set(dateKeys)].sort();
    const applied = await applyOzonFinanceToOrdersMysql({ from: sortedDates[0] || "", to: sortedDates[sortedDates.length - 1] || "" });
    if (sortedDates.length) await refreshProfitAnalyticsSnapshotsMysql({ from: sortedDates[0], to: sortedDates[sortedDates.length - 1] });
    return { ok: true, action, updated_orders: uniqueOrders.length, updated_items: updatedItems, unbound, finance_reapplied: applied };
  }
  throw new Error("Unsupported review action");
}

async function upsertInboundInventoryMovementMysql(connection, inboundId, body = {}) {
  const sourceRef = `inbound_${inboundId}`;
  const existingMovement = await mysqlConnectionQueryOne(connection, `
    SELECT id, product_id FROM inventory_movements
    WHERE source_type = 'purchase_inbound' AND source_ref = ?
    LIMIT 1
  `, [sourceRef]);
  if (existingMovement) {
    await connection.execute(`
      UPDATE inventory_movements
      SET product_id = ?, owner_person_id = ?, quantity_delta = ?, unit_cost = ?, amount = ?, note = ?, status = 'posted'
      WHERE id = ?
    `, [
      Number(body.product_id),
      nullableInteger(body.owner_person_id),
      Number(body.quantity || 0),
      Number(body.unitCost || 0),
      Number(body.amount || 0),
      body.note || "",
      existingMovement.id
    ]);
    await rebuildInventoryCurrentForProductMysql(connection, existingMovement.product_id);
    await rebuildInventoryCurrentForProductMysql(connection, body.product_id);
    return Number(existingMovement.id);
  }
  const movementId = await postInventoryMysql(connection, {
    product_id: body.product_id,
    owner_person_id: body.owner_person_id,
    source_type: "purchase_inbound",
    source_ref: sourceRef,
    quantity_delta: body.quantity,
    unit_cost: body.unitCost,
    amount: body.amount,
    note: body.note
  });
  await rebuildInventoryCurrentForProductMysql(connection, body.product_id);
  return movementId;
}

async function deleteInboundInventoryMovementMysql(connection, inboundId, productId) {
  await connection.execute(`
    DELETE FROM inventory_movements
    WHERE source_type = 'purchase_inbound' AND source_ref = ?
  `, [`inbound_${inboundId}`]);
  await rebuildInventoryCurrentForProductMysql(connection, productId);
}

async function refreshPurchaseOrderStatusMysql(connection, orderId) {
  if (!orderId) return;
  const summary = await mysqlConnectionQueryOne(connection, `
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN inbound_quantity >= actual_quantity AND actual_quantity > 0 THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN inbound_quantity > 0 AND inbound_quantity < actual_quantity THEN 1 ELSE 0 END) AS partial
    FROM purchase_order_items
    WHERE purchase_order_id = ?
  `, [Number(orderId)]);
  if (!summary?.total) return;
  const status = Number(summary.done || 0) === Number(summary.total)
    ? "inbound_done"
    : Number(summary.partial || 0) > 0 || Number(summary.done || 0) > 0
      ? "partial_inbound"
      : "purchased";
  await connection.execute("UPDATE purchase_orders SET status = ? WHERE id = ? AND status != 'cancelled'", [status, Number(orderId)]);
}

export async function purchaseOrdersMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim();
  const params = [];
  const having = [];
  if (searchText) {
    const like = `%${searchText.toLowerCase()}%`;
    having.push("(LOWER(COALESCE(po.order_no, '')) LIKE ? OR LOWER(COALESCE(pe.name, '')) LIKE ? OR LOWER(COALESCE(product_names, '')) LIKE ? OR LOWER(COALESCE(product_codes, '')) LIKE ? OR LOWER(COALESCE(mapped_skus, '')) LIKE ? OR LOWER(COALESCE(po.note, '')) LIKE ?)");
    params.push(like, like, like, like, like, like);
  }
  const havingSql = having.length ? `HAVING ${having.join(" AND ")}` : "";
  const selectSql = `
    SELECT po.id, po.order_no, po.created_by_person_id, po.status, po.note,
      po.created_at, po.purchased_at, po.cancelled_at,
      pe.name AS creator_name,
      COUNT(poi.id) AS item_count,
      COALESCE(SUM(poi.actual_quantity), SUM(poi.requested_quantity), po.total_quantity, 0) AS total_quantity,
      COALESCE(SUM(poi.amount + COALESCE(poi.shipping_amount, 0)), po.total_amount, 0) AS total_amount,
      GROUP_CONCAT(p.name SEPARATOR '||') AS product_names,
      GROUP_CONCAT(CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0')) END SEPARATOR '||') AS product_codes,
      GROUP_CONCAT(COALESCE(p.image_url, '') SEPARATOR '||') AS product_image_urls,
      GROUP_CONCAT(COALESCE(skus.skus, '') SEPARATOR '||') AS mapped_skus
    FROM purchase_orders po
    LEFT JOIN people pe ON pe.id = po.created_by_person_id
    LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    LEFT JOIN products p ON p.id = poi.product_id
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(ozon_sku SEPARATOR ', ') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
    WHERE po.status != 'cancelled'
    GROUP BY po.id
    ${havingSql}
  `;
  if (!paged) {
    return await mysqlQuery(`
      ${selectSql}
      ORDER BY po.created_at DESC, po.id DESC
    `, params);
  }
  const offset = (page - 1) * pageSize;
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`SELECT COUNT(*) AS total FROM (${selectSql}) purchase_order_rows`, params),
    mysqlQuery(`
      ${selectSql}
      ORDER BY po.created_at DESC, po.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset])
  ]);
  return {
    rows,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

export async function purchaseOrderDetailMysql(id) {
  ensureMysqlCutoverEnabled();
  const orderId = Number(id);
  const order = await mysqlQueryOne(
    "SELECT po.*, pe.name AS creator_name FROM purchase_orders po LEFT JOIN people pe ON pe.id = po.created_by_person_id WHERE po.id = ?",
    [orderId]
  );
  if (!order) return null;

  const items = await mysqlQuery(`
    SELECT poi.*,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS product_code,
      p.name AS product_name, p.image_url AS product_image_url,
      COALESCE(skus.skus, '') AS mapped_skus
    FROM purchase_order_items poi
    JOIN products p ON p.id = poi.product_id
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(ozon_sku SEPARATOR ', ') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
    WHERE poi.purchase_order_id = ?
    ORDER BY poi.id
  `, [orderId]);

  const requests = await mysqlQuery(`
    SELECT pr.*, pe.name AS person_name,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS product_code,
      p.name AS product_name
    FROM procurement_requests pr
    JOIN products p ON p.id = pr.product_id
    LEFT JOIN people pe ON pe.id = pr.person_id
    WHERE pr.purchase_order_id = ?
    ORDER BY pr.created_at
  `, [orderId]);

  return { order, items, requests };
}

export async function pendingInboundItemsMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT ir.id AS inbound_record_id, ir.quantity AS expected_quantity, ir.status AS inbound_status,
      ir.note AS inbound_note, ir.qc_status, ir.amount, ir.shipping_amount, ir.unit_cost, ir.purchase_url,
      ir.created_at AS inbound_created_at, ir.approved_at AS inbound_approved_at,
      po.id AS purchase_order_id, po.order_no, po.created_at AS order_created_at, po.purchased_at,
      poi.id AS purchase_order_item_id, poi.inbound_quantity, poi.actual_quantity,
      (poi.actual_quantity - poi.inbound_quantity) AS remaining_quantity,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS product_code,
      p.id AS product_id, p.name AS product_name, p.image_url AS product_image_url,
      COALESCE(skus.skus, '') AS mapped_skus
    FROM inbound_records ir
    JOIN purchase_order_items poi ON poi.id = ir.purchase_order_item_id
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    JOIN products p ON p.id = poi.product_id
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(ozon_sku SEPARATOR ', ') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
    WHERE ir.status = 'pending_arrival'
    ORDER BY po.created_at DESC, ir.id DESC
  `);
}

export async function createProcurementRequestMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const personId = await resolvePersonIdOrFirstMysql(body.person_id);
  const result = await mysqlExecute(`
    INSERT INTO procurement_requests
    (product_id, person_id, quantity, amount, shipping_amount, purchase_url, approval_status, status, needed_by, note, urgency, source_type, supplier_id)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', 'pending', ?, ?, ?, ?, ?)
  `, [
    Number(body.product_id),
    personId,
    Number(body.quantity || 1),
    Number(body.amount || 0),
    Number(body.shipping_amount || 0),
    body.purchase_url || "",
    body.needed_by || null,
    body.note || "",
    body.urgency || "normal",
    body.source_type || "1688",
    nullableInteger(body.supplier_id)
  ]);
  return { id: Number(result.insertId) };
}

export async function updateProcurementRequestMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const requestId = Number(id);
  const existing = await mysqlQueryOne("SELECT id FROM procurement_requests WHERE id = ?", [requestId]);
  if (!existing) throw new Error("Procurement request not found");
  const personId = await resolvePersonIdOrFirstMysql(body.person_id);
  await mysqlExecute(`
    UPDATE procurement_requests SET product_id = ?, person_id = ?, quantity = ?, amount = ?,
      shipping_amount = ?, purchase_url = ?, approval_status = ?, status = ?, needed_by = ?, note = ?, urgency = ?, source_type = ?, supplier_id = ?,
      cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, CURRENT_TIMESTAMP) ELSE cancelled_at END
    WHERE id = ?
  `, [
    Number(body.product_id),
    personId,
    Number(body.quantity || 1),
    Number(body.amount || 0),
    Number(body.shipping_amount || 0),
    body.purchase_url || "",
    body.approval_status || "submitted",
    body.status || "pending",
    body.needed_by || null,
    body.note || "",
    body.urgency || "normal",
    body.source_type || "1688",
    nullableInteger(body.supplier_id),
    body.status || "pending",
    requestId
  ]);
  return { ok: true };
}

export async function submitProcurementRequestsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const ids = [...new Set((body.request_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error("Please select procurement requests to submit");
  const placeholders = ids.map(() => "?").join(",");
  const existing = await mysqlQuery(`SELECT id, status FROM procurement_requests WHERE id IN (${placeholders})`, ids);
  if (existing.length !== ids.length) throw new Error("Some procurement requests no longer exist. Please refresh and try again.");
  const invalid = existing.filter((row) => row.status !== "pending");
  if (invalid.length) throw new Error("Only requests waiting for confirmation can be submitted");
  await mysqlExecute(`
    UPDATE procurement_requests
    SET status = 'submitted', approval_status = 'submitted'
    WHERE id IN (${placeholders})
  `, ids);
  return { ok: true, count: ids.length };
}

export async function deleteProcurementRequestMysql(id) {
  ensureMysqlCutoverEnabled();
  const requestId = Number(id);
  const request = await mysqlQueryOne("SELECT * FROM procurement_requests WHERE id = ?", [requestId]);
  if (!request) throw new Error("Procurement request not found");
  if (!["pending", "submitted", "cancelled"].includes(request.status)) {
    throw new Error("Only unpurchased procurement requests can be deleted");
  }
  await mysqlExecute("DELETE FROM procurement_requests WHERE id = ?", [requestId]);
  return { ok: true };
}

export async function mergeProcurementRequestsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const ids = [...new Set((body.request_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error("Please select procurement requests to merge");
  const placeholders = ids.map(() => "?").join(",");
  return await withMysqlTransaction(async (connection) => {
    const [requests] = await connection.query(`
      SELECT * FROM procurement_requests
      WHERE id IN (${placeholders}) AND status = 'submitted'
      FOR UPDATE
    `, ids);
    if (requests.length !== ids.length) throw new Error("Some procurement requests were already processed. Please refresh and try again.");
    const orderNo = await nextPurchaseOrderNoMysql(connection);
    const personId = await resolvePersonIdOrFirstMysql(body.person_id, connection);
    const grouped = new Map();
    for (const request of requests) {
      const productId = Number(request.product_id);
      const item = grouped.get(productId) || {
        product_id: productId,
        requested_quantity: 0,
        amount: 0,
        shipping_amount: 0,
        purchase_url: request.purchase_url || "",
        note: ""
      };
      item.requested_quantity += Number(request.quantity || 0);
      item.amount += Number(request.amount || 0);
      item.shipping_amount += Number(request.shipping_amount || 0);
      if (!item.purchase_url && request.purchase_url) item.purchase_url = request.purchase_url;
      item.note = [item.note, request.note].filter(Boolean).join("; ");
      grouped.set(productId, item);
    }
    const totalQuantity = [...grouped.values()].reduce((sum, item) => sum + item.requested_quantity, 0);
    const totalAmount = [...grouped.values()].reduce((sum, item) => sum + item.amount + item.shipping_amount, 0);
    const [orderResult] = await connection.execute(`
      INSERT INTO purchase_orders (order_no, created_by_person_id, status, total_quantity, total_amount, note)
      VALUES (?, ?, 'pending_purchase', ?, ?, ?)
    `, [orderNo, personId, totalQuantity, totalAmount, body.note || ""]);
    const orderId = Number(orderResult.insertId);
    for (const item of grouped.values()) {
      await connection.execute(`
        INSERT INTO purchase_order_items
        (purchase_order_id, product_id, requested_quantity, actual_quantity, unit_cost, amount, shipping_amount, purchase_url, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_purchase', ?)
      `, [
        orderId,
        item.product_id,
        item.requested_quantity,
        item.requested_quantity,
        item.requested_quantity ? (item.amount + item.shipping_amount) / item.requested_quantity : 0,
        item.amount,
        item.shipping_amount,
        item.purchase_url,
        item.note
      ]);
    }
    await connection.execute(`
      UPDATE procurement_requests
      SET status = 'merged', approval_status = 'merged', purchase_order_id = ?, merged_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `, [orderId, ...ids]);
    return { id: orderId, order_no: orderNo };
  });
}

export async function confirmPurchaseOrderMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const orderId = Number(id);
  return await withMysqlTransaction(async (connection) => {
    const order = await mysqlConnectionQueryOne(connection, "SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE", [orderId]);
    if (!order) throw new Error("Purchase order not found");
    if (!["pending_purchase", "purchased"].includes(order.status)) throw new Error("Current purchase order status cannot be confirmed as purchased");
    const [items] = await connection.query("SELECT * FROM purchase_order_items WHERE purchase_order_id = ? FOR UPDATE", [orderId]);
    const personId = await resolvePersonIdOrFirstMysql(body.person_id, connection);
    const overrides = new Map((body.items || []).map((item) => [Number(item.id), item]));
    let totalQuantity = 0;
    let totalAmount = 0;
    for (const item of items) {
      const input = overrides.get(Number(item.id)) || {};
      const actualQuantity = Math.max(0, Number(input.actual_quantity ?? item.actual_quantity ?? item.requested_quantity));
      const amount = Number(input.amount ?? (input.unit_cost != null ? Number(input.unit_cost) * actualQuantity : item.amount));
      const shippingAmount = Number(input.shipping_amount ?? item.shipping_amount ?? 0);
      const unitCost = actualQuantity ? (amount + shippingAmount) / actualQuantity : 0;
      const purchaseUrl = input.purchase_url ?? item.purchase_url ?? "";
      const note = input.note ?? item.note ?? "";
      await connection.execute(`
        UPDATE purchase_order_items
        SET actual_quantity = ?, unit_cost = ?, amount = ?, shipping_amount = ?, purchase_url = ?, note = ?, status = 'purchased'
        WHERE id = ?
      `, [actualQuantity, unitCost, amount, shippingAmount, purchaseUrl, note, item.id]);
      const exists = await mysqlConnectionQueryOne(
        connection,
        "SELECT id FROM inbound_records WHERE purchase_order_item_id = ? AND status = 'pending_arrival' LIMIT 1",
        [item.id]
      );
      if (!exists && actualQuantity > 0) {
        await connection.execute(`
          INSERT INTO inbound_records
          (product_id, person_id, quantity, amount, unit_cost, shipping_amount, purchase_url, status, note, purchase_order_id, purchase_order_item_id, qc_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_arrival', ?, ?, ?, 'pending')
        `, [item.product_id, personId, actualQuantity, amount, unitCost, shippingAmount, purchaseUrl, note, orderId, item.id]);
      }
      totalQuantity += actualQuantity;
      totalAmount += amount + shippingAmount;
    }
    await connection.execute(`
      UPDATE purchase_orders
      SET status = 'purchased', total_quantity = ?, total_amount = ?, purchased_at = CURRENT_TIMESTAMP, note = COALESCE(NULLIF(?, ''), note)
      WHERE id = ?
    `, [totalQuantity, totalAmount, body.note || "", orderId]);
    await connection.execute(`
      UPDATE procurement_requests
      SET status = 'purchased', approval_status = 'purchased'
      WHERE purchase_order_id = ? AND status = 'merged'
    `, [orderId]);
    return { ok: true };
  });
}

export async function cancelPurchaseOrderMysql(id) {
  ensureMysqlCutoverEnabled();
  const orderId = Number(id);
  return await withMysqlTransaction(async (connection) => {
    await connection.execute("UPDATE purchase_orders SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);
    await connection.execute("UPDATE purchase_order_items SET status = 'cancelled' WHERE purchase_order_id = ?", [orderId]);
    await connection.execute(`
      UPDATE procurement_requests
      SET status = 'submitted', approval_status = 'submitted', purchase_order_id = NULL, merged_at = NULL
      WHERE purchase_order_id = ? AND status = 'merged'
    `, [orderId]);
    return { ok: true };
  });
}

export async function updatePurchaseOrderMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const orderId = Number(id);
  return await withMysqlTransaction(async (connection) => {
    const order = await mysqlConnectionQueryOne(connection, "SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE", [orderId]);
    if (!order) throw new Error("Purchase order not found");
    await connection.execute(`
      UPDATE purchase_orders SET note = COALESCE(NULLIF(?, ''), note), total_amount = ?
      WHERE id = ?
    `, [body.note || "", Number(body.total_amount ?? order.total_amount ?? 0), orderId]);

    if (Array.isArray(body.items)) {
      for (const item of body.items) {
        const itemId = Number(item.id);
        const existingItem = await mysqlConnectionQueryOne(
          connection,
          "SELECT * FROM purchase_order_items WHERE id = ? AND purchase_order_id = ? FOR UPDATE",
          [itemId, orderId]
        );
        if (!existingItem) continue;
        const actualQty = Number(item.actual_quantity ?? existingItem.actual_quantity ?? 0);
        const amount = Number(item.amount ?? existingItem.amount ?? 0);
        const shippingAmount = Number(item.shipping_amount ?? existingItem.shipping_amount ?? 0);
        const unitCost = actualQty ? (amount + shippingAmount) / actualQty : 0;
        await connection.execute(`
          UPDATE purchase_order_items
          SET actual_quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?, purchase_url = ?, note = ?
          WHERE id = ?
        `, [actualQty, amount, shippingAmount, unitCost, item.purchase_url || existingItem.purchase_url || "", item.note || existingItem.note || "", itemId]);

        const inbound = await mysqlConnectionQueryOne(
          connection,
          "SELECT * FROM inbound_records WHERE purchase_order_item_id = ? AND status = 'pending_arrival' LIMIT 1",
          [itemId]
        );
        if (inbound) {
          await connection.execute(`
            UPDATE inbound_records
            SET quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?, purchase_url = ?, note = ?
            WHERE id = ?
          `, [actualQty, amount, shippingAmount, unitCost, item.purchase_url || inbound.purchase_url || "", item.note || inbound.note || "", inbound.id]);
        }
      }
    }
    return { ok: true };
  });
}

export async function deletePurchaseOrderMysql(id) {
  ensureMysqlCutoverEnabled();
  const orderId = Number(id);
  return await withMysqlTransaction(async (connection) => {
    const order = await mysqlConnectionQueryOne(connection, "SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE", [orderId]);
    if (!order) throw new Error("Purchase order not found");
    const [items] = await connection.query("SELECT * FROM purchase_order_items WHERE purchase_order_id = ?", [orderId]);
    for (const item of items) {
      await connection.execute("DELETE FROM inbound_records WHERE purchase_order_item_id = ? AND status = 'pending_arrival'", [item.id]);
      const [approvedInbound] = await connection.query(
        "SELECT * FROM inbound_records WHERE purchase_order_item_id = ? AND status = 'approved'",
        [item.id]
      );
      for (const inbound of approvedInbound) {
        await deleteInboundInventoryMovementMysql(connection, inbound.id, inbound.product_id);
      }
    }
    await connection.execute(`
      UPDATE procurement_requests
      SET status = 'submitted', approval_status = 'submitted', purchase_order_id = NULL, merged_at = NULL
      WHERE purchase_order_id = ? AND status = 'merged'
    `, [orderId]);
    await connection.execute("DELETE FROM purchase_order_items WHERE purchase_order_id = ?", [orderId]);
    await connection.execute("DELETE FROM purchase_orders WHERE id = ?", [orderId]);
    return { ok: true };
  });
}

export async function createInboundRecordMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  return await withMysqlTransaction(async (connection) => {
    const quantity = Number(body.quantity || 0);
    const amount = Number(body.amount || 0);
    const shippingAmount = Number(body.shipping_amount || 0);
    const unitCost = quantity ? (amount + shippingAmount) / quantity : Number(body.unit_cost || 0);
    const status = body.status || "pending_arrival";
    const personId = await resolvePersonIdOrFirstMysql(body.person_id, connection);
    const [result] = await connection.execute(`
      INSERT INTO inbound_records (product_id, person_id, quantity, amount, unit_cost, shipping_amount, purchase_url, status, note, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      Number(body.product_id),
      personId,
      quantity,
      amount,
      unitCost,
      shippingAmount,
      body.purchase_url || "",
      status,
      body.note || "",
      status === "approved" ? normalizeMysqlDateTime(new Date()) : null
    ]);
    const inboundId = Number(result.insertId);
    if (status === "approved") {
      await postInventoryMysql(connection, {
        product_id: body.product_id,
        owner_person_id: personId,
        source_type: "purchase_inbound",
        source_ref: `inbound_${inboundId}`,
        quantity_delta: quantity,
        unit_cost: unitCost,
        amount: amount + shippingAmount,
        note: body.note
      });
    }
    return { id: inboundId };
  });
}

export async function updateInboundRecordMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const inboundId = Number(id);
  return await withMysqlTransaction(async (connection) => {
    const existing = await mysqlConnectionQueryOne(connection, "SELECT * FROM inbound_records WHERE id = ? FOR UPDATE", [inboundId]);
    if (!existing) throw new Error("Inbound record not found");
    const productId = Number(body.product_id ?? existing.product_id);
    const personId = await resolvePersonIdOrFirstMysql(body.person_id ?? existing.person_id, connection);
    const quantity = Number(body.quantity ?? existing.quantity ?? 0);
    const amount = Number(body.amount ?? existing.amount ?? 0);
    const shippingAmount = Number(body.shipping_amount ?? existing.shipping_amount ?? 0);
    const unitCost = quantity ? (amount + shippingAmount) / quantity : Number(body.unit_cost ?? existing.unit_cost ?? 0);
    const status = body.status || "pending_arrival";
    await connection.execute(`
      UPDATE inbound_records SET product_id = ?, person_id = ?, quantity = ?, amount = ?, unit_cost = ?,
        shipping_amount = ?, purchase_url = ?, status = ?, note = ?, qc_status = ?,
        approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE approved_at END
      WHERE id = ?
    `, [
      productId,
      personId,
      quantity,
      amount,
      unitCost,
      shippingAmount,
      body.purchase_url || "",
      status,
      body.note || "",
      body.qc_status || existing.qc_status || "pending",
      status,
      normalizeMysqlDateTime(new Date()),
      inboundId
    ]);

    if (existing.status === "approved" && status === "approved") {
      await upsertInboundInventoryMovementMysql(connection, inboundId, {
        product_id: productId,
        owner_person_id: personId,
        quantity,
        unitCost,
        amount: amount + shippingAmount,
        note: body.note
      });
      const diff = quantity - Number(existing.quantity || 0);
      if (existing.purchase_order_item_id && diff) {
        await connection.execute(`
          UPDATE purchase_order_items
          SET inbound_quantity = GREATEST(0, inbound_quantity + ?),
            status = CASE WHEN GREATEST(0, inbound_quantity + ?) >= actual_quantity THEN 'inbound_done' ELSE 'partial_inbound' END
          WHERE id = ?
        `, [diff, diff, existing.purchase_order_item_id]);
        await refreshPurchaseOrderStatusMysql(connection, existing.purchase_order_id);
      }
    } else if (existing.status !== "approved" && status === "approved") {
      await postInventoryMysql(connection, {
        product_id: productId,
        owner_person_id: personId,
        source_type: "purchase_inbound",
        source_ref: `inbound_${inboundId}`,
        quantity_delta: quantity,
        unit_cost: unitCost,
        amount: amount + shippingAmount,
        note: body.note
      });
      if (existing.purchase_order_item_id) {
        await connection.execute(`
          UPDATE purchase_order_items
          SET inbound_quantity = inbound_quantity + ?,
            status = CASE WHEN inbound_quantity + ? >= actual_quantity THEN 'inbound_done' ELSE 'partial_inbound' END
          WHERE id = ?
        `, [quantity, quantity, existing.purchase_order_item_id]);
        await refreshPurchaseOrderStatusMysql(connection, existing.purchase_order_id);
      }
    } else if (existing.status === "approved" && status !== "approved") {
      await deleteInboundInventoryMovementMysql(connection, inboundId, existing.product_id);
      if (existing.purchase_order_item_id) {
        await connection.execute(`
          UPDATE purchase_order_items
          SET inbound_quantity = GREATEST(0, inbound_quantity - ?),
            status = CASE WHEN GREATEST(0, inbound_quantity - ?) <= 0 THEN 'purchased' ELSE 'partial_inbound' END
          WHERE id = ?
        `, [Number(existing.quantity || 0), Number(existing.quantity || 0), existing.purchase_order_item_id]);
        await refreshPurchaseOrderStatusMysql(connection, existing.purchase_order_id);
      }
    }
    return { ok: true };
  });
}

export async function deleteInboundRecordMysql(id) {
  ensureMysqlCutoverEnabled();
  const inboundId = Number(id);
  return await withMysqlTransaction(async (connection) => {
    const existing = await mysqlConnectionQueryOne(connection, "SELECT * FROM inbound_records WHERE id = ? FOR UPDATE", [inboundId]);
    if (!existing) throw new Error("Inbound record not found");
    if (existing.status === "approved") {
      await deleteInboundInventoryMovementMysql(connection, inboundId, existing.product_id);
      if (existing.purchase_order_item_id) {
        await connection.execute(`
          UPDATE purchase_order_items
          SET inbound_quantity = GREATEST(0, inbound_quantity - ?),
            status = CASE WHEN GREATEST(0, inbound_quantity - ?) <= 0 THEN 'purchased' ELSE 'partial_inbound' END
          WHERE id = ?
        `, [Number(existing.quantity || 0), Number(existing.quantity || 0), existing.purchase_order_item_id]);
        await refreshPurchaseOrderStatusMysql(connection, existing.purchase_order_id);
      }
    }
    await connection.execute("DELETE FROM inbound_records WHERE id = ?", [inboundId]);
    return { ok: true };
  });
}

export async function createInventoryMovementMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  return await withMysqlTransaction(async (connection) => {
    const id = await postInventoryMysql(connection, body);
    return { id };
  });
}

export async function rawOzonOrdersMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT r.*, s.name AS shop_name
    FROM ozon_orders_raw r
    JOIN shops s ON s.id = r.store_id
    ORDER BY r.fetched_at DESC, r.id DESC
    LIMIT 200
  `);
}

export async function profitItemsMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT opi.*, o.posting_number, oi.ozon_sku, p.code AS product_code, p.name AS product_name, s.name AS shop_name
    FROM order_profit_items opi
    JOIN order_items oi ON oi.id = opi.order_item_id
    JOIN orders o ON o.id = oi.order_id
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    ORDER BY opi.updated_at DESC, opi.id DESC
    LIMIT 300
  `);
}

export async function orderExceptionsMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT oe.*, s.name AS shop_name, p.code AS product_code, p.name AS product_name
    FROM order_exceptions oe
    LEFT JOIN shops s ON s.id = oe.store_id
    LEFT JOIN order_items oi ON oi.id = oe.order_item_id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    ORDER BY CASE WHEN oe.status = 'open' THEN 1 ELSE 0 END DESC, oe.created_at DESC, oe.id DESC
    LIMIT 300
  `);
}

function profitDateWhereMysql(alias = "o", from = "", to = "") {
  const where = [];
  const params = [];
  if (from) {
    where.push(`${chinaDateSqlMysql(`${alias}.ordered_at`)} >= ?`);
    params.push(String(from).slice(0, 10));
  }
  if (to) {
    where.push(`${chinaDateSqlMysql(`${alias}.ordered_at`)} <= ?`);
    params.push(String(to).slice(0, 10));
  }
  return {
    whereSql: where.length ? `AND ${where.join(" AND ")}` : "",
    params
  };
}

function normalizeProfitSummaryMysql(row = {}) {
  const revenue = Number(row.revenue || 0);
  const profit = Number(row.profit || 0);
  const returnRevenue = Number(row.return_revenue || 0);
  return {
    order_count: Number(row.order_count || 0),
    item_quantity: Number(row.item_quantity || 0),
    revenue: roundMoneyMysql(revenue),
    profit: roundMoneyMysql(profit),
    estimated_profit: roundMoneyMysql(row.estimated_profit || profit),
    accrued_profit: roundMoneyMysql(row.accrued_profit || 0),
    accrued_order_count: Number(row.accrued_order_count || 0),
    pending_profit: roundMoneyMysql(row.pending_profit || 0),
    pending_order_count: Number(row.pending_order_count || 0),
    cancelled_revenue: roundMoneyMysql(row.cancelled_revenue || 0),
    cancelled_orders: Number(row.cancelled_orders || 0),
    return_orders: Number(row.return_orders || 0),
    return_quantity: Number(row.return_quantity || 0),
    return_revenue: roundMoneyMysql(returnRevenue),
    event_cancelled_orders: Number(row.event_cancelled_orders || row.cancelled_orders || 0),
    event_return_orders: Number(row.event_return_orders || row.return_orders || 0),
    event_return_revenue: roundMoneyMysql(returnRevenue),
    effective_revenue: roundMoneyMysql(revenue - returnRevenue),
    effective_orders: Number(row.order_count || 0) - Number(row.cancelled_orders || 0),
    profit_margin: revenue ? profit / revenue : 0
  };
}

async function profitSummaryOverviewMysql(from = "", to = "") {
  const dateFilter = profitDateWhereMysql("o", from, to);
  const row = await mysqlQueryOne(`
    SELECT
      COUNT(DISTINCT CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0) ELSE 0 END), 0) AS profit,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' AND oi.settlement_state = 'accrued' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0) ELSE 0 END), 0) AS accrued_profit,
      COUNT(DISTINCT CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' AND oi.settlement_state = 'accrued' THEN o.id END) AS accrued_order_count,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' AND COALESCE(oi.settlement_state, '') != 'accrued' THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END), 0) AS pending_profit,
      COUNT(DISTINCT CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' AND COALESCE(oi.settlement_state, '') != 'accrued' THEN o.id END) AS pending_order_count,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN LOWER(COALESCE(o.status, '')) LIKE '%cancel%' THEN o.id END) AS cancelled_orders,
      COUNT(DISTINCT CASE WHEN LOWER(COALESCE(o.status, '')) LIKE '%return%' OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%' THEN o.id END) AS return_orders,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) LIKE '%return%' OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%' THEN oi.quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) LIKE '%return%' OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%' THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS return_revenue
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE 1=1 ${dateFilter.whereSql}
  `, dateFilter.params);
  return normalizeProfitSummaryMysql(row || {});
}

async function profitTrendRowsMysql(from, to, groupExpr, labelAlias = "date") {
  const dateFilter = profitDateWhereMysql("o", from, to);
  return await mysqlQuery(`
    SELECT ${groupExpr} AS ${labelAlias},
      COUNT(DISTINCT CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0) ELSE 0 END), 0) AS profit,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS cancelled_revenue
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE 1=1 ${dateFilter.whereSql}
    GROUP BY ${groupExpr}
    ORDER BY ${groupExpr}
  `, dateFilter.params);
}

export async function profitSummaryMysql(dateFrom = "", dateTo = {}) {
  ensureMysqlCutoverEnabled();
  const from = String(dateFrom || "").slice(0, 10);
  const to = String(dateTo || "").slice(0, 10);
  const [summary, byShop, bySku, byProduct] = await Promise.all([
    profitSummaryOverviewMysql(from, to),
    profitRankingMysql({ dimension: "shop", from, to, page: 1, pageSize: 200 }),
    profitRankingMysql({ dimension: "sku", from, to, page: 1, pageSize: 200 }),
    profitRankingMysql({ dimension: "product", from, to, page: 1, pageSize: 200 })
  ]);
  return {
    from,
    to,
    summary,
    byShop: byShop.rows,
    bySku: bySku.rows,
    byProduct: byProduct.rows
  };
}

const AFTERSALE_BUCKETS_MYSQL = [
  { key: "pre_fulfillment_cancel", label: "履约前取消", hint: "未发生实质履约损失，销售额不计入有效销售，损失默认为 0。" },
  { key: "rejected_unclaimed", label: "拒收/未取", hint: "买家拒签、未取、配送失败或清关失败，至少核对商品成本、国际运费和收单费。" },
  { key: "unsuitable_wrong_damaged", label: "不合适/发错货/破损", hint: "商品不合适、错发、破损等售后责任，核对商品成本、国内运费、国际运费和平台扣费。" },
  { key: "quality_issue", label: "质量问题", hint: "质量问题或售后退货风险最高，需要核对佣金、售后平台费和完整履约成本。" },
  { key: "platform_document_issue", label: "平台质检/描述核验", hint: "平台描述核验、护照缺失、发运登记失败等单独列示，默认不并入普通退货。" }
];

const AFTERSALE_BUCKET_LABELS_MYSQL = Object.fromEntries(AFTERSALE_BUCKETS_MYSQL.map((item) => [item.key, item.label]));
const AFTERSALE_BUCKET_HINTS_MYSQL = Object.fromEntries(AFTERSALE_BUCKETS_MYSQL.map((item) => [item.key, item.hint]));
const AFTERSALE_LOSS_POLICY_MYSQL = {
  pre_fulfillment_cancel: "0",
  rejected_unclaimed: "商品成本 + 国际运费 + 收单费",
  unsuitable_wrong_damaged: "商品成本 + 国内运费 + 国际运费 + 收单费",
  quality_issue: "商品成本 + 国内运费 + 国际运费 + 收单费 + 佣金/售后平台费",
  platform_document_issue: "待核实，按实际财务扣费或人工确认口径"
};

function normalizeAftersaleRowMysql(row = {}) {
  const outcomeType = classifyOrderOutcome(row);
  const cancellation = describeCancellation({ ...row, outcome_type: outcomeType });
  const outcome = String(outcomeType || "").trim();
  const profile = String(row.loss_profile_code || cancellation.loss_profile_code || "").trim();
  const reasonCode = String(row.cancel_reason_id || row.cancel_reason_code || "").trim().toLowerCase();
  const reasonText = [
    row.cancel_reason,
    row.raw_cancellation_reason,
    row.reason_label,
    row.reason_group_label,
    row.cancel_type,
    row.cancel_initiator
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  let bucket = "pre_fulfillment_cancel";
  if (outcome === "cancelled_pre_fulfillment") {
    bucket = "pre_fulfillment_cancel";
  } else if (
    reasonCode === "quality_inspection"
    || reasonCode === "missing_passport"
    || reasonCode === "shipment_registration_failed"
    || reasonText.includes("quality inspection")
    || reasonText.includes("inspection")
    || reasonText.includes("passport")
    || reasonText.includes("护照")
    || reasonText.includes("质检")
  ) {
    bucket = "platform_document_issue";
  } else if (reasonCode === "aftersale_quality_issue" || profile === "commission_purchase_collecting_international" || reasonText.includes("quality")) {
    bucket = "quality_issue";
  } else if (
    reasonCode === "item_unsuitable"
    || reasonCode === "wrong_item"
    || reasonCode === "damaged_in_delivery"
    || profile === "purchase_collecting_international"
    || reasonText.includes("not suitable")
    || reasonText.includes("wrong item")
    || reasonText.includes("damaged")
    || reasonText.includes("不合适")
    || reasonText.includes("错发")
    || reasonText.includes("破损")
  ) {
    bucket = "unsuitable_wrong_damaged";
  } else if (outcome === "rejected_unclaimed" || outcome === "after_delivery_return") {
    bucket = "rejected_unclaimed";
  }

  const sale = Number(row.sale_amount_cny || row.sale_amount || 0);
  const purchase = Number(row.purchase_cost_cny || 0);
  const domestic = Number(row.domestic_shipping_cny || 0);
  const international = Number(row.international_shipping_cny || 0);
  const collecting = Number(row.collecting_fee_cny || row.shipping_fee_cny || 0);
  const commission = Number(row.commission_fee_cny || 0);
  const returnLoss = Number(row.return_loss_cny || row.aftersale_loss || 0);

  let estimated = 0;
  if (bucket === "rejected_unclaimed") {
    estimated = purchase + international + collecting;
  } else if (bucket === "unsuitable_wrong_damaged") {
    estimated = purchase + domestic + international + collecting;
  } else if (bucket === "quality_issue") {
    estimated = purchase + domestic + international + collecting + commission + returnLoss;
  } else if (bucket === "platform_document_issue") {
    estimated = returnLoss;
  }

  return {
    ...row,
    ...cancellation,
    outcome_type: outcomeType,
    bucket,
    bucket_label: AFTERSALE_BUCKET_LABELS_MYSQL[bucket] || bucket,
    bucket_hint: AFTERSALE_BUCKET_HINTS_MYSQL[bucket] || "",
    loss_policy: AFTERSALE_LOSS_POLICY_MYSQL[bucket] || "",
    sale_amount_cny: roundMoneyMysql(sale),
    estimated_loss_cny: roundMoneyMysql(estimated),
    actual_loss_cny: roundMoneyMysql(returnLoss),
    purchase_cost_cny: roundMoneyMysql(purchase),
    domestic_shipping_cny: roundMoneyMysql(domestic),
    international_shipping_cny: roundMoneyMysql(international),
    commission_fee_cny: roundMoneyMysql(commission),
    return_loss_cny: roundMoneyMysql(returnLoss),
    missing_cost: bucket !== "pre_fulfillment_cancel" && purchase <= 0.005 ? 1 : 0,
    missing_shipping: ["rejected_unclaimed", "unsuitable_wrong_damaged", "quality_issue"].includes(bucket) && international <= 0.005 ? 1 : 0,
    needs_review: bucket === "platform_document_issue" ? 1 : 0
  };
}

function aftersaleRelevantMysql(row = {}) {
  return ["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(String(row.outcome_type || ""))
    || Boolean(row.cancel_reason || row.cancel_reason_id || row.cancel_type || row.cancel_initiator);
}

async function aftersaleBaseRowsMysql(query = {}) {
  const from = String(query.from || query.dateFrom || "").slice(0, 10);
  const to = String(query.to || query.dateTo || "").slice(0, 10);
  const shopId = String(query.shopId || query.shop_id || "");
  const where = ["1=1"];
  const params = [];
  if (from) {
    where.push("DATE(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00')) >= ?");
    params.push(from);
  }
  if (to) {
    where.push("DATE(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00')) <= ?");
    params.push(to);
  }
  if (shopId && shopId !== "all" && Number.isFinite(Number(shopId))) {
    where.push("o.shop_id = ?");
    params.push(Number(shopId));
  }
  where.push(`(
    LOWER(COALESCE(o.status, '')) LIKE '%cancel%'
    OR LOWER(COALESCE(o.status, '')) LIKE '%return%'
    OR LOWER(COALESCE(o.status, '')) LIKE '%reject%'
    OR LOWER(COALESCE(o.status, '')) LIKE '%not_accepted%'
    OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%'
    OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%'
    OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%reject%'
    OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%not_accepted%'
    OR LOWER(COALESCE(o.logistics_status, '')) LIKE '%cancel%'
    OR LOWER(COALESCE(o.logistics_status, '')) LIKE '%return%'
    OR LOWER(COALESCE(o.logistics_status, '')) LIKE '%reject%'
    OR LOWER(COALESCE(o.logistics_status, '')) LIKE '%not_accepted%'
    OR COALESCE(o.cancel_reason, '') != ''
    OR COALESCE(o.cancel_reason_id, '') != ''
    OR COALESCE(o.cancel_type, '') != ''
    OR COALESCE(o.cancel_initiator, '') != ''
  )`);
  const rows = await mysqlQuery(`
    SELECT
      o.id AS order_id,
      o.shop_id,
      s.name AS shop_name,
      o.posting_number,
      o.order_number,
      o.status,
      o.tracking_stage,
      o.logistics_status,
      o.ordered_at,
      o.delivered_at,
      o.accrued_at,
      o.cancel_reason,
      o.cancel_reason_id,
      o.cancel_initiator,
      o.cancel_type,
      o.cancelled_after_ship,
      oi.id AS order_item_id,
      oi.ozon_sku,
      oi.quantity,
      COALESCE(oi.ozon_name, op.name, p.name, oi.ozon_sku) AS item_name,
      COALESCE(oi.ozon_image_url, op.primary_image, op.image_url, p.image_url, '') AS image_url,
      COALESCE(p.id, 0) AS product_id,
      COALESCE(p.code, p.selection_id, '') AS product_code,
      COALESCE(p.name, '') AS product_name,
      COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) AS sale_amount_cny,
      COALESCE(opi.purchase_cost_cny, oi.frozen_purchase_cost * oi.quantity, 0) AS purchase_cost_cny,
      COALESCE(opi.domestic_shipping_cny, oi.frozen_domestic_shipping * oi.quantity, 0) AS domestic_shipping_cny,
      COALESCE(opi.international_shipping_cny, oi.frozen_international_shipping * oi.quantity, 0) AS international_shipping_cny,
      COALESCE(opi.commission_fee_cny, oi.estimated_commission, 0) AS commission_fee_cny,
      COALESCE(opi.ozon_service_fee_cny, oi.platform_fee_actual, 0) AS platform_fee_cny,
      COALESCE(opi.return_loss_cny, oi.aftersale_loss, 0) AS return_loss_cny,
      COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) AS profit_cny
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    WHERE ${where.join(" AND ")}
  `, params);
  return { rows, from, to, shopId };
}

export async function profitAftersalesMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const { rows, from, to, shopId } = await aftersaleBaseRowsMysql(query);
  const normalized = rows.map(normalizeAftersaleRowMysql).filter(aftersaleRelevantMysql);
  const buckets = new Map(AFTERSALE_BUCKETS_MYSQL.map((bucket) => [bucket.key, {
    key: bucket.key,
    label: bucket.label,
    hint: bucket.hint,
    loss_policy: AFTERSALE_LOSS_POLICY_MYSQL[bucket.key] || "",
    orderIds: new Set(),
    item_quantity: 0,
    sale_amount_cny: 0,
    estimated_loss_cny: 0,
    actual_loss_cny: 0,
    missing_cost_count: 0,
    missing_shipping_count: 0,
    needs_review_count: 0,
    sample_reason: ""
  }]));
  for (const row of normalized) {
    const target = buckets.get(row.bucket);
    if (!target) continue;
    target.orderIds.add(Number(row.order_id));
    target.item_quantity += Number(row.quantity || 0);
    target.sale_amount_cny += Number(row.sale_amount_cny || 0);
    target.estimated_loss_cny += Number(row.estimated_loss_cny || 0);
    target.actual_loss_cny += Number(row.actual_loss_cny || 0);
    target.missing_cost_count += Number(row.missing_cost || 0);
    target.missing_shipping_count += Number(row.missing_shipping || 0);
    target.needs_review_count += Number(row.needs_review || 0);
    if (!target.sample_reason && (row.reason_label || row.cancel_reason)) target.sample_reason = row.reason_label || row.cancel_reason;
  }
  const bucketRows = [...buckets.values()].map((row) => ({
    key: row.key,
    label: row.label,
    hint: row.hint,
    loss_policy: row.loss_policy,
    order_count: row.orderIds.size,
    item_quantity: row.item_quantity,
    sale_amount_cny: roundMoneyMysql(row.sale_amount_cny),
    estimated_loss_cny: roundMoneyMysql(row.estimated_loss_cny),
    actual_loss_cny: roundMoneyMysql(row.actual_loss_cny),
    missing_cost_count: row.missing_cost_count,
    missing_shipping_count: row.missing_shipping_count,
    needs_review_count: row.needs_review_count,
    sample_reason: row.sample_reason
  }));
  const totals = bucketRows.reduce((acc, row) => {
    acc.order_count += Number(row.order_count || 0);
    acc.item_quantity += Number(row.item_quantity || 0);
    acc.sale_amount_cny += Number(row.sale_amount_cny || 0);
    acc.estimated_loss_cny += Number(row.estimated_loss_cny || 0);
    acc.actual_loss_cny += Number(row.actual_loss_cny || 0);
    acc.missing_cost_count += Number(row.missing_cost_count || 0);
    acc.missing_shipping_count += Number(row.missing_shipping_count || 0);
    acc.needs_review_count += Number(row.needs_review_count || 0);
    return acc;
  }, { order_count: 0, item_quantity: 0, sale_amount_cny: 0, estimated_loss_cny: 0, actual_loss_cny: 0, missing_cost_count: 0, missing_shipping_count: 0, needs_review_count: 0 });
  return {
    from,
    to,
    shop_id: shopId || "all",
    buckets: bucketRows,
    totals: {
      ...totals,
      sale_amount_cny: roundMoneyMysql(totals.sale_amount_cny),
      estimated_loss_cny: roundMoneyMysql(totals.estimated_loss_cny),
      actual_loss_cny: roundMoneyMysql(totals.actual_loss_cny)
    },
    missing_alert: {
      count: totals.missing_cost_count + totals.missing_shipping_count,
      cost_count: totals.missing_cost_count,
      shipping_count: totals.missing_shipping_count,
      message: totals.missing_cost_count || totals.missing_shipping_count
        ? `售后订单存在 ${totals.missing_cost_count} 个成本缺失项、${totals.missing_shipping_count} 个国际运费缺失项，需要补齐后重算。`
        : ""
    }
  };
}

export async function profitAftersalesDetailsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const bucketFilter = String(query.bucket || query.type || "all").trim();
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.limit || 50), 1), 200);
  const { rows, from, to, shopId } = await aftersaleBaseRowsMysql(query);
  const normalized = rows.map(normalizeAftersaleRowMysql).filter(aftersaleRelevantMysql).filter((row) => bucketFilter === "all" || !bucketFilter || row.bucket === bucketFilter);
  const byOrder = new Map();
  for (const row of normalized) {
    const key = Number(row.order_id);
    const current = byOrder.get(key) || {
      order_id: key,
      shop_id: row.shop_id,
      shop_name: row.shop_name || "",
      posting_number: row.posting_number || "",
      order_number: row.order_number || "",
      status: row.status || "",
      tracking_stage: row.tracking_stage || "",
      logistics_status: row.logistics_status || "",
      ordered_at: row.ordered_at || "",
      cancel_reason: row.cancel_reason || "",
      cancel_initiator: row.cancel_initiator || "",
      cancel_type: row.cancel_type || "",
      outcome_type: row.outcome_type,
      bucket: row.bucket,
      bucket_label: row.bucket_label,
      reason_label: row.reason_label || "",
      reason_group_label: row.reason_group_label || "",
      loss_policy: row.loss_policy || "",
      image_url: row.image_url || "",
      sale_amount_cny: 0,
      estimated_loss_cny: 0,
      actual_loss_cny: 0,
      purchase_cost_cny: 0,
      domestic_shipping_cny: 0,
      international_shipping_cny: 0,
      commission_fee_cny: 0,
      missing_cost_count: 0,
      missing_shipping_count: 0,
      needs_review: 0,
      item_quantity: 0,
      item_names: [],
      skus: []
    };
    current.sale_amount_cny += Number(row.sale_amount_cny || 0);
    current.estimated_loss_cny += Number(row.estimated_loss_cny || 0);
    current.actual_loss_cny += Number(row.actual_loss_cny || 0);
    current.purchase_cost_cny += Number(row.purchase_cost_cny || 0);
    current.domestic_shipping_cny += Number(row.domestic_shipping_cny || 0);
    current.international_shipping_cny += Number(row.international_shipping_cny || 0);
    current.commission_fee_cny += Number(row.commission_fee_cny || 0);
    current.missing_cost_count += Number(row.missing_cost || 0);
    current.missing_shipping_count += Number(row.missing_shipping || 0);
    current.needs_review = current.needs_review || Number(row.needs_review || 0);
    current.item_quantity += Number(row.quantity || 0);
    if (row.item_name && !current.item_names.includes(row.item_name)) current.item_names.push(row.item_name);
    if (row.ozon_sku && !current.skus.includes(String(row.ozon_sku))) current.skus.push(String(row.ozon_sku));
    if (row.image_url && !current.image_url) current.image_url = row.image_url;
    byOrder.set(key, current);
  }
  const orderedRows = [...byOrder.values()].sort((left, right) => String(right.ordered_at || "").localeCompare(String(left.ordered_at || "")));
  const total = orderedRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const detailRows = orderedRows.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
    ...row,
    sale_amount_cny: roundMoneyMysql(row.sale_amount_cny),
    estimated_loss_cny: roundMoneyMysql(row.estimated_loss_cny),
    actual_loss_cny: roundMoneyMysql(row.actual_loss_cny),
    purchase_cost_cny: roundMoneyMysql(row.purchase_cost_cny),
    domestic_shipping_cny: roundMoneyMysql(row.domestic_shipping_cny),
    international_shipping_cny: roundMoneyMysql(row.international_shipping_cny),
    commission_fee_cny: roundMoneyMysql(row.commission_fee_cny),
    item_names: row.item_names.join(" / "),
    skus: row.skus.join(", ")
  }));
  return {
    from,
    to,
    shop_id: shopId || "all",
    bucket: bucketFilter || "all",
    rows: detailRows,
    total,
    page,
    page_size: pageSize,
    total_pages: totalPages
  };
}

function dateKeyMysql(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDaysMysql(date, days) {
  return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function monthStartMysql(date) {
  const [year, month] = dateKeyMysql(date).split("-");
  return new Date(`${year}-${month}-01T00:00:00+08:00`);
}

function yearStartMysql(date) {
  const [year] = dateKeyMysql(date).split("-");
  return new Date(`${year}-01-01T00:00:00+08:00`);
}

export async function profitDashboardSectionMysql(options = {}) {
  ensureMysqlCutoverEnabled();
  const section = String(options.section || "all").trim().toLowerCase() || "all";
  const anchor = options.date ? new Date(`${String(options.date).slice(0, 10)}T00:00:00+08:00`) : new Date();
  const today = dateKeyMysql(anchor);
  const yesterday = dateKeyMysql(addDaysMysql(anchor, -1));
  const currentMonthStart = dateKeyMysql(monthStartMysql(anchor));
  const [anchorYear, anchorMonth] = dateKeyMysql(anchor).split("-").map(Number);
  const lastMonthAnchor = new Date(anchorYear, anchorMonth - 2, 1);
  const lastMonthStart = dateKeyMysql(lastMonthAnchor);
  const lastMonthEnd = dateKeyMysql(addDaysMysql(monthStartMysql(anchor), -1));
  const currentQuarterStartMonth = Math.floor((anchorMonth - 1) / 3) * 3 + 1;
  const currentQuarterStart = dateKeyMysql(new Date(`${anchorYear}-${String(currentQuarterStartMonth).padStart(2, "0")}-01T00:00:00+08:00`));
  const currentYearStart = dateKeyMysql(yearStartMysql(anchor));

  if (section === "summary" || section === "all") {
    const ranges = {
      today: { from: today, to: today, summary: await profitSummaryOverviewMysql(today, today) },
      yesterday: { from: yesterday, to: yesterday, summary: await profitSummaryOverviewMysql(yesterday, yesterday) },
      currentMonth: { from: currentMonthStart, to: today, summary: await profitSummaryOverviewMysql(currentMonthStart, today) },
      lastMonth: { from: lastMonthStart, to: lastMonthEnd, summary: await profitSummaryOverviewMysql(lastMonthStart, lastMonthEnd) },
      currentQuarter: { from: currentQuarterStart, to: today, summary: await profitSummaryOverviewMysql(currentQuarterStart, today) },
      currentYear: { from: currentYearStart, to: today, summary: await profitSummaryOverviewMysql(currentYearStart, today) }
    };
    if (section === "summary") return { ranges };
    const dailyFrom = dateKeyMysql(addDaysMysql(anchor, -13));
    const previousDailyFrom = dateKeyMysql(addDaysMysql(anchor, -27));
    const previousDailyTo = dateKeyMysql(addDaysMysql(anchor, -14));
    const monthlyFrom = dateKeyMysql(new Date(anchorYear, anchorMonth - 12, 1));
    const [dailyTrend14, previousDailyTrend14, monthlyTrend12] = await Promise.all([
      profitTrendRowsMysql(dailyFrom, today, chinaDateKeySqlMysql("o.ordered_at"), "date"),
      profitTrendRowsMysql(previousDailyFrom, previousDailyTo, chinaDateKeySqlMysql("o.ordered_at"), "date"),
      profitTrendRowsMysql(monthlyFrom, today, "DATE_FORMAT(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00'), '%Y-%m')", "month")
    ]);
    return { ranges, dailyTrend14, previousDailyTrend14, monthlyTrend12 };
  }

  if (section === "daily-trend") {
    const dailyFrom = dateKeyMysql(addDaysMysql(anchor, -13));
    const previousDailyFrom = dateKeyMysql(addDaysMysql(anchor, -27));
    const previousDailyTo = dateKeyMysql(addDaysMysql(anchor, -14));
    const [dailyTrend14, previousDailyTrend14] = await Promise.all([
      profitTrendRowsMysql(dailyFrom, today, chinaDateKeySqlMysql("o.ordered_at"), "date"),
      profitTrendRowsMysql(previousDailyFrom, previousDailyTo, chinaDateKeySqlMysql("o.ordered_at"), "date")
    ]);
    return { dailyTrend14, previousDailyTrend14 };
  }

  if (section === "monthly-trend") {
    const monthlyFrom = dateKeyMysql(new Date(anchorYear, anchorMonth - 12, 1));
    return { monthlyTrend12: await profitTrendRowsMysql(monthlyFrom, today, "DATE_FORMAT(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00'), '%Y-%m')", "month") };
  }

  return {};
}

export async function profitRankingMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const dimension = String(query.dimension || "sku").toLowerCase();
  const page = Math.max(Number(query.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 200);
  const offset = (page - 1) * pageSize;
  const from = String(query.from || "").slice(0, 10);
  const to = String(query.to || "").slice(0, 10);
  const keyword = String(query.keyword || query.query || "").trim().toLowerCase();
  const sortBy = String(query.sortBy || query.sort_by || "profit");
  const sortOrder = String(query.sortOrder || query.sort_order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const dateFilter = profitDateWhereMysql("o", from, to);
  const params = [...dateFilter.params];
  const where = [];
  let selectFields = "";
  let groupFields = "";
  let joinSql = "";
  if (dimension === "shop") {
    selectFields = "s.id AS shop_id, s.name AS shop_name";
    groupFields = "s.id, s.name";
    joinSql = "JOIN shops s ON s.id = o.shop_id";
    if (keyword) {
      where.push("LOWER(COALESCE(s.name, '')) LIKE ?");
      params.push(`%${keyword}%`);
    }
  } else if (dimension === "product") {
    selectFields = "p.id AS product_id, MAX(p.code) AS product_code, MAX(p.name) AS product_name, MAX(p.image_url) AS image_url";
    groupFields = "p.id";
    joinSql = "LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id LEFT JOIN products p ON p.id = sm.product_id";
    if (keyword) {
      where.push("(LOWER(COALESCE(p.name, '')) LIKE ? OR LOWER(COALESCE(p.code, '')) LIKE ?)");
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
  } else {
    selectFields = "o.shop_id, MAX(s.name) AS shop_name, oi.ozon_sku, MAX(COALESCE(oi.ozon_name, sm.display_name, p.name, '')) AS product_name, MAX(COALESCE(p.image_url, '')) AS image_url";
    groupFields = "o.shop_id, oi.ozon_sku";
    joinSql = "JOIN shops s ON s.id = o.shop_id LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id LEFT JOIN products p ON p.id = sm.product_id";
    if (keyword) {
      where.push("(LOWER(COALESCE(oi.ozon_sku, '')) LIKE ? OR LOWER(COALESCE(oi.ozon_name, '')) LIKE ? OR LOWER(COALESCE(p.name, '')) LIKE ? OR LOWER(COALESCE(s.name, '')) LIKE ?)");
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
  }
  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  const baseSql = `
    SELECT ${selectFields},
      COUNT(DISTINCT o.id) AS order_count,
      COALESCE(SUM(oi.quantity), 0) AS quantity,
      COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue,
      COALESCE(SUM(COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0)), 0) AS profit,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.status, '')) LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS cancelled_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    ${joinSql}
    WHERE 1=1 ${dateFilter.whereSql} ${whereSql}
    GROUP BY ${groupFields}
  `;
  const sortable = new Set(["order_count", "quantity", "revenue", "profit", "cancelled_revenue"]);
  const orderField = sortable.has(sortBy) ? sortBy : "profit";
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`SELECT COUNT(*) AS total FROM (${baseSql}) ranking_rows`, params),
    mysqlQuery(`${baseSql} ORDER BY ${orderField} ${sortOrder} LIMIT ? OFFSET ?`, [...params, pageSize, offset])
  ]);
  return {
    dimension,
    rows: rows.map((row) => ({
      ...row,
      revenue: roundMoneyMysql(row.revenue),
      profit: roundMoneyMysql(row.profit),
      cancelled_revenue: roundMoneyMysql(row.cancelled_revenue),
      profit_margin: Number(row.revenue || 0) ? Number(row.profit || 0) / Number(row.revenue || 0) : 0
    })),
    total: Number(totalRow?.total || 0),
    totalPages: Math.max(1, Math.ceil(Number(totalRow?.total || 0) / pageSize)),
    page,
    pageSize,
    from,
    to
  };
}

export async function profitRankingDetailsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const dimension = String(query.dimension || "sku").toLowerCase();
  const limit = Math.min(Math.max(Number(query.limit || 200), 1), 500);
  const from = String(query.from || "").slice(0, 10);
  const to = String(query.to || "").slice(0, 10);
  const dateFilter = profitDateWhereMysql("o", from, to);
  const params = [...dateFilter.params];
  const where = [];
  if (dimension === "shop" && query.shop_id) {
    where.push("o.shop_id = ?");
    params.push(Number(query.shop_id));
  }
  if (dimension === "sku" && query.shop_id) {
    where.push("o.shop_id = ?");
    params.push(Number(query.shop_id));
  }
  if (dimension === "sku" && query.ozon_sku) {
    where.push("oi.ozon_sku = ?");
    params.push(String(query.ozon_sku));
  }
  const rows = await mysqlQuery(`
    SELECT o.id AS order_id, o.posting_number, o.order_number, o.status, o.ordered_at,
      s.name AS shop_name, oi.ozon_sku, oi.ozon_name, oi.quantity, oi.sale_price,
      oi.estimated_profit, oi.actual_profit,
      COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0) AS profit
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN shops s ON s.id = o.shop_id
    WHERE 1=1 ${dateFilter.whereSql} ${where.length ? `AND ${where.join(" AND ")}` : ""}
    ORDER BY o.ordered_at DESC, o.id DESC
    LIMIT ?
  `, [...params, limit]);
  return { rows, total: rows.length };
}

export async function profitDetailsMysql(query = {}) {
  return profitRankingDetailsMysql(query);
}

export async function ozonFinanceSummaryMysql() {
  ensureMysqlCutoverEnabled();
  const summary = await mysqlQueryOne(`
    SELECT COUNT(DISTINCT operation_id) AS operations,
      COUNT(*) AS rows,
      COUNT(DISTINCT posting_number) AS postings,
      COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS fees,
      MAX(synced_at) AS last_synced_at
    FROM ozon_finance_items
  `);
  const recent = await mysqlQuery(`
    SELECT ofi.posting_number, s.name AS shop_name,
      COUNT(*) AS rows,
      COALESCE(SUM(ofi.amount), 0) AS amount,
      COALESCE(SUM(CASE WHEN ofi.amount < 0 THEN -ofi.amount ELSE 0 END), 0) AS fee_amount,
      MAX(ofi.operation_date) AS operation_date
    FROM ozon_finance_items ofi
    JOIN shops s ON s.id = ofi.shop_id
    GROUP BY ofi.shop_id, ofi.posting_number
    ORDER BY operation_date DESC
    LIMIT 12
  `);
  return { summary, recent };
}

export async function dashboardMysql() {
  ensureMysqlCutoverEnabled();
  const [stock, procurement] = await Promise.all([
    stockAlertsMysql({ paged: "1", page: 1, pageSize: 20 }),
    procurementRequestsMysql({ grouped: "1", paged: "1", page: 1, pageSize: 20 })
  ]);
  return {
    summary: {
      urgent_count: (stock.rows || []).filter((item) => item.alert_level === "danger").length,
      warning_count: (stock.rows || []).filter((item) => item.alert_level !== "ok").length,
      fbp_count: Number(stock.meta?.warning_count || 0),
      fbs_count: 0,
      procurement_count: Number(procurement.total || 0)
    },
    alerts: {
      fbp: stock.rows || [],
      fbs: [],
      procurement: procurement.rows || []
    }
  };
}

export async function inventoryMysql() {
  ensureMysqlCutoverEnabled();
  return await mysqlQuery(`
    SELECT im.*, p.code AS product_code, p.name AS product_name, s.name AS shop_name, pe.name AS owner_name
    FROM inventory_movements im
    JOIN products p ON p.id = im.product_id
    LEFT JOIN shops s ON s.id = im.shop_id
    LEFT JOIN people pe ON pe.id = im.owner_person_id
    ORDER BY im.created_at DESC, im.id DESC
    LIMIT 300
  `);
}

export async function outboundRecordsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const { whereSql, params, needsSearchJoins } = outboundRecordsWhereMysql(query);
  const orderSql = "ORDER BY obr.created_at DESC, obr.id DESC";
  const selectSql = outboundRecordsSelectMysql(whereSql);

  if (!paged) {
    return await mysqlQuery(`
      ${selectSql}
      ${orderSql}
    `, params);
  }

  const offset = (page - 1) * pageSize;
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`
      SELECT COUNT(*) AS total
      FROM outbound_records obr
      ${needsSearchJoins ? `
        JOIN products p ON p.id = obr.product_id
        LEFT JOIN shops s ON s.id = obr.shop_id
        LEFT JOIN online_products op ON op.id = obr.online_product_id
        LEFT JOIN people pe ON pe.id = obr.person_id
      ` : ""}
      ${whereSql}
    `, params),
    mysqlQuery(`
      ${selectSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset])
  ]);

  return {
    rows,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    summary: {
      totalRows: Number(totalRow?.total || 0),
      totalOrders: 0,
      totalQuantity: 0,
      totalAmount: 0,
      cancelledCount: 0
    },
    mode: "paged"
  };
}

function outboundRecordsWhereMysql(query = {}) {
  const status = String(query.status || "all");
  const shopId = String(query.shopId || query.shop_id || "all");
  const dateFrom = String(query.dateFrom || query.date_from || "").trim();
  const dateTo = String(query.dateTo || query.date_to || "").trim();
  const searchText = String(query.query || query.search || "").trim();
  const params = [];
  const where = [];

  if (["deducted", "cancelled"].includes(status)) {
    where.push("obr.status = ?");
    params.push(status);
  }
  if (shopId !== "all" && shopId) {
    where.push("obr.shop_id = ?");
    params.push(Number(shopId));
  }
  if (dateFrom) {
    where.push("obr.created_at >= ?");
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push("obr.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(dateTo);
  }
  if (searchText) {
    const like = `%${searchText.toLowerCase()}%`;
    where.push(`(
      LOWER(COALESCE(obr.order_ref, '')) LIKE ?
      OR LOWER(COALESCE(obr.ozon_sku, op.ozon_sku, '')) LIKE ?
      OR LOWER(COALESCE(p.name, '')) LIKE ?
      OR LOWER(COALESCE(p.code, '')) LIKE ?
      OR LOWER(COALESCE(s.name, '')) LIKE ?
      OR LOWER(COALESCE(pe.name, '')) LIKE ?
      OR LOWER(COALESCE(obr.note, '')) LIKE ?
    )`);
    params.push(like, like, like, like, like, like, like);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
    needsSearchJoins: Boolean(searchText)
  };
}

function outboundRecordsSelectMysql(whereSql = "") {
  return `
    SELECT obr.*, p.code AS product_code, p.name AS product_name, p.image_url AS product_image_url,
      s.name AS shop_name, COALESCE(obr.ozon_sku, op.ozon_sku) AS ozon_sku, pe.name AS person_name,
      COALESCE(op.image_url, op.primary_image, p.image_url, '') AS image_urls,
      COALESCE(obr.order_item_id, im.related_order_item_id) AS order_item_id, 'deducted' AS row_kind,
      oi.sale_price AS sale_price,
      (oi.sale_price * obr.quantity) AS order_amount,
      o.ordered_at AS outbound_time
    FROM outbound_records obr
    JOIN products p ON p.id = obr.product_id
    LEFT JOIN shops s ON s.id = obr.shop_id
    LEFT JOIN online_products op ON op.id = obr.online_product_id
    LEFT JOIN people pe ON pe.id = obr.person_id
    LEFT JOIN (
      SELECT related_posting_number, product_id, status, MIN(related_order_item_id) AS related_order_item_id
      FROM inventory_movements
      WHERE source_type = 'order_outbound'
      GROUP BY related_posting_number, product_id, status
    ) im ON im.related_posting_number = obr.order_ref
      AND im.product_id = obr.product_id
      AND im.status = CASE WHEN obr.status = 'deducted' THEN 'posted' ELSE obr.status END
    LEFT JOIN order_items oi ON oi.id = COALESCE(obr.order_item_id, im.related_order_item_id)
    LEFT JOIN orders o ON o.posting_number = obr.order_ref
    ${whereSql}
  `;
}

export async function ordersMysql() {
  ensureMysqlCutoverEnabled();
  const rows = await mysqlQuery(`
    SELECT o.*, s.name AS shop_name, COUNT(oi.id) AS item_count,
      COALESCE(SUM(oi.quantity), 0) AS total_quantity,
      SUM(oi.sale_price * oi.quantity) AS revenue,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 0 ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS actual_profit,
      COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,
      COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,
      COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,
      COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,
      COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,
      COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,
      COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,
      GROUP_CONCAT(DISTINCT oi.settlement_state) AS settlement_states,
      GROUP_CONCAT(DISTINCT opi.profit_status) AS profit_statuses,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', oi.quantity) SEPARATOR '||') AS sku_quantities,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', oi.sale_price, ':', oi.quantity) SEPARATOR '||') AS sku_prices,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), '')) SEPARATOR '||') AS sku_names,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) SEPARATOR '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN op.ozon_product_id IS NOT NULL AND op.ozon_product_id != '' THEN CONCAT(oi.ozon_sku, ':', op.ozon_product_id) END) AS sku_ozon_product_ids,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) AS order_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.image_url, '') END) AS inventory_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', p.id) END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', op.id) END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', sm.id) END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(stock.fbs_present, 0), ':', COALESCE(stock.fbp_present, 0))) AS sku_stock_summaries,
      GROUP_CONCAT(DISTINCT CASE WHEN po.order_no IS NOT NULL THEN po.order_no END) AS purchase_order_numbers,
      GROUP_CONCAT(DISTINCT CASE WHEN ir.id IS NOT NULL THEN COALESCE(NULLIF(ir.note, ''), NULLIF(ir.purchase_url, ''), po.order_no) END) AS purchase_tracking_numbers,
      GROUP_CONCAT(DISTINCT p.id) AS product_ids,
      GROUP_CONCAT(DISTINCT sm.offer_id) AS offer_ids,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(DISTINCT COALESCE(CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT CASE
        WHEN p.id IS NOT NULL AND p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, 'Unbound product')) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_url, '')) AS purchase_urls,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_cost, 0)) AS purchase_costs,
      GROUP_CONCAT(DISTINCT COALESCE(p.supplier_note, '')) AS supplier_notes,
      GROUP_CONCAT(DISTINCT COALESCE(p.shipping_method, '')) AS product_shipping_methods,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.package_weight_g, 0) END) AS package_weights,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(COALESCE(p.length_cm, 0), 'x', COALESCE(p.width_cm, 0), 'x', COALESCE(p.height_cm, 0)) END) AS package_dimensions,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls,
      COALESCE(om.mark_type, '') AS mark_type,
      COALESCE(om.note, '') AS mark_note,
      olp.printed_at AS printed_at,
      olp.print_batch_id AS print_batch_id,
      olp.print_sequence AS print_sequence,
      raw.raw_json AS raw_json
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN (
      SELECT shop_id, ozon_sku,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_present
      FROM ozon_stock_snapshots
      GROUP BY shop_id, ozon_sku
    ) stock ON stock.shop_id = o.shop_id AND stock.ozon_sku = oi.ozon_sku
    LEFT JOIN inbound_records ir ON ir.product_id = p.id AND ir.purchase_order_id IS NOT NULL
    LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN order_marks om ON om.order_id = o.id
    LEFT JOIN order_label_prints olp ON olp.order_id = o.id
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    GROUP BY o.id
    ORDER BY o.ordered_at DESC
    LIMIT 10000
  `);

  return await Promise.all(rows.map(enrichOrderLogisticsMysql));
}

async function orderRowsByIdsMysql(ids = []) {
  const cleanIds = [...new Set(ids.map(Number).filter(Boolean))];
  if (!cleanIds.length) return [];
  const rows = await mysqlQuery(`
    SELECT o.*, s.name AS shop_name, COUNT(oi.id) AS item_count,
      COALESCE(SUM(oi.quantity), 0) AS total_quantity,
      SUM(oi.sale_price * oi.quantity) AS revenue,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 0 ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS actual_profit,
      COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,
      COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,
      COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,
      COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,
      COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,
      COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,
      COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,
      GROUP_CONCAT(DISTINCT oi.settlement_state) AS settlement_states,
      GROUP_CONCAT(DISTINCT opi.profit_status) AS profit_statuses,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', oi.quantity) SEPARATOR '||') AS sku_quantities,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', oi.sale_price, ':', oi.quantity) SEPARATOR '||') AS sku_prices,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), '')) SEPARATOR '||') AS sku_names,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) SEPARATOR '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN op.ozon_product_id IS NOT NULL AND op.ozon_product_id != '' THEN CONCAT(oi.ozon_sku, ':', op.ozon_product_id) END) AS sku_ozon_product_ids,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) AS order_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.image_url, '') END) AS inventory_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', p.id) END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', op.id) END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', sm.id) END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(stock.fbs_present, 0), ':', COALESCE(stock.fbp_present, 0))) AS sku_stock_summaries,
      GROUP_CONCAT(DISTINCT CASE WHEN po.order_no IS NOT NULL THEN po.order_no END) AS purchase_order_numbers,
      GROUP_CONCAT(DISTINCT CASE WHEN ir.id IS NOT NULL THEN COALESCE(NULLIF(ir.note, ''), NULLIF(ir.purchase_url, ''), po.order_no) END) AS purchase_tracking_numbers,
      GROUP_CONCAT(DISTINCT p.id) AS product_ids,
      GROUP_CONCAT(DISTINCT sm.offer_id) AS offer_ids,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(DISTINCT COALESCE(CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT CASE
        WHEN p.id IS NOT NULL AND p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, 'Unbound product')) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_url, '')) AS purchase_urls,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_cost, 0)) AS purchase_costs,
      GROUP_CONCAT(DISTINCT COALESCE(p.supplier_note, '')) AS supplier_notes,
      GROUP_CONCAT(DISTINCT COALESCE(p.shipping_method, '')) AS product_shipping_methods,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.package_weight_g, 0) END) AS package_weights,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(COALESCE(p.length_cm, 0), 'x', COALESCE(p.width_cm, 0), 'x', COALESCE(p.height_cm, 0)) END) AS package_dimensions,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls,
      COALESCE(om.mark_type, '') AS mark_type,
      COALESCE(om.note, '') AS mark_note,
      olp.printed_at AS printed_at,
      olp.print_batch_id AS print_batch_id,
      olp.print_sequence AS print_sequence,
      raw.raw_json AS raw_json
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN (
      SELECT shop_id, ozon_sku,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_present
      FROM ozon_stock_snapshots
      GROUP BY shop_id, ozon_sku
    ) stock ON stock.shop_id = o.shop_id AND stock.ozon_sku = oi.ozon_sku
    LEFT JOIN inbound_records ir ON ir.product_id = p.id AND ir.purchase_order_id IS NOT NULL
    LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN order_marks om ON om.order_id = o.id
    LEFT JOIN order_label_prints olp ON olp.order_id = o.id
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    WHERE o.id IN (${cleanIds.map(() => "?").join(",")})
    GROUP BY o.id
  `, cleanIds);
  const ordering = new Map(cleanIds.map((value, index) => [String(value), index]));
  return (await Promise.all(rows.map(enrichOrderLogisticsMysql))).sort((a, b) => (ordering.get(String(a.id)) ?? 0) - (ordering.get(String(b.id)) ?? 0));
}

async function orderBaseSqlMysql(query = {}) {
  const where = ["1 = 1"];
  const params = [];
  const shopId = String(query.shopId || query.shop_id || "all");
  if (shopId !== "all") {
    where.push("o.shop_id = ?");
    params.push(Number(shopId));
  }
  const from = normalizeSyncDateMysql(query.dateFrom || query.date_from);
  const to = normalizeSyncDateMysql(query.dateTo || query.date_to);
  if (from) {
    where.push(`${chinaDateSqlMysql("o.ordered_at")} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${chinaDateSqlMysql("o.ordered_at")} <= ?`);
    params.push(to);
  }
  return { where: where.join(" AND "), params };
}

async function orderFilteredSqlMysql(query, base) {
  const where = [base.where];
  const params = [...base.params];
  addOrderSearchSqlMysql(where, params, query);
  where.push(orderStatusSqlMysql(String(query.status || "all")));

  const mark = String(query.markFilter || query.mark_filter || "all");
  if (mark === "quality") {
    const prefixes = await orderQualityPrefixesMysql();
    const qualityParts = ["COALESCE((SELECT mark_type FROM order_marks WHERE order_id = o.id), '') = ?"];
    params.push("quality");
    for (const prefix of prefixes) {
      qualityParts.push("o.posting_number LIKE ?");
      params.push(`${prefix}%`);
    }
    where.push(`(${qualityParts.join(" OR ")})`);
  } else if (mark !== "all") {
    where.push("COALESCE((SELECT mark_type FROM order_marks WHERE order_id = o.id), '') = ?");
    params.push(mark);
  }

  const print = String(query.printFilter || query.print_filter || "all");
  if (print === "printed") where.push("EXISTS (SELECT 1 FROM order_label_prints olp WHERE olp.order_id = o.id)");
  if (print === "unprinted") where.push("NOT EXISTS (SELECT 1 FROM order_label_prints olp WHERE olp.order_id = o.id)");
  return { joins: "", where: where.filter(Boolean).join(" AND "), params };
}

function orderProductShippingExistsSqlMysql(methods = []) {
  return `EXISTS (
    SELECT 1
    FROM order_items oi
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    WHERE oi.order_id = o.id
      AND LOWER(COALESCE(p.shipping_method, '')) IN (${methods.map(() => "?").join(",")})
  )`;
}

function orderRawLogisticsExistsSqlMysql(condition) {
  return `EXISTS (
    SELECT 1 FROM ozon_orders_raw raw
    WHERE raw.store_id = o.shop_id
      AND raw.posting_number = o.posting_number
      AND (${condition})
  )`;
}

function orderRawLikeMysql(params, keyword) {
  params.push(`%${String(keyword).toLowerCase()}%`);
  return `LOWER(COALESCE(raw.raw_json, '')) LIKE ?`;
}

function orderRawAnyLikeMysql(params, keywords = []) {
  const parts = keywords.map((keyword) => orderRawLikeMysql(params, keyword));
  return parts.length ? `(${parts.join(" OR ")})` : "";
}

function orderRawNotLikeMysql(params, keyword) {
  params.push(`%${String(keyword).toLowerCase()}%`);
  return `LOWER(COALESCE(raw.raw_json, '')) NOT LIKE ?`;
}

function orderHunchunExclusionSqlMysql(params) {
  return ["hunchun", "hun chun", "hch-pd", "fbp", "珲春", "混春", "混川"]
    .map((keyword) => orderRawNotLikeMysql(params, keyword))
    .join(" AND ");
}

function normalizeOrderLogisticsTextMysql(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function resolveOrderLogisticsValueFromRowMysql(row = {}) {
  return resolveOrderLogisticsRuleValue({
    value: row.resolved_logistics_rule_value,
    name: row.resolved_logistics_rule_name,
    label: row.resolved_logistics_rule_name,
    channel: row.logistics_channel,
    carrier: row.delivery_method_name,
    warehousePatterns: [row.warehouse_name, row.delivery_method_name, row.logistics_channel]
  });
}

async function detectOrderLogisticsLabelMysql(text, row = {}) {
  const normalized = normalizeOrderLogisticsTextMysql(`${text || ""} ${row.delivery_method_name || ""} ${row.logistics_channel || ""} ${row.warehouse_name || ""}`);
  if (!normalized) return null;
  const methods = await activeOrderLogisticsFilterMethodsMysql();
  for (const method of methods) {
    if ((method.warehousePatterns || []).some((pattern) => normalized.includes(normalizeOrderLogisticsTextMysql(pattern)))) {
      return { value: method.value, label: method.label };
    }
  }
  return null;
}

async function orderLogisticsMethodClauseMysql(method, params) {
  const methods = await activeOrderLogisticsFilterMethodsMysql();
  const selectedMethods = methods.filter((item) => item.value === method);
  const selected = selectedMethods[0];
  const label = String(selected?.label || "").trim();
  if (label === "CEL Hunchun 2") return orderRawLogisticsExistsSqlMysql(orderRawAnyLikeMysql(params, ["hunchun", "hch-pd", "hch-cr", "cel fbp"]));
  if (label === "中国邮政 500g 以下") return orderRawLogisticsExistsSqlMysql(orderRawAnyLikeMysql(params, ["china post", "邮政"]));
  if (label === "CEL 陆运 0.5-30kg") return orderRawLogisticsExistsSqlMysql(orderRawAnyLikeMysql(params, ["0.5-30kg"]));
  if (label === "CEL 陆运经济 Budget") return orderRawLogisticsExistsSqlMysql(orderRawAnyLikeMysql(params, ["500-25000g"]));
  if (label === "CEL 陆运经济 Big") return orderRawLogisticsExistsSqlMysql(orderRawAnyLikeMysql(params, ["cel economy big", "2-30kg"]));
  if (label === "CEL 陆运经济 Small") return orderRawLogisticsExistsSqlMysql(orderRawAnyLikeMysql(params, ["cel economy small", "1-2000g"]));
  if (label === "CEL 陆运经济 Extra Small") return orderRawLogisticsExistsSqlMysql(orderRawAnyLikeMysql(params, ["cel economy extra small", "extra small economy"]));
  if (label === "CEL 陆空标准 Extra Small") return orderRawLogisticsExistsSqlMysql(orderRawAnyLikeMysql(params, ["cel standard extra small", "extra small standard"]));
  const patternSet = new Set();
  for (const methodRule of selectedMethods) {
    for (const pattern of methodRule?.warehousePatterns || []) {
      const normalized = String(pattern || "").trim();
      if (normalized) patternSet.add(normalized);
    }
  }
  const patterns = [...patternSet];
  if (!patterns.length) return "";
  return orderRawLogisticsExistsSqlMysql(patterns.map((pattern) => orderRawLikeMysql(params, pattern)).join(" OR "));
}

async function loadOrderRowsForBaseMysql(base) {
  const idRows = await mysqlQuery(`
    SELECT o.id
    FROM orders o
    WHERE ${base.where}
    GROUP BY o.id
  `, base.params);
  return await orderRowsByIdsMysql(idRows.map((row) => row.id));
}

async function loadOrderLogisticsSummaryForBaseMysql(base) {
  const cacheKey = `orders:logistics-summary:${base.where}:${JSON.stringify(base.params)}`;
  return getCachedMasterData(cacheKey, async () => {
    const rows = await mysqlQuery(`
      SELECT o.id, o.posting_number, o.tracking_number, raw.raw_json
      FROM orders o
      LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      WHERE ${base.where}
      GROUP BY o.id
    `, base.params);
    const resolvedRows = [];
    for (const row of rows) {
      const resolved = await resolveOrderLogisticsRuleMysql(row);
      if (!resolved?.rule?.value || !resolved?.rule?.label) continue;
      resolvedRows.push({
        id: Number(row.id),
        resolved_logistics_rule_name: resolved.rule.label,
        resolved_logistics_rule_value: resolved.rule.value
      });
    }
    return resolvedRows;
  }, ORDER_COUNTS_CACHE_TTL_MS);
}

function buildOrderLogisticsCountsMysql(rows = [], labelByValue = new Map()) {
  const counts = new Map();
  for (const row of rows) {
    const value = resolveOrderLogisticsValueFromRowMysql(row);
    const label = String(row.resolved_logistics_rule_name || "").trim() || labelByValue.get(value) || "";
    if (!value || !label) continue;
    const current = counts.get(value) || { value, label, count: 0 };
    current.count += 1;
    counts.set(value, current);
  }
  return counts;
}

async function orderLogisticsMethodOptionsMysql(base, rows = null) {
  const cacheKey = `orders:logistics-options:${base.where}:${JSON.stringify(base.params)}`;
  return getCachedMasterData(cacheKey, async () => {
    const options = [{ value: "all", label: "全部物流" }];
    const methods = await activeOrderLogisticsFilterMethodsMysql();
    const labelByValue = new Map(
      methods.map((item) => [String(item.value || "").trim(), String(item.label || "").trim()]).filter(([value, label]) => value && label)
    );
    const counts = buildOrderLogisticsCountsMysql(rows || await loadOrderLogisticsSummaryForBaseMysql(base), labelByValue);
    for (const item of [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-Hans"))) {
      options.push({
        value: item.value,
        label: `${item.label} (${item.count})`,
        count: item.count
      });
    }
    return options;
  }, ORDER_COUNTS_CACHE_TTL_MS);
}

function filterOrderIdsByLogisticsMethodMysql(rows = [], method) {
  const normalizedMethod = String(method || "all").trim();
  if (!normalizedMethod || normalizedMethod === "all") return null;
  return rows
    .filter((row) => resolveOrderLogisticsValueFromRowMysql(row) === normalizedMethod)
    .map((row) => Number(row.id))
    .filter(Boolean);
}

function withRestrictedOrderIdsMysql(base, ids) {
  if (ids === null) return base;
  if (!ids.length) {
    return {
      where: `${base.where} AND 1 = 0`,
      params: [...base.params]
    };
  }
  return {
    where: `${base.where} AND o.id IN (${ids.map(() => "?").join(",")})`,
    params: [...base.params, ...ids]
  };
}

async function orderPagedSqlCountsMysql(base) {
  const cacheKey = `orders:counts:${base.where}:${JSON.stringify(base.params)}`;
  return getCachedMasterData(cacheKey, async () => {
    const row = await mysqlQueryOne(`
      SELECT
        COUNT(*) AS all_count,
        SUM(CASE WHEN ${orderStatusSqlMysql("awaiting_packaging")} THEN 1 ELSE 0 END) AS awaiting_packaging,
        SUM(CASE WHEN ${orderStatusSqlMysql("awaiting_deliver")} THEN 1 ELSE 0 END) AS awaiting_deliver,
        SUM(CASE WHEN ${orderStatusSqlMysql("delivering")} THEN 1 ELSE 0 END) AS delivering,
        SUM(CASE WHEN ${orderStatusSqlMysql("dispute")} THEN 1 ELSE 0 END) AS dispute,
        SUM(CASE WHEN ${orderStatusSqlMysql("delivered")} THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN ${orderStatusSqlMysql("cancelled")} THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN ${orderStatusSqlMysql("unbound")} THEN 1 ELSE 0 END) AS unbound
      FROM orders o
      WHERE ${base.where}
    `, base.params);
    return {
      all: Number(row?.all_count || 0),
      awaiting_packaging: Number(row?.awaiting_packaging || 0),
      awaiting_deliver: Number(row?.awaiting_deliver || 0),
      delivering: Number(row?.delivering || 0),
      dispute: Number(row?.dispute || 0),
      delivered: Number(row?.delivered || 0),
      cancelled: Number(row?.cancelled || 0),
      unbound: Number(row?.unbound || 0)
    };
  }, ORDER_COUNTS_CACHE_TTL_MS);
}

export async function ordersPagedMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureOrderLabelPrintSchemaMysql();
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const includeRows = String(query.includeRows ?? query.include_rows ?? "1") !== "0";
  const includeCounts = String(query.includeCounts ?? query.include_counts ?? "1") !== "0";
  const includeLogisticsOptions = String(query.includeLogisticsOptions ?? query.include_logistics_options ?? "1") !== "0";
  const optionsBase = includeLogisticsOptions
    ? await orderBaseSqlMysql({ ...query, logisticsMethod: "all", logistics_method: "all" })
    : null;
  const logisticsMethod = String(query.logisticsMethod || query.logistics_method || "all");
  const rawBase = await orderBaseSqlMysql(query);
  const reuseLogisticsSummary = includeLogisticsOptions || logisticsMethod !== "all";
  const logisticsSummaryRows = reuseLogisticsSummary ? await loadOrderLogisticsSummaryForBaseMysql(rawBase) : null;
  const logisticsMethodOptions = includeLogisticsOptions && optionsBase
    ? await orderLogisticsMethodOptionsMysql(optionsBase, logisticsSummaryRows)
    : [];
  const logisticsIds = filterOrderIdsByLogisticsMethodMysql(logisticsSummaryRows || [], logisticsMethod);
  const base = withRestrictedOrderIdsMysql(rawBase, logisticsIds);
  const counts = includeCounts ? await orderPagedSqlCountsMysql(base) : {};
  const filtered = await orderFilteredSqlMysql(query, base);
  const total = Number((await mysqlQueryOne(`SELECT COUNT(*) AS total FROM orders o ${filtered.joins} WHERE ${filtered.where}`, filtered.params))?.total || 0);
  const start = (page - 1) * pageSize;
  const sortMode = String(query.sortMode || query.sort_mode || "ordered");
  let rows = [];
  if (includeRows) {
    if (sortMode === "inventory") {
      const idRows = await mysqlQuery(`
        SELECT o.id
        FROM orders o
        ${filtered.joins}
        WHERE ${filtered.where}
        GROUP BY o.id
        ORDER BY o.ordered_at DESC
      `, filtered.params);
      rows = sortPagedOrdersMysql(await orderRowsByIdsMysql(idRows.map((row) => row.id)), query).slice(start, start + pageSize);
    } else {
      const idRows = await mysqlQuery(`
        SELECT o.id
        FROM orders o
        ${filtered.joins}
        WHERE ${filtered.where}
        GROUP BY o.id
        ORDER BY o.ordered_at DESC
        LIMIT ? OFFSET ?
      `, [...filtered.params, pageSize, start]);
      rows = sortPagedOrdersMysql(await orderRowsByIdsMysql(idRows.map((row) => row.id)), query);
    }
  }
  return {
    rows,
    total,
    page,
    pageSize,
    counts,
    logisticsMethodOptions,
    mode: "paged"
  };
}

function addOrderSearchSqlMysql(where, params, query) {
  const text = String(query.searchQuery || query.search_query || "").trim();
  if (!text) return;
  const like = `%${text.toLowerCase()}%`;
  const type = String(query.searchType || query.search_type || "order");
  if (type === "order") {
    where.push("(LOWER(o.posting_number) LIKE ? OR LOWER(COALESCE(o.order_number, '')) LIKE ?)");
    params.push(like, like);
    return;
  }
  if (type === "tracking") {
    where.push("(LOWER(COALESCE(o.tracking_number, '')) LIKE ? OR LOWER(COALESCE(o.logistics_status, '')) LIKE ? OR LOWER(COALESCE(o.tracking_stage, '')) LIKE ?)");
    params.push(like, like, like);
    return;
  }
  if (type === "sku") {
    where.push("EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND LOWER(CONCAT(oi.ozon_sku, ' ', COALESCE(oi.ozon_name, ''))) LIKE ?)");
    params.push(like);
    return;
  }
  if (type === "offer") {
    where.push("EXISTS (SELECT 1 FROM order_items oi LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id WHERE oi.order_id = o.id AND LOWER(CONCAT(COALESCE(sm.offer_id, ''), ' ', oi.ozon_sku)) LIKE ?)");
    params.push(like);
    return;
  }
  if (type === "product") {
    where.push(`EXISTS (
      SELECT 1 FROM order_items oi
      LEFT JOIN sku_mappings sm ON (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku)) AND sm.active = 1
      LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
      WHERE oi.order_id = o.id AND LOWER(CONCAT(COALESCE(p.name, ''), ' ', COALESCE(p.code, ''), ' ', COALESCE(p.selection_id, ''), ' ', oi.ozon_sku)) LIKE ?
    )`);
    params.push(like);
    return;
  }
  if (type === "purchaseTracking") {
    where.push(`EXISTS (
      SELECT 1
      FROM order_items oi
      LEFT JOIN sku_mappings sm ON (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku)) AND sm.active = 1
      LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
      LEFT JOIN inbound_records ir ON ir.product_id = p.id AND ir.purchase_order_id IS NOT NULL
      LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
      WHERE oi.order_id = o.id
        AND LOWER(CONCAT(COALESCE(po.order_no, ''), ' ', COALESCE(ir.note, ''), ' ', COALESCE(ir.purchase_url, ''))) LIKE ?
    )`);
    params.push(like);
  }
}

async function addOrderLogisticsMethodSqlMysql(where, params, query) {
  const method = String(query.logisticsMethod || query.logistics_method || "all");
  if (method === "all") return;
  const clause = await orderLogisticsMethodClauseMysql(method, params);
  if (clause) where.push(clause);
}

function orderStatusSqlMysql(status) {
  if (status === "all") return "1 = 1";
  if (status === "unbound") {
    return `EXISTS (
      SELECT 1 FROM order_items oi
      LEFT JOIN sku_mappings sm ON (
        (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
        AND sm.active = 1
      )
      LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
      WHERE oi.order_id = o.id AND p.id IS NULL
    )`;
  }
  const state = "LOWER(COALESCE(o.status, ''))";
  const stage = "LOWER(COALESCE(o.tracking_stage, ''))";
  const value = `LOWER(CONCAT(COALESCE(o.status, ''), ' ', COALESCE(o.tracking_stage, ''), ' ', COALESCE(o.logistics_status, ''), ' ', COALESCE(o.tracking_number, '')))`;
  if (status === "awaiting_packaging") {
    return `((${state} IN ('awaiting_registration','acceptance_in_progress','awaiting_approve','awaiting_packaging','posting_created','posting_awaiting_registration','posting_acceptance_in_progress')
      OR ${stage} IN ('awaiting_registration','acceptance_in_progress','awaiting_approve','awaiting_packaging','posting_created','posting_awaiting_registration','posting_acceptance_in_progress'))
      AND NOT (${orderStatusSqlMysql("awaiting_deliver")})
      AND NOT (${orderStatusSqlMysql("delivering")})
      AND NOT (${orderStatusSqlMysql("delivered")})
      AND NOT (${orderStatusSqlMysql("cancelled")})
      AND NOT (${orderStatusSqlMysql("dispute")}))`;
  }
  if (status === "awaiting_deliver") {
    return `(${state} IN ('awaiting_deliver','posting_registered','sent_by_seller','posting_ready_for_pickup','posting_transferred_to_courier_service','posting_transferring','posting_in_carriage','posting_transferring_to_delivery')
      OR ${stage} IN ('awaiting_deliver','posting_registered','sent_by_seller','posting_ready_for_pickup','posting_transferred_to_courier_service','posting_transferring','posting_in_carriage','posting_transferring_to_delivery'))`;
  }
  if (status === "dispute") return `(${value} LIKE '%arbitration%' OR ${value} LIKE '%dispute%')`;
  if (status === "cancelled") return `(${value} LIKE '%cancel%' OR ${value} LIKE '%return%' OR ${value} LIKE '%not_accepted%')`;
  if (status === "delivered") return `(${value} LIKE '%delivered%' AND NOT (${orderStatusSqlMysql("cancelled")}))`;
  if (status === "delivering") {
    return `(
      ${value} NOT LIKE '%awaiting_packaging%' AND ${value} NOT LIKE '%awaiting_deliver%' AND ${value} NOT LIKE '%pending_stock%'
      AND ${value} NOT LIKE '%posting_in_carriage%' AND ${value} NOT LIKE '%posting_transferring%' AND ${value} NOT LIKE '%posting_transferring_to_delivery%'
      AND (
        ${value} LIKE '%delivering%' OR ${value} LIKE '%transferring%' OR ${value} LIKE '%carriage%' OR ${value} LIKE '%pickup%'
        OR ${value} LIKE '%sorting%' OR ${value} LIKE '%customs%' OR ${value} LIKE '%shipped%' OR ${value} LIKE '%sent%'
        OR ${value} LIKE '%on_way%'
      )
    )`;
  }
  return "1 = 1";
}

async function orderDetailFinanceMysql(order, items = []) {
  const directRows = await mysqlQuery(`
    SELECT service_type, service_name,
      COALESCE(SUM(amount), 0) AS amount,
      COALESCE(SUM(amount_cny), 0) AS amount_cny,
      COALESCE(MAX(accruals_for_sale), 0) AS accruals_for_sale,
      COALESCE(MAX(accruals_for_sale_cny), 0) AS accruals_for_sale_cny,
      COALESCE(MAX(sale_commission), 0) AS sale_commission,
      COALESCE(MAX(sale_commission_cny), 0) AS sale_commission_cny,
      COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS fee_amount,
      COALESCE(SUM(CASE WHEN amount_cny < 0 THEN -amount_cny ELSE 0 END), 0) AS fee_amount_cny,
      COALESCE(MAX(exchange_rate), 0) AS exchange_rate,
      COALESCE(MAX(currency_code), 'RUB') AS currency_code,
      COUNT(*) AS row_count,
      MAX(operation_date) AS operation_date
    FROM ozon_finance_items
    WHERE shop_id = ? AND posting_number = ?
    GROUP BY service_type, service_name
  `, [order.shop_id, order.posting_number]);

  const parentPosting = trimOrderPostingSuffix(order.posting_number);
  const extraRows = parentPosting && parentPosting !== order.posting_number
    ? await mysqlQuery(`
      SELECT service_type, service_name,
        COALESCE(SUM(amount), 0) AS amount,
        COALESCE(SUM(amount_cny), 0) AS amount_cny,
        COALESCE(MAX(accruals_for_sale), 0) AS accruals_for_sale,
        COALESCE(MAX(accruals_for_sale_cny), 0) AS accruals_for_sale_cny,
        COALESCE(MAX(sale_commission), 0) AS sale_commission,
        COALESCE(MAX(sale_commission_cny), 0) AS sale_commission_cny,
        COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS fee_amount,
        COALESCE(SUM(CASE WHEN amount_cny < 0 THEN -amount_cny ELSE 0 END), 0) AS fee_amount_cny,
        COALESCE(MAX(exchange_rate), 0) AS exchange_rate,
        COALESCE(MAX(currency_code), 'RUB') AS currency_code,
        COUNT(*) AS row_count,
        MAX(operation_date) AS operation_date
      FROM ozon_finance_items
      WHERE shop_id = ?
        AND posting_number = ?
        AND LOWER(COALESCE(service_name, '')) LIKE '%marketplaceredistributionofacquiringoperation%'
      GROUP BY service_type, service_name
    `, [order.shop_id, parentPosting])
    : [];

  const exactRows = new Set((directRows || []).map((row) => `${row.service_type}||${row.service_name}`));
  const totalSale = (items || []).reduce((sum, item) => sum + Number(item.sale_amount_cny || (Number(item.sale_price || 0) * Number(item.quantity || 0))), 0);
  const orderSale = totalSale || (items?.length ? 1 : 0);
  const siblingRows = parentPosting && parentPosting !== order.posting_number
    ? await mysqlQuery(`
      SELECT o.id, o.posting_number,
        COALESCE(SUM(opi.sale_amount_cny), SUM(oi.sale_price * oi.quantity), 0) AS sale_amount_cny
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      WHERE o.shop_id = ? AND o.posting_number LIKE ?
      GROUP BY o.id, o.posting_number
    `, [order.shop_id, `${parentPosting}-%`])
    : [];
  const siblingTotalSale = siblingRows.reduce((sum, row) => sum + Number(row.sale_amount_cny || 0), 0);
  const share = siblingTotalSale > 0
    ? orderSale / siblingTotalSale
    : siblingRows.length > 0 ? 1 / siblingRows.length : 1;

  const financeMap = new Map();
  for (const row of directRows || []) {
    financeMap.set(`${row.service_type}||${row.service_name}`, { ...row });
  }
  for (const row of extraRows || []) {
    const key = `${row.service_type}||${row.service_name}`;
    if (exactRows.has(key)) continue;
    financeMap.set(key, scaleFinanceRowMysql(row, share));
  }

  return [...financeMap.values()].sort((a, b) => {
    const feeDiff = Number(b.fee_amount_cny || 0) - Number(a.fee_amount_cny || 0);
    if (feeDiff) return feeDiff;
    const amountDiff = Math.abs(Number(b.amount_cny || 0)) - Math.abs(Number(a.amount_cny || 0));
    if (amountDiff) return amountDiff;
    return String(a.service_name || "").localeCompare(String(b.service_name || ""));
  });
}

export async function orderProfitDetailSnapshotMysql(orderId) {
  ensureMysqlCutoverEnabled();
  const row = await mysqlQueryOne("SELECT * FROM order_profit_detail_snapshots WHERE order_id = ?", [Number(orderId)]);
  if (!row) return null;
  return {
    ...row,
    actual_profit_ready: Boolean(row.actual_profit_ready),
    summary: parseJsonFallback(row.summary_json, {}),
    rows: parseJsonFallback(row.detail_rows_json, []),
    finance_totals: parseJsonFallback(row.finance_totals_json, {})
  };
}

export async function refreshOrderProfitDetailSnapshotsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  const explicitIds = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  const limit = Math.min(Math.max(Number(body.limit || 5000), 1), 50000);
  const where = [];
  const params = [];
  if (explicitIds.length) {
    where.push(`o.id IN (${explicitIds.map(() => "?").join(",")})`);
    params.push(...explicitIds);
  } else {
    if (from) {
      where.push(`${chinaDateSqlMysql("o.ordered_at")} >= ?`);
      params.push(from);
    }
    if (to) {
      where.push(`${chinaDateSqlMysql("o.ordered_at")} <= ?`);
      params.push(to);
    }
    if (Number(body.final_only ?? 1) !== 0) {
      where.push(`(
        LOWER(COALESCE(o.status, '')) LIKE '%deliver%'
        OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%deliver%'
        OR LOWER(COALESCE(o.status, '')) LIKE '%cancel%'
        OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%'
        OR EXISTS (SELECT 1 FROM ozon_finance_items ofi WHERE ofi.shop_id = o.shop_id AND ofi.posting_number = o.posting_number)
      )`);
    }
  }
  const orders = await mysqlQuery(`
    SELECT o.id
    FROM orders o
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY o.ordered_at DESC
    LIMIT ?
  `, [...params, limit]);

  let refreshed = 0;
  for (const orderRow of orders) {
    const detail = await orderDetailMysql(Number(orderRow.id));
    if (!detail?.order) continue;
    const payload = buildOrderProfitDetailSnapshotPayload(detail.order, detail.items, detail.finance);
    await mysqlExecute(`
      INSERT INTO order_profit_detail_snapshots (
        order_id, shop_id, posting_number, order_status, outcome_type, sale_amount_cny,
        estimated_profit_cny, estimated_cost_total_cny, actual_profit_cny, actual_profit_rate,
        actual_cost_total_cny, finance_match_status, finance_rows, actual_profit_ready,
        summary_json, detail_rows_json, finance_totals_json, refreshed_at, source_updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON DUPLICATE KEY UPDATE
        shop_id = VALUES(shop_id),
        posting_number = VALUES(posting_number),
        order_status = VALUES(order_status),
        outcome_type = VALUES(outcome_type),
        sale_amount_cny = VALUES(sale_amount_cny),
        estimated_profit_cny = VALUES(estimated_profit_cny),
        estimated_cost_total_cny = VALUES(estimated_cost_total_cny),
        actual_profit_cny = VALUES(actual_profit_cny),
        actual_profit_rate = VALUES(actual_profit_rate),
        actual_cost_total_cny = VALUES(actual_cost_total_cny),
        finance_match_status = VALUES(finance_match_status),
        finance_rows = VALUES(finance_rows),
        actual_profit_ready = VALUES(actual_profit_ready),
        summary_json = VALUES(summary_json),
        detail_rows_json = VALUES(detail_rows_json),
        finance_totals_json = VALUES(finance_totals_json),
        refreshed_at = CURRENT_TIMESTAMP,
        source_updated_at = VALUES(source_updated_at)
    `, [
      payload.order_id,
      payload.shop_id,
      payload.posting_number,
      payload.order_status,
      payload.outcome_type,
      payload.sale_amount_cny,
      payload.estimated_profit_cny,
      payload.estimated_cost_total_cny,
      payload.actual_profit_cny,
      payload.actual_profit_rate,
      payload.actual_cost_total_cny,
      payload.finance_match_status,
      payload.finance_rows,
      payload.actual_profit_ready,
      JSON.stringify(payload.summary),
      JSON.stringify(payload.detailRows),
      JSON.stringify(payload.financeTotals),
      normalizeMysqlNullableDateTime(detail.order.updated_at || detail.order.last_synced_at || detail.order.ordered_at)
    ]);
    refreshed += 1;
  }

  return {
    ok: true,
    matched: orders.length,
    refreshed,
    from,
    to,
    final_only: Number(body.final_only ?? 1) !== 0,
    db: "mysql"
  };
}

export async function orderDetailMysql(id) {
  ensureMysqlCutoverEnabled();
  const order = await mysqlQueryOne(
    "SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?",
    [Number(id)]
  );
  if (!order) return null;

  const items = await mysqlQuery(`
    SELECT oi.*, sm.ozon_sku AS mapped_ozon_sku, sm.offer_id,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END AS product_code,
      p.name AS product_name, pe.name AS owner_name,
      p.image_url AS product_image_url,
      op.primary_image AS online_primary_image,
      op.image_url AS online_image_url,
      COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), NULLIF(p.image_url, '')) AS image_url,
      p.shipping_method,
      p.package_weight_g,
      p.length_cm,
      p.width_cm,
      p.height_cm,
      p.return_rate,
      opi.sale_amount_cny,
      opi.purchase_cost_cny,
      opi.domestic_shipping_cny,
      opi.international_shipping_cny,
      opi.packaging_cost_cny,
      opi.commission_fee_cny,
      opi.ozon_service_fee_cny,
      opi.return_loss_cny,
      opi.advertising_cost_cny,
      opi.other_fee_cny,
      opi.gross_profit_cny,
      opi.net_profit_cny,
      opi.profit_status,
      opi.lock_reason
    FROM order_items oi
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN online_products op ON op.shop_id = ? AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN people pe ON pe.id = sm.person_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE oi.order_id = ?
  `, [Number(order.shop_id), Number(id)]);

  const finance = await orderDetailFinanceMysql(order, items);
  const outcomeType = classifyOrderOutcome(order);
  const cancellation = describeCancellation(order);
  order.outcome_type = outcomeType;
  order.outcome_label = orderOutcomeLabelMysql(outcomeType);
  order.outcome_hint = orderOutcomeHintMysql(outcomeType);
  order.cancel_initiator_label = cancellation.initiator_label;
  order.cancel_reason_label = cancellation.reason_label;
  order.cancel_reason_code = cancellation.reason_code;
  order.cancel_reason_group_label = cancellation.reason_group_label;
  order.cancel_accounting_hint = cancellation.accounting_hint;
  order.loss_profile_code = cancellation.loss_profile_code;
  order.loss_profile_label = cancellation.loss_profile_label;
  order.loss_formula_text = cancellation.loss_formula_text;
  const profitDetailSnapshot = await orderProfitDetailSnapshotMysql(Number(id));
  return { order, items, finance, profit_detail_snapshot: profitDetailSnapshot };
}

export async function orderStatusHistoryMysql(orderId, query = {}) {
  ensureMysqlCutoverEnabled();
  const limit = Math.min(Math.max(Number(query.limit || 200), 1), 1000);
  const rows = await mysqlQuery(`
    SELECT *
    FROM order_status_history
    WHERE order_id = ?
    ORDER BY observed_at ASC, id ASC
    LIMIT ${limit}
  `, [Number(orderId)]);
  return rows.map((row) => ({
    ...row,
    raw_status: parseJsonOrNull(row.raw_status_json) || null
  }));
}

export async function orderStatusHistorySummaryMysql() {
  ensureMysqlCutoverEnabled();
  const total = await mysqlQueryOne("SELECT COUNT(*) AS count FROM order_status_history");
  const openOrders = await mysqlQueryOne("SELECT COUNT(*) AS count FROM orders WHERE COALESCE(sync_state, 'open') != 'final'");
  const customerCoverage = await mysqlQueryOne(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(customer_name, '') != '' THEN 1 ELSE 0 END) AS customer_name_count,
      SUM(CASE WHEN COALESCE(buyer_region, '') != '' OR COALESCE(buyer_city, '') != '' THEN 1 ELSE 0 END) AS region_count,
      SUM(CASE WHEN delivery_date_begin IS NOT NULL OR delivery_date_end IS NOT NULL THEN 1 ELSE 0 END) AS delivery_window_count
    FROM order_status_history
  `);
  const byStatus = await mysqlQuery(`
    SELECT status, tracking_stage, COUNT(*) AS count, MAX(observed_at) AS latest_observed_at
    FROM order_status_history
    GROUP BY status, tracking_stage
    ORDER BY count DESC
    LIMIT 20
  `);
  const slowRegions = await mysqlQuery(`
    SELECT buyer_region, buyer_city, COUNT(DISTINCT order_id) AS order_count,
      AVG(TIMESTAMPDIFF(HOUR, ordered_at, delivered_at)) AS avg_delivery_hours
    FROM order_status_history
    WHERE ordered_at IS NOT NULL AND delivered_at IS NOT NULL
      AND (COALESCE(buyer_region, '') != '' OR COALESCE(buyer_city, '') != '')
    GROUP BY buyer_region, buyer_city
    HAVING order_count > 0
    ORDER BY avg_delivery_hours DESC
    LIMIT 20
  `);
  return {
    total_history_rows: Number(total?.count || 0),
    open_orders: Number(openOrders?.count || 0),
    customer_coverage: {
      total: Number(customerCoverage?.total || 0),
      customer_name_count: Number(customerCoverage?.customer_name_count || 0),
      region_count: Number(customerCoverage?.region_count || 0),
      delivery_window_count: Number(customerCoverage?.delivery_window_count || 0)
    },
    by_status: byStatus,
    slow_regions: slowRegions
  };
}

export async function updateSkuMappingMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const mappingId = Number(id);
  const existing = await mysqlQueryOne("SELECT * FROM sku_mappings WHERE id = ?", [mappingId]);
  if (!existing) throw new Error("SKU mapping not found");

  const productId = Number(body.product_id || existing.product_id);
  const product = await mysqlQueryOne("SELECT id FROM products WHERE id = ? AND active = 1", [productId]);
  if (!product) throw new Error("Product not found");

  const active = body.active === undefined ? Number(existing.active) : Number(body.active ? 1 : 0);
  const personId = body.person_id === undefined ? await resolveExistingPersonId(existing.person_id) : await resolveExistingPersonId(body.person_id);
  const payload = [productId, personId, active, mappingId];

  await mysqlExecute(`
    UPDATE sku_mappings
    SET product_id = ?, person_id = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, payload);
  db.prepare(`
    UPDATE sku_mappings
    SET product_id = ?, person_id = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...payload);

  if (existing.online_product_id) {
    const onlineProductId = Number(existing.online_product_id);
    await mysqlExecute("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [active ? productId : null, onlineProductId]);
    db.prepare("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(active ? productId : null, onlineProductId);
  }

  return { ok: true, id: mappingId };
}

export async function deleteSkuMappingMysql(id) {
  ensureMysqlCutoverEnabled();
  return await updateSkuMappingMysql(id, { active: 0 });
}

