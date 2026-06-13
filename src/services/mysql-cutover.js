import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { actualItemProfit, estimateItemProfit } from "../profit.js";
import { archiveOzonProducts, fetchOzonCategoryAttributes, fetchOzonChatHistory, fetchOzonChatList, fetchOzonFboSupplyOrderItems, fetchOzonFboSupplyOrders, fetchOzonManagedStocks, fetchOzonPackageLabel, fetchOzonPostingByNumber, fetchOzonPostings, fetchOzonFinanceTransactions, fetchOzonProductInfoAttributes, fetchOzonProducts, fetchOzonProductStocks, fetchOzonStockTurnover, fetchOzonWarehouses, shipOzonPosting, updateOzonProductStocks } from "../ozonClient.js";
import { buildOrderOutcomeSql, classifyOrderAccounting, classifyOrderOutcome, estimateOutcomeReturnLoss, resolveOrderLossProfile } from "./order-outcome.js";
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
import {
  getCachedMasterData,
  invalidateExceptionWorkbenchCache,
  invalidateMasterDataCache,
  invalidateMasterDataCachePrefix
} from "./mysql-master-data-cache.js";
import { scheduledJobSummary } from "./scheduled-jobs.js";
import { destroySessionsByPersonIdMysql } from "./mysql-auth-session.js";
import { stockWarehouseRulesMysql } from "./mysql-stock-warehouse-rules.js";
import { ensureProductBarcodeLabelCacheReadyMysql } from "./product-barcode-labels.js";
export {
  cleanExpiredSessionsMysql,
  createSessionMysql,
  destroySessionMysql,
  findPersonByIdMysql,
  findPersonForLoginMysql,
  getSessionMysql,
  updatePersonPasswordMysql
} from "./mysql-auth-session.js";
export {
  createSupplierMysql,
  deleteSupplierMysql,
  suppliersMysql,
  updateSupplierMysql
} from "./mysql-suppliers.js";
export {
  invalidateExceptionWorkbenchCache,
  invalidateMasterDataCache
} from "./mysql-master-data-cache.js";
export {
  createStockWarehouseRuleMysql,
  deleteStockWarehouseRuleMysql,
  stockWarehouseRulesMysql,
  updateStockWarehouseRuleMysql
} from "./mysql-stock-warehouse-rules.js";

const disabledLegacyMirrorStatement = {
  run: () => ({ changes: 0, lastInsertRowid: null }),
  get: () => null,
  all: () => []
};

const db = {
  prepare: () => disabledLegacyMirrorStatement,
  exec: () => {}
};

const BUILTIN_QUALITY_CHECK_PREFIXES_MYSQL = ["02090", "0213", "02131", "0247", "02478", "0249"];

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

function invalidateOrderLogisticsRuleCachesMysql() {
  logisticsRuleFilterCacheMysql = null;
  orderLogisticsRuleMatchCacheMysql.clear();
  invalidateMasterDataCachePrefix("orders:logistics-");
}

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
      if (["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(error?.code)) continue;
      if (/Duplicate column name|Duplicate key name/i.test(error?.message || "")) continue;
      throw error;
    }
  }
}

async function ensureOzonStockStorageSchemaMysql() {
  if (ozonStockStorageSchemaReady) return;
  await ensureMysqlColumns("ozon_stock_snapshots", [
    "ALTER TABLE ozon_stock_snapshots ADD COLUMN free_stock_count DECIMAL(18,4) NOT NULL DEFAULT 0",
    "ALTER TABLE ozon_stock_snapshots ADD COLUMN paid_stock_count DECIMAL(18,4) NOT NULL DEFAULT 0",
    "ALTER TABLE ozon_stock_snapshots ADD COLUMN expiring_stock_count DECIMAL(18,4) NOT NULL DEFAULT 0",
    "ALTER TABLE ozon_stock_snapshots ADD COLUMN waitingdocs_stock_count DECIMAL(18,4) NOT NULL DEFAULT 0",
    "ALTER TABLE ozon_stock_snapshots ADD COLUMN paid_storage_start_at DATE NULL",
    "ALTER TABLE ozon_stock_snapshots ADD COLUMN stock_days DECIMAL(18,4) NULL",
    "ALTER TABLE ozon_stock_snapshots ADD COLUMN average_daily_sales DECIMAL(18,4) NULL",
    "ALTER TABLE ozon_stock_snapshots ADD COLUMN stock_level VARCHAR(64) NOT NULL DEFAULT ''"
  ]);
  ozonStockStorageSchemaReady = true;
}

async function ensureStockLocationSchemaMysql() {
  if (stockLocationSchemaReadyMysql) return;
  await ensureMysqlColumns("outbound_records", [
    "ALTER TABLE outbound_records ADD COLUMN stock_location VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN'",
    "ALTER TABLE outbound_records ADD COLUMN stock_location_source VARCHAR(64) NOT NULL DEFAULT 'legacy_unknown'",
    "CREATE INDEX idx_outbound_stock_location ON outbound_records (stock_location, status, created_at)"
  ]);
  await ensureMysqlColumns("inventory_movements", [
    "ALTER TABLE inventory_movements ADD COLUMN stock_location VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN'",
    "ALTER TABLE inventory_movements ADD COLUMN stock_location_source VARCHAR(64) NOT NULL DEFAULT 'legacy_unknown'",
    "CREATE INDEX idx_inventory_stock_location ON inventory_movements (stock_location, status, created_at)"
  ]);
  stockLocationSchemaReadyMysql = true;
}

async function ensureProfitAnalyticsSchemaMysql() {
  if (profitAnalyticsSchemaReadyMysql) return;
  await ensureMysqlColumns("analytics_shop_daily", [
    "ALTER TABLE analytics_shop_daily ADD COLUMN total_revenue DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER item_quantity",
    "ALTER TABLE analytics_shop_daily ADD COLUMN effective_orders INT NOT NULL DEFAULT 0 AFTER order_count",
    "ALTER TABLE analytics_shop_daily ADD COLUMN accrued_profit DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER current_profit",
    "ALTER TABLE analytics_shop_daily ADD COLUMN accrued_order_count INT NOT NULL DEFAULT 0 AFTER accrued_profit",
    "ALTER TABLE analytics_shop_daily ADD COLUMN pending_profit DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER accrued_order_count",
    "ALTER TABLE analytics_shop_daily ADD COLUMN pending_order_count INT NOT NULL DEFAULT 0 AFTER pending_profit",
    "ALTER TABLE analytics_shop_daily ADD COLUMN cancelled_quantity INT NOT NULL DEFAULT 0 AFTER cancelled_orders",
    "ALTER TABLE analytics_shop_daily ADD COLUMN return_loss DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER return_revenue"
  ]);
  profitAnalyticsSchemaReadyMysql = true;
}

const STOCK_ALERT_BASE_CACHE_TTL_MS = 5 * 60_000;
const EXCEPTION_WORKBENCH_CACHE_TTL_MS = 45_000;
const ORDER_COUNTS_CACHE_TTL_MS = 180_000;
const ORDER_LOGISTICS_ROW_CACHE_TTL_MS = 10 * 60_000;
const PROFIT_DASHBOARD_CACHE_TTL_MS = 5 * 60_000;
const ORDER_LABEL_PREFETCH_INITIAL_DELAY_MS = 5 * 60 * 1000;
const ORDER_LABEL_PREFETCH_RETRY_DELAY_MS = 10 * 60 * 1000;
const ORDER_LABEL_PREFETCH_MAX_ATTEMPTS = 3;
const pendingOrderLabelPrefetchTimers = new Map();
let orderLabelPrintSchemaReady = false;
let orderPackageLabelCacheSchemaReady = false;
let ozonStockStorageSchemaReady = false;
let dashboardSnapshotSchemaReady = false;
let profitAnalyticsSchemaReadyMysql = false;
let stockLocationSchemaReadyMysql = false;
let logisticsRuleFilterCacheMysql = null;
const orderLogisticsRuleMatchCacheMysql = new Map();
let shopWatermarkSchemaReadyMysql = false;
let shopAdvertisingCredentialSchemaReadyMysql = false;
let procurementOrderSourceSchemaReadyMysql = false;
let procurementRequestTimestampSchemaReadyMysql = false;
let fbpTransferRecordsSchemaReadyMysql = false;
const dashboardSnapshotRefreshJobsMysql = new Map();

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

async function ensureDashboardSnapshotSchemaMysql() {
  if (dashboardSnapshotSchemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS dashboard_snapshots (
      snapshot_key VARCHAR(64) NOT NULL PRIMARY KEY,
      date_key DATE NOT NULL,
      payload_json JSON NOT NULL,
      source_updated_at DATETIME NULL,
      refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dashboard_snapshots_date (date_key),
      KEY idx_dashboard_snapshots_refreshed (refreshed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  dashboardSnapshotSchemaReady = true;
}

async function ensureProcurementOrderSourceSchemaMysql() {
  if (procurementOrderSourceSchemaReadyMysql) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS order_item_procurement_marks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      order_item_id BIGINT UNSIGNED NOT NULL,
      order_id BIGINT UNSIGNED NOT NULL,
      product_id BIGINT UNSIGNED NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'handled',
      handling_type VARCHAR(32) NOT NULL DEFAULT 'procurement_request',
      note TEXT NULL,
      created_by_person_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_order_item_procurement_marks_item (order_item_id),
      KEY idx_order_item_procurement_marks_order (order_id),
      KEY idx_order_item_procurement_marks_product (product_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  const statements = [
    "ALTER TABLE procurement_requests ADD COLUMN source_order_id BIGINT UNSIGNED NULL",
    "ALTER TABLE procurement_requests ADD COLUMN source_order_item_id BIGINT UNSIGNED NULL",
    "ALTER TABLE procurement_requests ADD COLUMN source_ozon_sku VARCHAR(128) NULL",
    "CREATE INDEX idx_procurement_source_order_item ON procurement_requests (source_order_item_id)",
    "CREATE INDEX idx_procurement_source_order ON procurement_requests (source_order_id)"
  ];
  for (const sql of statements) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (!["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(error?.code)) throw error;
    }
  }
  procurementOrderSourceSchemaReadyMysql = true;
}

async function ensureProcurementRequestTimestampSchemaMysql() {
  if (procurementRequestTimestampSchemaReadyMysql) return;
  await ensureMysqlColumns("procurement_requests", [
    "ALTER TABLE procurement_requests ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at"
  ]);
  procurementRequestTimestampSchemaReadyMysql = true;
}

async function ensureFbpTransferRecordsSchemaMysql() {
  if (fbpTransferRecordsSchemaReadyMysql) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS fbp_transfer_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      product_id BIGINT UNSIGNED NOT NULL,
      mapping_id BIGINT UNSIGNED NULL,
      shop_id BIGINT UNSIGNED NULL,
      ozon_sku VARCHAR(128) NOT NULL DEFAULT '',
      quantity INT NOT NULL DEFAULT 0,
      listed_quantity INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      tracking_no VARCHAR(128) NOT NULL DEFAULT '',
      box_no VARCHAR(128) NOT NULL DEFAULT '',
      source_type VARCHAR(32) NOT NULL DEFAULT 'manual',
      source_ref VARCHAR(128) NOT NULL DEFAULT '',
      warehouse_name VARCHAR(255) NOT NULL DEFAULT '',
      note TEXT NULL,
      person_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      shipped_at DATETIME NULL,
      expected_arrival_at DATETIME NULL,
      closed_at DATETIME NULL,
      KEY idx_fbp_transfer_product_status (product_id, status),
      KEY idx_fbp_transfer_mapping_status (mapping_id, status),
      KEY idx_fbp_transfer_shop_sku_status (shop_id, ozon_sku, status),
      KEY idx_fbp_transfer_source (source_type, source_ref),
      KEY idx_fbp_transfer_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  const statements = [
    "ALTER TABLE fbp_transfer_records ADD COLUMN source_type VARCHAR(32) NOT NULL DEFAULT 'manual'",
    "ALTER TABLE fbp_transfer_records ADD COLUMN source_ref VARCHAR(128) NOT NULL DEFAULT ''",
    "ALTER TABLE fbp_transfer_records ADD COLUMN warehouse_name VARCHAR(255) NOT NULL DEFAULT ''",
    "ALTER TABLE fbp_transfer_records DROP INDEX uk_fbp_transfer_source_line",
    "CREATE INDEX idx_fbp_transfer_source ON fbp_transfer_records (source_type, source_ref)"
  ];
  for (const sql of statements) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_CANT_DROP_FIELD_OR_KEY"].includes(error?.code)) continue;
      throw error;
    }
  }
  fbpTransferRecordsSchemaReadyMysql = true;
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
let assetVariantJobsSchemaReadyMysql = false;

async function ensureSelectionCreativeSchemaMysql() {
  if (selectionCreativeSchemaReadyMysql) return;
  const statements = [
    "ALTER TABLE products ADD COLUMN detail_image_urls LONGTEXT NULL",
    "ALTER TABLE products ADD COLUMN material VARCHAR(255) NULL",
    "ALTER TABLE products ADD COLUMN color VARCHAR(255) NULL",
    "ALTER TABLE products ADD COLUMN vehicle_brand VARCHAR(255) NULL",
    "ALTER TABLE products ADD COLUMN vehicle_model VARCHAR(255) NULL",
    "ALTER TABLE products ADD COLUMN selling_points TEXT NULL",
    "ALTER TABLE products ADD COLUMN listing_title_ru TEXT NULL",
    "ALTER TABLE products ADD COLUMN listing_tags_ru TEXT NULL",
    "ALTER TABLE products ADD COLUMN listing_description_ru TEXT NULL",
    "ALTER TABLE products ADD COLUMN listing_title_prompt TEXT NULL",
    "ALTER TABLE products ADD COLUMN listing_tags_prompt TEXT NULL",
    "ALTER TABLE products ADD COLUMN listing_description_prompt TEXT NULL",
    "ALTER TABLE products ADD COLUMN ozon_category_id VARCHAR(128) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN ozon_description_category_id BIGINT NOT NULL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN ozon_type_id BIGINT NOT NULL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN ozon_category_name VARCHAR(500) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN source_selection_id BIGINT NULL",
    "ALTER TABLE products ADD COLUMN variant_task_id VARCHAR(128) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN variant_result_id VARCHAR(128) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN variant_type VARCHAR(64) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN is_variant_generated TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN material_asset_status VARCHAR(64) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN advertising_rate DECIMAL(10,4) NOT NULL DEFAULT 0",
    "CREATE INDEX idx_products_selection_owner_updated ON products (active, owner_person_id, updated_at, id)",
    "CREATE INDEX idx_products_selection_status_updated ON products (active, selection_status, product_type, updated_at, id)",
    "CREATE INDEX idx_products_selection_active_updated ON products (active, updated_at, id)"
  ];
  for (const sql of statements) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (!["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(error?.code)) throw error;
    }
  }
  selectionCreativeSchemaReadyMysql = true;
}

async function ensureAssetVariantJobsTableMysql() {
  if (assetVariantJobsSchemaReadyMysql) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS asset_variant_jobs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      job_no VARCHAR(64) NOT NULL,
      job_type VARCHAR(64) NOT NULL DEFAULT 'publish_selection',
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      product_id BIGINT NULL,
      batch_id VARCHAR(128) NOT NULL DEFAULT '',
      total_count INT NOT NULL DEFAULT 0,
      success_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      request_json LONGTEXT NULL,
      result_json LONGTEXT NULL,
      error_json LONGTEXT NULL,
      created_by_person_id BIGINT NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_asset_variant_jobs_no (job_no),
      INDEX idx_asset_variant_jobs_status (status, created_at),
      INDEX idx_asset_variant_jobs_product (product_id, created_at),
      INDEX idx_asset_variant_jobs_product_type_id (product_id, job_type, id),
      INDEX idx_asset_variant_jobs_status_id (status, id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  for (const sql of [
    "CREATE INDEX idx_asset_variant_jobs_product_type_id ON asset_variant_jobs (product_id, job_type, id)",
    "CREATE INDEX idx_asset_variant_jobs_status_id ON asset_variant_jobs (status, id)"
  ]) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (error?.code !== "ER_DUP_KEYNAME") throw error;
    }
  }
  assetVariantJobsSchemaReadyMysql = true;
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
  await mysqlExecute(`
    UPDATE products p
    JOIN product_merge_history h ON h.target_product_id = p.id AND h.status = 'merged'
    SET p.product_type = 'main',
        p.selection_status = 'listed',
        p.updated_at = CURRENT_TIMESTAMP
    WHERE p.active = 1
      AND COALESCE(p.product_type, 'main') = 'selection'
      AND COALESCE(p.parent_product_id, 0) = 0
  `);
  productMergeSchemaReadyMysql = true;
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

function withProductImageEndpointMysql(row, options = {}) {
  if (!row) return row;
  const image = String(row.image_url || "");
  if (!shouldServeProductImageThroughEndpointMysql(image)) return row;
  return {
    ...row,
    image_url: productImageEndpointMysql(row, options)
  };
}

function compactProductImageUrlForListMysql(row = {}) {
  const image = String(row.image_url || "");
  if (!shouldServeProductImageThroughEndpointMysql(image)) return image;
  return productImageEndpointMysql({
    id: row.id || row.product_id,
    updated_at: row.updated_at || row.image_updated_at || row.created_at
  }, { thumbnail: true });
}

function productImageEndpointMysql(row = {}, options = {}) {
  const versionSource = row.updated_at || row.image_updated_at || "";
  const params = new URLSearchParams();
  if (versionSource) params.set("v", String(versionSource));
  if (options.thumbnail) params.set("thumb", "1");
  if (options.width) params.set("w", String(options.width));
  const query = params.toString();
  return `/api/products/${row.id}/image${query ? `?${query}` : ""}`;
}

function productDetailImageEndpointMysql(row = {}, index = 0, options = {}) {
  const versionSource = row.updated_at || row.image_updated_at || "";
  const params = new URLSearchParams();
  if (versionSource) params.set("v", String(versionSource));
  if (options.thumbnail) params.set("thumb", "1");
  if (options.width) params.set("w", String(options.width));
  const query = params.toString();
  return `/api/products/${row.id}/detail-images/${index}${query ? `?${query}` : ""}`;
}

function compactProductListRowMysql(row) {
  const imageUrl = String(row.image_url || "");
  return {
    id: row.id,
    selection_id: row.selection_id,
    code: row.code,
    inventory_id: row.inventory_id,
    name: row.name,
    image_url: shouldServeProductImageThroughEndpointMysql(imageUrl) ? productImageEndpointMysql(row, { thumbnail: true }) : imageUrl,
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
    manual_outbound_quantity: Number(row.manual_outbound_quantity || 0),
    manual_outbound_amount: Number(row.manual_outbound_amount || 0),
    incoming_stock: Number(row.incoming_stock || 0),
    fbp_stock: Number(row.fbp_stock || row.fbp_total || 0),
    fbp_transfer_in_transit_qty: Number(row.fbp_transfer_in_transit_qty || 0),
    fbs_stock: Number(row.fbs_stock || row.fbs_total || 0),
    inventory_value: Number(row.inventory_value || 0),
    sku_count: Number(row.sku_count || 0),
    mapped_skus: row.mapped_skus || "",
    origin_skus: row.origin_skus || "",
    total_sales_quantity: Number(row.total_sales_quantity || 0),
    total_sales_amount: Number(row.total_sales_amount || 0),
    avg_sale_price: Number(row.avg_sale_price || 0),
    estimated_profit_total: Number(row.estimated_profit_total || 0),
    actual_profit_total: Number(row.actual_profit_total || 0),
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
    avgPurchaseCost,
    status_counts: selectionBusinessStatusCountsMysql(rows)
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

function expectedUpdatedAtFromBody(body = {}) {
  return body.updated_at || body.updatedAt || body.version_updated_at || body.versionUpdatedAt || "";
}

function isSameMysqlTimestamp(left, right) {
  const normalizedLeft = normalizeMysqlDateTime(left);
  const normalizedRight = normalizeMysqlDateTime(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function throwStaleRecordError(message = "This record was modified by someone else. Please refresh before editing.") {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

function assertFreshRecord(body = {}, existing = {}, message) {
  const expectedUpdatedAt = expectedUpdatedAtFromBody(body);
  if (expectedUpdatedAt && !isSameMysqlTimestamp(expectedUpdatedAt, existing.updated_at)) {
    throwStaleRecordError(message);
  }
}

function firstJsonItem(value) {
  const parsed = parseJsonOrNull(value);
  if (!Array.isArray(parsed)) return "";
  const first = parsed.find((item) => String(item || "").trim());
  return first ? String(first) : "";
}

function normalizeProductImageUrlMysql(value) {
  const image = String(value || "").trim();
  if (/^\/api\/products\/\d+\/image(?:[?#].*)?$/i.test(image)) return "";
  return image;
}

function shouldServeProductImageThroughEndpointMysql(image) {
  return String(image || "").startsWith("data:image/")
    || /^\/api\/ai\/file\/[^/]+\/[^/]+\/.+/i.test(String(image || ""));
}

function isProductImageEndpointMysql(value, productId) {
  const image = String(value || "").trim();
  if (!image) return false;
  const match = image.match(/^\/api\/products\/(\d+)\/(?:image|detail-images\/\d+)(?:[?#].*)?$/i);
  if (!match) return false;
  return !productId || Number(match[1]) === Number(productId);
}

function productDetailImageEndpointIndexMysql(value, productId) {
  const image = String(value || "").trim();
  if (!image) return null;
  const match = image.match(/^\/api\/products\/(\d+)\/detail-images\/(\d+)(?:[?#].*)?$/i);
  if (!match) return null;
  if (productId && Number(match[1]) !== Number(productId)) return null;
  return Number(match[2]);
}

function productDetailImageListMysql(value) {
  const parsed = parseJsonOrNull(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(parsed)
      ? parsed
      : String(value || "").split(/\r?\n|,/);
  return list.map((item) => String(item || "").trim()).filter(Boolean);
}

function productDetailImagePreviewUrlsMysql(row = {}, options = {}) {
  return productDetailImageListMysql(row.detail_image_urls).map((image, index) => {
    if (!shouldServeProductImageThroughEndpointMysql(image)) return image;
    return productDetailImageEndpointMysql(row, index, options);
  });
}

function normalizeOzonCategoryIdMysql(value) {
  return String(value || "").trim().slice(0, 128);
}

function normalizeOzonCategoryNameMysql(value) {
  return String(value || "").trim().slice(0, 500);
}

function normalizeProductDetailImagesMysql(value) {
  const list = productDetailImageListMysql(value);
  return JSON.stringify(list.map((item) => normalizeProductImageUrlMysql(item)).filter(Boolean));
}

function normalizeProductDetailImagesForUpdateMysql(value, existingValue = "", productId = null) {
  const rawList = productDetailImageListMysql(value);
  const existingList = productDetailImageListMysql(existingValue);
  const resolvedList = rawList.map((item) => {
    const endpointIndex = productDetailImageEndpointIndexMysql(item, productId);
    if (endpointIndex !== null) return existingList[endpointIndex] || "";
    return normalizeProductImageUrlMysql(item);
  }).filter(Boolean);
  const normalized = JSON.stringify(resolvedList);
  const normalizedList = parseJsonOrNull(normalized) || [];
  if (!normalizedList.length && rawList.some((item) => isProductImageEndpointMysql(item, productId))) {
    return existingValue || normalized;
  }
  return normalized;
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

export function normalizePurchasePlanMysql(body = {}) {
  const quantity = Math.max(1, Number(body.procurement_quantity ?? (body.purchase_quantity || 1)));
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
  { key: "created_by_person_id", label: "创建人", type: "person" }
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
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : chinaDateKeyMysql(value);
  }
  const raw = String(value).trim();
  if (!raw) return "";
  const matched = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (matched) return matched[1];
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return chinaDateKeyMysql(date);
}

function normalizeMysqlNullableDate(value) {
  const text = normalizeSyncDateMysql(value);
  return text || null;
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

function normalizeStockLocationMysql(value = "") {
  const text = String(value || "").trim().toUpperCase();
  return ["LOCAL", "FBP", "UNKNOWN"].includes(text) ? text : "UNKNOWN";
}

function isFbpLogisticsTextMysql(value = "") {
  return /fbp|fbo|hunchun|hun chun|hch-pd|hch-cr|cel fbp|fbp standard|珲春|混春|混川/i.test(String(value || ""));
}

function resolveOrderStockLocationMysql(posting = {}) {
  const raw = parseOzonPostingRawMysql(posting);
  const deliveryMethod = raw.delivery_method || posting.delivery_method || {};
  const analytics = raw.analytics_data || posting.analytics_data || {};
  const warehouseName = textValueMysql(deliveryMethod.warehouse, deliveryMethod.name, raw.warehouse_name, posting.warehouse_name);
  const deliveryMethodName = textValueMysql(deliveryMethod.name, posting.delivery_method_name);
  const logisticsChannel = textValueMysql(deliveryMethod.tpl_provider, analytics.tpl_provider, raw.tpl_provider, posting.logistics_channel, posting.tracking_number);
  const logisticsText = `${warehouseName} ${deliveryMethodName} ${logisticsChannel} ${raw.delivery_type || ""} ${posting.raw_json || ""}`;
  const ruleValue = resolveOrderLogisticsRuleValue({
    value: posting.resolved_logistics_rule_value,
    label: posting.resolved_logistics_rule_name,
    name: deliveryMethodName,
    channel: logisticsChannel,
    carrier: deliveryMethodName,
    warehousePatterns: [warehouseName, deliveryMethodName, logisticsChannel]
  });
  const hasLogisticsText = Boolean(String(logisticsText || "").trim());
  if (ruleValue === "hunchun_2" || isFbpLogisticsTextMysql(logisticsText)) {
    return { stockLocation: "FBP", stockLocationSource: "order_warehouse_rule" };
  }
  if (hasLogisticsText) {
    return { stockLocation: "LOCAL", stockLocationSource: "order_warehouse_rule" };
  }
  return { stockLocation: "UNKNOWN", stockLocationSource: "missing_order_warehouse" };
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

async function mysqlConnectionQuery(connection, sql, params = []) {
  const [rows] = await connection.query(sql, params);
  return rows;
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
  return [...new Set([
    ...BUILTIN_QUALITY_CHECK_PREFIXES_MYSQL,
    ...rows.map((row) => String(row.prefix || "").trim()).filter(Boolean)
  ])].sort();
}

async function classifyOrderAccountingMysql(row = {}) {
  return classifyOrderAccounting(row, { qualityPrefixes: await orderQualityPrefixesMysql() });
}

function buildOnlineProductPayload(shopId, item = {}) {
  const storageSku = storageSafeOnlineProductSku(item);
  return [
    Number(shopId),
    storageSku,
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
    normalizeMysqlNullableDateTime(item.published_at),
    normalizeMysqlDateTime(item.ozon_updated_at)
  ];
}

function resolveOnlineProductPublishedAtMysql(row = {}) {
  const raw = parseJsonOrNull(row.raw_json) || {};
  return normalizeMysqlNullableDateTime(
    row.published_at
    || raw.published_at
    || raw.publishedAt
    || raw.created_at
    || raw.createdAt
    || raw.date
    || ""
  );
}

function strictOzonSkuValue(item = {}) {
  return String(
    item.sku
      || item.ozon_sku
      || item.product_sku
      || item.productSku
      || item.fbo_sku
      || item.fbs_sku
      || ""
  );
}

function missingOnlineProductSkuMarker(item = {}) {
  const productId = String(item.ozon_product_id || item.product_id || item.id || "").trim();
  const offerId = String(item.offer_id || "").trim();
  const seed = productId || offerId || "unknown";
  return `__MISSING_SKU__:${seed}`.slice(0, 128);
}

function storageSafeOnlineProductSku(item = {}) {
  const sku = String(item.ozon_sku || "").trim();
  return sku || missingOnlineProductSkuMarker(item);
}

async function upsertOnlineProductDualWrite(shopId, item = {}) {
  const payload = buildOnlineProductPayload(shopId, item);
  await mysqlExecute(`
    INSERT INTO online_products
    (shop_id, ozon_sku, offer_id, ozon_product_id, name, image_url, primary_image, sale_price,
     currency_code, marketing_price, old_price, status, visibility, archived, is_discounted,
     images_json, barcodes_json, stocks_json, commissions_json, attributes_json, raw_json, published_at, ozon_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      published_at = VALUES(published_at),
      ozon_updated_at = VALUES(ozon_updated_at),
      synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `, payload);

  db.prepare(`
    INSERT INTO online_products
    (shop_id, ozon_sku, offer_id, ozon_product_id, name, image_url, primary_image, sale_price,
     currency_code, marketing_price, old_price, status, visibility, archived, is_discounted,
     images_json, barcodes_json, stocks_json, commissions_json, attributes_json, raw_json, published_at, ozon_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      published_at = excluded.published_at,
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

async function ensureUserPreferencesSchemaMysql() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS system_settings (
      \`key\` VARCHAR(191) NOT NULL PRIMARY KEY,
      value_json JSON NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

function normalizeUserPreferenceKey(key) {
  const value = String(key || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,96}$/.test(value)) throw new Error("偏好 key 无效");
  return value;
}

function userPreferenceSettingKey(personId, key) {
  return `user_preferences:${Number(personId)}:${normalizeUserPreferenceKey(key)}`;
}

function parseJsonSettingValue(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export async function userPreferenceMysql(query = {}, personId = null) {
  ensureMysqlCutoverEnabled();
  const resolvedPersonId = Number(personId || 0);
  if (!resolvedPersonId) throw new Error("未登录，无法读取个人偏好");
  await ensureUserPreferencesSchemaMysql();
  const key = normalizeUserPreferenceKey(query.key);
  const row = await mysqlQueryOne("SELECT value_json, updated_at FROM system_settings WHERE `key` = ? LIMIT 1", [userPreferenceSettingKey(resolvedPersonId, key)]);
  return {
    key,
    value: parseJsonSettingValue(row?.value_json, null),
    updated_at: row?.updated_at || null
  };
}

export async function updateUserPreferenceMysql(body = {}, personId = null) {
  ensureMysqlCutoverEnabled();
  const resolvedPersonId = Number(personId || 0);
  if (!resolvedPersonId) throw new Error("未登录，无法保存个人偏好");
  await ensureUserPreferencesSchemaMysql();
  const key = normalizeUserPreferenceKey(body.key);
  const value = body.value === undefined ? null : body.value;
  await mysqlExecute(`
    INSERT INTO system_settings (\`key\`, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      value_json = VALUES(value_json),
      updated_at = CURRENT_TIMESTAMP
  `, [userPreferenceSettingKey(resolvedPersonId, key), JSON.stringify(value)]);
  return { ok: true, key, value };
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
  const accounting = await classifyOrderAccountingMysql(orderContext);
  const qty = Number(quantity || item?.quantity || 1);
  const saleAmount = Number(salePrice || item?.sale_price || 0) * qty;
  return estimateOutcomeReturnLoss({
    outcome: accounting.outcome_type,
    lossProfileCode: accounting.loss_profile_code,
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

  invalidateOrderLogisticsRuleCachesMysql();
  invalidateMasterDataCache();
  return { id: Number(result.insertId) };
}

export async function updateLogisticsRuleMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  const existing = await mysqlQueryOne("SELECT * FROM logistics_fee_rules WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("Logistics rule not found");
  assertFreshRecord(body, existing, "物流规则已被其他用户保存，请刷新后再继续编辑");

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

  invalidateOrderLogisticsRuleCachesMysql();
  invalidateMasterDataCache();
  return { ok: true };
}

export async function deleteLogisticsRuleMysql(id) {
  ensureMysqlCutoverEnabled();
  await mysqlExecute("UPDATE logistics_fee_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  db.prepare("UPDATE logistics_fee_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id));
  invalidateOrderLogisticsRuleCachesMysql();
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
  invalidateOrderLogisticsRuleCachesMysql();
  invalidateMasterDataCache();
  return { ok: true };
}

async function activeOrderLogisticsFilterMethodsMysql() {
  ensureMysqlCutoverEnabled();
  if (logisticsRuleFilterCacheMysql) return logisticsRuleFilterCacheMysql;
  await ensureLogisticsRuleFilterSchemaMysql();
  const [configuredRow, rows] = await Promise.all([
    mysqlQueryOne("SELECT COUNT(*) AS count FROM logistics_fee_rules"),
    mysqlQuery(`
      SELECT id, name, filter_keywords, carrier, channel, min_weight_g, usage_count
      FROM logistics_fee_rules
      WHERE enabled != 0
      ORDER BY usage_count DESC, carrier ASC, channel ASC, min_weight_g ASC, id ASC
    `)
  ]);
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
  if (!rules.length) {
    logisticsRuleFilterCacheMysql = Number(configuredRow?.count || 0) > 0 ? [] : FALLBACK_ORDER_LOGISTICS_METHODS_MYSQL;
    return logisticsRuleFilterCacheMysql;
  }
  const mergedByValue = new Map();
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
  logisticsRuleFilterCacheMysql = [...mergedByValue.values()];
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

function orderLogisticsRuleByLabelOrValueMysql(methods = [], label = "", value = "") {
  const normalizedLabel = String(label || "").trim().toLowerCase();
  if (normalizedLabel) {
    const exact = methods.find((rule) => String(rule.label || "").trim().toLowerCase() === normalizedLabel);
    if (exact) return exact;
  }
  const normalizedValue = String(value || resolveOrderLogisticsRuleValue({ label }) || "").trim();
  return normalizedValue ? methods.find((rule) => String(rule.value || "").trim() === normalizedValue) || null : null;
}

function matchOrderLogisticsRuleFromTextMysql(text, methods = []) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("guoo economy budget")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "GUOO 低客单轻小件");
  }
  if (normalized.includes("guoo economy small")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "GUOO 轻小件");
  }
  if (normalized.includes("guoo economy extra small")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "GUOO 超级轻小件");
  }
  if (normalized.includes("guoo")) return null;
  if (normalized.includes("hunchun") || normalized.includes("hch-pd") || normalized.includes("hch-cr") || normalized.includes("cel fbp")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "CEL Hunchun 2", "hunchun_2");
  }
  if (normalized.includes("china post") || normalized.includes("邮政")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "中国邮政 500g 以下", "postal_1_500g");
  }
  if (normalized.includes("0.5-30kg")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "CEL 陆运 0.5-30kg", "cel_land_0_5_30kg");
  }
  if (normalized.includes("500-25000g")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "CEL 陆运经济 Budget", "cel_land_500_25000g");
  }
  if (normalized.includes("cel economy big") || normalized.includes("2-30kg")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "CEL 陆运经济 Big", "cel_land_2_30kg");
  }
  if (normalized.includes("cel economy small")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "CEL 陆运经济 Small", "cel_land_1_500g");
  }
  if (normalized.includes("cel economy extra small") || normalized.includes("extra small economy")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "CEL 陆运经济 Extra Small", "cel_air_land_1_500g");
  }
  if (normalized.includes("cel standard extra small") || normalized.includes("extra small standard")) {
    return orderLogisticsRuleByLabelOrValueMysql(methods, "CEL 陆空标准 Extra Small", "cel_air_land_1_500g");
  }
  for (const rule of methods) {
    const patterns = Array.isArray(rule.warehousePatterns) ? rule.warehousePatterns : [];
    if (patterns.some((pattern) => normalized.includes(String(pattern || "").toLowerCase()))) {
      return rule;
    }
  }
  return null;
}

function orderLogisticsMatchCacheKeyMysql(row = {}, methods = []) {
  const methodSignature = methods
    .map((method) => `${method.value || ""}:${method.label || ""}:${(method.warehousePatterns || []).join("|")}`)
    .join(";");
  const text = `${row.tracking_number || ""} ${row.raw_json || ""}`;
  return createHash("sha1")
    .update(methodSignature)
    .update("\n")
    .update(text)
    .digest("hex");
}

function cachedOrderLogisticsRuleFromRowMysql(row = {}, methods = []) {
  const key = orderLogisticsMatchCacheKeyMysql(row, methods);
  const cached = orderLogisticsRuleMatchCacheMysql.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = normalizeResolvedLogisticsRuleMysql(
    matchOrderLogisticsRuleFromTextMysql(`${row.tracking_number || ""} ${row.raw_json || ""}`, methods)
  );
  orderLogisticsRuleMatchCacheMysql.set(key, {
    value,
    expiresAt: Date.now() + ORDER_LOGISTICS_ROW_CACHE_TTL_MS
  });
  if (orderLogisticsRuleMatchCacheMysql.size > 20_000) {
    const now = Date.now();
    for (const [cacheKey, item] of orderLogisticsRuleMatchCacheMysql) {
      if (item.expiresAt <= now || orderLogisticsRuleMatchCacheMysql.size > 12_000) {
        orderLogisticsRuleMatchCacheMysql.delete(cacheKey);
      }
      if (orderLogisticsRuleMatchCacheMysql.size <= 12_000) break;
    }
  }
  return value;
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
  assertFreshRecord(body, existing, "取消规则已被其他用户保存，请刷新后再继续编辑");

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
  await ensureOzonStockStorageSchemaMysql();
  const products = await getCachedMasterData("stock-alerts:base:v2", async () => {
    const rows = await mysqlQuery(`
    SELECT p.id AS product_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0')) END AS inventory_id,
      p.name AS product_name, p.image_url, p.alert_stock, p.created_at,
      COALESCE(ic.available_stock, 0) AS local_stock,
      sm.id AS mapping_id, sm.shop_id, sm.ozon_sku, sm.offer_id, sm.display_name, sm.active,
      s.name AS shop_name,
      COALESCE(op_by_id.id, op_by_sku.id) AS online_product_id,
      COALESCE(op_by_id.ozon_product_id, op_by_sku.ozon_product_id) AS ozon_product_id,
      COALESCE(op_by_id.name, op_by_sku.name) AS online_name,
      COALESCE(op_by_id.primary_image, op_by_sku.primary_image) AS online_image,
      COALESCE(op_by_id.image_url, op_by_sku.image_url) AS online_image_url,
      COALESCE(stock.fbp_present, 0) AS fbp_present,
      COALESCE(stock.fbp_available, 0) AS fbp_available,
      COALESCE(stock.fbs_present, 0) AS fbs_present,
      COALESCE(stock.fbs_available, 0) AS fbs_available,
      COALESCE(stock.unknown_present, 0) AS unknown_present,
      COALESCE(stock.free_stock_count, 0) AS free_stock_count,
      COALESCE(stock.paid_stock_count, 0) AS paid_stock_count,
      COALESCE(stock.expiring_stock_count, 0) AS expiring_stock_count,
      COALESCE(stock.waitingdocs_stock_count, 0) AS waitingdocs_stock_count,
      stock.paid_storage_start_at, stock.stock_days, stock.average_daily_sales, stock.stock_level,
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
    LEFT JOIN online_products op_by_id ON op_by_id.id = sm.online_product_id
    LEFT JOIN online_products op_by_sku ON op_by_sku.shop_id = sm.shop_id AND op_by_sku.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT shop_id, ozon_sku,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN available ELSE 0 END) AS fbp_available,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN available ELSE 0 END) AS fbs_available,
        SUM(CASE WHEN stock_type = 'unknown' THEN present ELSE 0 END) AS unknown_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN free_stock_count ELSE 0 END) AS free_stock_count,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN paid_stock_count ELSE 0 END) AS paid_stock_count,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN expiring_stock_count ELSE 0 END) AS expiring_stock_count,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN waitingdocs_stock_count ELSE 0 END) AS waitingdocs_stock_count,
        MIN(CASE WHEN stock_type = 'fbp_real' THEN paid_storage_start_at ELSE NULL END) AS paid_storage_start_at,
        MAX(CASE WHEN stock_type = 'fbp_real' THEN stock_days ELSE NULL END) AS stock_days,
        MAX(CASE WHEN stock_type = 'fbp_real' THEN average_daily_sales ELSE NULL END) AS average_daily_sales,
        MAX(CASE WHEN stock_type = 'fbp_real' THEN stock_level ELSE '' END) AS stock_level,
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
          image_url: compactProductImageUrlForListMysql({
            id: productId,
            image_url: row.image_url,
            created_at: row.created_at
          }),
          alert_stock: Number(row.alert_stock || 0),
          local_stock: Number(row.local_stock || 0),
          created_at: row.created_at,
          skus: [],
          fbp_total: 0,
          fbs_total: 0,
          unknown_total: 0,
          free_stock_count: 0,
          paid_stock_count: 0,
          expiring_stock_count: 0,
          waitingdocs_stock_count: 0,
          paid_storage_start_at: "",
          stock_days: null,
          average_daily_sales: null,
          stock_level: "",
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
        ozon_product_id: row.ozon_product_id,
        online_product_id: row.online_product_id,
        offer_id: row.offer_id,
        name: row.online_name || row.display_name || row.ozon_sku,
        image_url: String(row.online_image || row.online_image_url || "").startsWith("data:image/")
          ? compactProductImageUrlForListMysql({ id: productId, image_url: row.image_url, created_at: row.created_at })
          : (row.online_image || row.online_image_url || ""),
        fbp_present: Number(row.fbp_present || 0),
        fbp_available: Number(row.fbp_available || 0),
        fbs_present: Number(row.fbs_present || 0),
        fbs_available: Number(row.fbs_available || 0),
        fbs_low_threshold: 10,
        unknown_present: Number(row.unknown_present || 0),
        free_stock_count: Number(row.free_stock_count || 0),
        paid_stock_count: Number(row.paid_stock_count || 0),
        expiring_stock_count: Number(row.expiring_stock_count || 0),
        waitingdocs_stock_count: Number(row.waitingdocs_stock_count || 0),
        paid_storage_start_at: row.paid_storage_start_at || "",
        stock_days: row.stock_days == null ? null : Number(row.stock_days),
        average_daily_sales: row.average_daily_sales == null ? null : Number(row.average_daily_sales),
        stock_level: row.stock_level || "",
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
      product.free_stock_count += sku.free_stock_count;
      product.paid_stock_count += sku.paid_stock_count;
      product.expiring_stock_count += sku.expiring_stock_count;
      product.waitingdocs_stock_count += sku.waitingdocs_stock_count;
      product.paid_storage_start_at = maxTextDate(product.paid_storage_start_at, sku.paid_storage_start_at);
      if (sku.stock_days != null) product.stock_days = Math.max(Number(product.stock_days || 0), sku.stock_days);
      if (sku.average_daily_sales != null) product.average_daily_sales = Math.max(Number(product.average_daily_sales || 0), sku.average_daily_sales);
      if (sku.stock_level && !product.stock_level) product.stock_level = sku.stock_level;
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

function fbpOpportunityPriority(score) {
  if (score >= 80) return "high";
  if (score >= 55) return "medium";
  return "watch";
}

function fbpOpportunityPriorityText(priority) {
  if (priority === "high") return "高优先级";
  if (priority === "medium") return "中优先级";
  return "观察";
}

function fbpOpportunityTrendText(row) {
  const week1 = Number(row.week1_qty || 0);
  const week2 = Number(row.week2_qty || 0);
  const week3 = Number(row.week3_qty || 0);
  if (week1 > week2 && week2 > week3) return "连续三周增长";
  if (week1 > week2) return "最近一周增长";
  if (week1 === week2 && week2 === week3) return "三周持平";
  return "波动";
}

function normalizeFbpOpportunityRow(row) {
  const recent30d = Number(row.recent_30d_qty || 0);
  const recent7d = Number(row.recent_7d_qty || 0);
  const week1 = Number(row.week1_qty || 0);
  const week2 = Number(row.week2_qty || 0);
  const week3 = Number(row.week3_qty || 0);
  const fbpAvailable = Number(row.fbp_available || 0);
  const fbsAvailable = Number(row.fbs_available || 0);
  const localStock = Number(row.local_stock || 0);
  const pendingProcurementQty = Number(row.pending_procurement_qty || 0);
  const fbpTransferInTransitQty = Number(row.fbp_transfer_in_transit_qty || 0);
  const effectiveFbpAvailable = fbpAvailable + fbpTransferInTransitQty;
  const dailySales = recent30d > 0 ? recent30d / 30 : 0;
  const coverageDays = dailySales > 0 ? effectiveFbpAvailable / dailySales : null;
  const weeklyIncreasing = week1 > week2 && week2 > week3 && week1 > 0;
  const recentAcceleration = recent30d > 0 && recent7d / recent30d >= 0.35;
  const fbsOpportunity = fbsAvailable > fbpAvailable && recent30d >= 5;
  const activeWeeks = [week1, week2, week3].filter((value) => Number(value || 0) > 0).length;
  const sustainedDemand = recent30d > 0 && (activeWeeks >= 2 || recent7d > 0 || weeklyIncreasing);
  const oneMonthEstimate = Math.ceil(recent30d);
  const targetCoverageDays = 45;
  const targetStock = dailySales > 0 ? Math.ceil(dailySales * targetCoverageDays) : 0;

  let score = 0;
  if (recent30d > 10) score += 32;
  if (recent30d >= 30) score += 12;
  if (weeklyIncreasing) score += 24;
  if (recentAcceleration) score += 16;
  if (effectiveFbpAvailable <= 0) score += 18;
  else if (coverageDays !== null && coverageDays < 7) score += 14;
  else if (coverageDays !== null && coverageDays < 14) score += 10;
  if (fbsOpportunity) score += 8;
  if (localStock > 0) score += 5;
  score = Math.min(100, score);

  const priority = fbpOpportunityPriority(score);
  let suggestedBaseQty = 0;
  let targetDays = 0;
  if (score >= 50 && effectiveFbpAvailable <= 0 && sustainedDemand) {
    targetDays = 30;
    suggestedBaseQty = oneMonthEstimate;
  } else if (score >= 50 && effectiveFbpAvailable > 0 && coverageDays !== null && coverageDays < targetCoverageDays) {
    targetDays = targetCoverageDays;
    suggestedBaseQty = targetStock - effectiveFbpAvailable;
  }
  const suggestedQty = suggestedBaseQty > 0 ? Math.max(5, Math.ceil(suggestedBaseQty)) : 0;
  const suggestedTransferQty = Math.min(Math.max(0, localStock), suggestedQty);
  const suggestedPurchaseQty = Math.max(0, suggestedQty - suggestedTransferQty);
  const suggestedAction = suggestedQty <= 0 ? "observe" : suggestedTransferQty > 0 ? "transfer" : "purchase";
  const suggestedActionText = suggestedAction === "transfer" ? "本地发仓" : suggestedAction === "purchase" ? "先采购" : "观察";
  const reasons = [];
  if (recent30d > 10) reasons.push(`30天销量 ${recent30d} 件`);
  if (weeklyIncreasing) reasons.push(`三周 ${week3}/${week2}/${week1} 件递增`);
  else if (recentAcceleration) reasons.push(`近7天占30天 ${Math.round((recent7d / Math.max(1, recent30d)) * 100)}%`);
  if (effectiveFbpAvailable <= 0) reasons.push(`FBP可用为0，按约1个月销量建议`);
  else if (coverageDays !== null && coverageDays < targetCoverageDays) reasons.push(`FBP约覆盖 ${coverageDays.toFixed(1)} 天，低于45天目标`);
  if (fbsOpportunity) reasons.push(`FBS可售 ${fbsAvailable} 件`);
  if (fbpTransferInTransitQty > 0) reasons.push(`已有发仓在途 ${fbpTransferInTransitQty} 件`);
  if (pendingProcurementQty > 0) reasons.push(`已有采购 ${pendingProcurementQty} 件`);

  return {
    shop_id: row.shop_id,
    shop_name: row.shop_name || "",
    product_id: row.product_id,
    inventory_id: row.inventory_id || "",
    product_name: row.product_name || row.online_name || row.display_name || row.ozon_sku || "",
    online_product_id: row.online_product_id,
    ozon_product_id: row.ozon_product_id || "",
    mapping_id: row.mapping_id,
    ozon_sku: row.ozon_sku || "",
    offer_id: row.offer_id || "",
    name: row.online_name || row.display_name || row.product_name || row.ozon_sku || "",
    image_url: row.online_image || row.online_image_url || row.product_image_url || "",
    recent_7d_qty: recent7d,
    recent_30d_qty: recent30d,
    week1_qty: week1,
    week2_qty: week2,
    week3_qty: week3,
    trend_text: fbpOpportunityTrendText(row),
    fbp_present: Number(row.fbp_present || 0),
    fbp_available: fbpAvailable,
    fbp_effective_available: effectiveFbpAvailable,
    fbp_transfer_in_transit_qty: fbpTransferInTransitQty,
    fbs_present: Number(row.fbs_present || 0),
    fbs_available: fbsAvailable,
    local_stock: localStock,
    pending_procurement_qty: pendingProcurementQty,
    daily_sales: Number(dailySales.toFixed(2)),
    coverage_days: coverageDays === null ? null : Number(coverageDays.toFixed(1)),
    target_days: targetDays,
    target_stock: targetDays === 30 ? oneMonthEstimate : targetStock,
    suggested_qty: suggestedQty,
    suggested_transfer_qty: suggestedTransferQty,
    suggested_purchase_qty: suggestedPurchaseQty,
    suggested_action: suggestedAction,
    suggested_action_text: suggestedActionText,
    score,
    priority,
    priority_text: fbpOpportunityPriorityText(priority),
    reason: reasons.length ? reasons.join("，") : "销量或库存信号不足，暂不建议备货",
    barcode_cached_at: row.barcode_cached_at || "",
    barcode_cached: Boolean(row.barcode_cached_at),
    cached_barcode_value: row.cached_barcode_value || "",
    barcode_cache_source: row.barcode_cache_source || "",
    warehouses: parseWarehouseBreakdown(row.warehouse_breakdown),
    last_synced_at: row.last_synced_at || ""
  };
}

function applyFbpOpportunityQuery(rows, query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize || 20)));
  const text = String(query.query || "").trim().toLowerCase();
  const shopId = String(query.shopId || query.shop_id || "all");
  const priority = String(query.priority || "all");
  const signal = String(query.signal || "all");
  const minSales = Number(query.minSales || 0);
  const sortKey = String(query.sortKey || "score");
  const sortDir = String(query.sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const sortable = new Set(["score", "suggested_qty", "suggested_transfer_qty", "suggested_purchase_qty", "recent_30d_qty", "recent_7d_qty", "coverage_days", "fbp_available", "fbp_transfer_in_transit_qty"]);

  let filtered = rows.filter((row) => row.score >= 50 && row.suggested_qty > 0);
  if (text) {
    filtered = filtered.filter((row) => [
      row.shop_name,
      row.ozon_sku,
      row.offer_id,
      row.name,
      row.product_name,
      row.inventory_id
    ].some((value) => String(value || "").toLowerCase().includes(text)));
  }
  if (shopId !== "all") filtered = filtered.filter((row) => String(row.shop_id || "") === shopId);
  if (priority !== "all") filtered = filtered.filter((row) => row.priority === priority);
  if (minSales > 0) filtered = filtered.filter((row) => Number(row.recent_30d_qty || 0) >= minSales);
  if (signal === "growth") filtered = filtered.filter((row) => row.week1_qty > row.week2_qty && row.week2_qty > row.week3_qty);
  if (signal === "low_stock") filtered = filtered.filter((row) => Number(row.fbp_available || 0) <= 0 || (row.coverage_days !== null && Number(row.coverage_days) < 14));
  if (signal === "fbs_to_fbp") filtered = filtered.filter((row) => Number(row.fbs_available || 0) > Number(row.fbp_available || 0));

  const key = sortable.has(sortKey) ? sortKey : "score";
  filtered.sort((a, b) => {
    const av = a[key] === null || a[key] === undefined ? (sortDir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : Number(a[key] || 0);
    const bv = b[key] === null || b[key] === undefined ? (sortDir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : Number(b[key] || 0);
    const delta = av - bv;
    if (delta !== 0) return sortDir === "asc" ? delta : -delta;
    return String(a.ozon_sku || "").localeCompare(String(b.ozon_sku || ""));
  });

  const total = filtered.length;
  const rowsPage = filtered.slice((page - 1) * pageSize, page * pageSize);
  const summarySource = rows.filter((row) => row.score >= 50 && row.suggested_qty > 0);
  const rowsWithCoverage = summarySource.filter((row) => row.coverage_days !== null && row.coverage_days !== undefined);
  const summary = {
    total: summarySource.length,
    high_count: summarySource.filter((row) => row.priority === "high").length,
    medium_count: summarySource.filter((row) => row.priority === "medium").length,
    watch_count: summarySource.filter((row) => row.priority === "watch").length,
    suggested_total_qty: summarySource.reduce((sum, row) => sum + Number(row.suggested_qty || 0), 0),
    avg_coverage_days: Number((rowsWithCoverage.reduce((sum, row) => sum + Number(row.coverage_days || 0), 0) / Math.max(1, rowsWithCoverage.length)).toFixed(1))
  };
  return { rows: rowsPage, total, page, pageSize, summary };
}

export async function fbpOpportunitiesMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureOzonStockStorageSchemaMysql();
  await ensureProductBarcodeLabelCacheReadyMysql();
  await ensureFbpTransferRecordsSchemaMysql();
  const rows = await mysqlQuery(`
    SELECT
      sm.id AS mapping_id, sm.shop_id, sm.ozon_sku, sm.offer_id, sm.display_name,
      s.name AS shop_name,
      p.id AS product_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0')) END AS inventory_id,
      p.name AS product_name, p.image_url AS product_image_url,
      COALESCE(ic.available_stock, 0) AS local_stock,
      COALESCE(op_by_id.id, op_by_sku.id) AS online_product_id,
      COALESCE(op_by_id.ozon_product_id, op_by_sku.ozon_product_id) AS ozon_product_id,
      COALESCE(op_by_id.name, op_by_sku.name) AS online_name,
      COALESCE(op_by_id.primary_image, op_by_sku.primary_image) AS online_image,
      COALESCE(op_by_id.image_url, op_by_sku.image_url) AS online_image_url,
      cache.fetched_at AS barcode_cached_at,
      cache.barcode_value AS cached_barcode_value,
      cache.fetch_source AS barcode_cache_source,
      COALESCE(stock.fbp_present, 0) AS fbp_present,
      COALESCE(stock.fbp_available, 0) AS fbp_available,
      COALESCE(stock.fbs_present, 0) AS fbs_present,
      COALESCE(stock.fbs_available, 0) AS fbs_available,
      stock.last_synced_at,
      stock.warehouse_breakdown,
      COALESCE(sales.recent_7d_qty, 0) AS recent_7d_qty,
      COALESCE(sales.recent_30d_qty, 0) AS recent_30d_qty,
      COALESCE(sales.week1_qty, 0) AS week1_qty,
      COALESCE(sales.week2_qty, 0) AS week2_qty,
      COALESCE(sales.week3_qty, 0) AS week3_qty,
      COALESCE(procurement.pending_procurement_qty, 0) AS pending_procurement_qty,
      COALESCE(fbp_transfer.fbp_transfer_in_transit_qty, 0) AS fbp_transfer_in_transit_qty
    FROM sku_mappings sm
    JOIN shops s ON s.id = sm.shop_id
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN inventory_current ic ON ic.real_product_id = p.id
    LEFT JOIN online_products op_by_id ON op_by_id.id = sm.online_product_id
    LEFT JOIN online_products op_by_sku ON op_by_sku.shop_id = sm.shop_id AND op_by_sku.ozon_sku = sm.ozon_sku
    LEFT JOIN product_barcode_label_cache cache ON cache.online_product_id = COALESCE(op_by_id.id, op_by_sku.id)
    LEFT JOIN (
      SELECT shop_id, ozon_sku,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN available ELSE 0 END) AS fbp_available,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN available ELSE 0 END) AS fbs_available,
        MAX(synced_at) AS last_synced_at,
        GROUP_CONCAT(CONCAT(warehouse_name, ':', present, '/', available, ':', stock_type) SEPARATOR '||') AS warehouse_breakdown
      FROM ozon_stock_snapshots
      GROUP BY shop_id, ozon_sku
    ) stock ON stock.shop_id = sm.shop_id AND stock.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' AND ${chinaDateSqlMysql("o.ordered_at")} >= ? THEN oi.quantity ELSE 0 END) AS recent_7d_qty,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' AND ${chinaDateSqlMysql("o.ordered_at")} >= ? THEN oi.quantity ELSE 0 END) AS recent_30d_qty,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' AND ${chinaDateSqlMysql("o.ordered_at")} >= ? THEN oi.quantity ELSE 0 END) AS week1_qty,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' AND ${chinaDateSqlMysql("o.ordered_at")} >= ? AND ${chinaDateSqlMysql("o.ordered_at")} < ? THEN oi.quantity ELSE 0 END) AS week2_qty,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' AND ${chinaDateSqlMysql("o.ordered_at")} >= ? AND ${chinaDateSqlMysql("o.ordered_at")} < ? THEN oi.quantity ELSE 0 END) AS week3_qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      GROUP BY o.shop_id, oi.ozon_sku
    ) sales ON sales.shop_id = sm.shop_id AND sales.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT product_id, SUM(quantity) AS pending_procurement_qty
      FROM procurement_requests
      WHERE status NOT IN ('cancelled', 'purchased')
      GROUP BY product_id
    ) procurement ON procurement.product_id = sm.product_id
    LEFT JOIN (
      SELECT product_id, shop_id, ozon_sku,
        SUM(GREATEST(quantity - listed_quantity, 0)) AS fbp_transfer_in_transit_qty
      FROM fbp_transfer_records
      WHERE status IN ('sent', 'in_transit', 'received')
      GROUP BY product_id, shop_id, ozon_sku
    ) fbp_transfer ON fbp_transfer.product_id = sm.product_id
      AND (fbp_transfer.shop_id IS NULL OR fbp_transfer.shop_id = sm.shop_id)
      AND (fbp_transfer.ozon_sku = '' OR fbp_transfer.ozon_sku = sm.ozon_sku)
    WHERE sm.active = 1
      AND COALESCE(sm.ozon_sku, '') != ''
      AND (sm.product_id IS NULL OR p.active = 1)
  `, [
    dateKeyDaysAgoMysql(6),
    dateKeyDaysAgoMysql(29),
    dateKeyDaysAgoMysql(6),
    dateKeyDaysAgoMysql(13),
    dateKeyDaysAgoMysql(6),
    dateKeyDaysAgoMysql(20),
    dateKeyDaysAgoMysql(13)
  ]);

  const normalizedRows = rows.map(normalizeFbpOpportunityRow);
  return applyFbpOpportunityQuery(normalizedRows, query);
}

const FBP_TRANSFER_STATUSES = new Set(["draft", "sent", "in_transit", "received", "listed", "exception", "closed", "cancelled"]);

function normalizeFbpTransferRecord(row = {}) {
  const quantity = Number(row.quantity || 0);
  const listedQuantity = Number(row.listed_quantity || 0);
  return {
    id: Number(row.id || 0),
    product_id: Number(row.product_id || 0),
    mapping_id: row.mapping_id === null || row.mapping_id === undefined ? null : Number(row.mapping_id || 0),
    shop_id: row.shop_id === null || row.shop_id === undefined ? null : Number(row.shop_id || 0),
    shop_name: row.shop_name || "",
    ozon_sku: row.ozon_sku || "",
    product_name: row.product_name || "",
    product_image_url: row.product_image_url || "",
    inventory_id: row.inventory_id || "",
    quantity,
    listed_quantity: listedQuantity,
    in_transit_quantity: Math.max(0, quantity - listedQuantity),
    status: row.status || "draft",
    source_type: row.source_type || "",
    source_ref: row.source_ref || "",
    warehouse_name: row.warehouse_name || "",
    tracking_no: row.tracking_no || "",
    box_no: row.box_no || "",
    note: row.note || "",
    person_id: row.person_id === null || row.person_id === undefined ? null : Number(row.person_id || 0),
    person_name: row.person_name || "",
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
    shipped_at: row.shipped_at || "",
    expected_arrival_at: row.expected_arrival_at || "",
    closed_at: row.closed_at || ""
  };
}

export async function fbpTransferRecordsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureFbpTransferRecordsSchemaMysql();
  const where = [];
  const params = [];
  const productId = Number(query.productId || query.product_id || 0);
  const shopId = Number(query.shopId || query.shop_id || 0);
  const mappingId = Number(query.mappingId || query.mapping_id || 0);
  const ozonSku = String(query.ozonSku || query.ozon_sku || "").trim();
  const status = String(query.status || "all");
  const onlyOpen = String(query.onlyOpen || query.only_open || "") === "1";
  const text = String(query.query || "").trim();
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize || 20)));

  if (productId) {
    where.push("ftr.product_id = ?");
    params.push(productId);
  }
  if (shopId) {
    where.push("ftr.shop_id = ?");
    params.push(shopId);
  }
  if (mappingId) {
    where.push("ftr.mapping_id = ?");
    params.push(mappingId);
  }
  if (ozonSku) {
    where.push("ftr.ozon_sku = ?");
    params.push(ozonSku);
  }
  if (status !== "all") {
    where.push("ftr.status = ?");
    params.push(status);
  } else if (onlyOpen) {
    where.push("ftr.status IN ('draft', 'sent', 'in_transit', 'received')");
  }
  if (text) {
    where.push("(p.name LIKE ? OR ftr.ozon_sku LIKE ? OR ftr.tracking_no LIKE ? OR ftr.box_no LIKE ?)");
    const like = `%${text}%`;
    params.push(like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countRow = await mysqlQueryOne(`SELECT COUNT(*) AS total FROM fbp_transfer_records ftr LEFT JOIN products p ON p.id = ftr.product_id ${whereSql}`, params);
  const rows = await mysqlQuery(`
    SELECT ftr.*,
      p.name AS product_name, p.image_url AS product_image_url,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0')) END AS inventory_id,
      s.name AS shop_name,
      pe.name AS person_name
    FROM fbp_transfer_records ftr
    LEFT JOIN products p ON p.id = ftr.product_id
    LEFT JOIN shops s ON s.id = ftr.shop_id
    LEFT JOIN people pe ON pe.id = ftr.person_id
    ${whereSql}
    ORDER BY ftr.created_at DESC, ftr.id DESC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, (page - 1) * pageSize]);

  return {
    rows: rows.map(normalizeFbpTransferRecord),
    total: Number(countRow?.total || 0),
    page,
    pageSize
  };
}

export async function createFbpTransferRecordMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  await ensureFbpTransferRecordsSchemaMysql();
  const productId = Number(body.product_id || body.productId || 0);
  if (!productId) throw new Error("请选择产品");
  const quantity = Math.max(1, Math.round(Number(body.quantity || 0)));
  if (!quantity) throw new Error("请输入发仓数量");
  const mappingId = nullableInteger(body.mapping_id || body.mappingId);
  let shopId = nullableInteger(body.shop_id || body.shopId);
  let ozonSku = String(body.ozon_sku || body.ozonSku || "").trim();
  if ((!shopId || !ozonSku) && mappingId) {
    const mapping = await mysqlQueryOne("SELECT shop_id, ozon_sku FROM sku_mappings WHERE id = ?", [mappingId]);
    shopId = shopId || nullableInteger(mapping?.shop_id);
    ozonSku = ozonSku || String(mapping?.ozon_sku || "").trim();
  }
  const status = FBP_TRANSFER_STATUSES.has(String(body.status || "")) ? String(body.status) : "sent";
  const personId = await resolvePersonIdOrFirstMysql(body.person_id || body.personId || userId);
  const shippedAt = body.shipped_at || body.shippedAt || (status === "draft" ? null : new Date().toISOString().slice(0, 19).replace("T", " "));
  const result = await mysqlExecute(`
    INSERT INTO fbp_transfer_records
      (product_id, mapping_id, shop_id, ozon_sku, quantity, listed_quantity, status, tracking_no, box_no, note, person_id, shipped_at, expected_arrival_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    productId,
    mappingId,
    shopId,
    ozonSku,
    quantity,
    Math.max(0, Math.round(Number(body.listed_quantity || body.listedQuantity || 0))),
    status,
    String(body.tracking_no || body.trackingNo || "").trim(),
    String(body.box_no || body.boxNo || "").trim(),
    body.note || "",
    personId,
    shippedAt,
    body.expected_arrival_at || body.expectedArrivalAt || null
  ]);
  invalidateMasterDataCache("stock-alerts:base");
  invalidateMasterDataCache("stock-alerts:base:v2");
  return { ok: true, id: Number(result.insertId) };
}

export async function confirmFbpTransferReceivedMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  await ensureFbpTransferRecordsSchemaMysql();
  const id = Number(body.id || body.record_id || body.recordId || 0);
  if (!id) throw new Error("缺少 FBP 发仓记录");
  const record = await mysqlQueryOne("SELECT * FROM fbp_transfer_records WHERE id = ? LIMIT 1", [id]);
  if (!record) throw new Error("FBP 发仓记录不存在");
  if (["cancelled", "closed"].includes(String(record.status || ""))) throw new Error("这条发仓记录已关闭，不能确认入仓");
  const quantity = Math.max(0, Number(record.quantity || 0));
  const listedQuantity = Math.max(0, Number(record.listed_quantity || 0));
  const remaining = Math.max(0, quantity - listedQuantity);
  if (remaining <= 0) {
    return { ok: true, record: normalizeFbpTransferRecord(record), remaining_quantity: 0 };
  }
  const confirmAll = body.confirm_all === true || body.confirmAll === true;
  const receivedQuantity = confirmAll
    ? remaining
    : Math.max(0, Math.round(Number(body.received_quantity || body.receivedQuantity || 0)));
  if (!receivedQuantity) throw new Error("请输入本次入仓数量");
  if (receivedQuantity > remaining) throw new Error(`本次入仓数量不能超过剩余 ${remaining} 件`);
  const nextListedQuantity = Math.min(quantity, listedQuantity + receivedQuantity);
  const nextStatus = nextListedQuantity >= quantity ? "listed" : "received";
  const receivedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  const operatorId = await resolvePersonIdOrFirstMysql(userId);
  const noteSuffix = body.note
    ? `\n确认入仓 ${receivedQuantity} 件：${String(body.note || "").trim()}`
    : `\n确认入仓 ${receivedQuantity} 件`;
  await mysqlExecute(`
    UPDATE fbp_transfer_records
    SET listed_quantity = ?,
      status = ?,
      person_id = COALESCE(person_id, ?),
      note = CONCAT(COALESCE(note, ''), ?),
      closed_at = CASE WHEN ? >= quantity THEN ? ELSE closed_at END
    WHERE id = ?
  `, [
    nextListedQuantity,
    nextStatus,
    operatorId,
    noteSuffix,
    nextListedQuantity,
    receivedAt,
    id
  ]);
  invalidateMasterDataCache("stock-alerts:base");
  invalidateMasterDataCache("stock-alerts:base:v2");
  const updated = await mysqlQueryOne(`
    SELECT ftr.*,
      p.name AS product_name, p.image_url AS product_image_url,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0')) END AS inventory_id,
      s.name AS shop_name,
      pe.name AS person_name
    FROM fbp_transfer_records ftr
    LEFT JOIN products p ON p.id = ftr.product_id
    LEFT JOIN shops s ON s.id = ftr.shop_id
    LEFT JOIN people pe ON pe.id = ftr.person_id
    WHERE ftr.id = ?
  `, [id]);
  return {
    ok: true,
    received_quantity: receivedQuantity,
    remaining_quantity: Math.max(0, quantity - nextListedQuantity),
    record: normalizeFbpTransferRecord(updated)
  };
}

function normalizeOzonSupplyStatusMysql(status = "") {
  const text = String(status || "").toLowerCase();
  if (text.includes("cancel")) return "cancelled";
  if (text.includes("closed") || text.includes("completed")) return "closed";
  if (text.includes("accepted") || text.includes("received") || text.includes("placed")) return "received";
  if (text.includes("transit") || text.includes("shipping") || text.includes("sent")) return "in_transit";
  if (text.includes("draft") || text.includes("created")) return "sent";
  return "sent";
}

async function resolveFbpTransferMappingMysql(shopId, item = {}) {
  const ozonSku = String(item.ozon_sku || "").trim();
  const offerId = String(item.offer_id || "").trim();
  const ozonProductId = String(item.product_id || "").trim();
  const row = await mysqlQueryOne(`
    SELECT sm.id AS mapping_id, sm.product_id, sm.shop_id, sm.ozon_sku
    FROM sku_mappings sm
    LEFT JOIN online_products op ON op.id = sm.online_product_id
      OR (op.shop_id = sm.shop_id AND op.ozon_sku = sm.ozon_sku)
    WHERE sm.active = 1
      AND sm.shop_id = ?
      AND (
        (? != '' AND sm.ozon_sku = ?)
        OR (? != '' AND sm.offer_id = ?)
        OR (? != '' AND op.ozon_product_id = ?)
      )
    ORDER BY CASE WHEN sm.ozon_sku = ? THEN 0 ELSE 1 END, sm.id DESC
    LIMIT 1
  `, [Number(shopId), ozonSku, ozonSku, offerId, offerId, ozonProductId, ozonProductId, ozonSku]);
  return row || null;
}

export async function syncOzonFboSupplyOrdersMysql(body = {}, options = {}) {
  ensureMysqlCutoverEnabled();
  await ensureFbpTransferRecordsSchemaMysql();
  const targetShopId = nullableNumber(body.shop_id || body.shopId);
  const activeShops = (await shopsMysql()).filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  let fetchedOrders = 0;
  let fetchedItems = 0;
  let upserted = 0;
  const errors = [];

  for (const shop of activeShops) {
    try {
      const orders = await fetchOzonFboSupplyOrders(shop, {
        signal: options.signal,
        maxPages: body.maxPages || 10,
        since: body.since || body.from,
        to: body.to
      });
      fetchedOrders += orders.length;
      for (const order of orders) {
        const items = await fetchOzonFboSupplyOrderItems(shop, order, { signal: options.signal }).catch((error) => {
          errors.push(`${shop.name} ${order.supply_order_number || order.supply_order_id}: ${error.message}`);
          return [];
        });
        fetchedItems += items.length;
        for (const item of items) {
          const mapping = await resolveFbpTransferMappingMysql(shop.id, item);
          if (!mapping?.product_id) continue;
          const sourceRef = `${shop.id}:${order.supply_order_id || order.supply_order_number}:${item.ozon_sku || item.offer_id || item.product_id}`;
          const quantity = Math.max(0, Math.round(Number(item.quantity || 0)));
          const listedQuantity = Math.max(0, Math.round(Number(item.accepted_quantity || 0)));
          if (!quantity && !listedQuantity) continue;
          const payload = [
            Number(mapping.product_id),
            Number(mapping.mapping_id || 0) || null,
            Number(shop.id),
            item.ozon_sku || mapping.ozon_sku || "",
            quantity || listedQuantity,
            listedQuantity,
            normalizeOzonSupplyStatusMysql(order.status || item.status),
            order.warehouse_name || item.warehouse_name || "",
            `Ozon入仓请求 ${order.supply_order_number || order.supply_order_id || ""}`.trim(),
            order.created_at || null,
            order.appointment_at || null
          ];
          const existing = await mysqlQueryOne(`
            SELECT id
            FROM fbp_transfer_records
            WHERE source_type = 'ozon_supply_order' AND source_ref = ?
            LIMIT 1
          `, [sourceRef]);
          if (existing?.id) {
            await mysqlExecute(`
              UPDATE fbp_transfer_records
              SET product_id = ?,
                  mapping_id = ?,
                  shop_id = ?,
                  ozon_sku = ?,
                  quantity = ?,
                  listed_quantity = ?,
                  status = ?,
                  warehouse_name = ?,
                  note = ?,
                  shipped_at = ?,
                  expected_arrival_at = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `, [...payload, Number(existing.id)]);
          } else {
            await mysqlExecute(`
              INSERT INTO fbp_transfer_records
                (product_id, mapping_id, shop_id, ozon_sku, quantity, listed_quantity, status, source_type, source_ref, warehouse_name, note, shipped_at, expected_arrival_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'ozon_supply_order', ?, ?, ?, ?, ?)
            `, [
              payload[0],
              payload[1],
              payload[2],
              payload[3],
              payload[4],
              payload[5],
              payload[6],
              sourceRef,
              payload[7],
              payload[8],
              payload[9],
              payload[10]
            ]);
          }
          upserted += 1;
        }
      }
    } catch (error) {
      errors.push(`${shop.name}: ${error.message}`);
    }
  }

  invalidateMasterDataCache("stock-alerts:base");
  invalidateMasterDataCache("stock-alerts:base:v2");
  if (errors.length && fetchedOrders === 0 && fetchedItems === 0 && upserted === 0) {
    throw new Error(`Ozon入仓请求同步失败：${errors.slice(0, 3).join(" | ")}${errors.length > 3 ? ` 等 ${errors.length} 个店铺/接口错误` : ""}`);
  }
  return {
    ok: errors.length === 0,
    status: errors.length ? "partial_error" : "ok",
    fetched_orders: fetchedOrders,
    fetched_items: fetchedItems,
    upserted,
    errors,
    message: `Ozon入仓请求 ${fetchedOrders} 个，明细 ${fetchedItems} 条，更新 ${upserted} 条${errors.length ? `；${errors.slice(0, 3).join(" | ")}${errors.length > 3 ? ` 等 ${errors.length} 个错误` : ""}` : ""}`
  };
}

export async function createPersonMysql(body = {}, hashPassword, validatePasswordStrength) {
  ensureMysqlCutoverEnabled();
  validatePasswordStrength?.(body.password, body);
  const payload = [
    body.name,
    body.username || null,
    body.role || "operator",
    Number(body.active ?? 1),
    hashPassword(body.password)
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

export async function updatePersonMysql(id, body = {}, hashPassword, validatePasswordStrength) {
  ensureMysqlCutoverEnabled();
  const personId = Number(id);
  const existing = await mysqlQueryOne("SELECT id, updated_at FROM people WHERE id = ?", [personId]);
  if (!existing) throw new Error("Person not found");
  assertFreshRecord(body, existing, "人员资料已被其他用户保存，请刷新后再继续编辑");
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
    validatePasswordStrength?.(body.password, body);
    const passwordHash = hashPassword(String(body.password));
    await mysqlExecute("UPDATE people SET password_hash = ? WHERE id = ?", [passwordHash, personId]);
    db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(passwordHash, personId);
    await destroySessionsByPersonIdMysql(personId);
  } else if (Number(body.active ?? 1) === 0) {
    await destroySessionsByPersonIdMysql(personId);
  }

  invalidateMasterDataCache("people");
  return { ok: true };
}

export async function deletePersonMysql(id) {
  ensureMysqlCutoverEnabled();
  const personId = Number(id);
  await mysqlExecute("UPDATE people SET active = 0 WHERE id = ?", [personId]);
  db.prepare("UPDATE people SET active = 0 WHERE id = ?").run(personId);
  await destroySessionsByPersonIdMysql(personId);
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
      ["DELETE FROM sessions WHERE person_id = ?", [personId]],
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
  assertFreshRecord(body, existing, "店铺资料已被其他用户保存，请刷新后再继续编辑");
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
  await ensureOzonStockStorageSchemaMysql();
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
    (shop_id, online_product_id, product_id, ozon_product_id, ozon_sku, offer_id, warehouse_id, warehouse_name, stock_type,
     present, reserved, available, free_stock_count, paid_stock_count, expiring_stock_count, waitingdocs_stock_count,
     paid_storage_start_at, stock_days, average_daily_sales, stock_level, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      online_product_id = VALUES(online_product_id),
      product_id = VALUES(product_id),
      ozon_product_id = VALUES(ozon_product_id),
      offer_id = VALUES(offer_id),
      warehouse_name = VALUES(warehouse_name),
      present = VALUES(present),
      reserved = VALUES(reserved),
      available = VALUES(available),
      free_stock_count = VALUES(free_stock_count),
      paid_stock_count = VALUES(paid_stock_count),
      expiring_stock_count = VALUES(expiring_stock_count),
      waitingdocs_stock_count = VALUES(waitingdocs_stock_count),
      paid_storage_start_at = VALUES(paid_storage_start_at),
      stock_days = VALUES(stock_days),
      average_daily_sales = VALUES(average_daily_sales),
      stock_level = VALUES(stock_level),
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
    snapshotStockNumberMysql(row.free_stock_count),
    snapshotStockNumberMysql(row.paid_stock_count),
    snapshotStockNumberMysql(row.expiring_stock_count),
    snapshotStockNumberMysql(row.waitingdocs_stock_count),
    normalizeMysqlNullableDate(row.paid_storage_start_at),
    nullableNumber(row.stock_days),
    nullableNumber(row.average_daily_sales),
    String(row.stock_level || ""),
    row.raw_json || JSON.stringify(row)
  ]);
}

async function clearStockSnapshotsForSyncMysql(shopId, { productId = null, filters = {} } = {}) {
  const clauses = ["shop_id = ?"];
  const params = [Number(shopId)];
  const productIds = (filters.productIds || []).map(Number).filter(Boolean);
  const offerIds = (filters.offerIds || []).map(String).filter(Boolean);

  if (productId) {
    clauses.push("product_id = ?");
    params.push(Number(productId));
  } else if (productIds.length || offerIds.length) {
    const scopedClauses = [];
    if (productIds.length) {
      scopedClauses.push(`ozon_product_id IN (${productIds.map(() => "?").join(",")})`);
      params.push(...productIds.map(String));
    }
    if (offerIds.length) {
      scopedClauses.push(`offer_id IN (${offerIds.map(() => "?").join(",")})`);
      params.push(...offerIds);
    }
    clauses.push(`(${scopedClauses.join(" OR ")})`);
  }

  await mysqlExecute(`DELETE FROM ozon_stock_snapshots WHERE ${clauses.join(" AND ")}`, params);
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

function mergeOzonStockAnalyticsRowsMysql(stockRows = [], analyticsRows = []) {
  const analyticsBySku = new Map();
  for (const item of analyticsRows) {
    const sku = String(item.ozon_sku || "").trim();
    if (!sku) continue;
    analyticsBySku.set(sku, { ...(analyticsBySku.get(sku) || {}), ...item });
  }
  return stockRows.map((row) => {
    const analytics = analyticsBySku.get(String(row.ozon_sku || "").trim());
    if (!analytics) return row;
    const raw = {
      stock: parseJsonOrNull(row.raw_json) || row,
      analytics
    };
    return {
      ...row,
      free_stock_count: analytics.free_stock_count ?? row.free_stock_count,
      paid_stock_count: analytics.paid_stock_count ?? row.paid_stock_count,
      expiring_stock_count: analytics.expiring_stock_count ?? row.expiring_stock_count,
      waitingdocs_stock_count: analytics.waitingdocs_stock_count ?? row.waitingdocs_stock_count,
      paid_storage_start_at: analytics.paid_storage_start_at ?? row.paid_storage_start_at,
      stock_days: analytics.stock_days ?? row.stock_days,
      average_daily_sales: analytics.average_daily_sales ?? row.average_daily_sales,
      stock_level: analytics.stock_level ?? row.stock_level,
      raw_json: JSON.stringify(raw)
    };
  });
}

async function fetchOzonStockAnalyticsSafeMysql(shop, rows = [], options = {}) {
  const skus = [...new Set(rows.map((row) => Number(row.ozon_sku || 0)).filter(Boolean))];
  if (!skus.length) return { rows: [], errors: [] };
  const [turnoverResult, managedResult] = await Promise.allSettled([
    fetchOzonStockTurnover(shop, { skus, signal: options.signal }),
    fetchOzonManagedStocks(shop, { skus, signal: options.signal })
  ]);
  const errors = [];
  if (turnoverResult.status === "rejected") errors.push(`turnover: ${turnoverResult.reason?.message || turnoverResult.reason}`);
  if (managedResult.status === "rejected") errors.push(`managed: ${managedResult.reason?.message || managedResult.reason}`);
  return {
    rows: [
      ...(turnoverResult.status === "fulfilled" ? turnoverResult.value : []),
      ...(managedResult.status === "fulfilled" ? managedResult.value : [])
    ],
    errors
  };
}

function fbpStockDeltaKey(row = {}) {
  return `${Number(row.shop_id || 0)}::${String(row.ozon_sku || "").trim()}`;
}

async function currentFbpStockQuantityMapMysql(shopId, productId = null) {
  const where = ["shop_id = ?", "stock_type = 'fbp_real'"];
  const params = [Number(shopId)];
  if (productId) {
    where.push("product_id = ?");
    params.push(Number(productId));
  }
  const rows = await mysqlQuery(`
    SELECT shop_id, product_id, ozon_sku, SUM(present) AS fbp_quantity
    FROM ozon_stock_snapshots
    WHERE ${where.join(" AND ")}
    GROUP BY shop_id, product_id, ozon_sku
  `, params);
  return new Map(rows.map((row) => [fbpStockDeltaKey(row), {
    shop_id: Number(row.shop_id || 0),
    product_id: Number(row.product_id || 0),
    ozon_sku: String(row.ozon_sku || ""),
    fbp_quantity: Number(row.fbp_quantity || 0)
  }]));
}

async function autoConfirmFbpTransfersFromStockDeltaMysql(beforeByShop = new Map(), { productId = null } = {}) {
  let confirmedQuantity = 0;
  let confirmedRecords = 0;
  const details = [];
  for (const [shopId, beforeMap] of beforeByShop.entries()) {
    const afterMap = await currentFbpStockQuantityMapMysql(shopId, productId);
    for (const [key, after] of afterMap.entries()) {
      const beforeQuantity = Number(beforeMap.get(key)?.fbp_quantity || 0);
      let delta = Math.max(0, Number(after.fbp_quantity || 0) - beforeQuantity);
      if (delta <= 0) continue;
      const records = await mysqlQuery(`
        SELECT id, quantity, listed_quantity
        FROM fbp_transfer_records
        WHERE shop_id = ?
          AND ozon_sku = ?
          AND status IN ('sent', 'in_transit', 'received')
          AND GREATEST(quantity - COALESCE(listed_quantity, 0), 0) > 0
          ${productId ? "AND product_id = ?" : ""}
        ORDER BY COALESCE(shipped_at, created_at) ASC, id ASC
      `, productId ? [Number(shopId), after.ozon_sku, Number(productId)] : [Number(shopId), after.ozon_sku]);
      for (const record of records) {
        if (delta <= 0) break;
        const remaining = Math.max(0, Number(record.quantity || 0) - Number(record.listed_quantity || 0));
        if (remaining <= 0) continue;
        const receivedQuantity = Math.min(delta, remaining);
        await confirmFbpTransferReceivedMysql({
          id: Number(record.id),
          received_quantity: receivedQuantity,
          note: `库存同步自动确认：FBP库存从 ${beforeQuantity} 增至 ${Number(after.fbp_quantity || 0)}`
        });
        delta -= receivedQuantity;
        confirmedQuantity += receivedQuantity;
        confirmedRecords += 1;
        details.push({
          shop_id: Number(shopId),
          product_id: Number(after.product_id || 0),
          ozon_sku: after.ozon_sku,
          record_id: Number(record.id),
          received_quantity: receivedQuantity
        });
      }
    }
  }
  return { confirmedQuantity, confirmedRecords, details };
}

export async function syncOzonStocksMysql(body = {}, options = {}) {
  ensureMysqlCutoverEnabled();
  await ensureOzonStockStorageSchemaMysql();
  const targetShopId = nullableNumber(body.shop_id);
  const productId = nullableNumber(body.product_id);
  const activeShops = (await shopsMysql()).filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  let fetched = 0;
  let upserted = 0;
  const errors = [];
  const beforeFbpByShop = new Map();
  for (const shop of activeShops) {
    try {
      beforeFbpByShop.set(Number(shop.id), await currentFbpStockQuantityMapMysql(shop.id, productId));
      const filters = await stockSyncFiltersMysql(shop.id, productId);
      let rows = await fetchOzonProductStocks(shop, { ...filters, signal: options.signal });
      const analytics = await fetchOzonStockAnalyticsSafeMysql(shop, rows, options);
      rows = mergeOzonStockAnalyticsRowsMysql(rows, analytics.rows);
      if (analytics.errors.length) errors.push(`${shop.name}: stock analytics unavailable (${analytics.errors.join("; ")})`);
      await clearStockSnapshotsForSyncMysql(shop.id, { productId, filters });
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
  const autoFbpReceive = await autoConfirmFbpTransfersFromStockDeltaMysql(beforeFbpByShop, { productId });
  invalidateMasterDataCache("stock-alerts:base");
  invalidateMasterDataCache("stock-alerts:base:v2");
  const status = errors.length ? "partial_error" : "ok";
  const autoMessage = autoFbpReceive.confirmedQuantity ? `; auto confirmed FBP received ${autoFbpReceive.confirmedQuantity}` : "";
  const message = `Fetched ${fetched}, upserted ${upserted}${autoMessage}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  return { status, fetched, upserted, errors, message, auto_fbp_receive: autoFbpReceive, alerts: await stockAlertsMysql() };
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
  const requireAll = body.require_all !== false && body.allow_partial !== true;
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
  if (requireAll && failures.length) {
    const suffix = failures.slice(0, 5).map((item) => item.posting_number || item.id).filter(Boolean).join("、");
    const more = failures.length > 5 ? ` 等 ${failures.length} 个订单` : "";
    const error = new Error(suffix ? `部分面单生成失败：${suffix}${more}。本次未打开打印，请稍后重试或单独打印失败订单。` : "部分面单生成失败。本次未打开打印，请稍后重试。");
    error.status = 502;
    error.validation = { failures };
    throw error;
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
      ozon_sku: strictOzonSkuValue(product),
      offer_id: String(product.offer_id || ""),
      ozon_product_id: String(product.product_id || product.id || financialProduct.product_id || financialProduct.id || "")
    };
  });
  if (items.some((item) => Number(item.ozon_product_id || 0))) return items;
  return payloadItems.map((item) => ({
    ozon_sku: strictOzonSkuValue(item),
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

  const status = String(body.status || "handled").trim();
  if (!["open", "handled", "ignored"].includes(status)) {
    throw new Error("Invalid exception task status");
  }

  if (status === "open") {
    await mysqlExecute("DELETE FROM exception_task_states WHERE task_id = ?", [taskId]);
    db.prepare("DELETE FROM exception_task_states WHERE task_id = ?").run(taskId);
    return { ok: true, task_id: taskId, status };
  }

  await upsertExceptionTaskStatesMysql([taskId], status, String(body.note || ""), userId);
  return { ok: true, task_id: taskId, status };
}

async function upsertExceptionTaskStatesMysql(taskIds = [], status = "handled", note = "", userId = null) {
  const ids = [...new Set(taskIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return { ok: true, count: 0, task_ids: [] };
  const auditPersonId = await resolveAuditPersonId(userId);

  for (const taskId of ids) {
  await mysqlExecute(`
    INSERT INTO exception_task_states (task_id, status, note, updated_by_person_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      note = VALUES(note),
      updated_by_person_id = VALUES(updated_by_person_id),
      updated_at = CURRENT_TIMESTAMP
  `, [taskId, status, note, auditPersonId]);

  db.prepare(`
    INSERT INTO exception_task_states (task_id, status, note, updated_by_person_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_by_person_id = excluded.updated_by_person_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(taskId, status, note, auditPersonId);
  }

  invalidateExceptionWorkbenchCache();
  return { ok: true, count: ids.length, task_ids: ids };
}

function exceptionTaskMysql(values) {
  return { id: [values.type, values.orderId || values.productId || values.subject || "", values.title || ""].join(":"), ...values };
}

const EXCEPTION_VIEW_TYPES_MYSQL = {
  profit: new Set(["profit"]),
  deadline: new Set(["deadline"]),
  deadline_warning: new Set(["deadline_warning"]),
  stock: new Set(["order_stock_shortage", "stock_local", "stock_fbp", "stock_fbs", "stock_mapping"]),
  binding: new Set(["order_binding"])
};

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

function exceptionViewMysql(query = {}) {
  const view = String(query.view || "profit").trim();
  return EXCEPTION_VIEW_TYPES_MYSQL[view] ? view : "profit";
}

function exceptionShouldBuildOrderTasksMysql(view) {
  return ["profit", "deadline", "deadline_warning", "stock", "binding"].includes(view);
}

function exceptionShouldBuildStockTasksMysql(view) {
  return view === "stock";
}

function exceptionTaskMatchesViewMysql(task = {}, view = "profit") {
  return EXCEPTION_VIEW_TYPES_MYSQL[view]?.has(task.type) || false;
}

function exceptionTaskDateMysql(task = {}) {
  return task.ordered_at || task.deadline_due_at || task.task_state_updated_at || "";
}

function exceptionTaskMatchesSearchMysql(task = {}, keyword = "") {
  const text = String(keyword || "").trim().toLowerCase();
  if (!text) return true;
  return [
    task.title,
    task.subject,
    task.meta,
    task.detail,
    task.shop_name,
    task.order_ref,
    task.sku_text,
    task.inventory_id,
    task.product_name,
    task.profit_context_text,
    task.dimensions_text
  ].some((value) => String(value || "").toLowerCase().includes(text));
}

function exceptionTaskMatchesDateMysql(task = {}, from = "", to = "") {
  const date = String(exceptionTaskDateMysql(task) || "").slice(0, 10);
  if (from && (!date || date < from)) return false;
  if (to && (!date || date > to)) return false;
  return true;
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
    productId: Number(firstDelimitedValueMysql(row.product_ids)) || undefined,
    onlineProductId: Number(firstMappedValueMysql(row.sku_online_product_ids)) || undefined
  };
}

function selectionSummaryFromPricingRowsMysql(rows) {
  return selectionSummaryMysql(rows.map((row) => ({
    purchase_cost: row.purchase_cost,
    pricing: calculateSelectionPricing(row)
  })));
}

function selectionProductPredicateMysql(alias = "p") {
  const prefix = alias ? `${alias}.` : "";
  return `(COALESCE(${prefix}product_type, 'main') = 'selection' OR COALESCE(${prefix}selection_status, 'draft') = 'draft')`;
}

function selectionProductTypeExprMysql(alias = "p") {
  return `CASE
        WHEN ${selectionProductPredicateMysql(alias)} THEN 'selection'
        ELSE 'main'
      END`;
}

function selectionBusinessStatusMysql(row = {}) {
  const selectionStatus = String(row.selection_status || "draft");
  const listingStatus = String(row.listing_job_status || "").trim();
  if (selectionStatus === "listed") return "in_inventory";
  if (listingStatus === "queued" || listingStatus === "running") return "publishing";
  if (listingStatus === "failed") return "publish_failed";
  if (listingStatus === "success") return "published";
  if (listingStatus === "cancelled") return "publish_cancelled";
  return selectionReadinessMissingMysql(row).length ? "needs_work" : "ready_to_publish";
}

function selectionReadinessMissingMysql(row = {}) {
  const missing = [];
  if (!String(row.image_url || "").trim()) missing.push("主图");
  if (!String(row.detail_image_urls || "").trim() || String(row.detail_image_urls || "").trim() === "[]") missing.push("详情图");
  if (!String(row.selling_points || "").trim()) missing.push("卖点");
  if (!String(row.ozon_category_id || "").trim()) missing.push("Ozon类目");
  if (!Number(row.ozon_description_category_id || 0)) missing.push("Ozon描述类目");
  if (!Number(row.ozon_type_id || 0)) missing.push("Ozon类型");
  if (!(Number(row.listing_price_rub || 0) > 0 || Number(row.air_sale_price_rmb || 0) > 0)) missing.push("价格");
  if (!(Number(row.purchase_cost || 0) > 0)) missing.push("采购成本");
  if (!(Number(row.package_weight_g || 0) > 0)) missing.push("重量");
  if (!(Number(row.length_cm || 0) > 0 && Number(row.width_cm || 0) > 0 && Number(row.height_cm || 0) > 0)) missing.push("尺寸");
  if (!Number(row.owner_person_id || 0)) missing.push("负责人");
  if (!Number(row.logistics_rule_id || 0)) missing.push("物流规则");
  return missing;
}

function applySelectionBusinessStatusFilterMysql(rows = [], status = "all") {
  const key = String(status || "all");
  if (key === "all") return rows;
  return rows.filter((row) => row.business_status === key);
}

function selectionBusinessStatusCountsMysql(rows = []) {
  const counts = {
    all: rows.length,
    needs_work: 0,
    ready_to_publish: 0,
    publishing: 0,
    publish_failed: 0,
    published: 0,
    in_inventory: 0,
    publish_cancelled: 0
  };
  for (const row of rows) {
    const status = row.business_status || selectionBusinessStatusMysql(row);
    counts[status] = Number(counts[status] || 0) + 1;
  }
  return counts;
}

function stockAlertSkuTextMysql(row = {}) {
  const skus = Array.isArray(row.skus) ? row.skus : [];
  return skus.slice(0, 3).map((item) => [item.shop_name, item.ozon_sku, item.name].filter(Boolean).join(" / ")).join(", ");
}

function profitExceptionBreakdownMysql(row = {}, profitValue = 0) {
  const sale = Number(row.sale_amount_cny || 0);
  const purchase = Number(row.purchase_cost_cny || 0);
  const domestic = Number(row.domestic_shipping_cny || 0);
  const international = Number(row.international_shipping_cny || 0);
  const packaging = Number(row.packaging_cost_cny || 0);
  const commission = Number(row.commission_fee_cny || 0);
  const service = Number(row.ozon_service_fee_cny || 0);
  const returnLoss = Number(row.return_loss_cny || 0);
  const advertising = Number(row.advertising_cost_cny || 0);
  const other = Number(row.other_fee_cny || 0);
  const costTotal = purchase + domestic + international + packaging + commission + service + returnLoss + advertising + other;
  const statusText = [row.profit_statuses, row.settlement_states].filter(Boolean).join(" / ");
  const margin = sale ? (profitValue / sale) * 100 : 0;
  return {
    formula: [
      `利润 = 销售额 ${roundMoneyMysql(sale)} - 成本合计 ${roundMoneyMysql(costTotal)} = ${roundMoneyMysql(profitValue)}`,
      `利润率 ${roundMoneyMysql(margin)}%${statusText ? ` / 状态 ${statusText}` : ""}`
    ],
    costs: [
      `采购成本 ${roundMoneyMysql(purchase)}`,
      `国内运费 ${roundMoneyMysql(domestic)}`,
      `国际运费 ${roundMoneyMysql(international)}`,
      `包装/处理费 ${roundMoneyMysql(packaging)}`,
      `平台佣金 ${roundMoneyMysql(commission)}`,
      `Ozon 服务费 ${roundMoneyMysql(service)}`,
      `售后损失 ${roundMoneyMysql(returnLoss)}`,
      advertising ? `广告费 ${roundMoneyMysql(advertising)}` : "",
      other ? `其它费用 ${roundMoneyMysql(other)}` : ""
    ].filter(Boolean)
  };
}

function exceptionOrderSearchSqlMysql(params, keyword = "") {
  const text = String(keyword || "").trim().toLowerCase();
  if (!text) return "";
  const like = `%${text}%`;
  params.push(like, like, like, like, like, like);
  return `
    AND (
      LOWER(COALESCE(o.posting_number, '')) LIKE ?
      OR LOWER(COALESCE(o.order_number, '')) LIKE ?
      OR LOWER(COALESCE(s.name, '')) LIKE ?
      OR EXISTS (
        SELECT 1
        FROM order_items oi_search
        LEFT JOIN sku_mappings sm_search_id ON sm_search_id.id = oi_search.sku_mapping_id AND sm_search_id.active = 1
        LEFT JOIN sku_mappings sm_search_sku ON sm_search_sku.shop_id = o.shop_id AND sm_search_sku.ozon_sku = oi_search.ozon_sku AND sm_search_sku.active = 1
        LEFT JOIN products p_search ON p_search.id = COALESCE(sm_search_id.product_id, sm_search_sku.product_id) AND p_search.active = 1
        WHERE oi_search.order_id = o.id
          AND LOWER(CONCAT(COALESCE(oi_search.ozon_sku, ''), ' ', COALESCE(oi_search.ozon_name, ''), ' ', COALESCE(p_search.name, ''), ' ', COALESCE(p_search.code, ''))) LIKE ?
      )
      OR LOWER(COALESCE(o.tracking_number, '')) LIKE ?
      OR LOWER(COALESCE(o.logistics_status, '')) LIKE ?
    )
  `;
}

async function exceptionOrderCandidateRowsMysql(view = "profit", query = {}) {
  if (view !== "profit") return exceptionOrderIssueCandidateRowsMysql(view, query);

  const params = [];
  const where = ["1 = 1"];
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
  const searchSql = exceptionOrderSearchSqlMysql(params, query.search || query.keyword || "");
  const statusSql = view === "deadline" || view === "deadline_warning"
    ? `AND (${orderStatusSqlMysql("awaiting_packaging")} OR ${orderStatusSqlMysql("awaiting_deliver")})`
    : "";
  const havingByView = {
    profit: "profit_value < 0 AND unbound_item_count = 0",
    binding: "unbound_item_count > 0",
    stock: "local_stock_shortage_count > 0",
    deadline: "1 = 1",
    deadline_warning: "1 = 1"
  };
  const orderSql = view === "deadline"
    ? "o.ordered_at ASC, o.id ASC"
    : view === "deadline_warning"
      ? "ABS(TIMESTAMPDIFF(HOUR, DATE_ADD(o.ordered_at, INTERVAL 6 DAY), UTC_TIMESTAMP())) ASC, o.ordered_at ASC"
      : "o.ordered_at DESC, o.id DESC";
  const limit = Math.min(Math.max(Number(query.orderPageSize || 300), 50), 1000);
  return await mysqlQuery(`
    SELECT
      o.id,
      o.shop_id,
      o.posting_number,
      o.order_number,
      o.status,
      o.tracking_stage,
      o.logistics_status,
      o.tracking_number,
      o.ordered_at,
      s.name AS shop_name,
      COALESCE(SUM(CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued'
          THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0)
        ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, oi.actual_profit, 0)
      END), 0) AS profit_value,
      COALESCE(SUM(CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued'
          THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0)
        ELSE 0
      END), 0) AS actual_profit,
      COALESCE(SUM(CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued'
          THEN 0
        ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, oi.actual_profit, 0)
      END), 0) AS estimated_profit,
      COALESCE(SUM(COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)), 0) AS sale_amount_cny,
      COALESCE(SUM(COALESCE(opi.purchase_cost_cny, oi.frozen_purchase_cost * oi.quantity, 0)), 0) AS purchase_cost_cny,
      COALESCE(SUM(COALESCE(opi.domestic_shipping_cny, oi.frozen_domestic_shipping * oi.quantity, 0)), 0) AS domestic_shipping_cny,
      COALESCE(SUM(COALESCE(opi.international_shipping_cny, oi.frozen_international_shipping * oi.quantity, 0)), 0) AS international_shipping_cny,
      COALESCE(SUM(COALESCE(opi.packaging_cost_cny, oi.frozen_handling_fee * oi.quantity, 0)), 0) AS packaging_cost_cny,
      COALESCE(SUM(COALESCE(opi.commission_fee_cny, oi.estimated_commission, 0)), 0) AS commission_fee_cny,
      COALESCE(SUM(COALESCE(opi.ozon_service_fee_cny, oi.platform_fee_actual, 0)), 0) AS ozon_service_fee_cny,
      COALESCE(SUM(COALESCE(opi.return_loss_cny, oi.aftersale_loss, 0)), 0) AS return_loss_cny,
      COALESCE(SUM(COALESCE(opi.advertising_cost_cny, 0)), 0) AS advertising_cost_cny,
      COALESCE(SUM(COALESCE(opi.other_fee_cny, 0)), 0) AS other_fee_cny,
      GROUP_CONCAT(DISTINCT oi.settlement_state) AS settlement_states,
      GROUP_CONCAT(DISTINCT opi.profit_status) AS profit_statuses,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      COUNT(CASE WHEN p.id IS NOT NULL AND COALESCE(ic.available_stock, 0) < oi.quantity THEN 1 END) AS local_stock_shortage_count,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), '')) SEPARATOR '||') AS sku_names,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) SEPARATOR '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN p.id END) AS product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', op.id) END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE
        WHEN p.id IS NOT NULL AND p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, 'Unbound product')) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm_by_id ON sm_by_id.id = oi.sku_mapping_id AND sm_by_id.active = 1
    LEFT JOIN sku_mappings sm_by_sku ON sm_by_sku.shop_id = o.shop_id AND sm_by_sku.ozon_sku = oi.ozon_sku AND sm_by_sku.active = 1
    LEFT JOIN products p ON p.id = COALESCE(sm_by_id.product_id, sm_by_sku.product_id) AND p.active = 1
    LEFT JOIN inventory_current ic ON ic.real_product_id = p.id
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE ${where.join(" AND ")}
      ${searchSql}
      ${statusSql}
    GROUP BY o.id
    HAVING ${havingByView[view] || "1 = 1"}
    ORDER BY ${orderSql}
    LIMIT ?
  `, [...params, limit]);
}

async function exceptionOrderIssueCandidateRowsMysql(view = "binding", query = {}) {
  const params = [];
  const where = ["1 = 1"];
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
  const searchSql = exceptionOrderSearchSqlMysql(params, query.search || query.keyword || "");
  const statusSql = view === "deadline" || view === "deadline_warning"
    ? `AND (${orderStatusSqlMysql("awaiting_packaging")} OR ${orderStatusSqlMysql("awaiting_deliver")})`
    : "";
  const havingByView = {
    binding: "unbound_item_count > 0",
    stock: "local_stock_shortage_count > 0",
    deadline: "1 = 1",
    deadline_warning: "1 = 1"
  };
  const orderSql = view === "deadline"
    ? "o.ordered_at ASC, o.id ASC"
    : view === "deadline_warning"
      ? "ABS(TIMESTAMPDIFF(HOUR, DATE_ADD(o.ordered_at, INTERVAL 6 DAY), UTC_TIMESTAMP())) ASC, o.ordered_at ASC"
      : "o.ordered_at DESC, o.id DESC";
  const limit = Math.min(Math.max(Number(query.orderPageSize || 300), 50), 1000);
  return await mysqlQuery(`
    SELECT
      o.id,
      o.shop_id,
      o.posting_number,
      o.order_number,
      o.status,
      o.tracking_stage,
      o.logistics_status,
      o.tracking_number,
      o.ordered_at,
      s.name AS shop_name,
      0 AS profit_value,
      0 AS actual_profit,
      0 AS estimated_profit,
      0 AS sale_amount_cny,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      COUNT(CASE WHEN p.id IS NOT NULL AND COALESCE(ic.available_stock, 0) < oi.quantity THEN 1 END) AS local_stock_shortage_count,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), '')) SEPARATOR '||') AS sku_names,
      GROUP_CONCAT(CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) SEPARATOR '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN p.id END) AS product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', op.id) END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE
        WHEN p.id IS NOT NULL AND p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, 'Unbound product')) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm_by_id ON sm_by_id.id = oi.sku_mapping_id AND sm_by_id.active = 1
    LEFT JOIN sku_mappings sm_by_sku ON sm_by_sku.shop_id = o.shop_id AND sm_by_sku.ozon_sku = oi.ozon_sku AND sm_by_sku.active = 1
    LEFT JOIN products p ON p.id = COALESCE(sm_by_id.product_id, sm_by_sku.product_id) AND p.active = 1
    LEFT JOIN inventory_current ic ON ic.real_product_id = p.id
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    WHERE ${where.join(" AND ")}
      ${searchSql}
      ${statusSql}
    GROUP BY o.id
    HAVING ${havingByView[view] || "1 = 1"}
    ORDER BY ${orderSql}
    LIMIT ?
  `, [...params, limit]);
}

function exceptionOrderTasksMysql(row = {}, view = "profit") {
  const tasks = [];
  const context = exceptionOrderContextMysql(row);
  const profitValue = Number(row.profit_value ?? row.actual_profit ?? row.estimated_profit ?? 0);
  const hasUnbound = Number(row.unbound_count || row.unbound_item_count || 0) > 0 || String(row.product_codes || "").includes("UNBOUND");
  const hasStockIssue = Number(row.local_stock_shortage_count || row.stock_shortage_count || 0) > 0;
  const subject = row.posting_number || row.order_number || `Order ${row.id}`;
  const orderedAt = row.ordered_at || "";
  const meta = `${row.shop_name || ""} / ${normalizeMysqlDateTime(orderedAt) || ""}`;
  const base = {
    subject,
    order_ref: subject,
    shop_name: row.shop_name || "",
    ordered_at: orderedAt,
    shipping_method_text: row.resolved_logistics_rule_name || row.delivery_method_name || row.logistics_channel || "",
    orderId: row.id,
    ...context
  };

  if (view === "binding" && hasUnbound) {
    tasks.push(exceptionTaskMysql({
      ...base,
      type: "order_binding",
      level: "warning",
      title: "订单未绑定库存",
      meta,
      detail: "该订单仍有 SKU 没有关联库存商品。",
      action: "order-unbound"
    }));
  }

  if (view === "stock" && hasStockIssue) {
    tasks.push(exceptionTaskMysql({
      ...base,
      type: "order_stock_shortage",
      level: "danger",
      title: "订单库存不足",
      meta,
      detail: "已绑定库存不足，请优先补货或调整库存。",
      action: "order-stock"
    }));
  }

  if (view === "profit" && profitValue < 0 && !hasUnbound) {
    const breakdown = profitExceptionBreakdownMysql(row, profitValue);
    tasks.push(exceptionTaskMysql({
      ...base,
      type: "profit",
      level: "danger",
      title: "订单利润为负",
      meta: `${row.shop_name || ""} / ${profitValue.toFixed(2)}`,
      detail: "请核对销售额、采购成本、物流费、平台费和售后损失。",
      profit_context_text: `当前利润 ${roundMoneyMysql(profitValue)}，销售额 ${roundMoneyMysql(row.sale_amount_cny || 0)}`,
      profit_formula_lines: breakdown.formula,
      profit_cost_lines: breakdown.costs,
      action: "order-profit"
    }));
  }

  const deadlineAt = row.shipment_deadline_at || fallbackShipDeadlineMysql(row.ordered_at);
  const remaining = deadlineAt ? daysBetweenMysql(new Date(), new Date(deadlineAt)) : null;
  const hasDeadline = deadlineAt && Number.isFinite(remaining);
  const statusText = `${row.status || ""} ${row.tracking_stage || ""} ${row.logistics_status || ""}`.toLowerCase();
  const isFulfillmentStatus = [
    "awaiting_registration",
    "acceptance_in_progress",
    "awaiting_approve",
    "awaiting_packaging",
    "posting_created",
    "awaiting_deliver",
    "posting_registered",
    "sent_by_seller",
    "posting_ready_for_pickup",
    "posting_transferred_to_courier_service",
    "posting_transferring",
    "posting_in_carriage",
    "posting_transferring_to_delivery"
  ].some((item) => statusText.includes(item));

  if ((view === "deadline" || view === "deadline_warning") && hasDeadline && isFulfillmentStatus) {
    const overdue = remaining < 0;
    const warning = remaining >= 0 && remaining <= 1;
    if ((view === "deadline" && overdue) || (view === "deadline_warning" && warning)) {
      tasks.push(exceptionTaskMysql({
        ...base,
        type: view,
        level: overdue ? "danger" : "warning",
        title: overdue ? "订单超时异常" : "订单超时预警",
        meta,
        detail: overdue ? `已超过发货截止时间 ${Math.abs(remaining)} 天。` : remaining === 0 ? "今天到达发货截止时间。" : `距离发货截止时间 ${remaining} 天。`,
        deadline_due_at: deadlineAt,
        deadline_elapsed_days: overdue ? Math.abs(remaining) : "",
        action: "order-deadline"
      }));
    }
  }

  return tasks;
}

function exceptionWorkbenchCacheKeyMysql(query = {}) {
  const normalized = {};
  for (const key of [
    "view",
    "page",
    "pageSize",
    "page_size",
    "search",
    "keyword",
    "dateFrom",
    "date_from",
    "dateTo",
    "date_to",
    "orderPageSize",
    "stockPageSize"
  ]) {
    if (query[key] !== undefined && query[key] !== null && query[key] !== "") normalized[key] = String(query[key]);
  }
  return `exception-workbench:${JSON.stringify(normalized)}`;
}

export async function exceptionWorkbenchMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const refresh = ["1", "true", "yes"].includes(String(query.refresh || "").toLowerCase());
  const cacheKey = exceptionWorkbenchCacheKeyMysql(query);
  if (!refresh) {
    return getCachedMasterData(cacheKey, () => buildExceptionWorkbenchMysql(query), EXCEPTION_WORKBENCH_CACHE_TTL_MS);
  }
  invalidateExceptionWorkbenchCache();
  return buildExceptionWorkbenchMysql(query);
}

async function buildExceptionWorkbenchMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const view = exceptionViewMysql(query);
  const tasks = [];
  const orderPromise = exceptionShouldBuildOrderTasksMysql(view)
    ? exceptionOrderCandidateRowsMysql(view, query).then((rows) => ({ rows }))
    : Promise.resolve({ rows: [] });
  const stockPromise = exceptionShouldBuildStockTasksMysql(view)
    ? stockAlertsMysql({ ...query, paged: "1", page: 1, pageSize: Math.min(Math.max(Number(query.stockPageSize || 120), 50), 300), search: query.search || query.keyword || "" })
    : Promise.resolve({ rows: [] });
  const [orderPayload, stockPayload] = await Promise.all([orderPromise, stockPromise]);

  for (const row of orderPayload.rows || []) {
    tasks.push(...exceptionOrderTasksMysql(row, view));
  }

  for (const row of stockPayload.rows || []) {
    for (const warning of row.warnings || []) {
      if (!["local", "fbp", "fbs", "mapping"].includes(warning.type)) continue;
      tasks.push(exceptionTaskMysql({
        type: `stock_${warning.type}`,
        level: warning.level || "warning",
        title: warning.text || "库存预警",
        subject: row.product_name || row.inventory_id || `库存 ${row.product_id}`,
        meta: `${row.inventory_id || ""} / 本地 ${row.local_stock ?? 0}`,
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
  const withState = tasks
    .filter((task) => exceptionTaskMatchesViewMysql(task, view))
    .map((task) => {
      const state = stateMap.get(task.id);
      const status = state?.status || "open";
      return {
        ...task,
        task_state: status,
        task_state_label: status === "handled" ? "已处理" : status === "ignored" ? "已忽略" : "待处理",
        task_state_updated_at: state?.updated_at || ""
      };
    });
  const from = normalizeSyncDateMysql(query.dateFrom || query.date_from);
  const to = normalizeSyncDateMysql(query.dateTo || query.date_to);
  const keyword = String(query.search || query.keyword || "").trim();
  const visibleTasks = withState.filter((task) => {
    if (["handled", "ignored"].includes(task.task_state)) return false;
    if (!exceptionTaskMatchesSearchMysql(task, keyword)) return false;
    if (!exceptionTaskMatchesDateMysql(task, from, to)) return false;
    return true;
  });
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 50), 1), 200);
  const page = Math.max(Number(query.page || 1), 1);
  const start = (page - 1) * pageSize;
  const rows = visibleTasks.slice(start, start + pageSize);
  return {
    rows,
    total: visibleTasks.length,
    page,
    pageSize,
    resolved_total: withState.filter((item) => ["handled", "ignored"].includes(item.task_state)).length,
    hidden_total: withState.length - visibleTasks.length,
    counts: {
      danger: visibleTasks.filter((item) => item.level === "danger").length,
      warning: visibleTasks.filter((item) => item.level === "warning").length,
      info: visibleTasks.filter((item) => item.level === "info").length,
      profit: visibleTasks.filter((item) => item.type === "profit").length,
      delivery_timeout: visibleTasks.filter((item) => item.type === "deadline").length,
      delivery_warning: visibleTasks.filter((item) => item.type === "deadline_warning").length,
      binding: visibleTasks.filter((item) => item.type === "order_binding").length,
      stock: visibleTasks.filter((item) => item.type === "order_stock_shortage" || item.type.startsWith("stock")).length,
      order: visibleTasks.filter((item) => item.type.startsWith("order") || ["profit", "deadline", "deadline_warning"].includes(item.type)).length
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
  const concurrency = Math.min(Math.max(Number(body.concurrency || 3), 1), 5);
  const activeShops = await mysqlQuery(
    "SELECT * FROM shops WHERE status = 'active' AND (? IS NULL OR id = ?) ORDER BY id",
    [targetShopId, targetShopId]
  );
  const targetShops = activeShops.filter((shop) => !selectedRows.length || selectedShopIds.has(Number(shop.id)));

  let fetched = 0;
  let upserted = 0;
  const errors = [];
  const shopResults = [];

  await mapWithConcurrencyMysql(targetShops, concurrency, async (shop) => {
    const shopResult = {
      shop_id: Number(shop.id),
      shop_name: String(shop.name || ""),
      fetched: 0,
      upserted: 0,
      error: ""
    };
    try {
      const items = await fetchOzonProducts(shop);
      shopResult.fetched = items.length;
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
        shopResult.upserted += 1;
      }
    } catch (error) {
      shopResult.error = error?.message || String(error);
      errors.push(`${shop.name}: ${shopResult.error}`);
    }
    fetched += shopResult.fetched;
    upserted += shopResult.upserted;
    shopResults.push(shopResult);
  });

  const status = errors.length ? "partial_error" : "ok";
  const message = `Fetched ${fetched}, upserted ${upserted}, shops ${targetShops.length}, concurrency ${concurrency}${errors.length ? `; ${errors.join(" | ")}` : ""}`;

  const logResult = await mysqlExecute(
    "INSERT INTO sync_logs (job, status, message) VALUES ('ozon_online_products', ?, ?)",
    [status, message]
  );
  db.prepare("INSERT INTO sync_logs (id, job, status, message) VALUES (?, 'ozon_online_products', ?, ?)")
    .run(Number(logResult.insertId), status, message);

  if (errors.length && upserted === 0) throw new Error(errors.join(" | "));
  return { fetched, upserted, errors, concurrency, shops: shopResults };
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
  from = normalizeSyncDateMysql(from);
  to = normalizeSyncDateMysql(to);
  const orderIds = Array.isArray(arguments[0]?.orderIds) ? arguments[0].orderIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0) : [];
  const orderIdFilterSql = orderIds.length ? ` AND o.id IN (${orderIds.map(() => "?").join(",")})` : "";
  const rows = await mysqlQuery(`
    SELECT o.id AS order_id,
      MAX(o.posting_number) AS posting_number,
      MAX(o.order_number) AS order_number,
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
      ${orderIdFilterSql}
    GROUP BY o.id
  `, [from, from, to, to, ...orderIds]);

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
    const orderAccounting = await classifyOrderAccountingMysql({
      status: row.order_status,
      tracking_stage: row.tracking_stage,
      logistics_status: row.logistics_status,
      delivered_at: row.delivered_at,
      accrued_at: row.accrued_at,
      posting_number: row.posting_number,
      order_number: row.order_number,
      cancel_reason: row.cancel_reason,
      cancel_reason_id: row.cancel_reason_id,
      cancel_initiator: row.cancel_initiator,
      cancel_type: row.cancel_type,
      cancelled_after_ship: row.cancelled_after_ship
    });
    const orderOutcome = orderAccounting.outcome_type;
    const cancellation = describeCancellation({ ...row, outcome_type: orderOutcome });
    const orderLossProfile = { ...cancellation, code: orderAccounting.loss_profile_code };
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
  await ensureOnlineProductsPublishedAtSchemaMysql();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const shopId = String(query.shopId || query.shop_id || "all");
  const status = String(query.status || "all");
  const nameText = String(query.name || query.query || "").trim().toLowerCase();
  const offerText = String(query.offer || query.sku || "").trim().toLowerCase();
  const startDate = String(query.startDate || query.start_date || "").trim();
  const endDate = String(query.endDate || query.end_date || "").trim();
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
  if (startDate) {
    where.push("DATE(COALESCE(op.published_at, op.ozon_updated_at, op.synced_at, op.updated_at)) >= ?");
    params.push(startDate);
  }
  if (endDate) {
    where.push("DATE(COALESCE(op.published_at, op.ozon_updated_at, op.synced_at, op.updated_at)) <= ?");
    params.push(endDate);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const selectSql = `
    SELECT
      op.id, op.shop_id, op.ozon_sku, op.offer_id, op.ozon_product_id, op.name, op.image_url, op.primary_image,
      op.sale_price, op.currency_code, op.marketing_price, op.old_price, op.status, op.visibility, op.archived,
      op.is_discounted,
      CASE WHEN JSON_VALID(op.images_json) THEN JSON_UNQUOTE(JSON_EXTRACT(op.images_json, '$[0]')) ELSE '' END AS first_image_url,
      CASE WHEN op.raw_json IS NOT NULL AND op.raw_json != '' THEN 1 ELSE 0 END AS has_raw_json,
      op.published_at, op.ozon_updated_at, op.product_id, op.synced_at, op.updated_at,
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
    if (status === "all") {
      const [totalRow, countRows, rows] = await Promise.all([
        mysqlQueryOne(`
          SELECT COUNT(*) AS total
          FROM online_products op
          JOIN shops s ON s.id = op.shop_id
          LEFT JOIN products p ON p.id = op.product_id
          ${whereSql}
        `, params),
        mysqlQuery(`
          SELECT ${onlineStatusKeySqlMysql("op")} AS status_key, COUNT(*) AS count
          FROM online_products op
          JOIN shops s ON s.id = op.shop_id
          LEFT JOIN products p ON p.id = op.product_id
          ${whereSql}
          GROUP BY status_key
        `, params),
        mysqlQuery(`
          ${selectSql}
          ORDER BY COALESCE(op.published_at, op.ozon_updated_at, op.synced_at, op.updated_at) DESC, op.id DESC
          LIMIT ? OFFSET ?
        `, [...params, pageSize, (page - 1) * pageSize])
      ]);
      const statusCounts = { all: Number(totalRow?.total || 0), selling: 0, ready: 0, error: 0, moderation: 0, hidden: 0, archived: 0, other: 0 };
      for (const item of countRows) statusCounts[item.status_key] = Number(item.count || 0);
      const mappedRows = rows.map((row) => {
        const fallbackImage = String(row.primary_image || row.image_url || row.first_image_url || "").trim();
        return { ...row, primary_image: fallbackImage, image_url: fallbackImage };
      });
      return {
        rows: mappedRows,
        total: Number(totalRow?.total || 0),
        statusCounts,
        page,
        pageSize,
        mode: "paged"
      };
    }
    const allIds = await mysqlQuery(`
      SELECT op.id, op.status, op.visibility, op.archived, op.published_at, op.synced_at, op.updated_at, op.ozon_updated_at
      FROM online_products op
      JOIN shops s ON s.id = op.shop_id
      LEFT JOIN products p ON p.id = op.product_id
      ${whereSql}
      ORDER BY COALESCE(op.published_at, op.ozon_updated_at, op.synced_at, op.updated_at) DESC, op.id DESC
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
      const fallbackImage = String(row.primary_image || row.image_url || row.first_image_url || "").trim();
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
    ORDER BY COALESCE(op.published_at, op.ozon_updated_at, op.synced_at, op.updated_at) DESC, op.id DESC
  `, params);

  const mappedRows = rows.map((row) => {
    const fallbackImage = String(row.primary_image || row.image_url || row.first_image_url || "").trim();
    return {
      ...row,
      primary_image: fallbackImage,
      image_url: fallbackImage
    };
  });
  return mappedRows;
}

function onlineStatusDisplayRankMysql(row) {
  const key = onlineStatusKeyMysql(row);
  if (key === "selling") return 0;
  if (key === "ready") return 1;
  if (key === "moderation") return 2;
  if (key === "error") return 3;
  if (key === "hidden") return 4;
  if (key === "archived") return 5;
  return 6;
}

function sortOnlineProductsByDisplayPriorityMysql(a, b) {
  const publishedDiff = new Date(
    b.published_at || b.ozon_updated_at || b.synced_at || b.updated_at || 0
  ).getTime() - new Date(
    a.published_at || a.ozon_updated_at || a.synced_at || a.updated_at || 0
  ).getTime();
  if (Number.isFinite(publishedDiff) && publishedDiff) return publishedDiff;
  return Number(b.id || 0) - Number(a.id || 0);
}

let onlineProductsPublishedAtSchemaReady = false;

async function ensureOnlineProductsPublishedAtSchemaMysql() {
  if (onlineProductsPublishedAtSchemaReady) return;
  await ensureMysqlColumns("online_products", [
    "ALTER TABLE online_products ADD COLUMN published_at DATETIME NULL",
    "ALTER TABLE online_products ADD KEY idx_online_products_published (published_at, id)"
  ]);
  await mysqlExecute(`
    UPDATE online_products
    SET published_at = COALESCE(
      published_at,
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.published_at')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.publishedAt')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.created_at')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.createdAt')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.date')), '')
    )
    WHERE published_at IS NULL
      AND raw_json IS NOT NULL
      AND raw_json != ''
  `).catch(() => {});
  onlineProductsPublishedAtSchemaReady = true;
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

function onlineStatusKeySqlMysql(alias = "op") {
  const status = `LOWER(COALESCE(${alias}.status, ''))`;
  const visibility = `LOWER(COALESCE(${alias}.visibility, ''))`;
  return `
    CASE
      WHEN COALESCE(${alias}.archived, 0) <> 0 OR ${status} LIKE '%archive%' THEN 'archived'
      WHEN ${status} LIKE '%error%' OR ${status} LIKE '%fail%' OR ${visibility} LIKE '%failed%' OR ${visibility} LIKE '%banned%' THEN 'error'
      WHEN ${status} LIKE '%moder%' OR ${status} LIKE '%edit%' OR ${status} LIKE '%validation%' OR ${visibility} LIKE '%pending%' THEN 'moderation'
      WHEN ${status} LIKE '%ready%' OR ${status} LIKE '%created%' OR ${visibility} LIKE '%ready_to_supply%' OR ${visibility} LIKE '%empty_stock%' THEN 'ready'
      WHEN ${visibility} LIKE '%hidden%' OR ${visibility} LIKE '%blocked%' OR ${visibility} LIKE '%removed_from_sale%' OR ${status} LIKE '%hidden%' OR ${status} LIKE '%offline%' THEN 'hidden'
      WHEN ${status} LIKE '%online%' OR ${status} LIKE '%active%' OR ${status} LIKE '%sell%' OR ${visibility} LIKE '%in_sale%' OR ${visibility} LIKE '%visible%' OR ${visibility} LIKE '%moderated%' THEN 'selling'
      ELSE 'other'
    END
  `;
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
  if (!product) throw new Error(`Product not found: ${productId}`);

  const personId = await resolveExistingPersonId(body.person_id);
  const bindSku = String(body.ozon_sku || online.ozon_sku || "").trim();
  if (!bindSku) throw new Error("ozon_sku is required");
  const orderItemId = Number(body.order_item_id || body.orderItemId || 0);
  const existingMapping = await mysqlQueryOne(
    "SELECT * FROM sku_mappings WHERE shop_id = ? AND ozon_sku = ?",
    [Number(online.shop_id), bindSku]
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
      bindSku,
      String(online.offer_id || ""),
      String(online.name || "")
    ];
    const result = await mysqlExecute(`
      INSERT INTO sku_mappings
      (shop_id, product_id, person_id, online_product_id, ozon_sku, offer_id, display_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, payload);
    mappingId = Number(result.insertId);
    const legacyExisting = db.prepare("SELECT id FROM sku_mappings WHERE shop_id = ? AND ozon_sku = ?").get(Number(online.shop_id), bindSku);
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

  if (orderItemId) {
    const updateOrderItemPayload = [mappingId, orderItemId, bindSku, Number(online.shop_id)];
    await mysqlExecute(`
      UPDATE order_items
      SET sku_mapping_id = ?
      WHERE id = ?
        AND TRIM(ozon_sku) = ?
        AND order_id IN (SELECT id FROM orders WHERE shop_id = ?)
    `, updateOrderItemPayload);
    db.prepare(`
      UPDATE order_items
      SET sku_mapping_id = ?
      WHERE id = ?
        AND TRIM(ozon_sku) = ?
        AND order_id IN (SELECT id FROM orders WHERE shop_id = ?)
    `).run(...updateOrderItemPayload);
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

function isOzonItemNotFoundError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("item not found") || message.includes("not found");
}

function archivedOnlineOrderExceptionTaskIdsMysql(orderId) {
  return [
    exceptionTaskMysql({ type: "profit", orderId, title: "订单利润为负" }).id,
    exceptionTaskMysql({ type: "deadline", orderId, title: "订单超时异常" }).id,
    exceptionTaskMysql({ type: "deadline_warning", orderId, title: "订单超时预警" }).id,
    exceptionTaskMysql({ type: "order_stock_shortage", orderId, title: "订单库存不足" }).id,
    exceptionTaskMysql({ type: "order_binding", orderId, title: "订单未绑定库存" }).id
  ];
}

async function relatedArchivedOnlineProductExceptionTaskIdsMysql(online = {}) {
  const taskIds = new Set();
  const shopId = Number(online.shop_id || 0);
  const onlineProductId = Number(online.id || 0);
  const ozonSku = String(online.ozon_sku || "").trim();
  const offerId = String(online.offer_id || "").trim();
  const productIds = new Set();
  if (Number(online.product_id || 0) > 0) productIds.add(Number(online.product_id));

  if (shopId && ozonSku) {
    const orderRows = await mysqlQuery(`
      SELECT DISTINCT o.id
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.shop_id = ? AND oi.ozon_sku = ?
    `, [shopId, ozonSku]);
    for (const row of orderRows) {
      for (const taskId of archivedOnlineOrderExceptionTaskIdsMysql(Number(row.id))) taskIds.add(taskId);
    }
  }

  if (shopId && (onlineProductId || ozonSku || offerId)) {
    const mappingWhere = [];
    const mappingParams = [shopId];
    if (onlineProductId) {
      mappingWhere.push("online_product_id = ?");
      mappingParams.push(onlineProductId);
    }
    if (ozonSku) {
      mappingWhere.push("ozon_sku = ?");
      mappingParams.push(ozonSku);
    }
    if (offerId) {
      mappingWhere.push("offer_id = ?");
      mappingParams.push(offerId);
    }
    const mappingRows = mappingWhere.length
      ? await mysqlQuery(`
        SELECT DISTINCT product_id
        FROM sku_mappings
        WHERE shop_id = ? AND active = 1 AND (${mappingWhere.join(" OR ")})
      `, mappingParams)
      : [];
    for (const row of mappingRows) {
      const productId = Number(row.product_id || 0);
      if (productId) productIds.add(productId);
    }
  }

  if (productIds.size) {
    const stockPayload = await stockAlertsMysql({ mode: "alerts", paged: "0" });
    for (const row of stockPayload.rows || []) {
      const productId = Number(row.product_id || 0);
      if (!productIds.has(productId)) continue;
      for (const warning of row.warnings || []) {
        if (!["local", "fbp", "fbs", "mapping"].includes(warning.type)) continue;
        taskIds.add(exceptionTaskMysql({
          type: `stock_${warning.type}`,
          productId,
          title: warning.text || "库存预警"
        }).id);
      }
    }
  }

  return [...taskIds];
}

async function markArchivedOnlineProductExceptionsHandledMysql(online = {}, userId = null) {
  const taskIds = await relatedArchivedOnlineProductExceptionTaskIdsMysql(online);
  return upsertExceptionTaskStatesMysql(taskIds, "handled", "在线商品已归档，关联异常自动标记为已处理", userId);
}

async function resolveFreshOzonProductIdForArchiveMysql(shop, online = {}) {
  const offerIds = [online.offer_id, online.ozon_sku].map((item) => String(item || "").trim()).filter(Boolean);
  if (!offerIds.length) return 0;
  const stockRows = await fetchOzonProductStocks(shop, { offerIds, limit: 1000 });
  const matched = stockRows.find((row) => (
    offerIds.includes(String(row.offer_id || "").trim()) ||
    offerIds.includes(String(row.ozon_sku || "").trim())
  ));
  const productId = Number(matched?.ozon_product_id || 0);
  if (productId) {
    await mysqlExecute("UPDATE online_products SET ozon_product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [String(productId), Number(online.id)]);
    db.prepare("UPDATE online_products SET ozon_product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(String(productId), Number(online.id));
  }
  return productId;
}

export async function onlineProductWarehousesMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const shopId = Number(query.shop_id || query.shopId || 0);
  if (!shopId) throw new Error("请选择店铺后再获取 Ozon 仓库");
  const shop = await mysqlQueryOne("SELECT * FROM shops WHERE id = ? AND status != 'deleted'", [shopId]);
  if (!shop) throw new Error("店铺不存在");
  const warehouses = await fetchOzonWarehouses(shop);
  return {
    shop_id: shopId,
    shop_name: shop.name || "",
    warehouses
  };
}

function normalizeOzonAttributeValueObjectsMysql(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      if (!value || typeof value !== "object") return null;
      const text = String(value.value || value.name || "").trim();
      const dictionaryValueId = Number(value.dictionary_value_id || value.id || 0);
      if (!text && !dictionaryValueId) return null;
      return {
        ...(dictionaryValueId ? { dictionary_value_id: dictionaryValueId } : {}),
        ...(text ? { value: text } : {})
      };
    })
    .filter(Boolean);
}

function onlineProductAttributeValueMysql(attribute = {}, isCollection = false) {
  const values = normalizeOzonAttributeValueObjectsMysql(attribute.values || []);
  if (isCollection) return values.map((item) => String(item.value || "").trim()).filter(Boolean);
  return values[0]?.value || "";
}

function attributeValueTextByIdsMysql(attributes = [], ids = []) {
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).map((item) => String(item || "")).filter(Boolean));
  const found = (Array.isArray(attributes) ? attributes : []).find((item) => idSet.has(String(item?.id || item?.attribute_id || "")));
  return onlineProductAttributeValueMysql(found, false);
}

function normalizeOnlineAttributeNameMysql(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function onlineProductAttributeMatchesMysql(attribute = {}, ids = [], keywords = []) {
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).map((item) => String(item || "")).filter(Boolean));
  const attrId = String(attribute?.id || attribute?.attribute_id || "").trim();
  if (attrId && idSet.has(attrId)) return true;
  const normalizedName = normalizeOnlineAttributeNameMysql(attribute?.name || attribute?.attribute_name || "");
  return (Array.isArray(keywords) ? keywords : [keywords])
    .map((item) => normalizeOnlineAttributeNameMysql(item))
    .filter(Boolean)
    .some((keyword) => normalizedName.includes(keyword));
}

function attributeValueTextByIdsOrKeywordsMysql(attributes = [], ids = [], keywords = [], isCollection = false) {
  const found = (Array.isArray(attributes) ? attributes : []).find((item) => onlineProductAttributeMatchesMysql(item, ids, keywords));
  return onlineProductAttributeValueMysql(found, isCollection);
}

function onlineProductRawTextByKeysMysql(raw = {}, keyCandidates = []) {
  const keys = new Set((Array.isArray(keyCandidates) ? keyCandidates : [keyCandidates]).map((item) => normalizeOnlineAttributeNameMysql(item)).filter(Boolean));
  if (!keys.size || !raw || typeof raw !== "object") return "";
  const queue = [raw];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      const normalizedKey = normalizeOnlineAttributeNameMysql(key);
      if (keys.has(normalizedKey)) {
        const text = String(value?.value || value?.name || value || "").trim();
        if (text) return text;
      }
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return "";
}

function mergeOnlineProductSourceAttributesMysql(primaryAttributes = [], fallbackAttributes = []) {
  const byId = new Map();
  for (const item of Array.isArray(fallbackAttributes) ? fallbackAttributes : []) {
    const key = String(item?.id || item?.attribute_id || "").trim();
    if (key) byId.set(key, item);
  }
  for (const item of Array.isArray(primaryAttributes) ? primaryAttributes : []) {
    const key = String(item?.id || item?.attribute_id || "").trim();
    if (!key) continue;
    const fallback = byId.get(key);
    if (!fallback) {
      byId.set(key, item);
      continue;
    }
    const primaryValues = normalizeOzonAttributeValueObjectsMysql(item?.values || []);
    const fallbackValues = normalizeOzonAttributeValueObjectsMysql(fallback?.values || []);
    byId.set(key, {
      ...fallback,
      ...item,
      name: item?.name || fallback?.name || "",
      attribute_name: item?.attribute_name || fallback?.attribute_name || "",
      values: primaryValues.length ? primaryValues : fallbackValues
    });
  }
  return [...byId.values()];
}

function mergeOnlineProductEditableAttributesMysql(currentAttributes = [], schemaAttributes = []) {
  const currentById = new Map(
    (Array.isArray(currentAttributes) ? currentAttributes : [])
      .map((item) => [String(item?.id || item?.attribute_id || ""), item])
      .filter(([key]) => key)
  );
  const merged = [];
  for (const schema of Array.isArray(schemaAttributes) ? schemaAttributes : []) {
    const id = Number(schema?.id || schema?.attribute_id || 0);
    if (!id) continue;
    const current = currentById.get(String(id)) || {};
    merged.push({
      attribute_id: id,
      id,
      name: String(schema?.name || current?.name || `属性 ${id}`).trim(),
      value: onlineProductAttributeValueMysql(current, Boolean(schema?.is_collection)),
      values: normalizeOzonAttributeValueObjectsMysql(current?.values || []),
      required: Boolean(schema?.is_required || schema?.required),
      dictionary_id: Number(schema?.dictionary_id || 0) || "",
      is_collection: Boolean(schema?.is_collection),
      type: String(schema?.type || "").trim(),
      source: "online_product_live",
      raw: current && Object.keys(current).length ? current : schema
    });
    currentById.delete(String(id));
  }
  for (const current of currentById.values()) {
    const id = Number(current?.id || current?.attribute_id || 0);
    if (!id) continue;
    merged.push({
      attribute_id: id,
      id,
      name: String(current?.name || `属性 ${id}`).trim(),
      value: onlineProductAttributeValueMysql(current, false),
      values: normalizeOzonAttributeValueObjectsMysql(current?.values || []),
      required: false,
      dictionary_id: "",
      is_collection: false,
      type: "",
      source: "online_product_live",
      raw: current
    });
  }
  return merged;
}

function onlineProductImageItemsMysql(urls = []) {
  return (Array.isArray(urls) ? urls : [])
    .map((url) => String(url || "").trim())
    .filter(Boolean)
    .map((url, index) => ({ url, sort_order: index + 1 }));
}

function collectUrlsFromNestedValueMysql(value, urls = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrlsFromNestedValueMysql(item, urls));
    return urls;
  }
  if (value && typeof value === "object") {
    const directUrl = String(value.url || value.value || "").trim();
    if (/^https?:\/\//i.test(directUrl)) urls.push(directUrl);
    Object.values(value).forEach((item) => collectUrlsFromNestedValueMysql(item, urls));
    return urls;
  }
  const text = String(value || "").trim();
  if (/^https?:\/\//i.test(text)) urls.push(text);
  return urls;
}

function onlineProductRawMediaUrlsMysql(raw = {}, keyCandidates = []) {
  const keys = (Array.isArray(keyCandidates) ? keyCandidates : [keyCandidates])
    .map((item) => normalizeOnlineAttributeNameMysql(item))
    .filter(Boolean);
  if (!keys.length || !raw || typeof raw !== "object") return [];
  const urls = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = normalizeOnlineAttributeNameMysql(key);
      if (keys.some((candidate) => normalizedKey.includes(candidate))) {
        collectUrlsFromNestedValueMysql(value, urls);
      }
      visit(value);
    }
  };
  visit(raw);
  return [...new Set(urls)];
}

function onlineProductComplexAttributeUrlsMysql(complexAttributes = [], targetIds = []) {
  const ids = new Set((Array.isArray(targetIds) ? targetIds : [targetIds]).map((item) => Number(item || 0)).filter(Boolean));
  if (!ids.size) return [];
  const urls = [];
  for (const item of Array.isArray(complexAttributes) ? complexAttributes : []) {
    const attributeId = Number(item?.id || item?.attribute_id || 0);
    if (!ids.has(attributeId)) continue;
    for (const value of Array.isArray(item?.values) ? item.values : []) {
      const url = String(value?.value || value?.url || value || "").trim();
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

function onlineProductComplexAttributeUrlsByIdsOrNamesMysql(complexAttributes = [], ids = [], keywords = []) {
  const urls = [];
  for (const item of Array.isArray(complexAttributes) ? complexAttributes : []) {
    if (!onlineProductAttributeMatchesMysql(item, ids, keywords)) continue;
    for (const value of Array.isArray(item?.values) ? item.values : []) {
      const url = String(value?.value || value?.url || value || "").trim();
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

async function resolveOzonCategoryNameMysql(descriptionCategoryId, typeId) {
  const descriptionId = Number(descriptionCategoryId || 0);
  const normalizedTypeId = Number(typeId || 0);
  if (!descriptionId || !normalizedTypeId) return "";
  const rows = await mysqlQuery(`
    SELECT
      COALESCE(NULLIF(path_zh, ''), NULLIF(name_zh, ''), NULLIF(path_ru, ''), NULLIF(name_ru, '')) AS category_name
    FROM ozon_category_mappings
    WHERE description_category_id = ? AND type_id = ? AND status = 'active'
    LIMIT 1
  `, [descriptionId, normalizedTypeId]).catch(() => []);
  return String(rows?.[0]?.category_name || "").trim();
}

export async function onlineProductEditDraftMysql(id) {
  ensureMysqlCutoverEnabled();
  const onlineProductId = Number(id);
  if (!onlineProductId) throw new Error("Missing online product id");
  const online = await mysqlQueryOne(`
    SELECT op.*, s.name AS shop_name
    FROM online_products op
    JOIN shops s ON s.id = op.shop_id
    WHERE op.id = ?
  `, [onlineProductId]);
  if (!online) throw new Error("Online product not found");
  if (!online.shop_id) throw new Error("在线商品缺少店铺信息");
  const shop = await mysqlQueryOne("SELECT * FROM shops WHERE id = ? AND status != 'deleted'", [Number(online.shop_id)]);
  if (!shop) throw new Error("店铺不存在或已停用");

  const productRefs = [];
  const offerId = String(online.offer_id || "").trim();
  const ozonSku = String(online.ozon_sku || "").trim();
  const productId = Number(online.ozon_product_id || 0);
  if (offerId) productRefs.push(offerId);
  if (ozonSku && ozonSku !== offerId) productRefs.push(ozonSku);

  let liveDetail = null;
  if (productRefs.length) {
    const liveRowsByOffer = await fetchOzonProductInfoAttributes(shop, {
      offerIds: productRefs
    }).catch(() => []);
    liveDetail = (Array.isArray(liveRowsByOffer) ? liveRowsByOffer : [liveRowsByOffer]).find((item) => item) || null;
  }
  if (!liveDetail && productId) {
    const liveRowsByProductId = await fetchOzonProductInfoAttributes(shop, {
      productIds: [productId]
    }).catch(() => []);
    liveDetail = (Array.isArray(liveRowsByProductId) ? liveRowsByProductId : [liveRowsByProductId]).find((item) => item) || null;
  }
  if (!liveDetail) {
    throw new Error("未能从 Ozon 拉到该商品的实时编辑信息，请先同步在线商品后再试");
  }

  const descriptionCategoryId = Number(liveDetail.description_category_id || 0);
  const typeId = Number(liveDetail.type_id || 0);
  const storedAttributes = parseJsonFallback(online.attributes_json, []);
  const storedRaw = parseJsonFallback(online.raw_json, {});
  const mergedLiveAttributes = mergeOnlineProductSourceAttributesMysql(liveDetail.attributes || [], storedAttributes);
  const mergedComplexAttributes = mergeOnlineProductSourceAttributesMysql(
    liveDetail.complex_attributes || [],
    storedRaw.complex_attributes || []
  );
  const schemaAttributes = descriptionCategoryId && typeId
    ? await fetchOzonCategoryAttributes(shop, {
      descriptionCategoryId,
      typeId,
      language: "ZH_HANS"
    }).catch(() => [])
    : [];
  const mergedAttributes = mergeOnlineProductEditableAttributesMysql(mergedLiveAttributes, schemaAttributes);
  const summary = String(
    attributeValueTextByIdsMysql(mergedLiveAttributes, [4191])
    || onlineProductRawTextByKeysMysql(storedRaw, ["summary", "description", "annotation"])
    || ""
  ).trim();
  const richJson = String(
    attributeValueTextByIdsMysql(mergedLiveAttributes, [11254])
    || onlineProductRawTextByKeysMysql(storedRaw, ["rich_content_json", "richcontentjson", "rich_json"])
    || ""
  ).trim();
  const videoUrls = [...new Set([
    ...onlineProductComplexAttributeUrlsMysql(mergedComplexAttributes, [21841]),
    ...onlineProductComplexAttributeUrlsByIdsOrNamesMysql(mergedComplexAttributes, [], ["video url", "video", "видео"]),
    ...onlineProductRawMediaUrlsMysql(storedRaw, ["video_urls", "video_url", "videos", "video"])
  ])];
  const videoCoverUrls = [...new Set([
    ...onlineProductComplexAttributeUrlsMysql(mergedComplexAttributes, [21845]),
    ...onlineProductComplexAttributeUrlsByIdsOrNamesMysql(mergedComplexAttributes, [], ["video cover", "cover video", "видео облож", "облож"]),
    ...onlineProductRawMediaUrlsMysql(storedRaw, ["video_cover_urls", "video_cover_url", "video_covers", "cover_video_urls", "cover_video_url", "cover_video"])
  ])];
  const brandValue = attributeValueTextByIdsOrKeywordsMysql(mergedLiveAttributes, [85], ["brand", "бренд", "品牌"]);
  const modelValue = attributeValueTextByIdsOrKeywordsMysql(mergedLiveAttributes, [9048], ["model", "модел", "型号"]);
  const colorValue = attributeValueTextByIdsOrKeywordsMysql(mergedLiveAttributes, [10096, 22814], ["color", "цвет", "颜色"]);
  const quantityValue = attributeValueTextByIdsOrKeywordsMysql(mergedLiveAttributes, [7202], ["quantity", "pieces", "колич", "件数"]);
  const tagValues = attributeValueTextByIdsOrKeywordsMysql(mergedLiveAttributes, [23171], ["tag", "keyword", "ключ", "тег", "标签"], true);
  const categoryName = String(
    liveDetail.category_name
    || online.category_name
    || await resolveOzonCategoryNameMysql(descriptionCategoryId, typeId)
    || ""
  ).trim();
  const baseImages = [
    String(liveDetail.primary_image || "").trim(),
    ...((Array.isArray(liveDetail.images) ? liveDetail.images : []).map((item) => String(item || "").trim()))
  ].filter(Boolean);
  const uniqueImages = [...new Set(baseImages)];
  const primaryImage = uniqueImages[0] || String(online.primary_image || online.image_url || "").trim();
  const extraImages = uniqueImages.filter((url) => url !== primaryImage);
  const itemPayload = {
    offer_id: offerId || ozonSku || String(liveDetail.offer_id || "").trim(),
    name: String(liveDetail.name || online.name || "").trim(),
    price: String(online.sale_price || 0),
    old_price: String(online.old_price || online.marketing_price || online.sale_price || 0),
    currency_code: String(online.currency_code || "CNY").trim() || "CNY",
    vat: "0",
    description_category_id: descriptionCategoryId || undefined,
    type_id: typeId || undefined,
    depth: Number(liveDetail.depth || 0),
    width: Number(liveDetail.width || 0),
    height: Number(liveDetail.height || 0),
    dimension_unit: String(liveDetail.dimension_unit || "mm").trim() || "mm",
    weight: Number(liveDetail.weight || 0),
    weight_unit: String(liveDetail.weight_unit || "g").trim() || "g",
    primary_image: primaryImage,
    images: extraImages,
    video_urls: videoUrls,
    video_cover_urls: videoCoverUrls,
    description: summary,
    attributes: mergedLiveAttributes,
    complex_attributes: mergedComplexAttributes,
    rich_content_json: richJson
  };
  const variant = {
    id: `online-${onlineProductId}`,
    sku: itemPayload.offer_id,
    offer_id: itemPayload.offer_id,
    name: itemPayload.name,
    title: itemPayload.name,
    images: onlineProductImageItemsMysql(uniqueImages),
    video_urls: videoUrls,
    video_cover_urls: videoCoverUrls,
    color: colorValue,
    color_values: colorValue ? [colorValue] : [],
    price: Number(online.sale_price || 0),
    old_price: Number(online.old_price || online.marketing_price || online.sale_price || 0),
    weight_g: Number(liveDetail.weight || 0),
    length_mm: Number(liveDetail.depth || 0),
    width_mm: Number(liveDetail.width || 0),
    height_mm: Number(liveDetail.height || 0),
    stock: Number(quantityValue || 0)
  };
  const template = {
    id: "",
    template_name: `在线商品编辑 / ${itemPayload.offer_id || onlineProductId}`,
    title: itemPayload.name,
    description: summary,
    ozon_category_id: descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : "",
    category_name: categoryName,
    images: onlineProductImageItemsMysql(uniqueImages),
    attributes: mergedAttributes,
    source_raw: {
      source_type: "online_product_live",
      online_product_id: onlineProductId,
      shop_id: Number(online.shop_id),
      shop_name: online.shop_name || "",
      offer_id: itemPayload.offer_id,
      ozon_sku: ozonSku,
      ozon_product_id: productId || Number(liveDetail.id || 0) || 0,
      from_online_product: true,
      items: [itemPayload]
    },
    editable_payload: {
      sku: itemPayload.offer_id,
      title: itemPayload.name,
      description: summary,
      category_id: descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : "",
      description_category_id: descriptionCategoryId || "",
      type_id: typeId || "",
      legacy_category_id: descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : "",
      category_name: categoryName,
      price: {
        value: Number(online.sale_price || 0),
        old_price: Number(online.old_price || online.marketing_price || online.sale_price || 0),
        currency_code: String(online.currency_code || "CNY").trim() || "CNY",
        vat: "0"
      },
      dimensions: {
        length_cm: Number(liveDetail.depth || 0) / 10,
        width_cm: Number(liveDetail.width || 0) / 10,
        height_cm: Number(liveDetail.height || 0) / 10,
        weight_g: Number(liveDetail.weight || 0)
      },
      logistics: {
        brand: brandValue,
        color: colorValue,
        spec: modelValue,
        model: modelValue,
        modelName: modelValue,
        quantity: quantityValue,
        tags: tagValues
      },
      rich_content_json: richJson,
      attributes: mergedAttributes,
      images: onlineProductImageItemsMysql(uniqueImages),
      video_urls: videoUrls,
      video_cover_urls: videoCoverUrls,
      variants: [variant],
      source_raw: {
        source_type: "online_product_live",
        online_product_id: onlineProductId,
        shop_id: Number(online.shop_id),
        offer_id: itemPayload.offer_id,
        ozon_sku: ozonSku,
        ozon_product_id: productId || Number(liveDetail.id || 0) || 0,
        from_online_product: true,
        items: [itemPayload]
      }
    }
  };
  return {
    ok: true,
    shop_id: Number(online.shop_id),
    shop_name: online.shop_name || "",
    online_product_id: onlineProductId,
    offer_id: itemPayload.offer_id,
    ozon_product_id: productId || Number(liveDetail.id || 0) || 0,
    draft_source: "online_product_live",
    template
  };
}

function normalizeBulkStockOnlineProductIdsMysql(body = {}) {
  return [...new Set((body.online_product_ids || body.onlineProductIds || body.ids || [])
    .map(Number)
    .filter(Boolean))];
}

export async function batchUpdateOnlineProductStocksMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const onlineProductIds = normalizeBulkStockOnlineProductIdsMysql(body);
  const stock = Math.max(0, Math.round(Number(body.stock ?? body.quantity ?? 888)));
  const warehouseId = String(body.warehouse_id || body.warehouseId || "").trim();
  const shopId = Number(body.shop_id || body.shopId || 0);
  if (!onlineProductIds.length) throw new Error("请选择需要更新库存的在线商品");
  if (!warehouseId) throw new Error("请选择 Ozon 仓库");

  const rows = await mysqlQuery(`
    SELECT op.*, s.name AS shop_name
    FROM online_products op
    JOIN shops s ON s.id = op.shop_id
    WHERE op.id IN (${onlineProductIds.map(() => "?").join(",")})
  `, onlineProductIds);
  if (!rows.length) throw new Error("没有找到可更新库存的在线商品");

  const targetShopIds = [...new Set(rows.map((row) => Number(row.shop_id || 0)).filter(Boolean))];
  if (shopId && targetShopIds.some((id) => id !== shopId)) throw new Error("所选商品不属于当前店铺，请按店铺分批更新库存");
  if (targetShopIds.length !== 1) throw new Error("请先筛选单个店铺，再批量更新库存");

  const targetShopId = targetShopIds[0];
  const shop = await mysqlQueryOne("SELECT * FROM shops WHERE id = ? AND status != 'deleted'", [targetShopId]);
  if (!shop) throw new Error("店铺不存在");

  const targets = [];
  const skipped = [];
  for (const row of rows) {
    if (!String(row.offer_id || "").trim() && !Number(row.ozon_product_id || 0)) {
      skipped.push({ online_product_id: Number(row.id), reason: "缺少 offer_id / product_id" });
      continue;
    }
    targets.push({
      online_product_id: Number(row.id),
      offer_id: String(row.offer_id || ""),
      product_id: Number(row.ozon_product_id || 0),
      stock,
      warehouse_id: warehouseId
    });
  }
  if (!targets.length) throw new Error("所选商品缺少可用于更新库存的 offer_id / product_id");

  const actionIds = [];
  for (const row of rows.filter((item) => targets.some((target) => target.online_product_id === Number(item.id)))) {
    actionIds.push(await recordOnlineProductActionMysql({
      online: row,
      action: "batch_update_stock",
      status: "pending",
      request: { stock, warehouse_id: warehouseId },
      userId
    }));
  }

  const result = {
    ok: true,
    shop_id: targetShopId,
    shop_name: shop.name || "",
    warehouse_id: warehouseId,
    stock,
    requested_count: onlineProductIds.length,
    target_count: targets.length,
    skipped,
    response: null
  };

  try {
    result.response = await updateOzonProductStocks(shop, targets);
    for (const actionId of actionIds) await finishOnlineProductActionMysql(actionId, "success", result, "");
    invalidateMasterDataCachePrefix("online-products:");
    return result;
  } catch (error) {
    result.ok = false;
    result.error = error.message || String(error);
    for (const actionId of actionIds) await finishOnlineProductActionMysql(actionId, "failed", result, result.error);
    throw new Error(`批量更新 Ozon 库存失败：${result.error}`);
  }
}

export async function performOnlineProductActionMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const onlineProductId = Number(body.online_product_id || body.id || 0);
  const action = String(body.action || "").trim();
  if (!onlineProductId) throw new Error("Missing online product id");
  if (!["archive", "zero_stock", "zero_then_archive"].includes(action)) throw new Error("Unsupported online product action");
  const online = await mysqlQueryOne("SELECT * FROM online_products WHERE id = ?", [onlineProductId]);
  if (!online) throw new Error("Online product not found");
  const alreadyArchived = Number(online.archived || 0) || String(`${online.status || ""} ${online.visibility || ""}`).toLowerCase().includes("archive");
  if ((action === "archive" || action === "zero_then_archive") && alreadyArchived) {
    const result = {
      ok: true,
      action,
      already_archived: true,
      online_product_id: onlineProductId,
      message: "该在线商品此前已归档，本次无需重复归档。",
      steps: [{ action: "archive", ok: true, skipped: true, reason: "already_archived" }]
    };
    await mysqlExecute("UPDATE online_products SET archived = 1, status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [onlineProductId]);
    db.prepare("UPDATE online_products SET archived = 1, status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(onlineProductId);
    const handledResult = await markArchivedOnlineProductExceptionsHandledMysql(online, userId);
    result.handled_exception_count = handledResult.count;
    result.handled_exception_task_ids = handledResult.task_ids;
    invalidateMasterDataCachePrefix("online-products:");
    invalidateExceptionWorkbenchCache();
    return result;
  }
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
      let ozonProductId = Number(online.ozon_product_id || 0);
      if (!ozonProductId) {
        ozonProductId = await resolveFreshOzonProductIdForArchiveMysql(shop, online);
      }
      if (!ozonProductId) {
        throw new Error(`在线商品 ${online.name || online.ozon_sku || onlineProductId} 缺少可归档的 Ozon product_id。请先同步在线商品，或确认该 offer_id 属于当前店铺。`);
      }
      let archiveResult;
      try {
        archiveResult = await archiveOzonProducts(shop, [ozonProductId]);
      } catch (error) {
        const message = String(error?.message || error || "").toLowerCase();
        if (message.includes("already") && message.includes("archiv")) {
          archiveResult = { already_archived: true, message: error.message || String(error) };
          result.already_archived = true;
        } else if (isOzonItemNotFoundError(error)) {
          const freshProductId = await resolveFreshOzonProductIdForArchiveMysql(shop, online);
          if (!freshProductId || freshProductId === ozonProductId) {
            throw new Error(`Ozon 未找到 product_id=${ozonProductId}。已尝试用 offer_id/SKU「${online.offer_id || online.ozon_sku || "-"}」重新查询，但没有找到可归档商品。请先同步在线商品，或确认商品是否属于当前店铺/已被删除。`);
          }
          result.steps.push({ action: "refresh_product_id", ok: true, previous_product_id: ozonProductId, product_id: freshProductId });
          ozonProductId = freshProductId;
          archiveResult = await archiveOzonProducts(shop, [ozonProductId]);
        } else {
          throw error;
        }
      }
      await mysqlExecute("UPDATE online_products SET archived = 1, status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [onlineProductId]);
      db.prepare("UPDATE online_products SET archived = 1, status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(onlineProductId);
      const handledResult = await markArchivedOnlineProductExceptionsHandledMysql({ ...online, archived: 1, status: "archived" }, userId);
      result.handled_exception_count = handledResult.count;
      result.handled_exception_task_ids = handledResult.task_ids;
      result.steps.push({ action: "archive", ok: true, result: archiveResult });
    }
    await finishOnlineProductActionMysql(actionId, "success", result, "");
    invalidateMasterDataCachePrefix("online-products:");
    invalidateExceptionWorkbenchCache();
    return result;
  } catch (error) {
    result.ok = false;
    result.error = `归档在线商品「${online.name || online.ozon_sku || onlineProductId}」失败：${error.message || String(error)}`;
    await finishOnlineProductActionMysql(actionId, "failed", result, result.error);
    throw new Error(result.error);
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
  const sortKey = String(query.sortKey || query.sort_key || "").trim();
  const sortDir = String(query.sortDir || query.sort_dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortSqlMap = {
    product: "p.name",
    stock: "total_stock",
    incoming_stock: "incoming_stock",
    fbp_transfer_in_transit_qty: "fbp_transfer_in_transit_qty",
    total_sales_quantity: "total_sales_quantity",
    total_sales_amount: "total_sales_amount",
    order_count: "order_count",
    total_purchase_amount: "total_purchase_amount",
    manual_outbound_quantity: "manual_outbound_quantity",
    manual_outbound_amount: "manual_outbound_amount",
    avg_unit_cost: "avg_unit_cost",
    estimated_profit_total: "estimated_profit_total",
    actual_profit_total: "actual_profit_total",
    profit_rate: "profit_rate",
    inventory_value: "inventory_value"
  };
  const productSortSql = sortSqlMap[sortKey] ? `${sortSqlMap[sortKey]} ${sortDir}, p.id DESC` : "p.id DESC";
  const productListFieldsSql = `
        p.id, p.selection_id, p.code, p.name, p.image_url,
        p.owner_person_id, p.created_by_person_id, p.supplier_id,
        p.purchase_url, p.source_platform, p.shipping_method,
        p.purchase_cost, p.domestic_shipping, p.handling_fee, p.purchase_quantity,
        p.package_weight_g, p.length_cm, p.width_cm, p.height_cm,
        p.listing_price_rub, p.air_sale_price_rmb, p.exchange_rate,
        p.desired_profit_mode, p.desired_profit_value, p.return_rate,
        p.active, p.created_at, p.updated_at
  `;
  const where = ["p.active = 1"];
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
  if (paged && !sortSqlMap[sortKey]) {
    const offset = (page - 1) * pageSize;
    const totalRow = await mysqlQueryOne(`
      SELECT COUNT(*) AS total
      FROM products p
      LEFT JOIN people pe ON pe.id = p.owner_person_id
      ${whereSql}
    `, params);
    const pageRows = await mysqlQuery(`
      SELECT p.id
      FROM products p
      LEFT JOIN people pe ON pe.id = p.owner_person_id
      ${whereSql}
      ORDER BY p.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset]);
    const pageIds = pageRows.map((row) => Number(row.id || 0)).filter(Boolean);
    if (!pageIds.length) {
      return {
        rows: [],
        total: Number(totalRow?.total || 0),
        page,
        pageSize,
        mode: "paged"
      };
    }
    const pagePlaceholders = pageIds.map(() => "?").join(", ");
    const rows = await mysqlQuery(`
      SELECT ${productListFieldsSql},
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
        COALESCE(manual_loss.manual_outbound_quantity, 0) AS manual_outbound_quantity,
        COALESCE(manual_loss.manual_outbound_amount, 0) AS manual_outbound_amount,
        COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
        COALESCE(fbp_transfer.fbp_transfer_in_transit_qty, 0) AS fbp_transfer_in_transit_qty,
        COALESCE(skus.sku_count, 0) AS sku_count,
        COALESCE(skus.skus, '') AS mapped_skus,
        COALESCE(skus.origin_skus, '') AS origin_skus,
        COALESCE(sales.total_sales_quantity, 0) AS total_sales_quantity,
        COALESCE(sales.total_sales_amount, 0) AS total_sales_amount,
        CASE WHEN COALESCE(sales.total_sales_quantity, 0) > 0
          THEN COALESCE(sales.total_sales_amount, 0) / sales.total_sales_quantity
          ELSE 0 END AS avg_sale_price,
        COALESCE(sales.estimated_profit_total, 0) AS estimated_profit_total,
        COALESCE(sales.actual_profit_total, 0) AS actual_profit_total,
        COALESCE(sales.order_count, 0) AS order_count,
        CASE WHEN COALESCE(sales.total_sales_amount, 0) > 0
          THEN COALESCE(sales.estimated_profit_total, 0) / sales.total_sales_amount
          ELSE 0 END AS profit_rate
      FROM products p
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
        WHERE im.status = 'posted' AND im.product_id IN (${pagePlaceholders})
        GROUP BY im.product_id
      ) stock ON stock.product_id = p.id
      LEFT JOIN (
        SELECT product_id,
          SUM(ABS(quantity_delta)) AS manual_outbound_quantity,
          SUM(amount) AS manual_outbound_amount
        FROM inventory_movements
        WHERE status = 'posted' AND source_type = 'manual_outbound' AND product_id IN (${pagePlaceholders})
        GROUP BY product_id
      ) manual_loss ON manual_loss.product_id = p.id
      LEFT JOIN (
        SELECT pr.product_id,
          SUM(pr.quantity) AS total_purchase_quantity,
          SUM(pr.amount + COALESCE(pr.shipping_amount, 0)) AS total_purchase_amount,
          CASE WHEN SUM(pr.quantity) > 0 THEN SUM(pr.amount + COALESCE(pr.shipping_amount, 0)) / SUM(pr.quantity) ELSE NULL END AS avg_unit_cost
        FROM procurement_requests pr
        WHERE pr.status != 'cancelled' AND pr.product_id IN (${pagePlaceholders})
        GROUP BY pr.product_id
      ) proc ON proc.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS incoming_stock
        FROM (
          SELECT ir.product_id, ir.quantity
          FROM inbound_records ir
          WHERE ir.status = 'pending_arrival' AND ir.product_id IN (${pagePlaceholders})
          UNION ALL
          SELECT pr.product_id, pr.quantity
          FROM procurement_requests pr
          WHERE pr.status = 'submitted' AND pr.product_id IN (${pagePlaceholders})
        ) incoming_rows
        GROUP BY product_id
      ) incoming ON incoming.product_id = p.id
      LEFT JOIN (
        SELECT ftr.product_id,
          SUM(GREATEST(ftr.quantity - COALESCE(ftr.listed_quantity, 0), 0)) AS fbp_transfer_in_transit_qty
        FROM fbp_transfer_records ftr
        WHERE ftr.status IN ('sent', 'in_transit', 'received') AND ftr.product_id IN (${pagePlaceholders})
        GROUP BY ftr.product_id
      ) fbp_transfer ON fbp_transfer.product_id = p.id
      LEFT JOIN (
        SELECT sm.product_id, COUNT(*) AS sku_count,
          GROUP_CONCAT(sm.ozon_sku ORDER BY sm.id DESC SEPARATOR ', ') AS skus,
          GROUP_CONCAT(CONCAT(COALESCE(s.name, ''), ' / ', COALESCE(sm.ozon_sku, '')) ORDER BY sm.id DESC SEPARATOR '||') AS origin_skus
        FROM sku_mappings sm
        LEFT JOIN shops s ON s.id = sm.shop_id
        WHERE sm.active = 1 AND sm.product_id IN (${pagePlaceholders})
        GROUP BY sm.product_id
      ) skus ON skus.product_id = p.id
      LEFT JOIN (
        SELECT obr.product_id,
          SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(oi.sale_price, 0) * obr.quantity ELSE 0 END) AS total_sales_amount,
          SUM(CASE WHEN obr.status = 'deducted' THEN obr.quantity ELSE 0 END) AS total_sales_quantity,
          SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END) AS estimated_profit_total,
          SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(NULLIF(oi.actual_profit, 0), 0) ELSE 0 END) AS actual_profit_total,
          COUNT(DISTINCT CASE WHEN obr.status = 'deducted' THEN obr.order_ref END) AS order_count
        FROM outbound_records obr
        LEFT JOIN order_items oi ON oi.id = obr.order_item_id
        WHERE obr.product_id IN (${pagePlaceholders})
        GROUP BY obr.product_id
      ) sales ON sales.product_id = p.id
      WHERE p.id IN (${pagePlaceholders})
      ORDER BY FIELD(p.id, ${pagePlaceholders})
    `, [
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds
    ]);

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

  if (paged && sortSqlMap[sortKey]) {
    const offset = (page - 1) * pageSize;
    const needsStockSort = ["stock", "inventory_value"].includes(sortKey);
    const needsProcSort = ["total_purchase_amount", "avg_unit_cost", "inventory_value"].includes(sortKey);
    const needsManualLossSort = ["manual_outbound_quantity", "manual_outbound_amount"].includes(sortKey);
    const needsIncomingSort = sortKey === "incoming_stock";
    const needsFbpTransferSort = sortKey === "fbp_transfer_in_transit_qty";
    const needsSalesSort = ["total_sales_quantity", "total_sales_amount", "order_count", "estimated_profit_total", "actual_profit_total", "profit_rate"].includes(sortKey);
    const needsFbpSort = ["stock", "inventory_value"].includes(sortKey);
    const sortJoins = [];
    if (needsStockSort || needsProcSort) {
      sortJoins.push(`
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
      `);
    }
    if (needsProcSort) {
      sortJoins.push(`
        LEFT JOIN (
          SELECT product_id,
            SUM(quantity) AS total_purchase_quantity,
            SUM(amount + COALESCE(shipping_amount, 0)) AS total_purchase_amount,
            CASE WHEN SUM(quantity) > 0 THEN SUM(amount + COALESCE(shipping_amount, 0)) / SUM(quantity) ELSE NULL END AS avg_unit_cost
          FROM procurement_requests
          WHERE status != 'cancelled'
          GROUP BY product_id
        ) proc ON proc.product_id = p.id
      `);
    }
    if (needsManualLossSort) {
      sortJoins.push(`
        LEFT JOIN (
          SELECT product_id,
            SUM(ABS(quantity_delta)) AS manual_outbound_quantity,
            SUM(amount) AS manual_outbound_amount
          FROM inventory_movements
          WHERE status = 'posted' AND source_type = 'manual_outbound'
          GROUP BY product_id
        ) manual_loss ON manual_loss.product_id = p.id
      `);
    }
    if (needsIncomingSort) {
      sortJoins.push(`
        LEFT JOIN (
          SELECT product_id, SUM(quantity) AS incoming_stock
          FROM (
            SELECT product_id, quantity FROM inbound_records WHERE status = 'pending_arrival'
            UNION ALL
            SELECT product_id, quantity FROM procurement_requests WHERE status IN ('submitted', 'merged')
          ) incoming_rows
          GROUP BY product_id
        ) incoming ON incoming.product_id = p.id
      `);
    }
    if (needsFbpTransferSort) {
      sortJoins.push(`
        LEFT JOIN (
          SELECT product_id,
            SUM(GREATEST(quantity - COALESCE(listed_quantity, 0), 0)) AS fbp_transfer_in_transit_qty
          FROM fbp_transfer_records
          WHERE status IN ('sent', 'in_transit', 'received')
          GROUP BY product_id
        ) fbp_transfer ON fbp_transfer.product_id = p.id
      `);
    }
    if (needsFbpSort) {
      sortJoins.push(`
        LEFT JOIN (
          SELECT sm.product_id,
            SUM(COALESCE(stock_snapshot.fbp_stock, 0)) AS fbp_stock
          FROM sku_mappings sm
          LEFT JOIN (
            SELECT shop_id, ozon_sku,
              SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_stock
            FROM ozon_stock_snapshots
            GROUP BY shop_id, ozon_sku
          ) stock_snapshot ON stock_snapshot.shop_id = sm.shop_id AND stock_snapshot.ozon_sku = sm.ozon_sku
          WHERE sm.active = 1
          GROUP BY sm.product_id
        ) fbp ON fbp.product_id = p.id
      `);
    }
    if (needsSalesSort) {
      sortJoins.push(`
        LEFT JOIN (
          SELECT obr.product_id,
            SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(oi.sale_price, 0) * obr.quantity ELSE 0 END) AS total_sales_amount,
            SUM(CASE WHEN obr.status = 'deducted' THEN obr.quantity ELSE 0 END) AS total_sales_quantity,
            SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END) AS estimated_profit_total,
            SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(NULLIF(oi.actual_profit, 0), 0) ELSE 0 END) AS actual_profit_total,
            COUNT(DISTINCT CASE WHEN obr.status = 'deducted' THEN obr.order_ref END) AS order_count
          FROM outbound_records obr
          LEFT JOIN order_items oi ON oi.id = obr.order_item_id
          GROUP BY obr.product_id
        ) sales ON sales.product_id = p.id
      `);
    }
    const sortExpressions = {
      product: "p.name",
      stock: "COALESCE(stock.stock, 0)",
      incoming_stock: "COALESCE(incoming.incoming_stock, 0)",
      fbp_transfer_in_transit_qty: "COALESCE(fbp_transfer.fbp_transfer_in_transit_qty, 0)",
      total_sales_quantity: "COALESCE(sales.total_sales_quantity, 0)",
      total_sales_amount: "COALESCE(sales.total_sales_amount, 0)",
      order_count: "COALESCE(sales.order_count, 0)",
      total_purchase_amount: "COALESCE(proc.total_purchase_amount, stock.total_purchase_amount, 0)",
      manual_outbound_quantity: "COALESCE(manual_loss.manual_outbound_quantity, 0)",
      manual_outbound_amount: "COALESCE(manual_loss.manual_outbound_amount, 0)",
      avg_unit_cost: "COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost, 0)",
      estimated_profit_total: "COALESCE(sales.estimated_profit_total, 0)",
      actual_profit_total: "COALESCE(sales.actual_profit_total, 0)",
      profit_rate: "CASE WHEN COALESCE(sales.total_sales_amount, 0) > 0 THEN COALESCE(sales.estimated_profit_total, 0) / sales.total_sales_amount ELSE 0 END",
      inventory_value: "(COALESCE(stock.stock, 0) * COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost, 0))"
    };
    const sortedPageRows = await mysqlQuery(`
      SELECT p.id
      FROM products p
      LEFT JOIN people pe ON pe.id = p.owner_person_id
      ${sortJoins.join("\n")}
      ${whereSql}
      ORDER BY ${sortExpressions[sortKey]} ${sortDir}, p.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset]);
    const pageIds = sortedPageRows.map((row) => Number(row.id || 0)).filter(Boolean);
    const totalRow = await mysqlQueryOne(`
      SELECT COUNT(*) AS total
      FROM products p
      LEFT JOIN people pe ON pe.id = p.owner_person_id
      ${whereSql}
    `, params);
    if (!pageIds.length) {
      return {
        rows: [],
        total: Number(totalRow?.total || 0),
        page,
        pageSize,
        mode: "paged"
      };
    }
    const pagePlaceholders = pageIds.map(() => "?").join(", ");
    const rows = await mysqlQuery(`
      SELECT ${productListFieldsSql},
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
        COALESCE(manual_loss.manual_outbound_quantity, 0) AS manual_outbound_quantity,
        COALESCE(manual_loss.manual_outbound_amount, 0) AS manual_outbound_amount,
        COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
        COALESCE(fbp_transfer.fbp_transfer_in_transit_qty, 0) AS fbp_transfer_in_transit_qty,
        COALESCE(fbp.fbp_stock, 0) AS fbp_stock,
        COALESCE(stock.stock, 0) AS total_stock,
        (COALESCE(stock.stock, 0) * COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost, 0)) AS inventory_value,
        COALESCE(skus.sku_count, 0) AS sku_count,
        COALESCE(skus.skus, '') AS mapped_skus,
        COALESCE(skus.origin_skus, '') AS origin_skus,
        COALESCE(sales.total_sales_quantity, 0) AS total_sales_quantity,
        COALESCE(sales.total_sales_amount, 0) AS total_sales_amount,
        CASE WHEN COALESCE(sales.total_sales_quantity, 0) > 0
          THEN COALESCE(sales.total_sales_amount, 0) / sales.total_sales_quantity
          ELSE 0 END AS avg_sale_price,
        COALESCE(sales.estimated_profit_total, 0) AS estimated_profit_total,
        COALESCE(sales.actual_profit_total, 0) AS actual_profit_total,
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
        WHERE status = 'posted' AND product_id IN (${pagePlaceholders})
        GROUP BY product_id
      ) stock ON stock.product_id = p.id
      LEFT JOIN (
        SELECT product_id,
          SUM(ABS(quantity_delta)) AS manual_outbound_quantity,
          SUM(amount) AS manual_outbound_amount
        FROM inventory_movements
        WHERE status = 'posted' AND source_type = 'manual_outbound' AND product_id IN (${pagePlaceholders})
        GROUP BY product_id
      ) manual_loss ON manual_loss.product_id = p.id
      LEFT JOIN (
        SELECT product_id,
          SUM(quantity) AS total_purchase_quantity,
          SUM(amount + COALESCE(shipping_amount, 0)) AS total_purchase_amount,
          CASE WHEN SUM(quantity) > 0 THEN SUM(amount + COALESCE(shipping_amount, 0)) / SUM(quantity) ELSE NULL END AS avg_unit_cost
        FROM procurement_requests
        WHERE status != 'cancelled' AND product_id IN (${pagePlaceholders})
        GROUP BY product_id
      ) proc ON proc.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS incoming_stock
        FROM (
          SELECT product_id, quantity FROM inbound_records WHERE status = 'pending_arrival' AND product_id IN (${pagePlaceholders})
          UNION ALL
          SELECT product_id, quantity FROM procurement_requests WHERE status IN ('submitted', 'merged') AND product_id IN (${pagePlaceholders})
        ) incoming_rows
        GROUP BY product_id
      ) incoming ON incoming.product_id = p.id
      LEFT JOIN (
        SELECT product_id,
          SUM(GREATEST(quantity - COALESCE(listed_quantity, 0), 0)) AS fbp_transfer_in_transit_qty
        FROM fbp_transfer_records
        WHERE status IN ('sent', 'in_transit', 'received') AND product_id IN (${pagePlaceholders})
        GROUP BY product_id
      ) fbp_transfer ON fbp_transfer.product_id = p.id
      LEFT JOIN (
        SELECT sm.product_id, COUNT(*) AS sku_count,
          GROUP_CONCAT(sm.ozon_sku ORDER BY sm.id DESC SEPARATOR ', ') AS skus,
          GROUP_CONCAT(CONCAT(COALESCE(s.name, ''), ' / ', COALESCE(sm.ozon_sku, '')) ORDER BY sm.id DESC SEPARATOR '||') AS origin_skus
        FROM sku_mappings sm
        LEFT JOIN shops s ON s.id = sm.shop_id
        WHERE sm.active = 1 AND sm.product_id IN (${pagePlaceholders})
        GROUP BY sm.product_id
      ) skus ON skus.product_id = p.id
      LEFT JOIN (
        SELECT sm.product_id,
          SUM(COALESCE(stock_snapshot.fbp_stock, 0)) AS fbp_stock
        FROM sku_mappings sm
        LEFT JOIN (
          SELECT shop_id, ozon_sku,
            SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_stock
          FROM ozon_stock_snapshots
          GROUP BY shop_id, ozon_sku
        ) stock_snapshot ON stock_snapshot.shop_id = sm.shop_id AND stock_snapshot.ozon_sku = sm.ozon_sku
        WHERE sm.active = 1 AND sm.product_id IN (${pagePlaceholders})
        GROUP BY sm.product_id
      ) fbp ON fbp.product_id = p.id
      LEFT JOIN (
        SELECT obr.product_id,
          SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(oi.sale_price, 0) * obr.quantity ELSE 0 END) AS total_sales_amount,
          SUM(CASE WHEN obr.status = 'deducted' THEN obr.quantity ELSE 0 END) AS total_sales_quantity,
          SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END) AS estimated_profit_total,
          SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(NULLIF(oi.actual_profit, 0), 0) ELSE 0 END) AS actual_profit_total,
          COUNT(DISTINCT CASE WHEN obr.status = 'deducted' THEN obr.order_ref END) AS order_count
        FROM outbound_records obr
        LEFT JOIN order_items oi ON oi.id = obr.order_item_id
        WHERE obr.product_id IN (${pagePlaceholders})
        GROUP BY obr.product_id
      ) sales ON sales.product_id = p.id
      WHERE p.id IN (${pagePlaceholders})
      ORDER BY FIELD(p.id, ${pagePlaceholders})
    `, [
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds,
      ...pageIds
    ]);
    const mappingSummaries = await productMappingSummariesMysql(pageIds);
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
    SELECT ${productListFieldsSql},
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
      COALESCE(manual_loss.manual_outbound_quantity, 0) AS manual_outbound_quantity,
      COALESCE(manual_loss.manual_outbound_amount, 0) AS manual_outbound_amount,
      COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
      COALESCE(fbp_transfer.fbp_transfer_in_transit_qty, 0) AS fbp_transfer_in_transit_qty,
      COALESCE(fbp.fbp_stock, 0) AS fbp_stock,
      COALESCE(stock.stock, 0) AS total_stock,
      (COALESCE(stock.stock, 0) * COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost, 0)) AS inventory_value,
      COALESCE(skus.sku_count, 0) AS sku_count,
      COALESCE(skus.skus, '') AS mapped_skus,
      COALESCE(skus.origin_skus, '') AS origin_skus,
      COALESCE(sales.total_sales_quantity, 0) AS total_sales_quantity,
      COALESCE(sales.total_sales_amount, 0) AS total_sales_amount,
      CASE WHEN COALESCE(sales.total_sales_quantity, 0) > 0
        THEN COALESCE(sales.total_sales_amount, 0) / sales.total_sales_quantity
        ELSE 0 END AS avg_sale_price,
      COALESCE(sales.estimated_profit_total, 0) AS estimated_profit_total,
      COALESCE(sales.actual_profit_total, 0) AS actual_profit_total,
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
        SUM(ABS(quantity_delta)) AS manual_outbound_quantity,
        SUM(amount) AS manual_outbound_amount
      FROM inventory_movements
      WHERE status = 'posted' AND source_type = 'manual_outbound'
      GROUP BY product_id
    ) manual_loss ON manual_loss.product_id = p.id
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
        SELECT product_id, quantity FROM procurement_requests WHERE status IN ('submitted', 'merged')
      ) incoming_rows
      GROUP BY product_id
    ) incoming ON incoming.product_id = p.id
    LEFT JOIN (
      SELECT product_id,
        SUM(GREATEST(quantity - COALESCE(listed_quantity, 0), 0)) AS fbp_transfer_in_transit_qty
      FROM fbp_transfer_records
      WHERE status IN ('sent', 'in_transit', 'received')
      GROUP BY product_id
    ) fbp_transfer ON fbp_transfer.product_id = p.id
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
        SUM(COALESCE(stock.fbp_stock, 0)) AS fbp_stock
      FROM sku_mappings sm
      LEFT JOIN (
        SELECT shop_id, ozon_sku,
          SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_stock
        FROM ozon_stock_snapshots
        GROUP BY shop_id, ozon_sku
      ) stock ON stock.shop_id = sm.shop_id AND stock.ozon_sku = sm.ozon_sku
      WHERE sm.active = 1
      GROUP BY sm.product_id
    ) fbp ON fbp.product_id = p.id
    LEFT JOIN (
      SELECT obr.product_id,
        SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(oi.sale_price, 0) * obr.quantity ELSE 0 END) AS total_sales_amount,
        SUM(CASE WHEN obr.status = 'deducted' THEN obr.quantity ELSE 0 END) AS total_sales_quantity,
        SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END) AS estimated_profit_total,
        SUM(CASE WHEN obr.status = 'deducted' THEN COALESCE(NULLIF(oi.actual_profit, 0), 0) ELSE 0 END) AS actual_profit_total,
        COUNT(DISTINCT CASE WHEN obr.status = 'deducted' THEN obr.order_ref END) AS order_count
      FROM outbound_records obr
      LEFT JOIN order_items oi ON oi.id = obr.order_item_id
      GROUP BY obr.product_id
    ) sales ON sales.product_id = p.id
    ${whereSql}
  `;

  const totalRow = paged ? await mysqlQueryOne(`
    SELECT COUNT(*) AS total
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    ${whereSql}
  `, params) : null;
  const rows = await mysqlQuery(`
    ${selectSql}
    ORDER BY ${productSortSql}
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
  await ensureProductMergeSchemaMysql();
  await ensureAssetVariantJobsTableMysql();
  const paged = String(query.paged || "") === "1";
  const includeDetails = String(query.includeDetails || query.include_details || query.full || "") === "1";
  const summaryMode = String(query.summaryMode || query.summary_mode || "full").toLowerCase();
  const includeSummary = summaryMode !== "skip" && summaryMode !== "none" && summaryMode !== "false" && summaryMode !== "0";
  const summaryOnly = String(query.summaryOnly || query.summary_only || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const ownerPersonId = String(query.ownerPersonId || query.owner_person_id || "all");
  const quoteStatus = String(query.quoteStatus || query.quote_status || "all");
  const businessStatus = String(query.businessStatus || query.business_status || "all");
  const where = [
    "p.active = 1",
    selectionProductPredicateMysql("p")
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

  const filterFromSql = `
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    LEFT JOIN suppliers supplier ON supplier.id = p.supplier_id
    WHERE ${where.join(" AND ")}
  `;
  const latestPublishJobJoinSql = `
    LEFT JOIN (
      SELECT latest.product_id, latest.id
      FROM asset_variant_jobs latest
      INNER JOIN (
        SELECT product_id, MAX(id) AS latest_id
        FROM asset_variant_jobs
        WHERE job_type = 'publish_selection'
        GROUP BY product_id
      ) picked ON picked.latest_id = latest.id
    ) latest_publish_job ON latest_publish_job.product_id = p.id
    LEFT JOIN asset_variant_jobs aj ON aj.id = latest_publish_job.id
  `;
  const rowFromSql = `
    FROM products p
    ${latestPublishJobJoinSql}
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    LEFT JOIN suppliers supplier ON supplier.id = p.supplier_id
    WHERE ${where.join(" AND ")}
  `;
  const selectionFieldsSql = `
    SELECT p.id, p.selection_id, p.code,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS inventory_id,
      p.name, p.ozon_category_id, p.ozon_description_category_id, p.ozon_type_id, p.ozon_category_name,
      p.image_url, ${includeDetails ? "p.detail_image_urls" : "NULL AS detail_image_urls"}, p.material, p.color, p.vehicle_brand, p.vehicle_model, p.selling_points,
      p.listing_title_ru, p.listing_tags_ru, p.listing_description_ru,
      p.listing_title_prompt, p.listing_tags_prompt, p.listing_description_prompt,
      p.purchase_url, p.supplier_note, p.source_platform, p.supplier_id, p.shipping_method, p.logistics_rule_id,
      p.purchase_cost, p.domestic_shipping, p.handling_fee, p.purchase_quantity,
      p.package_weight_g, p.length_cm, p.width_cm, p.height_cm,
      p.listing_price_rub, p.air_sale_price_rmb, p.exchange_rate,
      p.target_margin, p.desired_profit_mode, p.desired_profit_value, p.advertising_rate, p.return_rate,
      ${selectionProductTypeExprMysql("p")} AS product_type,
      p.selection_status,
      p.source_selection_id, p.variant_task_id, p.variant_result_id, p.variant_type, p.is_variant_generated, p.material_asset_status,
      aj.id AS listing_job_id, aj.job_no AS listing_job_no, aj.status AS listing_job_status,
      aj.current_stage AS listing_job_current_stage,
      CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(aj.progress_json, '$.elapsedMs')), '0') AS UNSIGNED) AS listing_job_elapsed_ms,
      COALESCE(
        JSON_UNQUOTE(JSON_EXTRACT(aj.error_json, '$.message')),
        JSON_UNQUOTE(JSON_EXTRACT(aj.result_json, '$.results[0].error')),
        JSON_UNQUOTE(JSON_EXTRACT(aj.result_json, '$.results[0].precheck.errors[0]')),
        ''
      ) AS listing_job_error_message,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(aj.error_json, '$.fix_tip')), '') AS listing_job_error_fix_tip,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(aj.error_json, '$.raw_message')), '') AS listing_job_raw_error_message,
      aj.batch_id AS listing_job_batch_id, aj.total_count AS listing_job_total_count,
      aj.success_count AS listing_job_success_count, aj.failed_count AS listing_job_failed_count,
      NULL AS listing_job_result_json, NULL AS listing_job_progress_json, NULL AS listing_job_error_json,
      aj.created_at AS listing_job_created_at, aj.started_at AS listing_job_started_at,
      aj.finished_at AS listing_job_finished_at, aj.updated_at AS listing_job_updated_at,
      (
        SELECT COUNT(*)
        FROM asset_variant_jobs ahead
        WHERE ahead.status IN ('queued', 'running')
          AND ahead.id < aj.id
      ) AS listing_job_queue_ahead,
      p.owner_person_id, p.created_by_person_id, p.created_at, p.updated_at,
      pe.name AS owner_name, creator.name AS creator_name,
      supplier.name AS supplier_name
  `;
  const selectSql = `
    ${selectionFieldsSql}
    ${rowFromSql}
  `;
  const enrichSelectionRows = (rows) => rows.map((row) => {
    const nextRow = includeDetails
      ? { ...row, detail_image_urls: productDetailImagePreviewUrlsMysql(row, { thumbnail: true, width: 220 }) }
      : row;
    return {
      ...withProductImageEndpointMysql(nextRow, { thumbnail: true }),
      pricing: calculateSelectionPricing(row),
      business_status: selectionBusinessStatusMysql(row)
    };
  });
  const summaryFromEnrichedRows = (rows) => selectionSummaryMysql(rows.map((row) => ({
    ...row,
    pricing: row.pricing || calculateSelectionPricing(row),
    business_status: row.business_status || selectionBusinessStatusMysql(row)
  })));

  if (paged && quoteStatus === "all" && businessStatus === "all" && summaryOnly) {
    const [totalRow, summaryRows] = await Promise.all([
      mysqlQueryOne(`SELECT COUNT(*) AS total ${filterFromSql}`, params),
      mysqlQuery(`
        SELECT p.purchase_cost, p.domestic_shipping, p.handling_fee, p.purchase_quantity,
          p.package_weight_g, p.length_cm, p.width_cm, p.height_cm,
          p.listing_price_rub, p.air_sale_price_rmb, p.exchange_rate,
          p.desired_profit_mode, p.desired_profit_value, p.target_margin,
          p.advertising_rate, p.return_rate
        ${filterFromSql}
      `, params)
    ]);
    const total = Number(totalRow?.total || 0);
    return {
      rows: [],
      total,
      page,
      pageSize,
      mode: "summary_only",
      summary: {
        ...selectionSummaryFromPricingRowsMysql(summaryRows),
        products: total,
        status_counts: { all: total }
      }
    };
  }

  if (paged && quoteStatus === "all" && businessStatus === "all") {
    const offset = (page - 1) * pageSize;
    const queryTasks = [
      mysqlQueryOne(`SELECT COUNT(*) AS total ${filterFromSql}`, params),
      mysqlQuery(`
        ${selectSql}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT ? OFFSET ?
      `, [...params, pageSize, offset])
    ];
    if (includeSummary) {
      const pricingSummarySql = `
        SELECT p.purchase_cost, p.domestic_shipping, p.handling_fee, p.purchase_quantity,
          p.package_weight_g, p.length_cm, p.width_cm, p.height_cm,
          p.listing_price_rub, p.air_sale_price_rmb, p.exchange_rate,
          p.desired_profit_mode, p.desired_profit_value, p.target_margin,
          p.advertising_rate, p.return_rate
        ${filterFromSql}
      `;
      queryTasks.push(mysqlQuery(pricingSummarySql, params));
    }
    const [totalRow, pageRows, summaryRows = null] = await Promise.all(queryTasks);
    const total = Number(totalRow?.total || 0);

    return {
      rows: enrichSelectionRows(pageRows),
      total,
      page,
      pageSize,
      mode: "paged",
      ...(includeSummary
        ? {
            summary: {
              ...selectionSummaryFromPricingRowsMysql(summaryRows),
              products: total,
              status_counts: { all: total }
            }
          }
        : {})
    };
  }

  const rows = await mysqlQuery(`
    ${selectSql}
    ORDER BY p.updated_at DESC, p.id DESC
  `, params);
  const enriched = enrichSelectionRows(rows);
  const filtered = quoteStatus === "all"
    ? enriched
    : enriched.filter((row) => {
      const hasQuote = Boolean(row.pricing?.air || row.pricing?.land);
      return quoteStatus === "quoted" ? hasQuote : !hasQuote;
    });
  const businessFiltered = applySelectionBusinessStatusFilterMysql(filtered, businessStatus);

  if (!paged) return businessFiltered;

  const start = (page - 1) * pageSize;
  return {
    rows: businessFiltered.slice(start, start + pageSize),
    total: businessFiltered.length,
    page,
    pageSize,
    mode: "paged",
    summary: summaryFromEnrichedRows(businessFiltered)
  };
}

export async function selectionProductMysql(id, query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureSelectionCreativeSchemaMysql();
  await ensureAssetVariantJobsTableMysql();
  const includeDetails = String(query.includeDetails ?? query.include_details ?? "1") !== "0";
  const row = await mysqlQueryOne(`
    SELECT p.id, p.selection_id, p.code,
      CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        ELSE CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
      END AS inventory_id,
      p.name, p.ozon_category_id, p.ozon_description_category_id, p.ozon_type_id, p.ozon_category_name,
      p.image_url, ${includeDetails ? "p.detail_image_urls" : "NULL AS detail_image_urls"}, p.material, p.color, p.vehicle_brand, p.vehicle_model, p.selling_points,
      p.listing_title_ru, p.listing_tags_ru, p.listing_description_ru,
      p.listing_title_prompt, p.listing_tags_prompt, p.listing_description_prompt,
      p.purchase_url, p.supplier_note, p.source_platform, p.supplier_id, p.shipping_method, p.logistics_rule_id,
      p.purchase_cost, p.domestic_shipping, p.handling_fee, p.purchase_quantity,
      p.package_weight_g, p.length_cm, p.width_cm, p.height_cm,
      p.listing_price_rub, p.air_sale_price_rmb, p.exchange_rate,
      p.target_margin, p.desired_profit_mode, p.desired_profit_value, p.advertising_rate, p.return_rate,
      ${selectionProductTypeExprMysql("p")} AS product_type,
      p.selection_status,
      p.source_selection_id, p.variant_task_id, p.variant_result_id, p.variant_type, p.is_variant_generated, p.material_asset_status,
      aj.id AS listing_job_id, aj.job_no AS listing_job_no, aj.status AS listing_job_status,
      aj.current_stage AS listing_job_current_stage,
      CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(aj.progress_json, '$.elapsedMs')), '0') AS UNSIGNED) AS listing_job_elapsed_ms,
      COALESCE(
        JSON_UNQUOTE(JSON_EXTRACT(aj.error_json, '$.message')),
        JSON_UNQUOTE(JSON_EXTRACT(aj.result_json, '$.results[0].error')),
        JSON_UNQUOTE(JSON_EXTRACT(aj.result_json, '$.results[0].precheck.errors[0]')),
        ''
      ) AS listing_job_error_message,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(aj.error_json, '$.fix_tip')), '') AS listing_job_error_fix_tip,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(aj.error_json, '$.raw_message')), '') AS listing_job_raw_error_message,
      aj.batch_id AS listing_job_batch_id, aj.total_count AS listing_job_total_count,
      aj.success_count AS listing_job_success_count, aj.failed_count AS listing_job_failed_count,
      aj.result_json AS listing_job_result_json, aj.progress_json AS listing_job_progress_json, aj.error_json AS listing_job_error_json,
      aj.created_at AS listing_job_created_at, aj.started_at AS listing_job_started_at,
      aj.finished_at AS listing_job_finished_at, aj.updated_at AS listing_job_updated_at,
      (
        SELECT COUNT(*)
        FROM asset_variant_jobs ahead
        WHERE ahead.status IN ('queued', 'running')
          AND ahead.id < aj.id
      ) AS listing_job_queue_ahead,
      p.owner_person_id, p.created_by_person_id, p.created_at, p.updated_at,
      pe.name AS owner_name, creator.name AS creator_name
    FROM products p
    LEFT JOIN asset_variant_jobs aj ON aj.id = (
      SELECT MAX(latest_job.id)
      FROM asset_variant_jobs latest_job
      WHERE latest_job.product_id = p.id
        AND latest_job.job_type = 'publish_selection'
    )
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    WHERE p.active = 1 AND p.id = ?
  `, [Number(id)]);
  if (!row) return null;
  const detailImageUrls = includeDetails
    ? productDetailImagePreviewUrlsMysql(row, { thumbnail: true, width: 220 })
    : [];
  return {
    ...withProductImageEndpointMysql({
      ...row,
      detail_image_urls: detailImageUrls
    }),
    pricing: calculateSelectionPricing(row)
  };
}

export async function productImageMysql(id) {
  ensureMysqlCutoverEnabled();
  const row = await mysqlQueryOne("SELECT image_url FROM products WHERE id = ? AND active = 1", [Number(id)]);
  const image = String(row?.image_url || "").trim();
  if (/^\/api\/products\/\d+\/image$/i.test(image)) return "";
  return image;
}

export async function productDetailImageMysql(id, index = 0) {
  ensureMysqlCutoverEnabled();
  const row = await mysqlQueryOne("SELECT detail_image_urls FROM products WHERE id = ? AND active = 1", [Number(id)]);
  const images = productDetailImageListMysql(row?.detail_image_urls);
  return images[Number(index)] || "";
}

async function productOrderDetailRowsMysql(productId, cancelled, query = {}) {
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const shopId = String(query.shopId || query.shop_id || "all");
  const dateFrom = String(query.dateFrom || query.date_from || "").trim();
  const dateTo = String(query.dateTo || query.date_to || "").trim();
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const cancelCondition = cancelled
    ? "(LOWER(order_status) LIKE '%cancel%' OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%')"
    : "(LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%')";
  const filters = ["rn = 1", cancelCondition];
  const params = [Number(productId)];
  if (shopId !== "all" && shopId) {
    filters.push("shop_id = ?");
    params.push(Number(shopId));
  }
  if (dateFrom) {
    filters.push(`${chinaDateSqlMysql("ordered_at")} >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    filters.push(`${chinaDateSqlMysql("ordered_at")} <= ?`);
    params.push(dateTo);
  }
  if (searchText) {
    const like = `%${searchText}%`;
    filters.push(`(
      LOWER(COALESCE(posting_number, '')) LIKE ?
      OR LOWER(COALESCE(order_number, '')) LIKE ?
      OR LOWER(COALESCE(ozon_sku, '')) LIKE ?
      OR LOWER(COALESCE(ozon_name, '')) LIKE ?
      OR LOWER(COALESCE(product_name, '')) LIKE ?
      OR LOWER(COALESCE(mapping_display_name, '')) LIKE ?
      OR LOWER(COALESCE(shop_name, '')) LIKE ?
    )`);
    params.push(like, like, like, like, like, like, like);
  }
  const whereSql = filters.join(" AND ");
  const cteSql = `
    WITH mapped_items AS (
      SELECT
        oi.id AS order_item_id,
        oi.order_id,
        oi.ozon_sku,
        oi.ozon_name,
        oi.ozon_image_url,
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
        opi.profit_status,
        opi.lock_reason,
        o.posting_number,
        o.order_number,
        o.status AS order_status,
        o.tracking_stage,
        COALESCE(o.cancel_loss_applies, 0) AS cancel_loss_applies,
        o.cancel_reason,
        o.cancel_initiator,
        o.ordered_at,
        o.created_at,
        o.shop_id,
        s.name AS shop_name,
        sm.product_id,
        sm.id AS sku_mapping_id,
        sm.offer_id,
        sm.display_name AS mapping_display_name,
        sm.commission_low,
        sm.commission_high,
        p.name AS product_name,
        COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '') AS image_urls,
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
      LEFT JOIN online_products op ON op.id = sm.online_product_id
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
  `;
  const filteredSql = `
    ${cteSql}
    SELECT *
    FROM mapped_items
    WHERE ${whereSql}
  `;
  const countSql = `
    ${cteSql}
    SELECT COUNT(*) AS total
    FROM mapped_items
    WHERE ${whereSql}
  `;
  const rowsSql = `
    ${filteredSql}
    ORDER BY COALESCE(ordered_at, created_at) DESC, order_item_id DESC
    ${paged ? "LIMIT ? OFFSET ?" : "LIMIT 500"}
  `;
  if (!paged) return await mysqlQuery(rowsSql, params);
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(countSql, params),
    mysqlQuery(rowsSql, [...params, pageSize, (page - 1) * pageSize])
  ]);
  return {
    rows,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

function productOrderIsFinishedMysql(row = {}) {
  const settlementText = `${row.settlement_state || ""} ${row.profit_status || ""}`.toLowerCase();
  return settlementText.includes("accrued");
}

function positiveNumberMysql(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function nullablePositiveNumberMysql(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function nullableNumberMysql(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundNullableMoneyMysql(value) {
  return value === null || value === undefined ? null : roundMoneyMysql(value);
}

function productOrderFinanceChargeTotalMysql(row = {}, fieldNames = []) {
  const keys = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  const values = keys
    .map((field) => nullablePositiveNumberMysql(row?.[field]))
    .filter((value) => value !== null);
  if (!values.length) return null;
  return roundMoneyMysql(values.reduce((sum, value) => sum + Number(value || 0), 0));
}

function buildProductOrderProfitModelBreakdownMysql(row = {}, mode = "estimated", context = {}) {
  const quantity = Math.max(Number(context.quantity || row.quantity || 0), 0);
  const saleAmount = roundMoneyMysql(Number(context.revenue ?? row.revenue ?? 0));
  const isActual = mode === "actual";
  const actualReady = String(row.settlement_state || row.profit_status || "").toLowerCase().includes("accrued");
  const purchase = isActual
    ? (nullablePositiveNumberMysql(row.purchase_cost_cny) ?? nullablePositiveNumberMysql(context.purchaseCostTotal) ?? 0)
    : roundMoneyMysql(Number(context.purchaseCostTotal || 0));
  const domestic = isActual
    ? (nullablePositiveNumberMysql(row.domestic_shipping_cny) ?? nullablePositiveNumberMysql(context.domesticShippingTotal) ?? 0)
    : roundMoneyMysql(Number(context.domesticShippingTotal || 0));
  const international = isActual
    ? (nullablePositiveNumberMysql(row.international_shipping_cny) ?? nullablePositiveNumberMysql(context.internationalShippingTotal))
    : roundMoneyMysql(Number(context.internationalShippingTotal || 0));
  const packaging = isActual
    ? (nullablePositiveNumberMysql(row.packaging_cost_cny) ?? nullablePositiveNumberMysql(context.handlingFeeTotal) ?? 0)
    : roundMoneyMysql(Number(context.handlingFeeTotal || 0));
  const commission = isActual
    ? (nullablePositiveNumberMysql(row.commission_fee_cny) ?? nullablePositiveNumberMysql(context.commissionTotal) ?? 0)
    : roundMoneyMysql(Number(context.commissionTotal || 0));
  const collecting = isActual ? productOrderFinanceChargeTotalMysql(row, ["collecting_fee_cny", "acquiring_fee_cny"]) : 0;
  const service = isActual
    ? (nullablePositiveNumberMysql(row.ozon_service_fee_cny) ?? null)
    : roundMoneyMysql(Number(context.ozonServiceFeeTotal || 0));
  const returnLoss = isActual
    ? (nullablePositiveNumberMysql(row.return_loss_cny) ?? 0)
    : roundMoneyMysql(Number(context.returnLossTotal || 0));
  const advertising = roundMoneyMysql(Number(context.advertisingCostTotal || 0));
  const other = isActual
    ? roundMoneyMysql((nullablePositiveNumberMysql(row.other_fee_cny) ?? 0) + (nullablePositiveNumberMysql(row.aftersale_loss) ?? 0))
    : roundMoneyMysql(Number(context.otherFeeTotal || 0));
  const rows = [
    { key: "sale", label: "订单金额", value: saleAmount, emphasize: false },
    { key: "quantity", label: "件数", value: quantity, emphasize: false, value_type: "number" },
    { key: "purchase", label: "采购成本", value: purchase, emphasize: false },
    { key: "domestic", label: "国内运费", value: domestic, emphasize: false },
    { key: "international", label: "国际运费", value: international, emphasize: false },
    { key: "packaging", label: "包装处理费", value: packaging, emphasize: false },
    { key: "commission", label: "Ozon佣金", value: commission, emphasize: false },
    { key: "collecting", label: "收单费", value: collecting, emphasize: false },
    { key: "service", label: "Ozon服务费", value: service, emphasize: false },
    { key: "returnLoss", label: "售后/退货损失", value: returnLoss, emphasize: false },
    { key: "advertising", label: "广告费", value: advertising, emphasize: false },
    { key: "other", label: "其他费用", value: other, emphasize: false }
  ];
  const costTotal = roundMoneyMysql(
    Number(purchase || 0) +
    Number(domestic || 0) +
    Number(international || 0) +
    Number(packaging || 0) +
    Number(commission || 0) +
    Number(collecting || 0) +
    Number(service || 0) +
    Number(returnLoss || 0) +
    Number(advertising || 0) +
    Number(other || 0)
  );
  const profitValue = isActual
    ? (actualReady ? roundNullableMoneyMysql(nullableNumberMysql(row.actual_profit) ?? nullableNumberMysql(row.net_profit_cny) ?? roundMoneyMysql(saleAmount - costTotal)) : null)
    : roundMoneyMysql(Number(row.estimated_profit || context.calculatedProfitValue || saleAmount - costTotal));
  rows.push(
    { key: "costTotal", label: "成本合计", value: costTotal, emphasize: true },
    { key: "profit", label: isActual ? "真实利润" : "预估利润", value: profitValue, emphasize: true }
  );
  return {
    mode,
    label: isActual ? "真实利润" : "预估利润",
    ready: !isActual || actualReady,
    rows,
    totals: {
      sale: saleAmount,
      costTotal,
      profit: profitValue
    }
  };
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
  const isFinished = productOrderIsFinishedMysql(row);
  const estimatedProfit = Number(row.estimated_profit || 0);
  const actualProfit = Number(row.actual_profit || row.net_profit_cny || 0);
  const storedProfit = isFinished ? (actualProfit || estimatedProfit) : (estimatedProfit || actualProfit);
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
  const revenue = roundMoneyMysql(salePrice * quantity);
  const purchaseCostTotal = roundMoneyMysql(purchaseCost * quantity);
  const domesticShippingTotal = roundMoneyMysql(domesticShipping * quantity);
  const internationalShippingTotal = roundMoneyMysql(internationalShipping * quantity);
  const handlingFeeTotal = roundMoneyMysql(handlingFee * quantity);
  const commissionTotal = roundMoneyMysql(commission);
  const ozonServiceFeeTotal = roundMoneyMysql(ozonServiceFee);
  const returnLossTotal = roundMoneyMysql(returnLoss);
  const advertisingCostTotal = roundMoneyMysql(advertisingCost);
  const otherFeeTotal = roundMoneyMysql(otherFee);
  const baseContext = {
    quantity,
    revenue,
    purchaseCostTotal,
    domesticShippingTotal,
    internationalShippingTotal,
    handlingFeeTotal,
    commissionTotal,
    ozonServiceFeeTotal,
    returnLossTotal,
    advertisingCostTotal,
    otherFeeTotal,
    calculatedProfitValue: roundMoneyMysql(calculatedProfit)
  };
  const estimatedBreakdown = buildProductOrderProfitModelBreakdownMysql(row, "estimated", baseContext);
  const actualBreakdown = buildProductOrderProfitModelBreakdownMysql(row, "actual", baseContext);
  return {
    ...row,
    revenue,
    purchase_cost_total: purchaseCostTotal,
    domestic_shipping_total: domesticShippingTotal,
    international_shipping_total: internationalShippingTotal,
    handling_fee_total: handlingFeeTotal,
    commission_total: commissionTotal,
    final_mile_bank_fee: 0,
    ozon_service_fee_total: ozonServiceFeeTotal,
    return_loss_total: returnLossTotal,
    advertising_cost_total: advertisingCostTotal,
    other_fee_total: otherFeeTotal,
    cost_total: roundMoneyMysql((purchaseCost + domesticShipping + internationalShipping + handlingFee) * quantity),
    stored_profit_value: roundMoneyMysql(storedProfit),
    calculated_profit_value: roundMoneyMysql(calculatedProfit),
    estimated_profit: roundMoneyMysql(estimatedProfit || calculatedProfit),
    actual_profit: roundMoneyMysql(actualProfit),
    profit_model: isFinished ? "actual" : "estimated",
    profit_model_text: isFinished ? "真实利润" : "预估利润",
    profit_value: roundMoneyMysql(isFinished ? (actualProfit || calculatedProfit) : calculatedProfit),
    profit_models: {
      estimated: estimatedBreakdown,
      actual: actualBreakdown
    },
    cancel_loss_base: roundMoneyMysql(lossBase),
    cancel_loss: roundMoneyMysql(lossBase),
    cost_source: positiveNumberMysql(row.frozen_purchase_cost) || positiveNumberMysql(row.frozen_domestic_shipping)
      ? "下单冻结成本"
      : positiveNumberMysql(row.avg_unit_cost) ? "平均采购成本" : "产品当前成本"
  };
}

export async function productOrderProfitDetailsMysql(productId, query = {}) {
  ensureMysqlCutoverEnabled();
  const payload = await productOrderDetailRowsMysql(productId, false, query);
  if (!payload?.rows) return payload.map(computeProductOrderDetailMysql);
  const rows = payload.rows.map(computeProductOrderDetailMysql);
  return { ...payload, rows, summary: productOrderDetailSummaryMysql(rows, payload.total) };
}

export async function productCancelDetailsMysql(productId, query = {}) {
  ensureMysqlCutoverEnabled();
  const payload = await productOrderDetailRowsMysql(productId, true, query);
  if (!payload?.rows) return payload.map(computeProductOrderDetailMysql);
  const rows = payload.rows.map(computeProductOrderDetailMysql);
  return { ...payload, rows, summary: productOrderDetailSummaryMysql(rows, payload.total) };
}

function productOrderDetailSummaryMysql(rows = [], total = rows.length) {
  return rows.reduce((summary, row) => {
    summary.total = Number(total || rows.length);
    summary.page_count += 1;
    summary.quantity += Number(row.quantity || 0);
    summary.revenue = roundMoneyMysql(summary.revenue + Number(row.revenue || 0));
    summary.current_profit = roundMoneyMysql(summary.current_profit + Number(row.profit_value || 0));
    summary.estimated_profit = roundMoneyMysql(summary.estimated_profit + Number(row.estimated_profit || 0));
    summary.actual_profit = roundMoneyMysql(summary.actual_profit + Number(row.actual_profit || 0));
    return summary;
  }, {
    total: Number(total || rows.length),
    page_count: 0,
    quantity: 0,
    revenue: 0,
    current_profit: 0,
    estimated_profit: 0,
    actual_profit: 0
  });
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
    const ownerPersonId = await resolvePersonIdOrFirstMysql(body.owner_person_id || body.created_by_person_id, connection);
    const createdByPersonId = await resolvePersonIdOrFirstMysql(body.created_by_person_id || ownerPersonId, connection);
    const logisticsRuleId = nullableInteger(body.logistics_rule_id);
    const shippingMethod = body.shipping_method || recommendShippingMysql(body);
    const desiredProfitValue = Number(body.desired_profit_value || 20);
    const targetMargin = Number(body.desired_profit_mode === "margin" ? (desiredProfitValue > 1 ? desiredProfitValue / 100 : desiredProfitValue) : 0.2);
    const ozonDescriptionCategoryId = nullableInteger(body.ozon_description_category_id || body.description_category_id) || 0;
    const ozonTypeId = nullableInteger(body.ozon_type_id || body.type_id) || 0;
    const [result] = await connection.execute(`
      INSERT INTO products
      (selection_id, code, name, ozon_category_id, ozon_description_category_id, ozon_type_id, ozon_category_name,
       image_url, detail_image_urls, material, color, vehicle_brand, vehicle_model, selling_points,
       listing_title_ru, listing_tags_ru, listing_description_ru, listing_title_prompt, listing_tags_prompt, listing_description_prompt,
       purchase_url, supplier_note, source_platform, supplier_id, shipping_method,
       logistics_rule_id, recommended_shipping_method, purchase_cost, domestic_shipping, handling_fee, purchase_quantity,
       package_weight_g, length_cm, width_cm, height_cm, listing_price_rub, air_sale_price_rmb, exchange_rate,
       target_margin, desired_profit_mode, desired_profit_value, advertising_rate, return_rate, owner_person_id, created_by_person_id, product_type, selection_status,
       source_selection_id, variant_task_id, variant_result_id, variant_type, is_variant_generated, material_asset_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      selectionId,
      code,
      name,
      normalizeOzonCategoryIdMysql(body.ozon_category_id || (ozonDescriptionCategoryId && ozonTypeId ? `${ozonDescriptionCategoryId}:${ozonTypeId}` : "")),
      ozonDescriptionCategoryId,
      ozonTypeId,
      normalizeOzonCategoryNameMysql(body.ozon_category_name || body.category_name),
      normalizeProductImageUrlMysql(body.image_url),
      normalizeProductDetailImagesMysql(body.detail_image_urls),
      body.material || "",
      body.color || "",
      body.vehicle_brand || body.vehicleBrand || "",
      body.vehicle_model || body.vehicleModel || "",
      body.selling_points || "",
      body.listing_title_ru || body.listingTitleRu || "",
      body.listing_tags_ru || body.listingTagsRu || "",
      body.listing_description_ru || body.listingDescriptionRu || "",
      body.listing_title_prompt || body.listingTitlePrompt || "",
      body.listing_tags_prompt || body.listingTagsPrompt || "",
      body.listing_description_prompt || body.listingDescriptionPrompt || "",
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
      Number(body.advertising_rate || 0),
      Number(body.return_rate || 0.05),
      ownerPersonId,
      createdByPersonId,
      body.product_type || "main",
      body.selection_status || "listed",
      nullableInteger(body.source_selection_id),
      String(body.variant_task_id || ""),
      String(body.variant_result_id || ""),
      String(body.variant_type || ""),
      Number(body.is_variant_generated || 0) ? 1 : 0,
      String(body.material_asset_status || "")
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
  const existing = await mysqlQueryOne(`
    SELECT id, updated_at, image_url, detail_image_urls, material_asset_status, product_type, selection_status, created_by_person_id
    FROM products
    WHERE id = ? AND active = 1
  `, [productId]);
  if (!existing) throw new Error("Product not found or archived");
  assertFreshRecord(body, existing, "商品已被其他用户保存，请刷新后再继续编辑");
  const exchangeRate = Number(body.exchange_rate || await currentExchangeRateValueMysql() || 11.32);
  const desiredProfitValue = Number(body.desired_profit_value || 20);
  const targetMargin = Number(body.desired_profit_mode === "margin" ? (desiredProfitValue > 1 ? desiredProfitValue / 100 : desiredProfitValue) : 0.2);
  const ozonDescriptionCategoryId = nullableInteger(body.ozon_description_category_id || body.description_category_id) || 0;
  const ozonTypeId = nullableInteger(body.ozon_type_id || body.type_id) || 0;
  const nextImageUrl = body.image_url === undefined || isProductImageEndpointMysql(body.image_url, productId)
    ? existing.image_url
    : normalizeProductImageUrlMysql(body.image_url);
  const nextDetailImages = body.detail_image_urls === undefined
    ? null
    : normalizeProductDetailImagesForUpdateMysql(body.detail_image_urls, existing.detail_image_urls, productId);
  const nextProductType = String(body.product_type || existing.product_type || "main");
  const nextSelectionStatus = String(body.selection_status || existing.selection_status || (nextProductType === "selection" ? "draft" : "listed"));
  await mysqlExecute(`
    UPDATE products SET
      name = ?, image_url = ?,
      ozon_category_id = ?, ozon_description_category_id = ?, ozon_type_id = ?, ozon_category_name = ?,
      detail_image_urls = COALESCE(?, detail_image_urls),
      material = COALESCE(?, material),
      color = COALESCE(?, color),
      vehicle_brand = COALESCE(?, vehicle_brand),
      vehicle_model = COALESCE(?, vehicle_model),
      selling_points = COALESCE(?, selling_points),
      listing_title_ru = COALESCE(?, listing_title_ru),
      listing_tags_ru = COALESCE(?, listing_tags_ru),
      listing_description_ru = COALESCE(?, listing_description_ru),
      listing_title_prompt = COALESCE(?, listing_title_prompt),
      listing_tags_prompt = COALESCE(?, listing_tags_prompt),
      listing_description_prompt = COALESCE(?, listing_description_prompt),
      purchase_url = ?, supplier_note = ?, source_platform = ?, supplier_id = ?, shipping_method = ?, logistics_rule_id = ?,
      purchase_cost = ?, domestic_shipping = ?, handling_fee = ?, purchase_quantity = ?,
      package_weight_g = ?, length_cm = ?, width_cm = ?, height_cm = ?,
      listing_price_rub = ?, air_sale_price_rmb = ?, exchange_rate = ?, target_margin = ?,
      desired_profit_mode = ?, desired_profit_value = ?, advertising_rate = ?, return_rate = ?, owner_person_id = ?, created_by_person_id = ?,
      product_type = ?, selection_status = ?, material_asset_status = COALESCE(?, material_asset_status), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    body.name,
    nextImageUrl,
    normalizeOzonCategoryIdMysql(body.ozon_category_id || (ozonDescriptionCategoryId && ozonTypeId ? `${ozonDescriptionCategoryId}:${ozonTypeId}` : "")),
    ozonDescriptionCategoryId,
    ozonTypeId,
    normalizeOzonCategoryNameMysql(body.ozon_category_name || body.category_name),
    nextDetailImages,
    body.material === undefined ? null : body.material || "",
    body.color === undefined ? null : body.color || "",
    body.vehicle_brand === undefined && body.vehicleBrand === undefined ? null : body.vehicle_brand || body.vehicleBrand || "",
    body.vehicle_model === undefined && body.vehicleModel === undefined ? null : body.vehicle_model || body.vehicleModel || "",
    body.selling_points === undefined ? null : body.selling_points || "",
    body.listing_title_ru === undefined && body.listingTitleRu === undefined ? null : body.listing_title_ru || body.listingTitleRu || "",
    body.listing_tags_ru === undefined && body.listingTagsRu === undefined ? null : body.listing_tags_ru || body.listingTagsRu || "",
    body.listing_description_ru === undefined && body.listingDescriptionRu === undefined ? null : body.listing_description_ru || body.listingDescriptionRu || "",
    body.listing_title_prompt === undefined && body.listingTitlePrompt === undefined ? null : body.listing_title_prompt || body.listingTitlePrompt || "",
    body.listing_tags_prompt === undefined && body.listingTagsPrompt === undefined ? null : body.listing_tags_prompt || body.listingTagsPrompt || "",
    body.listing_description_prompt === undefined && body.listingDescriptionPrompt === undefined ? null : body.listing_description_prompt || body.listingDescriptionPrompt || "",
    body.purchase_url || "",
    body.supplier_note || "",
    body.source_platform || "1688",
    nullableInteger(body.supplier_id),
    body.shipping_method || recommendShippingMysql(body),
    nullableInteger(body.logistics_rule_id),
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
    Number(body.advertising_rate || 0),
    Number(body.return_rate || 0.05),
    nullableInteger(body.owner_person_id) || await firstActivePersonIdMysql(),
    nullableInteger(body.created_by_person_id) || nullableInteger(existing.created_by_person_id) || nullableInteger(body.owner_person_id) || await firstActivePersonIdMysql(),
    nextProductType,
    nextSelectionStatus,
    body.material_asset_status === undefined ? null : String(body.material_asset_status || ""),
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

async function assertNoDuplicateSkuMappingsAfterMergeMysql(connection, targetProductId, sourceProductIds = []) {
  const ids = [Number(targetProductId), ...sourceProductIds.map((item) => Number(item || 0)).filter(Boolean)];
  if (ids.length <= 1) return;
  const placeholders = ids.map(() => "?").join(",");
  const duplicate = await mysqlConnectionQueryOne(connection, `
    SELECT
      shop_id,
      ozon_sku,
      COUNT(*) AS duplicate_count
    FROM sku_mappings
    WHERE active = 1
      AND product_id IN (${placeholders})
    GROUP BY shop_id, ozon_sku
    HAVING COUNT(*) > 1
    LIMIT 1
  `, ids);
  if (!duplicate) return;
  throw new Error(`待合并产品存在重复 SKU 绑定，合并后会重复累计库存：店铺 ${duplicate.shop_id} / SKU ${duplicate.ozon_sku}`);
}

async function releaseSourceProductUniqueFieldsForMergeMysql(connection, sourceProductIds = []) {
  const ids = [...new Set((sourceProductIds || []).map((item) => Number(item || 0)).filter(Boolean))];
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  await connection.execute(`
    UPDATE products
    SET selection_id = CASE
          WHEN COALESCE(selection_id, '') = '' THEN NULL
          ELSE CONCAT(selection_id, '#merged#', id)
        END,
        code = CASE
          WHEN COALESCE(code, '') = '' THEN NULL
          ELSE CONCAT(code, '#merged#', id)
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id IN (${placeholders})
  `, ids);
}

function procurementMergeSignatureMysql(row = {}) {
  return JSON.stringify({
    product_id: Number(row.product_id || 0),
    person_id: Number(row.person_id || 0),
    supplier_id: Number(row.supplier_id || 0),
    purchase_url: String(row.purchase_url || "").trim(),
    approval_status: String(row.approval_status || ""),
    status: String(row.status || ""),
    needed_by: row.needed_by ? String(row.needed_by) : "",
    urgency: String(row.urgency || ""),
    source_type: String(row.source_type || ""),
    source_order_id: Number(row.source_order_id || 0),
    source_order_item_id: Number(row.source_order_item_id || 0),
    source_ozon_sku: String(row.source_ozon_sku || "").trim(),
    purchase_order_id: Number(row.purchase_order_id || 0)
  });
}

async function mergeProcurementRequestsAfterProductMergeMysql(connection, targetProductId) {
  const productId = Number(targetProductId || 0);
  if (!productId) return;
  const [rows] = await connection.query(`
    SELECT *
    FROM procurement_requests
    WHERE product_id = ?
      AND status IN ('pending', 'submitted')
    ORDER BY id ASC
    FOR UPDATE
  `, [productId]);
  if (!rows.length) return;
  const grouped = new Map();
  for (const row of rows) {
    const signature = procurementMergeSignatureMysql(row);
    const master = grouped.get(signature);
    if (!master) {
      grouped.set(signature, { ...row });
      continue;
    }
    const mergedQuantity = Number(master.quantity || 0) + Number(row.quantity || 0);
    const mergedAmount = Number(master.amount || 0) + Number(row.amount || 0);
    const mergedShippingAmount = Number(master.shipping_amount || 0) + Number(row.shipping_amount || 0);
    const mergedNote = [master.note, row.note, `自动合并采购请求 #${row.id}`].filter(Boolean).join(" ; ");
    await connection.execute(`
      UPDATE procurement_requests
      SET quantity = ?,
          amount = ?,
          shipping_amount = ?,
          note = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [mergedQuantity, mergedAmount, mergedShippingAmount, mergedNote, Number(master.id)]);
    await connection.execute(`
      UPDATE procurement_requests
      SET status = 'merged',
          approval_status = 'merged',
          quantity = 0,
          amount = 0,
          shipping_amount = 0,
          note = ?,
          merged_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [`已自动并入采购请求 #${master.id}`, Number(row.id)]);
    master.quantity = mergedQuantity;
    master.amount = mergedAmount;
    master.shipping_amount = mergedShippingAmount;
    master.note = mergedNote;
  }
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
    await assertNoDuplicateSkuMappingsAfterMergeMysql(connection, targetProductId, sourceProductIds);
    await releaseSourceProductUniqueFieldsForMergeMysql(connection, sourceProductIds);
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
      "main",
      "listed",
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
    await mergeProcurementRequestsAfterProductMergeMysql(connection, targetProductId);
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
  const bindSku = String(body.ozon_sku || online.ozon_sku || "").trim();
  const existingMapping = await mysqlQueryOne(`
    SELECT sm.*, p.id AS active_product_id, p.code, p.name
    FROM sku_mappings sm
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    WHERE sm.shop_id = ? AND sm.ozon_sku = ? AND sm.active = 1
    LIMIT 1
  `, [online.shop_id, bindSku || online.ozon_sku]);
  if (existingMapping?.id && existingMapping?.active_product_id) {
    await bindOnlineProductMysql({
      online_product_id: online.id,
      order_item_id: body.order_item_id || body.orderItemId,
      ozon_sku: bindSku,
      product_id: existingMapping.product_id,
      person_id: body.person_id || body.owner_person_id || existingMapping.person_id
    });
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
        order_item_id: body.order_item_id || body.orderItemId,
        ozon_sku: bindSku,
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
    procurement_quantity: body.procurement_quantity,
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
    order_item_id: body.order_item_id || body.orderItemId,
    ozon_sku: bindSku,
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
    WITH relevant_mappings AS (
      SELECT sm.id, sm.product_id, sm.shop_id, s.name AS shop_name,
        sm.ozon_sku, sm.offer_id,
        COALESCE(sm.display_name, op.name, '') AS online_name
      FROM sku_mappings sm
      LEFT JOIN shops s ON s.id = sm.shop_id
      LEFT JOIN online_products op ON op.id = sm.online_product_id
      WHERE sm.active = 1 AND sm.product_id IN (${placeholders})
    )
    SELECT rm.id, rm.product_id, rm.shop_id, rm.shop_name,
      rm.ozon_sku, rm.offer_id, rm.online_name,
      SUM(CASE WHEN stock.stock_type = 'fbp_real' THEN COALESCE(stock.present, 0) ELSE 0 END) AS fbp_stock,
      SUM(CASE WHEN stock.stock_type = 'fbs_virtual' THEN COALESCE(stock.present, 0) ELSE 0 END) AS fbs_stock
    FROM relevant_mappings rm
    LEFT JOIN ozon_stock_snapshots stock
      ON stock.shop_id = rm.shop_id
      AND stock.ozon_sku = rm.ozon_sku
      AND stock.stock_type IN ('fbp_real', 'fbs_virtual')
    GROUP BY rm.id, rm.product_id, rm.shop_id, rm.shop_name, rm.ozon_sku, rm.offer_id, rm.online_name
    ORDER BY rm.id DESC
  `, ids);
  const summaries = new Map();
  for (const row of rows) {
    const productId = Number(row.product_id || 0);
    if (!summaries.has(productId)) {
      summaries.set(productId, {
        shop_ids: [],
        shop_names: [],
        bound_mappings: [],
        fbp_stock: 0,
        fbs_stock: 0
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
      online_name: row.online_name || "",
      fbp_stock: Number(row.fbp_stock || 0),
      fbs_stock: Number(row.fbs_stock || 0)
    });
    summary.fbp_stock += Number(row.fbp_stock || 0);
    summary.fbs_stock += Number(row.fbs_stock || 0);
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
      GROUP_CONCAT(CONCAT(pe.name, ':', pr.quantity, '件 ￥', pr.amount) SEPARATOR '||') AS requesters,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(pr.purchase_url, ''), NULLIF(p.purchase_url, ''))) AS purchase_links,
      MIN(pr.created_at) AS earliest_created_at,
      MAX(CASE WHEN TIMESTAMPDIFF(DAY, pr.created_at, CURRENT_TIMESTAMP) >= 3 THEN 1 ELSE 0 END) AS overdue
    FROM procurement_requests pr
    JOIN products p ON p.id = pr.product_id
    LEFT JOIN people pe ON pe.id = pr.person_id
    WHERE pr.status IN ('pending', 'suggested', 'submitted', 'merged')
    GROUP BY p.id
    ORDER BY earliest_created_at ASC, total_quantity DESC
  `);
}

export async function procurementRequestsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProcurementRequestTimestampSchemaMysql();
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
      po.status AS purchase_order_status,
      CASE WHEN pr.status IN ('pending', 'suggested', 'submitted', 'merged') AND TIMESTAMPDIFF(DAY, pr.created_at, CURRENT_TIMESTAMP) >= 3 THEN 1 ELSE 0 END AS overdue
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
        SELECT product_id, quantity FROM procurement_requests WHERE status IN ('submitted', 'merged')
      ) incoming_rows
      GROUP BY product_id
    ) incoming ON incoming.product_id = p.id
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(ozon_sku SEPARATOR ', ') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
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
  const status = String(query.status || "waiting_purchase");
  const urgency = String(query.urgency || "all");
  const personId = String(query.personId || query.person_id || "all");
  const productId = Number(query.productId || query.product_id || 0);
  const dateFrom = String(query.dateFrom || query.date_from || "").trim();
  const dateTo = String(query.dateTo || query.date_to || "").trim();

  const filtered = rows.filter((row) => {
    const rowStatus = String(row.status || "");
    const orderStatus = String(row.purchase_order_status || "");
    if (productId && Number(row.product_id || 0) !== productId) return false;
    if (status === "waiting_purchase") {
      if (!["pending", "suggested", "submitted", "merged"].includes(rowStatus)) return false;
      if (["purchased", "partial_inbound", "inbound_done"].includes(orderStatus)) return false;
    } else if (status === "completed_purchase") {
      if (!["done"].includes(rowStatus) && !["inbound_done"].includes(orderStatus)) return false;
    } else if (status === "cancelled") {
      if (rowStatus !== "cancelled") return false;
    } else if (status !== "all" && rowStatus !== status) {
      return false;
      }
      if (urgency !== "all" && String(row.urgency || "") !== urgency) return false;
      if (personId !== "all" && String(row.person_id || "") !== personId) return false;
      const createdDate = String(row.created_at || "").slice(0, 10);
      if (dateFrom && createdDate && createdDate < dateFrom) return false;
      if (dateTo && createdDate && createdDate > dateTo) return false;
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

  const purchaseableRows = rows.filter((item) => {
    const rowStatus = String(item.status || "");
    const orderStatus = String(item.purchase_order_status || "");
    return ["pending", "suggested", "submitted"].includes(rowStatus)
      && !["purchased", "partial_inbound", "inbound_done"].includes(orderStatus);
  });

  for (const row of purchaseableRows) {
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
        latest_created_at: row.created_at || "",
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
    if (!target.latest_created_at || String(row.created_at || "") > String(target.latest_created_at)) {
      target.latest_created_at = row.created_at || "";
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
    .sort((a, b) => String(b.latest_created_at || "").localeCompare(String(a.latest_created_at || "")));

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
    SELECT
      COALESCE(SUM(CASE
        WHEN movement_type = 'ORDER_SHIPPED' THEN CASE WHEN quantity_delta < 0 THEN quantity_delta ELSE -ABS(quantity_delta) END
        WHEN movement_type IN ('PURCHASE_IN', 'MANUAL_ADJUST') THEN quantity_delta
        WHEN movement_type = 'RETURN_IN' THEN ABS(quantity_delta)
        ELSE 0
      END), 0) AS available_stock,
      COALESCE(SUM(CASE
        WHEN movement_type = 'ORDER_RESERVED' THEN ABS(quantity_delta)
        WHEN movement_type = 'CANCEL_RESTORE' THEN -ABS(quantity_delta)
        ELSE 0
      END), 0) AS reserved_stock,
      COALESCE(SUM(CASE
        WHEN movement_type = 'RETURN_LOSS' THEN ABS(quantity_delta)
        ELSE 0
      END), 0) AS damaged_stock,
      0 AS in_transit_stock
    FROM inventory_movements
    WHERE product_id = ? AND status = 'posted'
  `, [targetProductId]);
  await connection.execute(`
    INSERT INTO inventory_current (
      real_product_id,
      available_stock,
      reserved_stock,
      damaged_stock,
      in_transit_stock,
      last_updated_at
    )
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      available_stock = VALUES(available_stock),
      reserved_stock = VALUES(reserved_stock),
      damaged_stock = VALUES(damaged_stock),
      in_transit_stock = VALUES(in_transit_stock),
      last_updated_at = CURRENT_TIMESTAMP
  `, [
    targetProductId,
    Number(row?.available_stock || 0),
    Number(row?.reserved_stock || 0),
    Number(row?.damaged_stock || 0),
    Number(row?.in_transit_stock || 0)
  ]);
}

async function postInventoryMysql(connection, body = {}) {
  await ensureStockLocationSchemaMysql();
  const quantityDelta = Number(body.quantity_delta || 0);
  const movementType = body.movement_type || movementTypeFromSourceMysql(body.source_type, quantityDelta);
  const stockLocation = normalizeStockLocationMysql(body.stock_location);
  const stockLocationSource = String(body.stock_location_source || (stockLocation === "UNKNOWN" ? "legacy_unknown" : "explicit")).slice(0, 64);
  const [result] = await connection.execute(`
    INSERT INTO inventory_movements
    (product_id, shop_id, sku_mapping_id, owner_person_id, source_type, source_ref, quantity_delta, stock_location, stock_location_source,
     unit_cost, amount, status, note, movement_type, related_posting_number, related_order_item_id, operator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    Number(body.product_id),
    nullableInteger(body.shop_id),
    nullableInteger(body.sku_mapping_id),
    nullableInteger(body.owner_person_id) || nullableInteger(body.person_id),
    body.source_type || "manual_adjustment",
    body.source_ref || null,
    quantityDelta,
    stockLocation,
    stockLocationSource,
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
    const hadOrderItemMapping = Number(row.sku_mapping_id || 0) > 0;
    if (Number(row.sku_mapping_id || 0) !== Number(row.mapping_id)) {
      await mysqlExecute("UPDATE order_items SET sku_mapping_id = ? WHERE id = ?", [row.mapping_id, row.id]);
    }
    const existed = await mysqlQueryOne(`
      SELECT id, status, product_id FROM inventory_movements
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
      LIMIT 1
    `, [row.id]);
    if (existed) {
      if (Number(existed.product_id) !== Number(row.product_id)) {
        continue;
      }
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
    if (!hadOrderItemMapping) {
      await mysqlExecute(`
        UPDATE order_exceptions SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
        WHERE store_id = ? AND posting_number = ? AND ozon_sku = ? AND exception_type IN ('UNMAPPED_SKU', 'OUTBOUND_UNBOUND_SKU')
      `, [row.shop_id, row.posting_number, row.ozon_sku]);
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
  const resolvedImageUrl = await resolveOrderItemImageUrlMysql(shop, item);
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
    `, [item.offer_id || "", item.ozon_product_id || "", item.name || "", resolvedImageUrl, resolvedImageUrl, Number(item.sale_price || 0), existing.id]);
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
    resolvedImageUrl,
    resolvedImageUrl,
    Number(item.sale_price || 0),
    JSON.stringify(item)
  ]);
  return { id: Number(result.insertId), shop_id: shop.id, ozon_sku: item.ozon_sku };
}

function pickLiveProductImageMysql(detail = {}) {
  const images = Array.isArray(detail?.images) ? detail.images : [];
  return String(
    detail?.primary_image
    || detail?.image_url
    || images.find((item) => String(item || "").trim())
    || ""
  ).trim();
}

async function resolveOrderItemImageUrlMysql(shop, item = {}) {
  const directImage = String(item.image_url || item.ozon_image_url || "").trim();
  if (directImage) return directImage;

  const offerIds = [item.offer_id, item.ozon_sku]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (offerIds.length) {
    const details = await fetchOzonProductInfoAttributes(shop, { offerIds, limit: 10 }).catch(() => []);
    const matched = (Array.isArray(details) ? details : [details]).find((detail) => {
      const offerId = String(detail?.offer_id || "").trim();
      const sku = String(detail?.sku || detail?.id || detail?.product_id || "").trim();
      return offerIds.includes(offerId) || offerIds.includes(sku);
    }) || (Array.isArray(details) ? details[0] : details);
    const image = pickLiveProductImageMysql(matched);
    if (image) return image;
  }

  const productId = Number(item.ozon_product_id || item.product_id || 0);
  if (productId) {
    const details = await fetchOzonProductInfoAttributes(shop, { productIds: [productId], limit: 1 }).catch(() => []);
    const matched = Array.isArray(details) ? details[0] : details;
    const image = pickLiveProductImageMysql(matched);
    if (image) return image;
  }

  const refreshed = await refreshOnlineProductImageFromCatalogMysql(shop, item).catch(() => null);
  if (refreshed?.image_url) return String(refreshed.image_url || "").trim();

  return "";
}

async function refreshOnlineProductImageFromCatalogMysql(shop, item = {}) {
  const offerId = String(item.offer_id || "").trim();
  const ozonSku = String(item.ozon_sku || item.sku || "").trim();
  const ozonProductId = String(item.ozon_product_id || item.product_id || "").trim();

  if (ozonProductId) {
    const byId = await fetchOzonProductsByIds(shop, [Number(ozonProductId)]).catch(() => []);
    const matchedById = (Array.isArray(byId) ? byId : [byId]).find((row) => String(row?.image_url || row?.primary_image || "").trim()) || null;
    if (matchedById) {
      await upsertOnlineProductDualWrite(shop.id, matchedById);
      return matchedById;
    }
  }

  const products = await fetchOzonProducts(shop).catch(() => []);
  const matched = (Array.isArray(products) ? products : []).find((row) => {
    const rowOffer = String(row?.offer_id || "").trim();
    const rowSku = String(row?.ozon_sku || "").trim();
    const rowProductId = String(row?.ozon_product_id || "").trim();
    if (!String(row?.image_url || row?.primary_image || "").trim()) return false;
    return (offerId && rowOffer === offerId)
      || (ozonSku && rowSku === ozonSku)
      || (ozonProductId && rowProductId === ozonProductId);
  }) || null;
  if (!matched) return null;
  await upsertOnlineProductDualWrite(shop.id, matched);
  return matched;
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
  const accounting = await classifyOrderAccountingMysql(posting);
  return accounting.loss_profile_code !== "none";
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
      frozen_purchase_cost = ?,
      frozen_domestic_shipping = ?,
      frozen_international_shipping = ?,
      frozen_handling_fee = ?,
      estimated_commission = ?,
      platform_fee_actual = CASE WHEN ? = 'accrued' AND COALESCE(actual_profit, 0) = 0 THEN ? ELSE platform_fee_actual END,
      aftersale_loss = ?,
      estimated_profit = ?,
      actual_profit = CASE WHEN ? = 'accrued' THEN ? ELSE 0 END,
      settlement_state = ?
    WHERE id = ?
  `, [
    mapping.id,
    product?.purchase_cost || 0,
    product?.domestic_shipping || 0,
    estimated?.freight || product?.international_shipping || 0,
    product?.handling_fee || 0,
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

function normalizeForceRecalculateOrderItemIdsMysql(body = {}) {
  const list = Array.isArray(body.order_item_ids) ? body.order_item_ids : [];
  return [...new Set(list.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
}

async function productForProfitEstimateMysql(productId) {
  return await mysqlQueryOne(`
    SELECT p.*, 
      rule.name AS logistics_rule_name,
      rule.carrier AS logistics_rule_carrier,
      rule.channel AS logistics_rule_channel,
      rule.base_fee_cny AS logistics_rule_base_fee_cny,
      rule.per_gram_cny AS logistics_rule_per_gram_cny,
      rule.per_ticket_cny AS logistics_rule_per_ticket_cny
    FROM products p
    LEFT JOIN logistics_fee_rules rule ON rule.id = p.logistics_rule_id
    WHERE p.id = ? AND p.active = 1
  `, [Number(productId)]);
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
  const product = await productForProfitEstimateMysql(mapping.product_id);
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
  await mysqlExecute(`
    UPDATE order_items
    SET actual_profit = 0,
      settlement_state = CASE WHEN COALESCE(settlement_state, '') = 'accrued' THEN settlement_state ELSE 'pending' END
    WHERE order_id = ?
      AND COALESCE(settlement_state, '') != 'accrued'
  `, [orderId]);
  await mysqlExecute(`
    UPDATE order_profit_items
    SET profit_status = CASE WHEN COALESCE(profit_status, '') = 'accrued' THEN profit_status ELSE 'estimated' END,
      updated_at = CURRENT_TIMESTAMP
    WHERE order_item_id IN (
      SELECT id FROM order_items WHERE order_id = ?
    )
      AND COALESCE(profit_status, '') != 'accrued'
  `, [orderId]);
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
  const outboundStockLocation = resolveOrderStockLocationMysql(posting);

  let insertedItems = 0;
  for (const item of posting.items || []) {
    const resolvedImageUrl = await resolveOrderItemImageUrlMysql(shop, item);
    const normalizedItem = { ...item, image_url: resolvedImageUrl || item.image_url || "" };
    await upsertOnlineProductFromOrderItemMysql(shop, normalizedItem);
    const mapping = await mysqlQueryOne(`
      SELECT sm.*, op.commissions_json AS commissions_json
      FROM sku_mappings sm
      LEFT JOIN online_products op ON op.id = sm.online_product_id
      WHERE sm.shop_id = ? AND sm.ozon_sku = ? AND sm.active = 1
    `, [shop.id, item.ozon_sku]);
    const product = mapping ? await productForProfitEstimateMysql(mapping.product_id) : null;
    const existingItem = await mysqlQueryOne("SELECT id, quantity FROM order_items WHERE order_id = ? AND ozon_sku = ?", [orderId, item.ozon_sku]);
    if (existingItem) {
      const previousQuantity = Number(existingItem.quantity || 0);
      const nextQuantity = Number(item.quantity || 1);
      await mysqlExecute(`
        UPDATE order_items
        SET sku_mapping_id = COALESCE(?, sku_mapping_id),
          ozon_name = COALESCE(NULLIF(?, ''), ozon_name),
          ozon_image_url = COALESCE(NULLIF(?, ''), ozon_image_url),
          ozon_product_id = COALESCE(NULLIF(?, ''), ozon_product_id),
          quantity = ?,
          sale_price = ?
        WHERE id = ?
      `, [mapping?.id || null, item.name || "", normalizedItem.image_url || "", item.ozon_product_id || "", nextQuantity, item.sale_price, existingItem.id]);
      if (product && mapping && previousQuantity !== nextQuantity) {
        const quantityDelta = previousQuantity - nextQuantity;
        await postInventoryMysql(mysqlPoolConnectionAdapter, {
          product_id: product.id,
          shop_id: shop.id,
          sku_mapping_id: mapping.id,
          owner_person_id: mapping.person_id,
          source_type: "order_outbound_adjustment",
          source_ref: posting.posting_number,
          quantity_delta: quantityDelta,
          unit_cost: product.purchase_cost,
          amount: Math.abs(quantityDelta) * Number(product.purchase_cost || 0),
          stock_location: outboundStockLocation.stockLocation,
          stock_location_source: outboundStockLocation.stockLocationSource,
          related_posting_number: posting.posting_number,
          related_order_item_id: existingItem.id,
          note: "Ozon order item quantity changed during sync"
        });
        await mysqlExecute(`
          UPDATE outbound_records
          SET quantity = ?, stock_location = ?, stock_location_source = ?, note = ?
          WHERE order_item_id = ? AND status = 'deducted'
        `, [nextQuantity, outboundStockLocation.stockLocation, outboundStockLocation.stockLocationSource, "Updated by Ozon sync", existingItem.id]);
      }
      if (product && mapping) {
        const estimated = estimateItemProfit({ salePrice: item.sale_price, quantity: nextQuantity, product, mapping });
        const settlement = resolveProfitSettlementStatusMysql(posting);
        const returnLossEstimate = await estimateOrderItemReturnLossMysql({ order: posting, item, product, estimated, quantity: nextQuantity, salePrice: item.sale_price });
        const estimatedProfit = estimatedProfitValueMysql({ item, product, estimated, returnLossEstimate });
        await persistRecalculatedItemMysql({
          itemId: existingItem.id,
          mapping,
          product,
          estimated,
          settlement,
          returnLossEstimate,
          estimatedProfit,
          quantity: nextQuantity,
          salePrice: item.sale_price,
          order: posting,
          item
        });
      }
      continue;
    }
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
      normalizedItem.image_url || "",
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
        stock_location: outboundStockLocation.stockLocation,
        stock_location_source: outboundStockLocation.stockLocationSource,
        unit_cost: product.purchase_cost,
        amount: Math.abs(qty) * product.purchase_cost,
        related_posting_number: posting.posting_number,
        related_order_item_id: orderItemId,
        note: "Ozon order outbound"
      });
      await mysqlExecute(`
        INSERT INTO outbound_records (product_id, shop_id, online_product_id, order_ref, order_item_id, ozon_sku, person_id, quantity, stock_location, stock_location_source, reason, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'order', 'deducted', ?)
      `, [product.id, shop.id, mapping.online_product_id, posting.posting_number, orderItemId, item.ozon_sku, mapping.person_id, item.quantity, outboundStockLocation.stockLocation, outboundStockLocation.stockLocationSource, "Created by Ozon sync"]);
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

function normalizeShanghaiDateBoundaryMysql(value, boundary = "start") {
  if (!value) return "";
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const time = boundary === "end" ? "23:59:59.999" : "00:00:00.000";
  const date = new Date(`${raw}T${time}+08:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
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
  const statuses = Array.isArray(body.statuses)
    ? body.statuses.map((item) => String(item || "").trim()).filter(Boolean)
    : String(body.status || "").split(",").map((item) => item.trim()).filter(Boolean);
  const from = normalizeSyncDateMysql(rawFromDateTime || rawFrom);
  const to = normalizeSyncDateMysql(rawToDateTime || rawTo);
  const fetchFrom = normalizeSyncDateTimeMysql(rawFromDateTime) || normalizeShanghaiDateBoundaryMysql(rawFrom, "start") || from;
  const fetchTo = normalizeSyncDateTimeMysql(rawToDateTime) || normalizeShanghaiDateBoundaryMysql(rawTo, "end") || to;
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
      const result = await fetchOzonPostings(shop, { from: fetchFrom, to: fetchTo, statuses, chunkDays: 14, signal: options.signal });
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
          to
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

export async function syncOzonPostingsByNumberMysql(body = {}, options = {}) {
  ensureMysqlCutoverEnabled();
  const postingNumbers = [...new Set((body.posting_numbers || body.postingNumbers || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
  if (!postingNumbers.length) throw new Error("Missing posting numbers");
  const targetShopId = nullableInteger(body.shop_id);
  const activeShops = (await shopsMysql()).filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  const rows = [];
  const errors = [];
  let inserted = 0;
  let updated = 0;
  let insertedItems = 0;
  for (const postingNumber of postingNumbers) {
    let matched = false;
    for (const shop of activeShops) {
      throwIfAbortedMysql(options.signal);
      try {
        const posting = await fetchOzonPostingByNumber(shop, postingNumber, { signal: options.signal });
        if (!posting?.posting_number) continue;
        const stats = await upsertPostingMysql(shop, posting);
        inserted += stats.inserted;
        updated += stats.updated;
        insertedItems += stats.insertedItems;
        rows.push({
          posting_number: postingNumber,
          shop_id: shop.id,
          shop_name: shop.name,
          status: posting.status,
          tracking_stage: posting.tracking_stage || posting.substatus || "",
          inserted: stats.inserted,
          updated: stats.updated,
          inserted_items: stats.insertedItems
        });
        matched = true;
        break;
      } catch (error) {
        if (!String(error?.message || "").includes("Unknown posting number")) {
          errors.push(`${shop.name} ${postingNumber}: ${error.message}`);
        }
      }
    }
    if (!matched) {
      rows.push({ posting_number: postingNumber, found: false });
    }
  }
  await syncOutboundForOpenOrdersMysql();
  let refreshFrom = String(body.from || body.date_from || "").slice(0, 10);
  let refreshTo = String(body.to || body.date_to || "").slice(0, 10);
  if ((!refreshFrom || !refreshTo) && rows.some((row) => row.found !== false)) {
    const syncedNumbers = rows.map((row) => String(row.posting_number || "").trim()).filter(Boolean);
    const placeholders = syncedNumbers.map(() => "?").join(",");
    const dateRange = placeholders
      ? await mysqlQueryOne(`
        SELECT
          DATE_FORMAT(MIN(${chinaDateSqlMysql("ordered_at")}), '%Y-%m-%d') AS min_date,
          DATE_FORMAT(MAX(${chinaDateSqlMysql("ordered_at")}), '%Y-%m-%d') AS max_date
        FROM orders
        WHERE posting_number IN (${placeholders})
      `, syncedNumbers)
      : null;
    refreshFrom = refreshFrom || String(dateRange?.min_date || "").slice(0, 10);
    refreshTo = refreshTo || String(dateRange?.max_date || "").slice(0, 10);
  }
  await refreshProfitAnalyticsSnapshotsMysql({ from: refreshFrom || "", to: refreshTo || "" });
  invalidateMasterDataCache();
  return {
    ok: !errors.length,
    fetched: rows.filter((row) => row.found !== false).length,
    inserted,
    updated,
    inserted_items: insertedItems,
    rows,
    errors
  };
}

export async function syncKnownOzonPostingDetailsMysql(body = {}, options = {}) {
  ensureMysqlCutoverEnabled();
  const days = Math.min(Math.max(Number(body.days || body.recent_days || 30), 1), 365);
  const limit = Math.min(Math.max(Number(body.limit || 200), 1), 5000);
  const concurrency = Math.min(Math.max(Number(body.concurrency || 2), 1), 5);
  const targetShopId = nullableInteger(body.shop_id);
  const from = dateKeyDaysAgoMysql(days);
  const to = todayDateKeyMysql();
  const activeShops = (await shopsMysql()).filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  const shopById = new Map(activeShops.map((shop) => [Number(shop.id), shop]));
  const params = [from];
  const filters = [
    `${chinaDateSqlMysql("o.ordered_at")} >= ?`,
    "COALESCE(o.posting_number, '') != ''"
  ];
  if (targetShopId) {
    filters.push("o.shop_id = ?");
    params.push(targetShopId);
  }
  const rows = await mysqlQuery(`
    SELECT o.id, o.shop_id, o.posting_number, o.status, o.tracking_stage, o.ordered_at, o.last_synced_at
    FROM orders o
    JOIN shops s ON s.id = o.shop_id AND s.status = 'active'
    WHERE ${filters.join(" AND ")}
    ORDER BY
      CASE
        WHEN LOWER(CONCAT_WS(' ', COALESCE(o.status, ''), COALESCE(o.tracking_stage, ''), COALESCE(o.logistics_status, ''))) LIKE '%cancel%' THEN 2
        WHEN ${orderStatusSqlMysql("awaiting_packaging")} OR ${orderStatusSqlMysql("awaiting_deliver")} THEN 1
        WHEN ${orderStatusSqlMysql("delivering")} THEN 2
        WHEN ${orderStatusSqlMysql("delivered")} THEN 3
        ELSE 1
      END ASC,
      COALESCE(o.last_synced_at, '1970-01-01') ASC,
      o.ordered_at DESC
    LIMIT ?
  `, [...params, limit]);
  const result = {
    mode: body.mode || "known_posting_details",
    from,
    to,
    candidate_orders: rows.length,
    fetched: 0,
    inserted: 0,
    updated: 0,
    inserted_items: 0,
    errors: [],
    rows: []
  };
  await mapWithConcurrencyMysql(rows, concurrency, async (row) => {
    throwIfAbortedMysql(options.signal);
    const shop = shopById.get(Number(row.shop_id));
    if (!shop) return;
    try {
      const posting = await fetchOzonPostingByNumber(shop, row.posting_number, { signal: options.signal });
      if (!posting?.posting_number) {
        result.rows.push({ order_id: row.id, shop_id: row.shop_id, posting_number: row.posting_number, found: false });
        return;
      }
      const stats = await upsertPostingMysql(shop, posting);
      result.fetched += 1;
      result.inserted += Number(stats.inserted || 0);
      result.updated += Number(stats.updated || 0);
      result.inserted_items += Number(stats.insertedItems || 0);
      result.rows.push({
        order_id: row.id,
        shop_id: row.shop_id,
        posting_number: row.posting_number,
        status: posting.status,
        tracking_stage: posting.tracking_stage || posting.substatus || "",
        inserted: stats.inserted,
        updated: stats.updated,
        inserted_items: stats.insertedItems
      });
    } catch (error) {
      const message = `${shop.name || row.shop_id} ${row.posting_number}: ${error.message}`;
      result.errors.push(message);
      result.rows.push({ order_id: row.id, shop_id: row.shop_id, posting_number: row.posting_number, error: error.message });
    }
  });
  await syncOutboundForOpenOrdersMysql();
  await refreshProfitAnalyticsSnapshotsMysql({ from, to });
  const status = result.errors.length ? "partial_error" : "ok";
  const message = `Known posting detail sync ${from}~${to}; candidates ${result.candidate_orders}, fetched ${result.fetched}, inserted item(s) ${result.inserted_items}, updated order(s) ${result.updated}${result.errors.length ? `; ${result.errors.slice(0, 10).join(" | ")}` : ""}`;
  await mysqlExecute("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_posting_details', ?, ?)", [status, message]);
  if (result.errors.length && result.fetched === 0 && rows.length) throw new Error(result.errors.join(" | "));
  return result;
}

export function exceptionWorkbenchSyncWindowMysql() {
  return {
    from: dateKeyDaysAgoMysql(30),
    to: todayDateKeyMysql()
  };
}

export async function refreshProfitAnalyticsSnapshotsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProfitAnalyticsSchemaMysql();
  const rangeFrom = normalizeSyncDateMysql(body.from) || "2000-01-01";
  const rangeTo = normalizeSyncDateMysql(body.to) || "9999-12-31";
  const outcome = buildOrderOutcomeSql("o", "mysql");
  const effectiveBusinessSale = `(${outcome.effectiveSale} AND NOT ${outcome.afterDeliveryReturn})`;
  const orderedAtFilter = profitOrderedAtUtcRangeMysql("o", rangeFrom, rangeTo);
  await mysqlExecute("DELETE FROM analytics_shop_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);
  await mysqlExecute("DELETE FROM analytics_product_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);
  await mysqlExecute("DELETE FROM analytics_sku_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);

  await mysqlExecute(`
    INSERT INTO analytics_shop_daily (
      date_key, shop_id, order_count, effective_orders, item_quantity, total_revenue, revenue,
      estimated_profit, confirmed_profit, current_profit, accrued_profit, accrued_order_count, pending_profit, pending_order_count,
      cancelled_orders, cancelled_quantity, cancelled_revenue, return_orders, return_quantity, return_revenue, return_loss, refreshed_at
    )
    SELECT
      ${chinaDateSqlMysql("o.ordered_at")} AS date_key,
      o.shop_id,
      COUNT(DISTINCT o.id) AS order_count,
      COUNT(DISTINCT CASE WHEN ${effectiveBusinessSale} THEN o.id END) AS effective_orders,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)), 0) AS total_revenue,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END ELSE 0 END), 0) AS current_profit,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS accrued_profit,
      COUNT(DISTINCT CASE WHEN ${effectiveBusinessSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN o.id END) AS accrued_order_count,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') != 'accrued' THEN COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) ELSE 0 END), 0) AS pending_profit,
      COUNT(DISTINCT CASE WHEN ${effectiveBusinessSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') != 'accrued' THEN o.id END) AS pending_order_count,
      COUNT(DISTINCT CASE WHEN ${outcome.cancelledPreFulfillment} THEN o.id END) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN oi.quantity ELSE 0 END), 0) AS cancelled_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN o.id END) AS return_orders,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS return_revenue,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.return_loss_cny, oi.aftersale_loss, 0) ELSE 0 END), 0) AS return_loss,
      CURRENT_TIMESTAMP
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE 1=1 ${orderedAtFilter.whereSql}
    GROUP BY ${chinaDateSqlMysql("o.ordered_at")}, o.shop_id
    ON DUPLICATE KEY UPDATE
      order_count = VALUES(order_count),
      effective_orders = VALUES(effective_orders),
      item_quantity = VALUES(item_quantity),
      total_revenue = VALUES(total_revenue),
      revenue = VALUES(revenue),
      estimated_profit = VALUES(estimated_profit),
      confirmed_profit = VALUES(confirmed_profit),
      current_profit = VALUES(current_profit),
      accrued_profit = VALUES(accrued_profit),
      accrued_order_count = VALUES(accrued_order_count),
      pending_profit = VALUES(pending_profit),
      pending_order_count = VALUES(pending_order_count),
      cancelled_orders = VALUES(cancelled_orders),
      cancelled_quantity = VALUES(cancelled_quantity),
      cancelled_revenue = VALUES(cancelled_revenue),
      return_orders = VALUES(return_orders),
      return_quantity = VALUES(return_quantity),
      return_revenue = VALUES(return_revenue),
      return_loss = VALUES(return_loss),
      refreshed_at = VALUES(refreshed_at)
  `, orderedAtFilter.params);

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
    WHERE 1=1 ${orderedAtFilter.whereSql}
    GROUP BY ${chinaDateSqlMysql("o.ordered_at")}, sm.product_id, o.shop_id
    ON DUPLICATE KEY UPDATE
      order_count = VALUES(order_count),
      item_quantity = VALUES(item_quantity),
      revenue = VALUES(revenue),
      estimated_profit = VALUES(estimated_profit),
      confirmed_profit = VALUES(confirmed_profit),
      current_profit = VALUES(current_profit),
      refreshed_at = VALUES(refreshed_at)
  `, orderedAtFilter.params);

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
    WHERE 1=1 ${orderedAtFilter.whereSql}
    GROUP BY ${chinaDateSqlMysql("o.ordered_at")}, o.shop_id, oi.ozon_sku
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
  `, orderedAtFilter.params);

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
    const product = await productForProfitEstimateMysql(mapping.product_id);
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

export async function forceRecalculateOrderProfitsForProductMysql(productId, body = {}) {
  ensureMysqlCutoverEnabled();
  const product = await mysqlQueryOne("SELECT id FROM products WHERE id = ? AND active = 1", [Number(productId)]);
  if (!product) throw new Error("Inventory product not found or archived");

  const orderItemIds = normalizeForceRecalculateOrderItemIdsMysql(body);
  if (!orderItemIds.length) {
    return {
      ok: true,
      product_id: Number(productId),
      selected: 0,
      matched: 0,
      updated: 0,
      unbound: 0,
      missing: 0,
      missing_order_item_ids: [],
      updated_rows: [],
      skipped_rows: [],
      finance_reapplied: { orders: 0, items: 0 }
    };
  }

  const placeholders = orderItemIds.map(() => "?").join(",");
  const rows = await mysqlQuery(`
    SELECT oi.*, o.shop_id, o.id AS order_id, o.posting_number, o.order_number, o.status AS order_status, o.tracking_stage, o.logistics_status,
      o.ordered_at, o.delivered_at, o.accrued_at, o.cancel_reason, o.cancel_reason_id, o.cancel_initiator, o.cancel_type, o.cancelled_after_ship
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN sku_mappings sm_current ON sm_current.id = oi.sku_mapping_id
    WHERE sm_current.product_id = ?
      AND oi.id IN (${placeholders})
  `, [Number(productId), ...orderItemIds]);

  let updated = 0;
  let unbound = 0;
  const updatedRows = [];
  const skippedRows = [];
  const touchedOrderIds = new Set();
  const matchedIds = new Set(rows.map((row) => Number(row.id)));
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
    `, [item.shop_id, item.ozon_sku, Number(item.sku_mapping_id || 0)]);
    if (!mapping) {
      unbound += 1;
      skippedRows.push({
        order_item_id: Number(item.id),
        posting_number: item.posting_number || "",
        ozon_sku: item.ozon_sku || "",
        status: item.order_status || "",
        reason: "missing_mapping"
      });
      continue;
    }
    const mappedProduct = await productForProfitEstimateMysql(mapping.product_id);
    if (!mappedProduct || Number(mappedProduct.id) !== Number(productId)) {
      unbound += 1;
      skippedRows.push({
        order_item_id: Number(item.id),
        posting_number: item.posting_number || "",
        ozon_sku: item.ozon_sku || "",
        status: item.order_status || "",
        reason: !mappedProduct ? "missing_product" : "mapped_to_other_product"
      });
      continue;
    }
    const estimated = estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product: mappedProduct, mapping });
    const settlement = resolveProfitSettlementStatusMysql(item);
    const returnLossEstimate = await estimateOrderItemReturnLossMysql({ order: item, item, product: mappedProduct, estimated, quantity: item.quantity, salePrice: item.sale_price });
    const estimatedProfit = estimatedProfitValueMysql({ item, product: mappedProduct, estimated, returnLossEstimate });
    await persistRecalculatedItemMysql({
      itemId: item.id,
      mapping,
      product: mappedProduct,
      estimated,
      settlement,
      returnLossEstimate,
      estimatedProfit,
      quantity: item.quantity,
      salePrice: item.sale_price,
      order: item,
      item
    });
    updated += 1;
    touchedOrderIds.add(Number(item.order_id));
    updatedRows.push({
      order_item_id: Number(item.id),
      posting_number: item.posting_number || "",
      ozon_sku: item.ozon_sku || "",
      status: item.order_status || "",
      settlement_state: settlement || "",
      estimated_profit: Number(estimatedProfit || 0)
    });
  }

  const missingOrderItemIds = orderItemIds.filter((id) => !matchedIds.has(Number(id)));
  for (const orderItemId of missingOrderItemIds) {
    skippedRows.push({
      order_item_id: Number(orderItemId),
      posting_number: "",
      ozon_sku: "",
      status: "",
      reason: "not_found_for_product"
    });
  }

  let financeReapplied = { orders: 0, items: 0 };
  if (touchedOrderIds.size) {
    const orderIds = [...touchedOrderIds];
    const orderPlaceholders = orderIds.map(() => "?").join(",");
    const [rangeRow] = await mysqlQuery(`
      SELECT MIN(DATE(operation_date)) AS min_date, MAX(DATE(operation_date)) AS max_date
      FROM ozon_finance_items
      WHERE posting_number IN (
        SELECT posting_number FROM orders WHERE id IN (${orderPlaceholders})
      )
    `, orderIds);
    const from = rangeRow?.min_date ? String(rangeRow.min_date).slice(0, 10) : "";
    const to = rangeRow?.max_date ? String(rangeRow.max_date).slice(0, 10) : "";
    financeReapplied = await applyOzonFinanceToOrdersMysql({ from, to, orderIds });
    const dateRows = await mysqlQuery(`
      SELECT DISTINCT ${chinaDateSqlMysql("ordered_at")} AS order_date
      FROM orders
      WHERE id IN (${orderPlaceholders})
      ORDER BY order_date ASC
    `, orderIds);
    const dates = dateRows.map((row) => row.order_date).filter(Boolean);
    if (dates.length) {
      await refreshProfitAnalyticsSnapshotsMysql({ from: dates[0], to: dates[dates.length - 1] });
    }
    await refreshOrderProfitDetailSnapshotsMysql({ order_ids: orderIds, final_only: 0 });
  }

  return {
    ok: true,
    product_id: Number(productId),
    selected: orderItemIds.length,
    matched: rows.length,
    updated,
    unbound,
    missing: missingOrderItemIds.length,
    missing_order_item_ids: missingOrderItemIds,
    updated_rows: updatedRows.slice(0, 50),
    skipped_rows: skippedRows.slice(0, 50),
    finance_reapplied: financeReapplied
  };
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

export async function cleanupHistoricalUnconfirmedActualProfitMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  const onlyFinal = Number(body.only_final ?? 0) !== 0;
  const filters = [
    "COALESCE(oi.actual_profit, 0) != 0",
    "COALESCE(oi.settlement_state, '') = 'accrued'",
    "COALESCE(opi.profit_status, '') != 'accrued'",
    `NOT EXISTS (
      SELECT 1
      FROM ozon_finance_items ofi
      WHERE ofi.shop_id = o.shop_id
        AND ofi.posting_number = o.posting_number
    )`
  ];
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

  const rows = await mysqlQuery(`
    SELECT
      oi.id AS order_item_id,
      oi.order_id,
      ${chinaDateSqlMysql("o.ordered_at")} AS order_date,
      COALESCE(oi.estimated_profit, 0) AS estimated_profit,
      COALESCE(oi.actual_profit, 0) AS actual_profit
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE ${filters.join(" AND ")}
    ORDER BY ${chinaDateSqlMysql("o.ordered_at")} ASC, oi.id ASC
  `, params);

  if (!rows.length) {
    return {
      ok: true,
      from,
      to,
      only_final: onlyFinal,
      updated_items: 0,
      updated_orders: 0,
      cleared_actual_profit_cny: 0
    };
  }

  let updatedItems = 0;
  let clearedActualProfit = 0;
  const updatedOrders = new Set();
  const dateKeys = new Set();

  await withMysqlTransaction(async (connection) => {
    for (const row of rows) {
      const estimatedProfit = roundMoneyMysql(Number(row.estimated_profit || 0));
      const previousActual = roundMoneyMysql(Number(row.actual_profit || 0));
      await connection.execute(`
        UPDATE order_items
        SET actual_profit = 0,
          settlement_state = 'pending',
          estimated_profit = ?
        WHERE id = ?
      `, [estimatedProfit, Number(row.order_item_id)]);
      await connection.execute(`
        UPDATE order_profit_items
        SET profit_status = 'estimated',
          updated_at = CURRENT_TIMESTAMP
        WHERE order_item_id = ?
          AND COALESCE(profit_status, '') != 'accrued'
      `, [Number(row.order_item_id)]);
      updatedItems += 1;
      clearedActualProfit += previousActual;
      updatedOrders.add(Number(row.order_id));
      if (row.order_date) dateKeys.add(row.order_date);
    }
  });

  let refreshWarning = "";
  try {
    if (dateKeys.size) {
      const sortedDates = [...dateKeys].sort();
      await refreshProfitAnalyticsSnapshotsMysql({
        from: from || sortedDates[0],
        to: to || sortedDates[sortedDates.length - 1]
      });
    } else if (from || to) {
      await refreshProfitAnalyticsSnapshotsMysql({ from, to });
    }
  } catch (error) {
    refreshWarning = error?.message || "profit analytics refresh failed";
  }
  if (updatedOrders.size) {
    await refreshOrderProfitDetailSnapshotsMysql({ order_ids: [...updatedOrders], final_only: 0 });
  }

  return {
    ok: true,
    from,
    to,
    only_final: onlyFinal,
    updated_items: updatedItems,
    updated_orders: updatedOrders.size,
    cleared_actual_profit_cny: roundMoneyMysql(clearedActualProfit),
    refresh_warning: refreshWarning
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

async function rollbackProcurementDirectInboundMysql(connection, request) {
  const requestId = Number(request.id || 0);
  const productId = Number(request.product_id || 0);
  const personId = nullableInteger(request.person_id);
  const quantity = Math.max(0, Number(request.quantity || 0));
  const amount = Number(request.amount || 0);
  const shippingAmount = Number(request.shipping_amount || 0);
  if (!requestId || !productId || !quantity) return false;

  const exact = await mysqlConnectionQueryOne(connection, `
    SELECT *
    FROM inbound_records
    WHERE product_id = ?
      AND purchase_order_id IS NULL
      AND purchase_order_item_id IS NULL
      AND status = 'approved'
      AND quantity = ?
      AND amount = ?
      AND shipping_amount = ?
      AND (? IS NULL OR person_id <=> ?)
    ORDER BY approved_at DESC, id DESC
    LIMIT 1
    FOR UPDATE
  `, [productId, quantity, amount, shippingAmount, personId, personId]);

  const fallback = exact || await mysqlConnectionQueryOne(connection, `
    SELECT *
    FROM inbound_records
    WHERE product_id = ?
      AND purchase_order_id IS NULL
      AND purchase_order_item_id IS NULL
      AND status = 'approved'
      AND (? IS NULL OR person_id <=> ?)
    ORDER BY approved_at DESC, id DESC
    LIMIT 1
    FOR UPDATE
  `, [productId, personId, personId]);

  if (!fallback) return false;
  await deleteInboundInventoryMovementMysql(connection, Number(fallback.id), Number(fallback.product_id || productId));
  await connection.execute("DELETE FROM inbound_records WHERE id = ?", [Number(fallback.id)]);
  return true;
}

async function rollbackProcurementMergedInboundMysql(connection, request) {
  const orderId = Number(request.purchase_order_id || 0);
  const productId = Number(request.product_id || 0);
  if (!orderId || !productId) return false;

  const item = await mysqlConnectionQueryOne(connection, `
    SELECT *
    FROM purchase_order_items
    WHERE purchase_order_id = ? AND product_id = ?
    LIMIT 1
    FOR UPDATE
  `, [orderId, productId]);
  if (!item) return false;

  const requestQty = Math.max(0, Number(request.quantity || 0));
  const requestAmount = Number(request.amount || 0);
  const requestShipping = Number(request.shipping_amount || 0);
  const amountPerUnit = requestQty > 0 ? requestAmount / requestQty : 0;
  const shippingPerUnit = requestQty > 0 ? requestShipping / requestQty : 0;

  let remainingQty = requestQty;
  let remainingAmount = requestAmount;
  let remainingShipping = requestShipping;

  const inboundRows = await mysqlConnectionQuery(connection, `
    SELECT *
    FROM inbound_records
    WHERE purchase_order_item_id = ?
    ORDER BY
      CASE WHEN status = 'approved' THEN 0 ELSE 1 END,
      COALESCE(approved_at, created_at) DESC,
      id DESC
    FOR UPDATE
  `, [Number(item.id)]);

  for (const inbound of inboundRows) {
    if (remainingQty <= 0) break;
    const inboundQty = Math.max(0, Number(inbound.quantity || 0));
    if (!inboundQty) continue;

    const deductQty = Math.min(inboundQty, remainingQty);
    const deductAmount = deductQty === remainingQty
      ? remainingAmount
      : Math.min(remainingAmount, amountPerUnit * deductQty);
    const deductShipping = deductQty === remainingQty
      ? remainingShipping
      : Math.min(remainingShipping, shippingPerUnit * deductQty);

    const nextQty = Math.max(0, inboundQty - deductQty);
    const nextAmount = Math.max(0, Number(inbound.amount || 0) - deductAmount);
    const nextShipping = Math.max(0, Number(inbound.shipping_amount || 0) - deductShipping);
    const nextUnitCost = nextQty ? (nextAmount + nextShipping) / nextQty : 0;

    if (String(inbound.status || "") === "approved") {
      if (nextQty <= 0) {
        await deleteInboundInventoryMovementMysql(connection, Number(inbound.id), Number(inbound.product_id || productId));
        await connection.execute("DELETE FROM inbound_records WHERE id = ?", [Number(inbound.id)]);
      } else {
        await connection.execute(`
          UPDATE inbound_records
          SET quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?
          WHERE id = ?
        `, [nextQty, nextAmount, nextShipping, nextUnitCost, Number(inbound.id)]);
        await upsertInboundInventoryMovementMysql(connection, Number(inbound.id), {
          product_id: Number(inbound.product_id || productId),
          owner_person_id: inbound.person_id,
          quantity: nextQty,
          unitCost: nextUnitCost,
          amount: nextAmount + nextShipping,
          note: inbound.note || ""
        });
      }
    } else if (nextQty <= 0) {
      await connection.execute("DELETE FROM inbound_records WHERE id = ?", [Number(inbound.id)]);
    } else {
      await connection.execute(`
        UPDATE inbound_records
        SET quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?
        WHERE id = ?
      `, [nextQty, nextAmount, nextShipping, nextUnitCost, Number(inbound.id)]);
    }

    remainingQty = Math.max(0, remainingQty - deductQty);
    remainingAmount = Math.max(0, remainingAmount - deductAmount);
    remainingShipping = Math.max(0, remainingShipping - deductShipping);
  }

  const nextRequestedQty = Math.max(0, Number(item.requested_quantity || 0) - requestQty);
  const nextActualQty = Math.max(0, Number(item.actual_quantity || 0) - requestQty);
  const nextInboundQty = Math.max(0, Number(item.inbound_quantity || 0) - requestQty);
  const nextAmount = Math.max(0, Number(item.amount || 0) - requestAmount);
  const nextShipping = Math.max(0, Number(item.shipping_amount || 0) - requestShipping);
  const nextUnitCost = nextActualQty ? (nextAmount + nextShipping) / nextActualQty : 0;

  if (nextRequestedQty <= 0 && nextActualQty <= 0) {
    const orphanInbound = await mysqlConnectionQuery(connection, `
      SELECT *
      FROM inbound_records
      WHERE purchase_order_item_id = ?
      FOR UPDATE
    `, [Number(item.id)]);
    for (const inbound of orphanInbound) {
      if (String(inbound.status || "") === "approved") {
        await deleteInboundInventoryMovementMysql(connection, Number(inbound.id), Number(inbound.product_id || productId));
      }
      await connection.execute("DELETE FROM inbound_records WHERE id = ?", [Number(inbound.id)]);
    }
    await connection.execute("DELETE FROM purchase_order_items WHERE id = ?", [Number(item.id)]);
  } else {
    const nextItemStatus = nextInboundQty >= nextActualQty && nextActualQty > 0
      ? "inbound_done"
      : nextInboundQty > 0
        ? "partial_inbound"
        : "purchased";
    await connection.execute(`
      UPDATE purchase_order_items
      SET requested_quantity = ?, actual_quantity = ?, inbound_quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?, status = ?
      WHERE id = ?
    `, [nextRequestedQty, nextActualQty, nextInboundQty, nextAmount, nextShipping, nextUnitCost, nextItemStatus, Number(item.id)]);
  }

  const summary = await mysqlConnectionQueryOne(connection, `
    SELECT
      COUNT(*) AS item_count,
      COALESCE(SUM(actual_quantity), 0) AS total_quantity,
      COALESCE(SUM(amount + shipping_amount), 0) AS total_amount
    FROM purchase_order_items
    WHERE purchase_order_id = ?
  `, [orderId]);

  if (Number(summary?.item_count || 0) <= 0) {
    await connection.execute("DELETE FROM purchase_orders WHERE id = ?", [orderId]);
  } else {
    await connection.execute(`
      UPDATE purchase_orders
      SET total_quantity = ?, total_amount = ?
      WHERE id = ?
    `, [Number(summary?.total_quantity || 0), Number(summary?.total_amount || 0), orderId]);
    await refreshPurchaseOrderStatusMysql(connection, orderId);
  }

  return true;
}

async function refreshProcurementRequestStatusForOrderMysql(connection, orderId, orderStatus) {
  if (!orderId) return;
  if (orderStatus === "inbound_done") {
    await connection.execute(`
      UPDATE procurement_requests
      SET status = 'done', approval_status = 'done'
      WHERE purchase_order_id = ? AND status != 'cancelled'
    `, [Number(orderId)]);
    return;
  }
  if (["purchased", "partial_inbound"].includes(orderStatus)) {
    await connection.execute(`
      UPDATE procurement_requests
      SET status = 'purchased', approval_status = 'purchased'
      WHERE purchase_order_id = ? AND status NOT IN ('cancelled', 'done')
    `, [Number(orderId)]);
  }
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
  await refreshProcurementRequestStatusForOrderMysql(connection, orderId, status);
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
  await ensureProcurementRequestTimestampSchemaMysql();
  await ensureProcurementOrderSourceSchemaMysql();
  const personId = await resolvePersonIdOrFirstMysql(body.person_id);
  const result = await mysqlExecute(`
    INSERT INTO procurement_requests
    (product_id, person_id, quantity, amount, shipping_amount, purchase_url, approval_status, status, needed_by, note, urgency, source_type, supplier_id, source_order_id, source_order_item_id, source_ozon_sku)
    VALUES (?, ?, ?, ?, ?, ?, 'submitted', 'submitted', ?, ?, ?, ?, ?, ?, ?, ?)
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
    nullableInteger(body.supplier_id),
    nullableInteger(body.source_order_id),
    nullableInteger(body.source_order_item_id),
    body.source_ozon_sku || null
  ]);
  return { id: Number(result.insertId) };
}

async function orderProcurementCandidateRowsMysql(orderId, connection = null) {
  const query = connection
    ? (sql, params) => connection.query(sql, params).then(([rows]) => rows)
    : mysqlQuery;
  const rows = await query(`
    WITH source_products AS (
      SELECT DISTINCT sm.product_id
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN sku_mappings sm ON (
        (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
        AND sm.active = 1
      )
      JOIN products p ON p.id = sm.product_id AND p.active = 1
      WHERE o.id = ?
    ),
    mapped_items AS (
      SELECT oi.id AS order_item_id, oi.order_id, oi.ozon_sku, oi.ozon_name, oi.quantity,
        oi.sale_price, COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '') AS image_url,
        o.posting_number, o.order_number, o.ordered_at, o.status, o.tracking_stage, o.logistics_status,
        sm.product_id, p.name AS product_name, p.code AS product_code, p.image_url AS product_image_url, p.purchase_url,
        p.purchase_cost, p.domestic_shipping, p.source_platform, p.supplier_id,
        COALESCE(stock.current_stock, 0) AS current_stock,
        COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
        ROW_NUMBER() OVER (PARTITION BY oi.id ORDER BY CASE WHEN sm.id = oi.sku_mapping_id THEN 0 ELSE 1 END, sm.id DESC) AS rn
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN sku_mappings sm ON (
        (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
        AND sm.active = 1
      )
      JOIN source_products sp ON sp.product_id = sm.product_id
      JOIN products p ON p.id = sm.product_id AND p.active = 1
      LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
      LEFT JOIN (
        SELECT product_id, SUM(quantity_delta) AS current_stock
        FROM inventory_movements
        WHERE status = 'posted'
        GROUP BY product_id
      ) stock ON stock.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS incoming_stock
        FROM (
          SELECT product_id, quantity FROM inbound_records WHERE status = 'pending_arrival'
          UNION ALL
          SELECT product_id, quantity FROM procurement_requests WHERE status IN ('submitted', 'merged')
        ) incoming_rows
        GROUP BY product_id
      ) incoming ON incoming.product_id = p.id
      WHERE (${orderStatusSqlMysql("awaiting_packaging")} OR ${orderStatusSqlMysql("awaiting_deliver")})
    )
    SELECT mi.*
    FROM mapped_items mi
    LEFT JOIN procurement_requests pr ON pr.source_order_item_id = mi.order_item_id
      AND pr.status NOT IN ('cancelled')
    LEFT JOIN order_item_procurement_marks oipm ON oipm.order_item_id = mi.order_item_id
      AND oipm.status = 'handled'
    WHERE mi.rn = 1 AND pr.id IS NULL AND oipm.id IS NULL
    ORDER BY mi.product_id, mi.ordered_at ASC, mi.order_id, mi.order_item_id
  `, [Number(orderId)]);
  return rows;
}

async function orderProcurementMissingItemsMysql(orderId) {
  return await mysqlQuery(`
    SELECT oi.id AS order_item_id, oi.order_id, oi.ozon_sku, oi.ozon_name,
      op.id AS online_product_id, op.ozon_product_id, op.name AS online_product_name,
      COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, '')) AS image_url
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    WHERE oi.order_id = ? AND p.id IS NULL
    ORDER BY oi.id
  `, [Number(orderId)]);
}

function summarizeOrderProcurementCandidatesMysql(rows = [], missingItems = []) {
  const grouped = new Map();
  for (const row of rows) {
    const productId = Number(row.product_id || 0);
    if (!grouped.has(productId)) {
      grouped.set(productId, {
        product_id: productId,
        product_name: row.product_name || "",
        product_code: row.product_code || "",
        purchase_url: row.purchase_url || "",
        source_type: row.source_platform || "1688",
        supplier_id: row.supplier_id || null,
        total_quantity: 0,
        ledger_stock: Number(row.current_stock || 0),
        current_stock: Math.max(0, Number(row.current_stock || 0)),
        stock_debt: Math.max(0, -Number(row.current_stock || 0)),
        incoming_stock: Number(row.incoming_stock || 0),
        shortage_quantity: 0,
        order_count: 0,
        sku_count: 0,
        estimated_amount: 0,
        estimated_shipping: 0,
        orders: new Set(),
        skus: new Set(),
        items: []
      });
    }
    const target = grouped.get(productId);
    const quantity = Math.max(1, Number(row.quantity || 1));
    target.total_quantity += quantity;
    target.estimated_amount += Number(row.purchase_cost || 0) * quantity;
    target.estimated_shipping += Number(row.domestic_shipping || 0) * quantity;
    target.orders.add(Number(row.order_id));
    target.skus.add(String(row.ozon_sku || ""));
    target.items.push({
      order_item_id: Number(row.order_item_id),
      order_id: Number(row.order_id),
      posting_number: row.posting_number || row.order_number || "",
      ordered_at: row.ordered_at || "",
      ozon_sku: row.ozon_sku || "",
      ozon_name: row.ozon_name || "",
      image_url: row.image_url || row.product_image_url || "",
      quantity,
      sale_amount: roundMoneyMysql(Number(row.sale_price || 0) * quantity)
    });
  }
  for (const item of grouped.values()) {
    item.shortage_quantity = Math.max(0, Number(item.total_quantity || 0) - Number(item.current_stock || 0) - Number(item.incoming_stock || 0));
  }
  return {
    ok: true,
    purchasable_count: rows.length,
    total_quantity: rows.reduce((sum, row) => sum + Math.max(1, Number(row.quantity || 1)), 0),
    product_count: grouped.size,
    missing_count: missingItems.length,
    products: [...grouped.values()].map((item) => ({
      ...item,
      order_count: item.orders.size,
      sku_count: item.skus.size,
      estimated_amount: roundMoneyMysql(item.estimated_amount),
      estimated_shipping: roundMoneyMysql(item.estimated_shipping),
      ledger_stock: roundMoneyMysql(item.ledger_stock),
      current_stock: roundMoneyMysql(item.current_stock),
      stock_debt: roundMoneyMysql(item.stock_debt),
      incoming_stock: roundMoneyMysql(item.incoming_stock),
      shortage_quantity: roundMoneyMysql(item.shortage_quantity),
      orders: undefined,
      skus: [...item.skus].filter(Boolean)
    })),
    missing_items: missingItems.map((item) => ({
      order_item_id: Number(item.order_item_id),
      order_id: Number(item.order_id),
      ozon_sku: item.ozon_sku || "",
      ozon_name: item.ozon_name || item.online_product_name || "",
      online_product_id: Number(item.online_product_id || 0) || null,
      ozon_product_id: item.ozon_product_id || "",
      image_url: item.image_url || ""
    }))
  };
}

export async function previewOrderProcurementMysql(orderId) {
  ensureMysqlCutoverEnabled();
  await ensureProcurementOrderSourceSchemaMysql();
  const [rows, missingItems] = await Promise.all([
    orderProcurementCandidateRowsMysql(orderId),
    orderProcurementMissingItemsMysql(orderId)
  ]);
  return summarizeOrderProcurementCandidatesMysql(rows, missingItems);
}

export async function createOrderProcurementRequestsMysql(orderId, body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  await ensureProcurementOrderSourceSchemaMysql();
  return await withMysqlTransaction(async (connection) => {
    const selectedIds = Array.isArray(body.order_item_ids)
      ? new Set(body.order_item_ids.map(Number).filter(Boolean))
      : null;
    const rows = (await orderProcurementCandidateRowsMysql(orderId, connection))
      .filter((row) => !selectedIds || selectedIds.has(Number(row.order_item_id)));
    const missingItems = await orderProcurementMissingItemsMysql(orderId);
    const summary = summarizeOrderProcurementCandidatesMysql(rows, missingItems);
    if (!rows.length) {
      return { ...summary, created_count: 0, stock_satisfied_count: 0, marked_count: 0, request_ids: [] };
    }
    const personId = await resolvePersonIdOrFirstMysql(body.person_id || userId, connection);
    const purchaseOverrides = new Map((Array.isArray(body.product_purchases) ? body.product_purchases : [])
      .map((item) => [Number(item.product_id || 0), item])
      .filter(([productId]) => productId));
    const requestIds = [];
    let stockSatisfiedCount = 0;
    let markedCount = 0;
    const remainingStockByProduct = new Map();
    const createdRequestProductIds = new Set();
    const sortedRows = [...rows].sort((a, b) => {
      const productDiff = Number(a.product_id || 0) - Number(b.product_id || 0);
      if (productDiff) return productDiff;
      return String(a.ordered_at || "").localeCompare(String(b.ordered_at || ""))
        || Number(a.order_id || 0) - Number(b.order_id || 0)
        || Number(a.order_item_id || 0) - Number(b.order_item_id || 0);
    });
    for (const row of sortedRows) {
      const quantity = Math.max(1, Number(row.quantity || 1));
      const productId = Number(row.product_id);
      if (!remainingStockByProduct.has(productId)) {
        remainingStockByProduct.set(productId, Math.max(0, Number(row.current_stock || 0)));
      }
      const remainingStock = Number(remainingStockByProduct.get(productId) || 0);
      let handlingType = "stock_available";
      let note = `库存可满足：${row.posting_number || row.order_number || row.order_id} / SKU ${row.ozon_sku || ""}`;
      const override = purchaseOverrides.get(productId);
      const overrideQuantity = Math.max(0, Number(override?.quantity || 0));
      if (override && overrideQuantity <= 0) {
        handlingType = "stock_available";
        note = `无需采购，已确认处理：${row.posting_number || row.order_number || row.order_id} / SKU ${row.ozon_sku || ""}`;
        stockSatisfiedCount += 1;
      } else if (overrideQuantity > 0 && !createdRequestProductIds.has(productId)) {
        handlingType = "procurement_request";
        note = `订单采购：${row.posting_number || row.order_number || row.order_id} / SKU ${row.ozon_sku || ""}`;
        const [result] = await connection.execute(`
          INSERT INTO procurement_requests
          (product_id, person_id, quantity, amount, shipping_amount, purchase_url, approval_status, status, needed_by, note, urgency, source_type, supplier_id, source_order_id, source_order_item_id, source_ozon_sku)
          VALUES (?, ?, ?, ?, ?, ?, 'submitted', 'submitted', NULL, ?, ?, ?, ?, ?, ?, ?)
        `, [
          productId,
          personId,
          overrideQuantity,
          Number(override?.amount || 0),
          Number(override?.shipping_amount || 0),
          row.purchase_url || "",
          `订单采购：${rows.filter((item) => Number(item.product_id) === productId).length} 条关联订单 / ${row.product_name || row.ozon_sku || productId}`,
          body.urgency || "normal",
          row.source_platform || "1688",
          nullableInteger(row.supplier_id),
          Number(row.order_id),
          Number(row.order_item_id),
          row.ozon_sku || null
        ]);
        requestIds.push(Number(result.insertId));
        createdRequestProductIds.add(productId);
      } else if (createdRequestProductIds.has(productId)) {
        handlingType = "procurement_request";
        note = `订单采购已合并：${row.posting_number || row.order_number || row.order_id} / SKU ${row.ozon_sku || ""}`;
      } else if (remainingStock >= quantity) {
        remainingStockByProduct.set(productId, remainingStock - quantity);
        stockSatisfiedCount += 1;
      } else {
        const requestQuantity = Math.max(1, quantity - Math.max(0, remainingStock));
        remainingStockByProduct.set(productId, 0);
        handlingType = "procurement_request";
        note = `订单采购：${row.posting_number || row.order_number || row.order_id} / SKU ${row.ozon_sku || ""}`;
        const [result] = await connection.execute(`
          INSERT INTO procurement_requests
          (product_id, person_id, quantity, amount, shipping_amount, purchase_url, approval_status, status, needed_by, note, urgency, source_type, supplier_id, source_order_id, source_order_item_id, source_ozon_sku)
          VALUES (?, ?, ?, ?, ?, ?, 'submitted', 'submitted', NULL, ?, ?, ?, ?, ?, ?, ?)
        `, [
          productId,
          personId,
          requestQuantity,
          Number(row.purchase_cost || 0) * requestQuantity,
          Number(row.domestic_shipping || 0) * requestQuantity,
          row.purchase_url || "",
          note,
          body.urgency || "normal",
          row.source_platform || "1688",
          nullableInteger(row.supplier_id),
          Number(row.order_id),
          Number(row.order_item_id),
          row.ozon_sku || null
        ]);
        requestIds.push(Number(result.insertId));
      }
      await connection.execute(`
        INSERT INTO order_item_procurement_marks
        (order_item_id, order_id, product_id, status, handling_type, note, created_by_person_id)
        VALUES (?, ?, ?, 'handled', ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          product_id = VALUES(product_id),
          status = VALUES(status),
          handling_type = VALUES(handling_type),
          note = VALUES(note),
          created_by_person_id = VALUES(created_by_person_id),
          updated_at = CURRENT_TIMESTAMP
      `, [Number(row.order_item_id), Number(row.order_id), productId, handlingType, note, personId]);
      markedCount += 1;
    }
    return {
      ...summary,
      created_count: requestIds.length,
      stock_satisfied_count: stockSatisfiedCount,
      marked_count: markedCount,
      request_ids: requestIds
    };
  });
}

export async function updateProcurementRequestMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProcurementRequestTimestampSchemaMysql();
  const requestId = Number(id);
  return await withMysqlTransaction(async (connection) => {
    const existing = await mysqlConnectionQueryOne(connection, "SELECT * FROM procurement_requests WHERE id = ? FOR UPDATE", [requestId]);
    if (!existing) throw new Error("Procurement request not found");
    assertFreshRecord(body, existing, "采购请求已被其他用户保存，请刷新后再继续编辑");
    const existingStatus = String(existing.status || "");
    let canRefreshMergedOrderItems = false;
    if (existingStatus === "merged") {
      const orderId = Number(existing.purchase_order_id || 0);
      if (!orderId) throw new Error("Merged procurement request is missing its purchase order");
      const order = await mysqlConnectionQueryOne(connection, "SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE", [orderId]);
      if (!order) throw new Error("Purchase order not found");
      canRefreshMergedOrderItems = String(order.status || "") === "pending_purchase";
    }

    const nextStatus = body.status || existing.status || "pending";
    const nextApprovalStatus = body.approval_status || existing.approval_status || nextStatus || "pending";
    const personId = await resolvePersonIdOrFirstMysql(body.person_id ?? existing.person_id, connection);
    const nextProductId = Number(body.product_id ?? existing.product_id);
    const nextQuantity = Number(body.quantity ?? existing.quantity ?? 1);
    const nextAmount = Number(body.amount ?? existing.amount ?? 0);
    const nextShippingAmount = Number(body.shipping_amount ?? existing.shipping_amount ?? 0);
    const nextPurchaseUrl = body.purchase_url ?? existing.purchase_url ?? "";
    const nextNeededBy = body.needed_by ?? existing.needed_by ?? null;
    const nextNote = body.note ?? existing.note ?? "";
    const nextUrgency = body.urgency ?? existing.urgency ?? "normal";
    const nextSourceType = body.source_type ?? existing.source_type ?? "1688";
    const nextSupplierId = body.supplier_id !== undefined ? nullableInteger(body.supplier_id) : nullableInteger(existing.supplier_id);

    await connection.execute(`
      UPDATE procurement_requests SET product_id = ?, person_id = ?, quantity = ?, amount = ?,
        shipping_amount = ?, purchase_url = ?, approval_status = ?, status = ?, needed_by = ?, note = ?, urgency = ?, source_type = ?, supplier_id = ?,
        cancelled_at = CASE
          WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, CURRENT_TIMESTAMP)
          WHEN COALESCE(status, '') = 'cancelled' AND ? != 'cancelled' THEN NULL
          ELSE cancelled_at
        END
      WHERE id = ?
    `, [
      nextProductId,
      personId,
      nextQuantity,
      nextAmount,
      nextShippingAmount,
      nextPurchaseUrl,
      nextApprovalStatus,
      nextStatus,
      nextNeededBy,
      nextNote,
      nextUrgency,
      nextSourceType,
      nextSupplierId,
      nextStatus,
      nextStatus,
      requestId
    ]);

    if (existingStatus === "merged" && canRefreshMergedOrderItems) {
      const orderId = Number(existing.purchase_order_id || 0);
      const affectedProductIds = [...new Set([Number(existing.product_id || 0), nextProductId].filter(Boolean))];
      await refreshPurchaseOrderItemsFromMergedRequestsMysql(connection, orderId, affectedProductIds);
    } else if (Number(existing.purchase_order_id || 0)) {
      const orderId = Number(existing.purchase_order_id || 0);
      const affectedProductIds = [...new Set([Number(existing.product_id || 0), nextProductId].filter(Boolean))];
      for (const productId of affectedProductIds) {
        await syncFinalizedPurchaseFactsFromProcurementRequestsMysql(connection, orderId, productId);
      }
    }

    return { ok: true };
  });
}

async function syncFinalizedPurchaseFactsFromProcurementRequestsMysql(connection, orderId, productId) {
  const normalizedOrderId = Number(orderId || 0);
  const normalizedProductId = Number(productId || 0);
  if (!normalizedOrderId || !normalizedProductId) return false;

  const order = await mysqlConnectionQueryOne(connection, "SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE", [normalizedOrderId]);
  if (!order || ["pending_purchase", "cancelled"].includes(String(order.status || ""))) return false;

  const item = await mysqlConnectionQueryOne(connection, `
    SELECT *
    FROM purchase_order_items
    WHERE purchase_order_id = ? AND product_id = ?
    FOR UPDATE
  `, [normalizedOrderId, normalizedProductId]);
  if (!item) return false;

  const summary = await mysqlConnectionQueryOne(connection, `
    SELECT
      COALESCE(SUM(quantity), 0) AS quantity,
      COALESCE(SUM(amount), 0) AS amount,
      COALESCE(SUM(shipping_amount), 0) AS shipping_amount,
      MAX(NULLIF(purchase_url, '')) AS purchase_url,
      GROUP_CONCAT(NULLIF(note, '') SEPARATOR '; ') AS note
    FROM procurement_requests
    WHERE purchase_order_id = ?
      AND product_id = ?
      AND status NOT IN ('cancelled')
  `, [normalizedOrderId, normalizedProductId]);
  const quantity = Math.max(0, Number(summary?.quantity || 0));
  const amount = Number(summary?.amount || 0);
  const shippingAmount = Number(summary?.shipping_amount || 0);
  const unitCost = quantity ? (amount + shippingAmount) / quantity : 0;
  const purchaseUrl = summary?.purchase_url || item.purchase_url || "";
  const note = summary?.note || item.note || "";

  await connection.execute(`
    UPDATE purchase_order_items
    SET requested_quantity = ?, actual_quantity = ?, inbound_quantity = ?,
      unit_cost = ?, amount = ?, shipping_amount = ?, purchase_url = ?, note = ?,
      status = CASE
        WHEN ? > 0 AND inbound_quantity >= actual_quantity THEN 'inbound_done'
        WHEN inbound_quantity > 0 THEN 'partial_inbound'
        ELSE status
      END
    WHERE id = ?
  `, [
    quantity,
    quantity,
    String(item.status || "") === "inbound_done" ? quantity : Math.min(Number(item.inbound_quantity || 0), quantity),
    unitCost,
    amount,
    shippingAmount,
    purchaseUrl,
    note,
    quantity,
    Number(item.id)
  ]);

  const inboundRows = await mysqlConnectionQuery(connection, `
    SELECT *
    FROM inbound_records
    WHERE purchase_order_item_id = ?
    ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END, id ASC
    FOR UPDATE
  `, [Number(item.id)]);
  if (inboundRows.length === 1) {
    const inbound = inboundRows[0];
    await connection.execute(`
      UPDATE inbound_records
      SET quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?, purchase_url = ?, note = ?
      WHERE id = ?
    `, [quantity, amount, shippingAmount, unitCost, purchaseUrl, note, Number(inbound.id)]);
    if (String(inbound.status || "") === "approved") {
      await upsertInboundInventoryMovementMysql(connection, Number(inbound.id), {
        product_id: normalizedProductId,
        owner_person_id: inbound.person_id,
        quantity,
        unitCost,
        amount: amount + shippingAmount,
        note
      });
    }
  }

  const orderSummary = await mysqlConnectionQueryOne(connection, `
    SELECT
      COALESCE(SUM(actual_quantity), 0) AS total_quantity,
      COALESCE(SUM(amount + shipping_amount), 0) AS total_amount
    FROM purchase_order_items
    WHERE purchase_order_id = ?
  `, [normalizedOrderId]);
  await connection.execute(`
    UPDATE purchase_orders
    SET total_quantity = ?, total_amount = ?
    WHERE id = ?
  `, [Number(orderSummary?.total_quantity || 0), Number(orderSummary?.total_amount || 0), normalizedOrderId]);
  await refreshPurchaseOrderStatusMysql(connection, normalizedOrderId);
  return true;
}

async function refreshPurchaseOrderItemsFromMergedRequestsMysql(connection, orderId, productIds = []) {
  const normalizedOrderId = Number(orderId || 0);
  const ids = [...new Set(productIds.map((item) => Number(item || 0)).filter(Boolean))];
  if (!normalizedOrderId || !ids.length) return;
  const placeholders = ids.map(() => "?").join(",");

  const groupedRows = await mysqlConnectionQuery(connection, `
    SELECT
      product_id,
      COALESCE(SUM(quantity), 0) AS requested_quantity,
      COALESCE(SUM(amount), 0) AS amount,
      COALESCE(SUM(shipping_amount), 0) AS shipping_amount,
      MAX(NULLIF(purchase_url, '')) AS purchase_url,
      GROUP_CONCAT(NULLIF(note, '') SEPARATOR '; ') AS note
    FROM procurement_requests
    WHERE purchase_order_id = ?
      AND status = 'merged'
      AND product_id IN (${placeholders})
    GROUP BY product_id
  `, [normalizedOrderId, ...ids]);
  const groupedByProductId = new Map(groupedRows.map((row) => [Number(row.product_id || 0), row]));

  const existingItems = await mysqlConnectionQuery(connection, `
    SELECT *
    FROM purchase_order_items
    WHERE purchase_order_id = ?
      AND product_id IN (${placeholders})
    FOR UPDATE
  `, [normalizedOrderId, ...ids]);
  const existingByProductId = new Map(existingItems.map((row) => [Number(row.product_id || 0), row]));

  for (const productId of ids) {
    const summary = groupedByProductId.get(productId);
    const existingItem = existingByProductId.get(productId);
    if (!summary) {
      if (existingItem) {
        await connection.execute("DELETE FROM purchase_order_items WHERE id = ?", [Number(existingItem.id)]);
      }
      continue;
    }
    const requestedQuantity = Number(summary.requested_quantity || 0);
    const amount = Number(summary.amount || 0);
    const shippingAmount = Number(summary.shipping_amount || 0);
    const unitCost = requestedQuantity ? (amount + shippingAmount) / requestedQuantity : 0;
    const purchaseUrl = summary.purchase_url || existingItem?.purchase_url || "";
    const note = summary.note || existingItem?.note || "";
    if (existingItem) {
      await connection.execute(`
        UPDATE purchase_order_items
        SET requested_quantity = ?, actual_quantity = ?, unit_cost = ?, amount = ?, shipping_amount = ?, purchase_url = ?, note = ?
        WHERE id = ?
      `, [requestedQuantity, requestedQuantity, unitCost, amount, shippingAmount, purchaseUrl, note, Number(existingItem.id)]);
    } else {
      await connection.execute(`
        INSERT INTO purchase_order_items
        (purchase_order_id, product_id, requested_quantity, actual_quantity, unit_cost, amount, shipping_amount, purchase_url, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_purchase', ?)
      `, [normalizedOrderId, productId, requestedQuantity, requestedQuantity, unitCost, amount, shippingAmount, purchaseUrl, note]);
    }
  }

  const totals = await mysqlConnectionQueryOne(connection, `
    SELECT
      COUNT(*) AS item_count,
      COALESCE(SUM(actual_quantity), 0) AS total_quantity,
      COALESCE(SUM(amount + shipping_amount), 0) AS total_amount
    FROM purchase_order_items
    WHERE purchase_order_id = ?
  `, [normalizedOrderId]);

  if (Number(totals?.item_count || 0) <= 0) {
    await connection.execute("DELETE FROM purchase_orders WHERE id = ?", [normalizedOrderId]);
    return;
  }

  await connection.execute(`
    UPDATE purchase_orders
    SET total_quantity = ?, total_amount = ?
    WHERE id = ?
  `, [Number(totals?.total_quantity || 0), Number(totals?.total_amount || 0), normalizedOrderId]);
}

export async function submitProcurementRequestsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProcurementRequestTimestampSchemaMysql();
  const ids = [...new Set((body.request_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error("Please select procurement requests to submit");
  const placeholders = ids.map(() => "?").join(",");
  const existing = await mysqlQuery(`SELECT id, status FROM procurement_requests WHERE id IN (${placeholders})`, ids);
  if (existing.length !== ids.length) throw new Error("Some procurement requests no longer exist. Please refresh and try again.");
  const invalid = existing.filter((row) => String(row.status || "") !== "pending");
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
  return await withMysqlTransaction(async (connection) => {
    const request = await mysqlConnectionQueryOne(connection, "SELECT * FROM procurement_requests WHERE id = ? FOR UPDATE", [requestId]);
    if (!request) throw new Error("Procurement request not found");
    const status = String(request.status || "");

    const hasOrder = Number(request.purchase_order_id || 0) > 0;
    if (hasOrder) {
      await rollbackProcurementMergedInboundMysql(connection, request);
      await connection.execute("DELETE FROM procurement_requests WHERE id = ?", [requestId]);
      return { ok: true };
    }

    if (["done", "purchased", "approved", "partial_inbound", "inbound_done"].includes(status)) {
      await rollbackProcurementDirectInboundMysql(connection, request);
    }

    await connection.execute("DELETE FROM procurement_requests WHERE id = ?", [requestId]);
    return { ok: true };
  });
}

export async function directInboundProcurementRequestsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProcurementRequestTimestampSchemaMysql();
  const ids = [...new Set((body.request_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error("Please select procurement requests to inbound");
  return await withMysqlTransaction(async (connection) => {
    const placeholders = ids.map(() => "?").join(",");
    const requests = await mysqlConnectionQuery(connection, `
      SELECT *
      FROM procurement_requests
      WHERE id IN (${placeholders})
      FOR UPDATE
    `, ids);
    if (requests.length !== ids.length) throw new Error("Some procurement requests no longer exist. Please refresh and try again.");
    const invalid = requests.filter((row) => ["done", "cancelled"].includes(String(row.status || "")));
    if (invalid.length) throw new Error("Only open procurement requests can be directly inbounded");
    const inboundIds = [];
    for (const request of requests) {
      const quantity = Math.max(0, Number(request.quantity || 0));
      const amount = Number(request.amount || 0);
      const shippingAmount = Number(request.shipping_amount || 0);
      const unitCost = quantity ? (amount + shippingAmount) / quantity : 0;
      const personId = await resolvePersonIdOrFirstMysql(request.person_id, connection);
      const [result] = await connection.execute(`
        INSERT INTO inbound_records
        (product_id, person_id, quantity, amount, unit_cost, shipping_amount, purchase_url, status, note, approved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
      `, [
        Number(request.product_id),
        personId,
        quantity,
        amount,
        unitCost,
        shippingAmount,
        request.purchase_url || "",
        request.note || `采购请求 #${request.id} 直接入库`,
        normalizeMysqlDateTime(new Date())
      ]);
      const inboundId = Number(result.insertId);
      inboundIds.push(inboundId);
      await postInventoryMysql(connection, {
        product_id: request.product_id,
        owner_person_id: personId,
        source_type: "purchase_inbound",
        source_ref: `inbound_${inboundId}`,
        quantity_delta: quantity,
        unit_cost: unitCost,
        amount: amount + shippingAmount,
        note: request.note || `采购请求 #${request.id} 直接入库`
      });
      await connection.execute(`
        UPDATE procurement_requests
        SET status = 'done',
          approval_status = 'done',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [Number(request.id)]);
      if (request.purchase_order_id) {
        await refreshPurchaseOrderStatusMysql(connection, request.purchase_order_id);
      }
    }
    return { ok: true, count: inboundIds.length, inbound_ids: inboundIds, request_ids: ids };
  });
}

export async function mergeProcurementRequestsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const ids = [...new Set((body.request_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error("Please select procurement requests to merge");
  const placeholders = ids.map(() => "?").join(",");
  return await withMysqlTransaction(async (connection) => {
    const [requests] = await connection.query(`
      SELECT * FROM procurement_requests
      WHERE id IN (${placeholders}) AND status IN ('pending', 'submitted')
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

export function startConfirmProcurementRequestsPurchasedMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const requestIds = [...new Set((body.request_ids || []).map(Number).filter(Boolean))];
  if (!requestIds.length) throw new Error("Please select procurement requests to merge");
  const queuedBody = { ...body, request_ids: requestIds };
  setTimeout(async () => {
    try {
      const result = await mergeProcurementRequestsMysql(queuedBody);
      if (result?.id) await confirmPurchaseOrderMysql(result.id, queuedBody);
    } catch (error) {
      console.error("[procurement] async purchase confirmation failed", error);
    }
  }, 0);
  return { ok: true, accepted: true, count: requestIds.length };
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

async function applyInboundRecordUpdateMysql(connection, id, body = {}, options = {}) {
  const inboundId = Number(id);
  const existing = await mysqlConnectionQueryOne(connection, "SELECT * FROM inbound_records WHERE id = ? FOR UPDATE", [inboundId]);
  if (!existing) throw new Error("Inbound record not found");
  assertFreshRecord(body, existing, "入库记录已被其他用户保存，请刷新后再继续编辑");
  const productId = Number(body.product_id ?? existing.product_id);
  const personId = await resolvePersonIdOrFirstMysql(body.person_id ?? existing.person_id, connection);
  const quantity = Number(body.quantity ?? existing.quantity ?? 0);
  const amount = Number(body.amount ?? existing.amount ?? 0);
  const shippingAmount = Number(body.shipping_amount ?? existing.shipping_amount ?? 0);
  const unitCost = quantity ? (amount + shippingAmount) / quantity : Number(body.unit_cost ?? existing.unit_cost ?? 0);
  const status = body.status || "pending_arrival";
  const markPurchaseOrderChanged = async () => {
    if (!existing.purchase_order_id) return;
    if (options.changedPurchaseOrderIds) {
      options.changedPurchaseOrderIds.add(Number(existing.purchase_order_id));
      return;
    }
    await refreshPurchaseOrderStatusMysql(connection, existing.purchase_order_id);
  };

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
      await markPurchaseOrderChanged();
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
      await markPurchaseOrderChanged();
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
      await markPurchaseOrderChanged();
    }
  }
  return { ok: true };
}

export async function updateInboundRecordMysql(id, body = {}) {
  ensureMysqlCutoverEnabled();
  return await withMysqlTransaction(async (connection) => {
    return await applyInboundRecordUpdateMysql(connection, id, body);
  });
}

export async function batchUpdateInboundRecordsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const records = Array.isArray(body.records) ? body.records : [];
  if (!records.length) throw new Error("Please select inbound records to update");
  return await withMysqlTransaction(async (connection) => {
    const changedPurchaseOrderIds = new Set();
    const ids = [];
    for (const record of records) {
      const inboundId = Number(record.id ?? record.inbound_record_id);
      if (!inboundId) continue;
      const payload = record.payload && typeof record.payload === "object" ? record.payload : record;
      await applyInboundRecordUpdateMysql(connection, inboundId, payload, { changedPurchaseOrderIds });
      ids.push(inboundId);
    }
    for (const orderId of changedPurchaseOrderIds) {
      await refreshPurchaseOrderStatusMysql(connection, orderId);
    }
    return { ok: true, count: ids.length, ids };
  });
}

export function startBatchUpdateInboundRecordsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const records = Array.isArray(body.records) ? body.records : [];
  if (!records.length) throw new Error("Please select inbound records to update");
  const queuedRecords = records.map((record) => ({
    id: record.id ?? record.inbound_record_id,
    payload: record.payload && typeof record.payload === "object" ? { ...record.payload } : { ...record }
  }));
  setTimeout(() => {
    batchUpdateInboundRecordsMysql({ records: queuedRecords }).catch((error) => {
      console.error("[procurement] async inbound batch update failed", error);
    });
  }, 0);
  return { ok: true, accepted: true, count: queuedRecords.length };
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

export async function createInventoryMovementMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  return await withMysqlTransaction(async (connection) => {
    const sourceType = String(body.source_type || body.sourceType || "").trim();
    const isManualOutbound = sourceType === "manual_outbound";
    const quantity = Number(body.quantity ?? body.quantity_delta ?? 0);
    const productId = Number(body.product_id || body.productId || 0);
    if (isManualOutbound && (!productId || quantity <= 0)) {
      throw new Error("手动出库需要选择库存产品并填写大于 0 的出库数量");
    }
    const payload = isManualOutbound ? {
      ...body,
      product_id: productId,
      source_type: "manual_outbound",
      source_ref: body.source_ref || `manual_outbound_${productId}_${Date.now()}`,
      quantity_delta: -Math.abs(quantity),
      amount: Number(body.amount ?? body.loss_amount ?? 0),
      movement_type: "ORDER_SHIPPED",
      stock_location: normalizeStockLocationMysql(body.stock_location || "LOCAL"),
      stock_location_source: body.stock_location_source || "manual",
      note: body.note || body.reason || "手动出库",
      operator: userId ? String(userId) : (body.operator || "manual_outbound")
    } : body;
    const id = await postInventoryMysql(connection, payload);
    return { id };
  });
}

export async function updateInventoryMovementMysql(id, body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const movementId = Number(id || 0);
  if (!movementId) throw new Error("缺少库存流水 ID");
  return await withMysqlTransaction(async (connection) => {
    const existing = await mysqlConnectionQueryOne(connection, "SELECT * FROM inventory_movements WHERE id = ? FOR UPDATE", [movementId]);
    if (!existing) throw new Error("库存流水不存在");
    if (String(existing.source_type || "") !== "manual_outbound") throw new Error("只能编辑手动出库记录");
    const quantity = Math.round(Number(body.quantity ?? body.quantity_delta ?? Math.abs(Number(existing.quantity_delta || 0))));
    if (quantity <= 0) throw new Error("请输入大于 0 的出库数量");
    const stockLocation = normalizeStockLocationMysql(body.stock_location || existing.stock_location || "LOCAL");
    const amount = Number(body.amount ?? body.loss_amount ?? existing.amount ?? 0);
    const operator = userId ? String(userId) : String(body.operator || existing.operator || "manual_outbound");
    await connection.execute(`
      UPDATE inventory_movements
      SET quantity_delta = ?,
        stock_location = ?,
        stock_location_source = 'manual',
        amount = ?,
        note = ?,
        movement_type = 'ORDER_SHIPPED',
        status = 'posted',
        operator = ?
      WHERE id = ?
    `, [
      -Math.abs(quantity),
      stockLocation,
      amount,
      body.note || existing.note || "手动出库",
      operator,
      movementId
    ]);
    await rebuildInventoryCurrentForProductMysql(connection, Number(existing.product_id));
    return { ok: true, id: movementId };
  });
}

export async function deleteInventoryMovementMysql(id, userId = null) {
  ensureMysqlCutoverEnabled();
  const movementId = Number(id || 0);
  if (!movementId) throw new Error("缺少库存流水 ID");
  return await withMysqlTransaction(async (connection) => {
    const existing = await mysqlConnectionQueryOne(connection, "SELECT * FROM inventory_movements WHERE id = ? FOR UPDATE", [movementId]);
    if (!existing) return { ok: true, deleted: false };
    if (String(existing.source_type || "") !== "manual_outbound") throw new Error("只能删除手动出库记录");
    await connection.execute("DELETE FROM inventory_movements WHERE id = ?", [movementId]);
    await rebuildInventoryCurrentForProductMysql(connection, Number(existing.product_id));
    return { ok: true, deleted: true, operator: userId ? String(userId) : "" };
  });
}

export async function inventoryStockDebtsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const search = String(query.search || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  const where = ["stock.ledger_stock < 0"];
  const params = [];
  if (search) {
    where.push("LOWER(CONCAT(COALESCE(p.code, ''), ' ', COALESCE(p.name, ''), ' ', COALESCE(skus.skus, ''))) LIKE ?");
    params.push(`%${search}%`);
  }
  params.push(limit);
  const rows = await mysqlQuery(`
    SELECT
      p.id AS product_id,
      p.code AS product_code,
      p.name AS product_name,
      stock.ledger_stock,
      ABS(stock.ledger_stock) AS stock_debt,
      COALESCE(skus.skus, '') AS skus,
      COALESCE(outbound.last_outbound_at, '') AS last_outbound_at,
      COALESCE(outbound.outbound_count, 0) AS outbound_count
    FROM (
      SELECT product_id, COALESCE(SUM(quantity_delta), 0) AS ledger_stock
      FROM inventory_movements
      WHERE status = 'posted'
      GROUP BY product_id
    ) stock
    JOIN products p ON p.id = stock.product_id AND p.active = 1
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(DISTINCT ozon_sku ORDER BY ozon_sku SEPARATOR ',') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
    LEFT JOIN (
      SELECT product_id, MAX(created_at) AS last_outbound_at, COUNT(*) AS outbound_count
      FROM inventory_movements
      WHERE status = 'posted' AND source_type = 'order_outbound'
      GROUP BY product_id
    ) outbound ON outbound.product_id = p.id
    WHERE ${where.join(" AND ")}
    ORDER BY stock.ledger_stock ASC, p.id DESC
    LIMIT ?
  `, params);
  return {
    rows: rows.map((row) => ({
      product_id: Number(row.product_id),
      product_code: row.product_code || "",
      product_name: row.product_name || "",
      ledger_stock: roundMoneyMysql(row.ledger_stock),
      stock_debt: roundMoneyMysql(row.stock_debt),
      skus: String(row.skus || "").split(",").filter(Boolean),
      last_outbound_at: row.last_outbound_at ? new Date(row.last_outbound_at).toISOString() : "",
      outbound_count: Number(row.outbound_count || 0)
    }))
  };
}

export async function adjustInventoryStockDebtMysql(body = {}, userId = null) {
  ensureMysqlCutoverEnabled();
  const productId = Number(body.product_id || 0);
  if (!productId) throw new Error("product_id is required");
  return await withMysqlTransaction(async (connection) => {
    const product = await mysqlConnectionQueryOne(connection, "SELECT id, code, name FROM products WHERE id = ? AND active = 1 FOR UPDATE", [productId]);
    if (!product) throw new Error("Product not found");
    const stock = await mysqlConnectionQueryOne(connection, `
      SELECT COALESCE(SUM(quantity_delta), 0) AS ledger_stock
      FROM inventory_movements
      WHERE product_id = ? AND status = 'posted'
    `, [productId]);
    const ledgerStock = Number(stock?.ledger_stock || 0);
    const debt = Math.max(0, -ledgerStock);
    if (debt <= 0) return { ok: true, adjusted: false, product_id: productId, ledger_stock: roundMoneyMysql(ledgerStock), stock_debt: 0 };
    const requestedQuantity = Number(body.quantity || 0);
    const quantity = requestedQuantity > 0 ? Math.min(debt, requestedQuantity) : debt;
    const movementId = await postInventoryMysql(connection, {
      product_id: productId,
      owner_person_id: nullableInteger(body.owner_person_id || body.person_id || userId),
      source_type: "manual_adjustment",
      source_ref: body.source_ref || `stock_debt_adjust_${productId}_${Date.now()}`,
      quantity_delta: quantity,
      unit_cost: Number(body.unit_cost || 0),
      amount: Number(body.amount || 0),
      note: body.note || `历史负库存冲正：${product.code || productId} / ${product.name || ""}`,
      operator: body.operator || "stock_debt_adjustment"
    });
    await rebuildInventoryCurrentForProductMysql(connection, productId);
    return {
      ok: true,
      adjusted: true,
      movement_id: movementId,
      product_id: productId,
      quantity: roundMoneyMysql(quantity),
      ledger_stock_before: roundMoneyMysql(ledgerStock),
      ledger_stock_after: roundMoneyMysql(ledgerStock + quantity),
      stock_debt_before: roundMoneyMysql(debt),
      stock_debt_after: roundMoneyMysql(Math.max(0, -(ledgerStock + quantity)))
    };
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
  return profitDateExpressionWhereMysql(chinaDateSqlMysql(`${alias}.ordered_at`), from, to);
}

function shanghaiDateKeyToUtcDateTimeMysql(dateKey = "", addDays = 0) {
  const text = String(dateKey || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + Number(addDays || 0));
  return normalizeMysqlDateTime(date);
}

function profitOrderedAtUtcRangeMysql(alias = "o", from = "", to = "") {
  const where = [];
  const params = [];
  const fromUtc = shanghaiDateKeyToUtcDateTimeMysql(from, 0);
  const toUtcExclusive = shanghaiDateKeyToUtcDateTimeMysql(to, 1);
  if (fromUtc) {
    where.push(`${alias}.ordered_at >= ?`);
    params.push(fromUtc);
  }
  if (toUtcExclusive) {
    where.push(`${alias}.ordered_at < ?`);
    params.push(toUtcExclusive);
  }
  return {
    whereSql: where.length ? `AND ${where.join(" AND ")}` : "",
    params
  };
}

function profitDateExpressionWhereMysql(dateExpression, from = "", to = "") {
  const where = [];
  const params = [];
  if (from) {
    where.push(`${dateExpression} >= ?`);
    params.push(String(from).slice(0, 10));
  }
  if (to) {
    where.push(`${dateExpression} <= ?`);
    params.push(String(to).slice(0, 10));
  }
  return {
    whereSql: where.length ? `AND ${where.join(" AND ")}` : "",
    params
  };
}

function normalizeProfitSummaryMysql(row = {}) {
  const effectiveRevenue = Number(row.effective_revenue ?? row.revenue ?? 0);
  const totalRevenue = Number(row.total_revenue ?? effectiveRevenue);
  const profit = Number(row.profit || 0);
  const returnRevenue = Number(row.return_revenue || 0);
  return {
    order_count: Number(row.order_count || 0),
    item_quantity: Number(row.item_quantity || 0),
    revenue: roundMoneyMysql(effectiveRevenue),
    total_revenue: roundMoneyMysql(totalRevenue),
    effective_revenue: roundMoneyMysql(effectiveRevenue),
    profit: roundMoneyMysql(profit),
    estimated_profit: roundMoneyMysql(row.estimated_profit || profit),
    accrued_profit: roundMoneyMysql(row.accrued_profit || 0),
    accrued_order_count: Number(row.accrued_order_count || 0),
    pending_profit: roundMoneyMysql(row.pending_profit || 0),
    pending_order_count: Number(row.pending_order_count || 0),
    cancelled_revenue: roundMoneyMysql(row.cancelled_revenue || 0),
    cancelled_orders: Number(row.cancelled_orders || 0),
    cancelled_quantity: Number(row.cancelled_quantity || row.cancelled_orders || 0),
    return_orders: Number(row.return_orders || 0),
    return_quantity: Number(row.return_quantity || 0),
    return_revenue: roundMoneyMysql(returnRevenue),
    return_loss: roundMoneyMysql(row.return_loss || 0),
    event_cancelled_orders: Number(row.event_cancelled_orders || row.cancelled_orders || 0),
    event_return_orders: Number(row.event_return_orders || row.return_orders || 0),
    event_return_revenue: roundMoneyMysql(returnRevenue),
    effective_orders: Number(row.effective_orders ?? (Number(row.order_count || 0) - Number(row.cancelled_orders || 0))),
    profit_margin: effectiveRevenue ? profit / effectiveRevenue : 0
  };
}

async function profitSummaryOverviewMysql(from = "", to = "") {
  const cacheKey = `profit-dashboard:summary:${from || ""}:${to || ""}`;
  return getCachedMasterData(cacheKey, async () => buildProfitSummaryOverviewMysql(from, to), PROFIT_DASHBOARD_CACHE_TTL_MS);
}

async function buildProfitSummaryOverviewMysql(from = "", to = "") {
  const analyticsSummary = await buildProfitSummaryOverviewFromAnalyticsMysql(from, to);
  if (analyticsSummary) return analyticsSummary;
  return buildProfitSummaryOverviewFromOrdersMysql(from, to);
}

async function buildProfitSummaryOverviewFromAnalyticsMysql(from = "", to = "") {
  await ensureProfitAnalyticsSchemaMysql();
  const dateFilter = profitDateExpressionWhereMysql("date_key", from, to);
  const row = await mysqlQueryOne(`
    SELECT
      COUNT(*) AS snapshot_rows,
      COUNT(DISTINCT date_key) AS snapshot_days,
      COALESCE(SUM(order_count), 0) AS order_count,
      COALESCE(SUM(effective_orders), 0) AS effective_orders,
      COALESCE(SUM(item_quantity), 0) AS item_quantity,
      COALESCE(SUM(total_revenue), 0) AS total_revenue,
      COALESCE(SUM(revenue), 0) AS effective_revenue,
      COALESCE(SUM(current_profit), 0) AS profit,
      COALESCE(SUM(estimated_profit), 0) AS estimated_profit,
      COALESCE(SUM(accrued_profit), 0) AS accrued_profit,
      COALESCE(SUM(accrued_order_count), 0) AS accrued_order_count,
      COALESCE(SUM(pending_profit), 0) AS pending_profit,
      COALESCE(SUM(pending_order_count), 0) AS pending_order_count,
      COALESCE(SUM(cancelled_revenue), 0) AS cancelled_revenue,
      COALESCE(SUM(cancelled_orders), 0) AS cancelled_orders,
      COALESCE(SUM(cancelled_quantity), 0) AS cancelled_quantity,
      COALESCE(SUM(return_orders), 0) AS return_orders,
      COALESCE(SUM(return_quantity), 0) AS return_quantity,
      COALESCE(SUM(return_revenue), 0) AS return_revenue,
      COALESCE(SUM(return_loss), 0) AS return_loss,
      MAX(refreshed_at) AS refreshed_at
    FROM analytics_shop_daily
    WHERE 1=1 ${dateFilter.whereSql}
  `, dateFilter.params);
  if (!Number(row?.snapshot_rows || 0)) return null;
  const orderDateFilter = profitOrderedAtUtcRangeMysql("o", from, to);
  const coverage = await mysqlQueryOne(`
    SELECT COUNT(DISTINCT ${chinaDateSqlMysql("o.ordered_at")}) AS order_days
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE 1=1 ${orderDateFilter.whereSql}
  `, orderDateFilter.params);
  if (Number(coverage?.order_days || 0) > Number(row?.snapshot_days || 0)) return null;
  return {
    ...normalizeProfitSummaryMysql(row || {}),
    source: "analytics_shop_daily",
    snapshot_days: Number(row?.snapshot_days || 0),
    refreshed_at: row?.refreshed_at ? new Date(row.refreshed_at).toISOString() : ""
  };
}

async function buildProfitSummaryOverviewFromOrdersMysql(from = "", to = "") {
  const dateFilter = profitOrderedAtUtcRangeMysql("o", from, to);
  const outcome = buildOrderOutcomeSql("o", "mysql");
  const effectiveBusinessSale = `(${outcome.effectiveSale} AND NOT ${outcome.afterDeliveryReturn})`;
  const row = await mysqlQueryOne(`
    SELECT
      COUNT(DISTINCT o.id) AS order_count,
      COUNT(DISTINCT CASE WHEN ${effectiveBusinessSale} THEN o.id END) AS effective_orders,
      COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS total_revenue,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS effective_revenue,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0) ELSE 0 END), 0) AS profit,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} AND oi.settlement_state = 'accrued' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0) ELSE 0 END), 0) AS accrued_profit,
      COUNT(DISTINCT CASE WHEN ${effectiveBusinessSale} AND oi.settlement_state = 'accrued' THEN o.id END) AS accrued_order_count,
      COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} AND COALESCE(oi.settlement_state, '') != 'accrued' THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END), 0) AS pending_profit,
      COUNT(DISTINCT CASE WHEN ${effectiveBusinessSale} AND COALESCE(oi.settlement_state, '') != 'accrued' THEN o.id END) AS pending_order_count,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN ${outcome.cancelledPreFulfillment} THEN o.id END) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN oi.quantity ELSE 0 END), 0) AS cancelled_quantity,
      COUNT(DISTINCT CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN o.id END) AS return_orders,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS return_revenue,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.return_loss_cny, oi.aftersale_loss, 0) ELSE 0 END), 0) AS return_loss
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE 1=1 ${dateFilter.whereSql}
  `, dateFilter.params);
  return normalizeProfitSummaryMysql(row || {});
}

async function profitTrendRowsMysql(from, to, groupExpr, labelAlias = "date") {
  const cacheKey = `profit-dashboard:trend:${from || ""}:${to || ""}:${labelAlias}:${groupExpr}`;
  return getCachedMasterData(cacheKey, async () => buildProfitTrendRowsMysql(from, to, groupExpr, labelAlias), PROFIT_DASHBOARD_CACHE_TTL_MS);
}

async function buildProfitTrendRowsMysql(from, to, groupExpr, labelAlias = "date") {
  const dateFilter = profitOrderedAtUtcRangeMysql("o", from, to);
  const outcome = buildOrderOutcomeSql("o", "mysql");
  return await mysqlQuery(`
    SELECT ${groupExpr} AS ${labelAlias},
      COUNT(DISTINCT o.id) AS order_count,
      COUNT(DISTINCT CASE WHEN ${outcome.effectiveSale} THEN o.id END) AS effective_orders,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0) ELSE 0 END), 0) AS profit,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN ${outcome.cancelledPreFulfillment} THEN o.id END) AS cancelled_orders
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

function normalizeAftersaleRowMysql(row = {}, qualityPrefixes = []) {
  const accounting = classifyOrderAccounting(row, { qualityPrefixes });
  const outcomeType = accounting.outcome_type;
  const cancellation = describeCancellation({
    ...row,
    outcome_type: outcomeType,
    loss_profile_code: accounting.loss_profile_code
  });
  const bucket = accounting.aftersale_bucket;

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
    order_nature: accounting.order_nature,
    is_quality_order: accounting.is_quality_order ? 1 : 0,
    should_include_aftersale_loss: accounting.should_include_aftersale_loss ? 1 : 0,
    loss_profile_code: accounting.loss_profile_code,
    loss_profile_label: accounting.loss_profile_label,
    loss_formula_text: accounting.loss_formula_text,
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
  if (String(row.bucket || "") === "platform_document_issue") return true;
  if (Number(row.is_quality_order || 0) > 0) return false;
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
      COALESCE((SELECT mark_type FROM order_marks WHERE order_id = o.id), '') AS mark_type,
      oi.id AS order_item_id,
      oi.ozon_sku,
      oi.quantity,
      COALESCE(oi.ozon_name, op.name, op_by_product.name, p.name, oi.ozon_sku) AS item_name,
      COALESCE(
        NULLIF(oi.ozon_image_url, ''),
        NULLIF(op.primary_image, ''),
        NULLIF(op.image_url, ''),
        NULLIF(op_by_product.primary_image, ''),
        NULLIF(op_by_product.image_url, ''),
        NULLIF(p.image_url, ''),
        ''
      ) AS image_url,
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
    LEFT JOIN online_products op_by_product ON op_by_product.shop_id = o.shop_id AND op_by_product.ozon_product_id = oi.ozon_product_id
    WHERE ${where.join(" AND ")}
  `, params);
  return { rows, from, to, shopId };
}

export async function profitAftersalesMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const { rows, from, to, shopId } = await aftersaleBaseRowsMysql(query);
  const qualityPrefixes = await orderQualityPrefixesMysql();
  const normalized = rows.map((row) => normalizeAftersaleRowMysql(row, qualityPrefixes)).filter(aftersaleRelevantMysql);
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
  const qualityPrefixes = await orderQualityPrefixesMysql();
  const normalized = rows.map((row) => normalizeAftersaleRowMysql(row, qualityPrefixes)).filter(aftersaleRelevantMysql).filter((row) => bucketFilter === "all" || !bucketFilter || row.bucket === bucketFilter);
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
    const [
      todaySummary,
      yesterdaySummary,
      currentMonthSummary,
      lastMonthSummary,
      currentQuarterSummary,
      currentYearSummary
    ] = await Promise.all([
      profitSummaryOverviewMysql(today, today),
      profitSummaryOverviewMysql(yesterday, yesterday),
      profitSummaryOverviewMysql(currentMonthStart, today),
      profitSummaryOverviewMysql(lastMonthStart, lastMonthEnd),
      profitSummaryOverviewMysql(currentQuarterStart, today),
      profitSummaryOverviewMysql(currentYearStart, today)
    ]);
    const ranges = {
      today: { from: today, to: today, summary: todaySummary },
      yesterday: { from: yesterday, to: yesterday, summary: yesterdaySummary },
      currentMonth: { from: currentMonthStart, to: today, summary: currentMonthSummary },
      lastMonth: { from: lastMonthStart, to: lastMonthEnd, summary: lastMonthSummary },
      currentQuarter: { from: currentQuarterStart, to: today, summary: currentQuarterSummary },
      currentYear: { from: currentYearStart, to: today, summary: currentYearSummary }
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
  const fastMode = ["1", "true", "yes"].includes(String(query.fast || query.noCount || "").toLowerCase());
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
  let total = 0;
  let rows = [];
  if (fastMode) {
    const fastRows = await mysqlQuery(`${baseSql} ORDER BY ${orderField} ${sortOrder} LIMIT ? OFFSET ?`, [...params, pageSize + 1, offset]);
    const hasMore = fastRows.length > pageSize;
    rows = hasMore ? fastRows.slice(0, pageSize) : fastRows;
    total = offset + rows.length + (hasMore ? 1 : 0);
  } else {
    const [totalRow, resultRows] = await Promise.all([
      mysqlQueryOne(`SELECT COUNT(*) AS total FROM (${baseSql}) ranking_rows`, params),
      mysqlQuery(`${baseSql} ORDER BY ${orderField} ${sortOrder} LIMIT ? OFFSET ?`, [...params, pageSize, offset])
    ]);
    total = Number(totalRow?.total || 0);
    rows = resultRows;
  }
  return {
    dimension,
    rows: rows.map((row) => ({
      ...row,
      revenue: roundMoneyMysql(row.revenue),
      profit: roundMoneyMysql(row.profit),
      cancelled_revenue: roundMoneyMysql(row.cancelled_revenue),
      profit_margin: Number(row.revenue || 0) ? Number(row.profit || 0) / Number(row.revenue || 0) : 0
    })),
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
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

function emptyDashboardAdSummaryMysql(dateKey = "", reason = "no_data") {
  return {
    date_key: dateKey,
    data_available: false,
    reason,
    shop_count: 0,
    sku_count: 0,
    campaign_count: 0,
    abnormal_sku_count: 0,
    impressions: null,
    clicks: null,
    add_to_cart: null,
    orders: null,
    units: null,
    spend_cny: null,
    revenue_cny: null,
    roi: null,
    roas: null,
    acos: null,
    ctr: null,
    conversion_rate: null
  };
}

async function latestDashboardAdDateMysql(maxDateKey) {
  try {
    const row = await mysqlQueryOne(`
      SELECT MAX(date_key) AS date_key
      FROM ozon_ad_sku_daily
      WHERE date_key <= ?
    `, [maxDateKey]);
    return row?.date_key ? String(row.date_key).slice(0, 10) : "";
  } catch (error) {
    console.warn("[dashboard] latest ad date unavailable:", error.message);
    return "";
  }
}

function latestIsoDateTimeMysql(rows = [], key) {
  const latest = rows.reduce((max, item) => {
    const time = item?.[key] ? new Date(item[key]).getTime() : 0;
    return Number.isFinite(time) && time > max ? time : max;
  }, 0);
  return latest ? new Date(latest).toISOString() : "";
}

async function dashboardAdSummaryMysql(fromDateKey, toDateKey = fromDateKey) {
  const from = String(fromDateKey || toDateKey || todayDateKeyMysql()).slice(0, 10);
  const to = String(toDateKey || from).slice(0, 10);
  try {
    const dateFilter = profitOrderedAtUtcRangeMysql("o", from, to);
    const outcome = buildOrderOutcomeSql("o", "mysql");
    const effectiveBusinessSale = `(${outcome.effectiveSale} AND NOT ${outcome.afterDeliveryReturn})`;
    const rows = await mysqlQuery(`
      SELECT
        s.name AS shop_name,
        ad.shop_id,
        COUNT(*) AS row_count,
        COUNT(DISTINCT ad.ozon_sku) AS sku_count,
        COUNT(DISTINCT NULLIF(ad.campaign_id, '')) AS campaign_count,
        COALESCE(SUM(ad.impressions), 0) AS impressions,
        COALESCE(SUM(ad.clicks), 0) AS clicks,
        COALESCE(SUM(ad.add_to_cart), 0) AS add_to_cart,
        COALESCE(SUM(ad.orders), 0) AS orders,
        COALESCE(SUM(ad.units), 0) AS units,
        COALESCE(SUM(ad.spend_rub), 0) AS spend_rub,
        COALESCE(SUM(ad.spend_cny), 0) AS spend_cny,
        COALESCE(SUM(ad.revenue_rub), 0) AS revenue_rub,
        COALESCE(SUM(ad.revenue_cny), 0) AS revenue_cny,
        COALESCE(MAX(local.local_revenue_cny), 0) AS local_revenue_cny,
        MAX(ad.synced_at) AS last_synced_at,
        MAX(ad.updated_at) AS last_updated_at,
        SUM(CASE WHEN ad.spend_cny > 0 AND (ad.revenue_cny IS NULL OR ad.revenue_cny <= 0 OR ad.revenue_cny / ad.spend_cny < 1) THEN 1 ELSE 0 END) AS abnormal_sku_count
      FROM ozon_ad_sku_daily ad
      LEFT JOIN shops s ON s.id = ad.shop_id
      LEFT JOIN (
        SELECT
          o.shop_id,
          COALESCE(SUM(COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)), 0) AS local_revenue_cny
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
        JOIN (
          SELECT DISTINCT shop_id, ozon_sku
          FROM ozon_ad_sku_daily
          WHERE date_key >= ? AND date_key <= ?
            AND COALESCE(ozon_sku, '') != ''
        ) ad_sku ON ad_sku.shop_id = o.shop_id AND ad_sku.ozon_sku = oi.ozon_sku
        WHERE 1=1 ${dateFilter.whereSql}
          AND ${effectiveBusinessSale}
        GROUP BY o.shop_id
      ) local ON local.shop_id = ad.shop_id
      WHERE ad.date_key >= ? AND ad.date_key <= ?
      GROUP BY ad.shop_id, s.name
      ORDER BY spend_cny DESC
    `, [from, to, ...dateFilter.params, from, to]);
    const row = rows.reduce((acc, item) => ({
      row_count: Number(acc.row_count || 0) + Number(item.row_count || 0),
      shop_count: Number(acc.shop_count || 0) + 1,
      sku_count: Number(acc.sku_count || 0) + Number(item.sku_count || 0),
      campaign_count: Number(acc.campaign_count || 0) + Number(item.campaign_count || 0),
      abnormal_sku_count: Number(acc.abnormal_sku_count || 0) + Number(item.abnormal_sku_count || 0),
      impressions: Number(acc.impressions || 0) + Number(item.impressions || 0),
      clicks: Number(acc.clicks || 0) + Number(item.clicks || 0),
      add_to_cart: Number(acc.add_to_cart || 0) + Number(item.add_to_cart || 0),
      orders: Number(acc.orders || 0) + Number(item.orders || 0),
      units: Number(acc.units || 0) + Number(item.units || 0),
      spend_rub: Number(acc.spend_rub || 0) + Number(item.spend_rub || 0),
      spend_cny: Number(acc.spend_cny || 0) + Number(item.spend_cny || 0),
      revenue_rub: Number(acc.revenue_rub || 0) + Number(item.revenue_rub || 0),
      revenue_cny: Number(acc.revenue_cny || 0) + Number(item.revenue_cny || 0),
      local_revenue_cny: Number(acc.local_revenue_cny || 0) + Number(item.local_revenue_cny || 0)
    }), {});
    if (!Number(row?.row_count || 0)) {
      return {
        ...emptyDashboardAdSummaryMysql(to),
        from,
        to
      };
    }
    const exchangeRate = await currentExchangeRateValueMysql();
    const spendRub = Number(row?.spend_rub || 0);
    const revenueRub = Number(row?.revenue_rub || 0);
    const spend = Number(row?.spend_cny || 0) || rubToCnyMysql(spendRub, exchangeRate);
    const localRevenue = Number(row?.local_revenue_cny || 0);
    const revenue = Number(row?.revenue_cny || 0) || rubToCnyMysql(revenueRub, exchangeRate) || localRevenue;
    const roi = spend ? revenue / spend : null;
    const acos = revenue ? spend / revenue : null;
    const lastSyncedAt = latestIsoDateTimeMysql(rows, "last_synced_at");
    const lastUpdatedAt = latestIsoDateTimeMysql(rows, "last_updated_at");
    return {
      date_key: to,
      from,
      to,
      data_available: true,
      shop_count: Number(row?.shop_count || 0),
      sku_count: Number(row?.sku_count || 0),
      campaign_count: Number(row?.campaign_count || 0),
      abnormal_sku_count: Number(row?.abnormal_sku_count || 0),
      impressions: Number(row?.impressions || 0),
      clicks: Number(row?.clicks || 0),
      add_to_cart: Number(row?.add_to_cart || 0),
      orders: Number(row?.orders || 0),
      units: Number(row?.units || 0),
      spend_cny: roundMoneyMysql(spend),
      revenue_cny: roundMoneyMysql(revenue),
      local_revenue_cny: roundMoneyMysql(localRevenue),
      spend_rub: roundMoneyMysql(spendRub),
      revenue_rub: roundMoneyMysql(revenueRub),
      last_synced_at: lastSyncedAt,
      last_updated_at: lastUpdatedAt,
      exchange_rate: exchangeRate,
      cny_estimated_from_rub: !Number(row?.spend_cny || 0) && spendRub > 0,
      revenue_source: Number(row?.revenue_cny || 0) || revenueRub ? "ozon_ad_report" : (localRevenue ? "local_order_fallback" : "none"),
      roi,
      roas: roi,
      acos: acos ?? (revenueRub ? spendRub / revenueRub : null),
      ctr: Number(row?.impressions || 0) ? Number(row?.clicks || 0) / Number(row?.impressions || 0) : 0,
      conversion_rate: Number(row?.clicks || 0) ? Number(row?.orders || 0) / Number(row?.clicks || 0) : 0,
      shops: rows.map((item) => {
        const shopSpendRub = Number(item.spend_rub || 0);
        const shopRevenueRub = Number(item.revenue_rub || 0);
        const shopLocalRevenue = Number(item.local_revenue_cny || 0);
        const shopSpend = Number(item.spend_cny || 0) || rubToCnyMysql(shopSpendRub, exchangeRate);
        const shopRevenue = Number(item.revenue_cny || 0) || rubToCnyMysql(shopRevenueRub, exchangeRate) || shopLocalRevenue;
        return {
          shop_id: item.shop_id,
          shop_name: item.shop_name || `店铺 ${item.shop_id}`,
          spend_cny: roundMoneyMysql(shopSpend),
          revenue_cny: roundMoneyMysql(shopRevenue),
          local_revenue_cny: roundMoneyMysql(shopLocalRevenue),
          spend_rub: roundMoneyMysql(shopSpendRub),
          revenue_rub: roundMoneyMysql(shopRevenueRub),
          revenue_source: Number(item.revenue_cny || 0) || shopRevenueRub ? "ozon_ad_report" : (shopLocalRevenue ? "local_order_fallback" : "none"),
          last_synced_at: item.last_synced_at ? new Date(item.last_synced_at).toISOString() : "",
          last_updated_at: item.last_updated_at ? new Date(item.last_updated_at).toISOString() : "",
          roi: shopSpend ? shopRevenue / shopSpend : null,
          clicks: Number(item.clicks || 0),
          conversion_rate: Number(item.clicks || 0) ? Number(item.orders || 0) / Number(item.clicks || 0) : 0,
          orders: Number(item.orders || 0),
          sku_count: Number(item.sku_count || 0)
        };
      })
    };
  } catch (error) {
    console.warn("[dashboard] ad summary unavailable:", error.message);
    return {
      ...emptyDashboardAdSummaryMysql(to, "unavailable"),
      from,
      to
    };
  }
}

async function dashboardShopCommerceBreakdownMysql(dateKey) {
  try {
    const dateFilter = profitOrderedAtUtcRangeMysql("o", dateKey, dateKey);
    const outcome = buildOrderOutcomeSql("o", "mysql");
    const effectiveBusinessSale = `(${outcome.effectiveSale} AND NOT ${outcome.afterDeliveryReturn})`;
    const rows = await mysqlQuery(`
      SELECT
        o.shop_id,
        COALESCE(s.name, CONCAT('店铺 ', o.shop_id)) AS shop_name,
        COUNT(DISTINCT o.id) AS order_count,
        COUNT(DISTINCT CASE WHEN ${effectiveBusinessSale} THEN o.id END) AS effective_orders,
        COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS total_revenue,
        COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
        COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS effective_revenue,
        COALESCE(SUM(CASE WHEN ${effectiveBusinessSale} AND COALESCE(oi.settlement_state, '') != 'accrued' THEN COALESCE(oi.estimated_profit, 0) ELSE 0 END), 0) AS pending_profit,
        COUNT(DISTINCT CASE WHEN ${outcome.cancelledPreFulfillment} THEN o.id END) AS cancelled_orders,
        COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN oi.quantity ELSE 0 END), 0) AS cancelled_quantity,
        COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS cancelled_revenue,
        COUNT(DISTINCT CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN o.id END) AS return_orders,
        COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.quantity ELSE 0 END), 0) AS return_quantity,
        COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.sale_price * oi.quantity ELSE 0 END), 0) AS return_revenue
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN shops s ON s.id = o.shop_id
      WHERE 1=1 ${dateFilter.whereSql}
      GROUP BY o.shop_id, s.name
      ORDER BY effective_revenue DESC, order_count DESC
    `, dateFilter.params);
    return rows.map((row) => ({
      shop_id: row.shop_id,
      shop_name: row.shop_name || `店铺 ${row.shop_id}`,
      order_count: Number(row.order_count || 0),
      effective_orders: Number(row.effective_orders || 0),
      item_quantity: Number(row.item_quantity || 0),
      total_revenue: roundMoneyMysql(row.total_revenue || 0),
      revenue: roundMoneyMysql(row.effective_revenue || 0),
      effective_revenue: roundMoneyMysql(row.effective_revenue || 0),
      pending_profit: roundMoneyMysql(row.pending_profit || 0),
      cancelled_orders: Number(row.cancelled_orders || 0),
      cancelled_quantity: Number(row.cancelled_quantity || 0),
      cancelled_revenue: roundMoneyMysql(row.cancelled_revenue || 0),
      return_orders: Number(row.return_orders || 0),
      return_quantity: Number(row.return_quantity || 0),
      return_revenue: roundMoneyMysql(row.return_revenue || 0)
    }));
  } catch (error) {
    console.warn("[dashboard] commerce shop breakdown unavailable:", error.message);
    return [];
  }
}

async function dashboardFbpInventoryValueMysql() {
  try {
    const row = await mysqlQueryOne(`
      SELECT
        COALESCE(SUM(GREATEST(COALESCE(oss.present, 0), 0) * COALESCE(p.purchase_cost, 0)), 0) AS inventory_value,
        COALESCE(SUM(GREATEST(COALESCE(oss.present, 0), 0)), 0) AS inventory_quantity
      FROM ozon_stock_snapshots oss
      LEFT JOIN sku_mappings sm ON sm.shop_id = oss.shop_id AND sm.ozon_sku = oss.ozon_sku AND sm.active = 1
      LEFT JOIN products p ON p.id = COALESCE(oss.product_id, sm.product_id)
      WHERE oss.stock_type = 'fbp_real'
    `);
    return {
      value: roundMoneyMysql(row?.inventory_value || 0),
      quantity: Number(row?.inventory_quantity || 0)
    };
  } catch (error) {
    console.warn("[dashboard] FBP inventory value unavailable:", error.message);
    return { value: null, quantity: null };
  }
}

async function dashboardMonthShippingCostSummaryMysql(today) {
  const to = today || todayDateKeyMysql();
  const from = `${String(to).slice(0, 7)}-01`;
  try {
    const dateFilter = profitOrderedAtUtcRangeMysql("o", from, to);
    const outcome = buildOrderOutcomeSql("o", "mysql");
    const effectiveBusinessSale = `(${outcome.effectiveSale} AND NOT ${outcome.afterDeliveryReturn})`;
    const rows = await mysqlQuery(`
      SELECT
        o.shop_id,
        COALESCE(s.name, CONCAT('店铺 ', o.shop_id)) AS shop_name,
        COUNT(DISTINCT o.id) AS order_count,
        COALESCE(SUM(oi.quantity), 0) AS item_quantity,
        COALESCE(SUM(COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)), 0) AS revenue,
        COALESCE(SUM(COALESCE(opi.purchase_cost_cny, oi.frozen_purchase_cost * oi.quantity, 0)), 0) AS purchase_cost,
        COALESCE(SUM(COALESCE(opi.domestic_shipping_cny, oi.frozen_domestic_shipping * oi.quantity, 0)), 0) AS domestic_shipping_cost,
        COALESCE(SUM(COALESCE(opi.international_shipping_cny, oi.frozen_international_shipping * oi.quantity, 0)), 0) AS international_shipping_cost
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      LEFT JOIN shops s ON s.id = o.shop_id
      WHERE 1=1 ${dateFilter.whereSql}
        AND ${effectiveBusinessSale}
      GROUP BY o.shop_id, s.name
      ORDER BY revenue DESC, order_count DESC
    `, dateFilter.params);
    const totals = rows.reduce((acc, row) => ({
      order_count: Number(acc.order_count || 0) + Number(row.order_count || 0),
      item_quantity: Number(acc.item_quantity || 0) + Number(row.item_quantity || 0),
      revenue: Number(acc.revenue || 0) + Number(row.revenue || 0),
      purchase_cost: Number(acc.purchase_cost || 0) + Number(row.purchase_cost || 0),
      domestic_shipping_cost: Number(acc.domestic_shipping_cost || 0) + Number(row.domestic_shipping_cost || 0),
      international_shipping_cost: Number(acc.international_shipping_cost || 0) + Number(row.international_shipping_cost || 0)
    }), {});
    const revenue = Number(totals.revenue || 0);
    const purchaseCost = Number(totals.purchase_cost || 0);
    const domesticShippingCost = Number(totals.domestic_shipping_cost || 0);
    const internationalShippingCost = Number(totals.international_shipping_cost || 0);
    const shippingCost = domesticShippingCost + internationalShippingCost;
    return {
      from,
      to,
      order_count: Number(totals.order_count || 0),
      item_quantity: Number(totals.item_quantity || 0),
      revenue: roundMoneyMysql(revenue),
      purchase_cost: roundMoneyMysql(purchaseCost),
      purchase_cost_ratio: revenue ? purchaseCost / revenue : null,
      domestic_shipping_cost: roundMoneyMysql(domesticShippingCost),
      international_shipping_cost: roundMoneyMysql(internationalShippingCost),
      shipping_cost: roundMoneyMysql(shippingCost),
      shipping_cost_ratio: revenue ? shippingCost / revenue : null,
      shops: rows.map((row) => {
        const shopRevenue = Number(row.revenue || 0);
        const shopPurchaseCost = Number(row.purchase_cost || 0);
        const shopDomesticShippingCost = Number(row.domestic_shipping_cost || 0);
        const shopInternationalShippingCost = Number(row.international_shipping_cost || 0);
        const shopShippingCost = shopDomesticShippingCost + shopInternationalShippingCost;
        return {
          shop_id: row.shop_id,
          shop_name: row.shop_name || `店铺 ${row.shop_id || ""}`.trim(),
          order_count: Number(row.order_count || 0),
          item_quantity: Number(row.item_quantity || 0),
          revenue: roundMoneyMysql(shopRevenue),
          purchase_cost: roundMoneyMysql(shopPurchaseCost),
          purchase_cost_ratio: shopRevenue ? shopPurchaseCost / shopRevenue : null,
          domestic_shipping_cost: roundMoneyMysql(shopDomesticShippingCost),
          international_shipping_cost: roundMoneyMysql(shopInternationalShippingCost),
          shipping_cost: roundMoneyMysql(shopShippingCost),
          shipping_cost_ratio: shopRevenue ? shopShippingCost / shopRevenue : null
        };
      })
    };
  } catch (error) {
    console.warn("[dashboard] month purchase cost summary unavailable:", error.message);
    return {
      from,
      to,
      order_count: 0,
      item_quantity: 0,
      revenue: null,
      purchase_cost: null,
      purchase_cost_ratio: null,
      domestic_shipping_cost: null,
      international_shipping_cost: null,
      shipping_cost: null,
      shipping_cost_ratio: null,
      shops: []
    };
  }
}

async function dashboardProfitTrendSummaryMysql(today) {
  const sevenDayFrom = dateKeyDaysAgoMysql(6);
  const monthFrom = String(today || todayDateKeyMysql()).slice(0, 7) + "-01";
  const current = new Date(`${today}T00:00:00+08:00`);
  const previousMonthStartDate = new Date(current.getFullYear(), current.getMonth() - 1, 1);
  const previousMonthEndDate = new Date(current.getFullYear(), current.getMonth(), 0);
  const quarterStartMonth = Math.floor(current.getMonth() / 3) * 3;
  const quarterFrom = dateKeyMysql(new Date(current.getFullYear(), quarterStartMonth, 1));
  const previousMonthFrom = dateKeyMysql(previousMonthStartDate);
  const previousMonthTo = dateKeyMysql(previousMonthEndDate);
  const [sevenDaySummary, monthSummary, previousMonthSummary, quarterSummary] = await Promise.all([
    profitSummaryOverviewMysql(sevenDayFrom, today),
    profitSummaryOverviewMysql(monthFrom, today),
    profitSummaryOverviewMysql(previousMonthFrom, previousMonthTo),
    profitSummaryOverviewMysql(quarterFrom, today)
  ]);
  const sevenDayCount = inclusiveDateSpanDaysMysql(sevenDayFrom, today);
  const monthDayCount = inclusiveDateSpanDaysMysql(monthFrom, today);
  const previousMonthDayCount = inclusiveDateSpanDaysMysql(previousMonthFrom, previousMonthTo);
  const quarterDayCount = inclusiveDateSpanDaysMysql(quarterFrom, today);
  return {
    seven_day_average_profit: roundMoneyMysql(Number(sevenDaySummary?.profit || 0) / Math.max(sevenDayCount, 1)),
    month_average_profit: roundMoneyMysql(Number(monthSummary?.profit || 0) / Math.max(monthDayCount, 1)),
    previous_month_average_profit: roundMoneyMysql(Number(previousMonthSummary?.profit || 0) / Math.max(previousMonthDayCount, 1)),
    quarter_average_profit: roundMoneyMysql(Number(quarterSummary?.profit || 0) / Math.max(quarterDayCount, 1)),
    seven_day_total_profit: roundMoneyMysql(sevenDaySummary?.profit || 0),
    month_total_profit: roundMoneyMysql(monthSummary?.profit || 0),
    previous_month_total_profit: roundMoneyMysql(previousMonthSummary?.profit || 0),
    quarter_total_profit: roundMoneyMysql(quarterSummary?.profit || 0),
    month_total_revenue: roundMoneyMysql(monthSummary?.effective_revenue ?? monthSummary?.revenue ?? 0),
    previous_month_total_revenue: roundMoneyMysql(previousMonthSummary?.effective_revenue ?? previousMonthSummary?.revenue ?? 0),
    month_effective_orders: Number(monthSummary?.effective_orders || 0),
    previous_month_effective_orders: Number(previousMonthSummary?.effective_orders || 0),
    month_cancelled_orders: Number(monthSummary?.cancelled_orders || 0),
    previous_month_cancelled_orders: Number(previousMonthSummary?.cancelled_orders || 0),
    month_cancelled_quantity: Number(monthSummary?.cancelled_quantity || 0),
    previous_month_cancelled_quantity: Number(previousMonthSummary?.cancelled_quantity || 0),
    month_cancelled_revenue: roundMoneyMysql(monthSummary?.cancelled_revenue || 0),
    previous_month_cancelled_revenue: roundMoneyMysql(previousMonthSummary?.cancelled_revenue || 0),
    month_return_orders: Number(monthSummary?.return_orders || 0),
    previous_month_return_orders: Number(previousMonthSummary?.return_orders || 0),
    month_return_quantity: Number(monthSummary?.return_quantity || 0),
    previous_month_return_quantity: Number(previousMonthSummary?.return_quantity || 0),
    month_return_revenue: roundMoneyMysql(monthSummary?.return_revenue || 0),
    previous_month_return_revenue: roundMoneyMysql(previousMonthSummary?.return_revenue || 0),
    seven_day_days: sevenDayCount,
    month_days: monthDayCount,
    previous_month_days: previousMonthDayCount,
    quarter_days: quarterDayCount
  };
}

async function dashboardAftersalesLossSummaryMysql(today) {
  const to = today || todayDateKeyMysql();
  const from = `${String(to).slice(0, 7)}-01`;
  try {
    const payload = await profitAftersalesMysql({ from, to, shopId: "all", bucket: "all" });
    const bucketMap = new Map((payload.buckets || []).map((item) => [item.key, item]));
    const amount = (key) => roundMoneyMysql(bucketMap.get(key)?.estimated_loss_cny || 0);
    return {
      from,
      to,
      total_estimated_loss_cny: roundMoneyMysql(payload.totals?.estimated_loss_cny || 0),
      rejected_unclaimed_loss_cny: amount("rejected_unclaimed"),
      unsuitable_wrong_damaged_loss_cny: amount("unsuitable_wrong_damaged"),
      quality_issue_loss_cny: amount("quality_issue")
    };
  } catch (error) {
    console.warn("[dashboard] aftersales loss summary unavailable:", error.message);
    return {
      from,
      to,
      total_estimated_loss_cny: null,
      rejected_unclaimed_loss_cny: null,
      unsuitable_wrong_damaged_loss_cny: null,
      quality_issue_loss_cny: null
    };
  }
}

function inclusiveDateSpanDaysMysql(from, to) {
  const start = new Date(`${String(from || "").slice(0, 10)}T00:00:00+08:00`);
  const end = new Date(`${String(to || "").slice(0, 10)}T00:00:00+08:00`);
  const diff = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  return Number.isFinite(diff) && diff > 0 ? diff : 1;
}

function shouldRefreshDashboardMysql(query = {}) {
  return ["1", "true", "yes", "force"].includes(String(query.refresh || query.forceRefresh || "").toLowerCase());
}

function invalidateDashboardCachesMysql() {
  invalidateMasterDataCachePrefix("profit-dashboard:");
  invalidateMasterDataCache("stock-alerts:base");
  invalidateMasterDataCache("stock-alerts:base:v2");
}

function dashboardSnapshotKeyMysql(dateKey = todayDateKeyMysql()) {
  return `dashboard:${String(dateKey || todayDateKeyMysql()).slice(0, 10)}`;
}

function parseDashboardSnapshotPayloadMysql(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function withDashboardSnapshotMetaMysql(payload = {}, row = {}, status = "snapshot") {
  return {
    ...payload,
    snapshot: {
      ...(payload.snapshot || {}),
      status,
      date_key: String(row.date_key || payload?.commerce?.date_key || todayDateKeyMysql()).slice(0, 10),
      refreshed_at: row.refreshed_at ? new Date(row.refreshed_at).toISOString() : (payload.snapshot?.refreshed_at || ""),
      source_updated_at: row.source_updated_at ? new Date(row.source_updated_at).toISOString() : (payload.snapshot?.source_updated_at || "")
    }
  };
}

async function loadDashboardSnapshotMysql(dateKey = todayDateKeyMysql()) {
  await ensureDashboardSnapshotSchemaMysql();
  const row = await mysqlQueryOne(`
    SELECT snapshot_key, date_key, payload_json, source_updated_at, refreshed_at
    FROM dashboard_snapshots
    WHERE snapshot_key = ?
    LIMIT 1
  `, [dashboardSnapshotKeyMysql(dateKey)]);
  if (!row) return null;
  const payload = parseDashboardSnapshotPayloadMysql(row.payload_json);
  if (!payload) return null;
  return withDashboardSnapshotMetaMysql(payload, row, "snapshot");
}

async function saveDashboardSnapshotMysql(dateKey, payload = {}) {
  await ensureDashboardSnapshotSchemaMysql();
  const snapshotKey = dashboardSnapshotKeyMysql(dateKey);
  const savedAt = new Date().toISOString();
  const nextPayload = withDashboardSnapshotMetaMysql(payload, {
    date_key: dateKey,
    refreshed_at: savedAt,
    source_updated_at: savedAt
  }, "fresh");
  await mysqlExecute(`
    INSERT INTO dashboard_snapshots (snapshot_key, date_key, payload_json, source_updated_at, refreshed_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      payload_json = VALUES(payload_json),
      source_updated_at = VALUES(source_updated_at),
      refreshed_at = VALUES(refreshed_at)
  `, [snapshotKey, dateKey, JSON.stringify(nextPayload)]);
  return nextPayload;
}

async function buildDashboardPayloadMysql({ forceRefresh = false } = {}) {
  if (forceRefresh) invalidateDashboardCachesMysql();
  const today = todayDateKeyMysql();
  const adLatestDate = await latestDashboardAdDateMysql(today);
  const adCurrentDate = adLatestDate || today;
  const adPreviousDate = adLatestDate ? dateKeyMysql(addDaysMysql(new Date(`${adLatestDate}T00:00:00+08:00`), -1)) : dateKeyDaysAgoMysql(1);
  const adMonthFrom = `${String(today).slice(0, 7)}-01`;
  const [stock, procurement, todayProfit, yesterdayProfit, profitTrend, shopBreakdown, adToday, adYesterday, adMonth, fbpInventoryValue, monthShippingCost, fbpOpportunities, aftersalesLoss, scheduledJobs] = await Promise.all([
    stockAlertsMysql({ mode: "fbp-alerts", paged: "1", page: 1, pageSize: 100 }),
    procurementRequestsMysql({ grouped: "1", paged: "1", page: 1, pageSize: 8 }),
    profitSummaryOverviewMysql(today, today),
    profitSummaryOverviewMysql(dateKeyDaysAgoMysql(1), dateKeyDaysAgoMysql(1)),
    dashboardProfitTrendSummaryMysql(today),
    dashboardShopCommerceBreakdownMysql(today),
    dashboardAdSummaryMysql(adCurrentDate),
    dashboardAdSummaryMysql(adPreviousDate),
    dashboardAdSummaryMysql(adMonthFrom, today),
    dashboardFbpInventoryValueMysql(),
    dashboardMonthShippingCostSummaryMysql(today),
    fbpOpportunitiesMysql({ page: 1, pageSize: 8 }),
    dashboardAftersalesLossSummaryMysql(today),
    scheduledJobSummary()
  ]);
  const stockRows = stock.rows || [];
  const procurementRows = procurement.rows || [];
  const urgentCount = Number(stock.meta?.urgent_count || stockRows.filter((item) => item.alert_level === "danger").length);
  const warningCount = Number(stock.meta?.warning_count || stockRows.filter((item) => item.alert_level !== "ok").length);
  const procurementAmount = procurementRows.reduce((sum, item) => sum + Number(item.total_amount || 0), 0);
  return {
    summary: {
      urgent_count: urgentCount,
      warning_count: warningCount,
      fbp_count: Number(stock.meta?.warning_count || 0),
      fbs_count: 0,
      procurement_count: Number(procurement.total || 0),
      procurement_amount: roundMoneyMysql(procurementAmount),
      fbp_inventory_value: fbpInventoryValue.value,
      fbp_inventory_quantity: fbpInventoryValue.quantity,
      month_shipping_cost: monthShippingCost,
      month_order_outcomes: {
        effective_orders: Number(profitTrend?.month_effective_orders || monthShippingCost?.order_count || 0),
        cancelled_orders: Number(profitTrend?.month_cancelled_orders || 0),
        cancelled_quantity: Number(profitTrend?.month_cancelled_quantity || 0),
        cancelled_revenue: roundMoneyMysql(profitTrend?.month_cancelled_revenue || 0),
        return_orders: Number(profitTrend?.month_return_orders || 0),
        return_quantity: Number(profitTrend?.month_return_quantity || 0),
        return_revenue: roundMoneyMysql(profitTrend?.month_return_revenue || 0)
      },
      fbp_opportunities: fbpOpportunities.summary || {},
      aftersales_loss: aftersalesLoss,
      scheduled_jobs: scheduledJobs
    },
    commerce: {
      date_key: today,
      today: todayProfit,
      yesterday: yesterdayProfit,
      profit_trend: profitTrend,
      shops: shopBreakdown,
      advertising: {
        date_key: adCurrentDate,
        latest_date_key: adLatestDate || "",
        is_latest_today: adLatestDate === today,
        today: adToday,
        yesterday: adYesterday,
        month: adMonth
      }
    },
    alerts: {
      fbp: stockRows,
      fbpOpportunities: fbpOpportunities.rows || [],
      fbs: [],
      procurement: procurementRows,
      scheduledJobs: scheduledJobs
    }
  };
}

async function rebuildDashboardSnapshotMysql(options = {}) {
  ensureMysqlCutoverEnabled();
  const dateKey = todayDateKeyMysql();
  const payload = await buildDashboardPayloadMysql({ forceRefresh: options.forceRefresh === true });
  return saveDashboardSnapshotMysql(dateKey, payload);
}

export async function refreshDashboardSnapshotMysql(options = {}) {
  return rebuildDashboardSnapshotMysql({
    forceRefresh: options.forceRefresh === true || options.refresh === true
  });
}

function queueDashboardSnapshotRefreshMysql(options = {}) {
  const dateKey = todayDateKeyMysql();
  const snapshotKey = dashboardSnapshotKeyMysql(dateKey);
  if (dashboardSnapshotRefreshJobsMysql.has(snapshotKey)) return;
  const job = rebuildDashboardSnapshotMysql(options)
    .catch((error) => {
      console.warn("[dashboard] snapshot refresh failed:", error.message);
    })
    .finally(() => {
      dashboardSnapshotRefreshJobsMysql.delete(snapshotKey);
    });
  dashboardSnapshotRefreshJobsMysql.set(snapshotKey, job);
}

export async function dashboardMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const forceRefresh = shouldRefreshDashboardMysql(query);
  const snapshotOnly = ["1", "true", "yes"].includes(String(query.snapshotOnly || query.snapshot_only || "").toLowerCase());
  const today = todayDateKeyMysql();

  if (forceRefresh) {
    return rebuildDashboardSnapshotMysql({ forceRefresh: true });
  }

  const snapshot = await loadDashboardSnapshotMysql(today);
  if (snapshot) {
    if (!snapshotOnly) queueDashboardSnapshotRefreshMysql({ forceRefresh: false });
    return snapshot;
  }

  return rebuildDashboardSnapshotMysql({ forceRefresh: false });
}

export async function inventoryMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureStockLocationSchemaMysql();

  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const productId = Number(query.productId || query.product_id || 0);
  const sourceType = String(query.sourceType || query.source_type || "").trim();
  const rawStockLocation = String(query.stockLocation || query.stock_location || "").trim().toUpperCase();
  const stockLocation = ["LOCAL", "FBP", "UNKNOWN"].includes(rawStockLocation) ? rawStockLocation : "";
  const search = String(query.query || query.search || "").trim();
  const where = [];
  const params = [];

  if (productId > 0) {
    where.push("im.product_id = ?");
    params.push(productId);
  }
  if (sourceType) {
    where.push("im.source_type = ?");
    params.push(sourceType);
  }
  if (stockLocation) {
    where.push("im.stock_location = ?");
    params.push(stockLocation);
  }
  if (search) {
    where.push(`(
      p.name LIKE ? OR p.code LIKE ? OR im.note LIKE ? OR im.source_ref LIKE ?
    )`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const selectSql = `
    SELECT
      im.*,
      p.code AS product_code,
      p.name AS product_name,
      p.image_url AS product_image_url,
      s.name AS shop_name,
      pe.name AS owner_name,
      COALESCE(op.name, im.operator, '') AS operator_name
    FROM inventory_movements im
    JOIN products p ON p.id = im.product_id
    LEFT JOIN shops s ON s.id = im.shop_id
    LEFT JOIN people pe ON pe.id = im.owner_person_id
    LEFT JOIN people op ON op.id = CASE WHEN im.operator REGEXP '^[0-9]+$' THEN CAST(im.operator AS UNSIGNED) ELSE NULL END
    ${whereSql}
  `;
  const orderSql = "ORDER BY im.created_at DESC, im.id DESC";

  if (!paged) {
    return await mysqlQuery(`
      ${selectSql}
      ${orderSql}
      LIMIT 300
    `, params);
  }

  const offset = (page - 1) * pageSize;
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`
      SELECT COUNT(*) AS total
      FROM inventory_movements im
      JOIN products p ON p.id = im.product_id
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
    mode: "paged"
  };
}

export async function outboundRecordsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureStockLocationSchemaMysql();
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
      LEFT JOIN orders o ON o.posting_number = obr.order_ref AND o.shop_id = obr.shop_id
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
  const rawStockLocation = String(query.stockLocation || query.stock_location || "").trim();
  const stockLocation = normalizeStockLocationMysql(rawStockLocation);
  const productId = Number(query.productId || query.product_id || 0);
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
  if (rawStockLocation) {
    where.push("obr.stock_location = ?");
    params.push(stockLocation);
  }
  if (productId) {
    where.push("obr.product_id = ?");
    params.push(productId);
  }
  if (dateFrom) {
    where.push("COALESCE(o.ordered_at, obr.created_at) >= ?");
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push("COALESCE(o.ordered_at, obr.created_at) < DATE_ADD(?, INTERVAL 1 DAY)");
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
      oi.estimated_profit AS estimated_profit,
      oi.actual_profit AS actual_profit,
      oi.settlement_state AS settlement_state,
      o.status AS order_status,
      o.tracking_stage AS tracking_stage,
      CASE
        WHEN COALESCE(oi.settlement_state, '') = 'accrued'
          OR LOWER(COALESCE(o.status, '')) LIKE '%delivered%'
          OR LOWER(COALESCE(o.status, '')) LIKE '%cancel%'
          OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%'
          OR LOWER(COALESCE(o.status, '')) LIKE '%return%'
        THEN 'actual'
        ELSE 'estimated'
      END AS profit_model,
      CASE
        WHEN COALESCE(oi.settlement_state, '') = 'accrued'
          OR LOWER(COALESCE(o.status, '')) LIKE '%delivered%'
          OR LOWER(COALESCE(o.status, '')) LIKE '%cancel%'
          OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%'
          OR LOWER(COALESCE(o.status, '')) LIKE '%return%'
        THEN '真实利润'
        ELSE '预估利润'
      END AS profit_model_text,
      (oi.sale_price * obr.quantity) AS order_amount,
      DATE_FORMAT(COALESCE(o.ordered_at, obr.created_at), '%Y-%m-%d %H:%i:%s') AS outbound_time
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
    LEFT JOIN orders o ON o.posting_number = obr.order_ref AND o.shop_id = obr.shop_id
    ${whereSql}
  `;
}

function stockLocationClassificationSqlMysql() {
  return `
    CASE
      WHEN LOWER(CONCAT_WS(' ', COALESCE(osh.warehouse_name, ''), COALESCE(osh.tpl_provider, ''), COALESCE(osh.raw_status_json, ''), COALESCE(raw.raw_json, ''), COALESCE(o.tracking_number, '')))
        REGEXP 'fbp|fbo|hunchun|hun chun|hch-pd|hch-cr|cel fbp|fbp standard|珲春|混春|混川'
      THEN 'FBP'
      WHEN o.id IS NOT NULL
      THEN 'LOCAL'
      ELSE 'UNKNOWN'
    END
  `;
}

function stockLocationSourceClassificationSqlMysql() {
  return `
    CASE
      WHEN o.id IS NULL
      THEN 'missing_order'
      WHEN LOWER(CONCAT_WS(' ', COALESCE(osh.warehouse_name, ''), COALESCE(osh.tpl_provider, ''), COALESCE(osh.raw_status_json, ''), COALESCE(raw.raw_json, ''), COALESCE(o.tracking_number, '')))
        REGEXP 'fbp|fbo|hunchun|hun chun|hch-pd|hch-cr|cel fbp|fbp standard|珲春|混春|混川'
      THEN 'order_warehouse_rule'
      ELSE 'order_warehouse_rule'
    END
  `;
}

function outboundStockLocationBackfillJoinSqlMysql() {
  return `
    FROM outbound_records obr
    LEFT JOIN orders o ON o.posting_number = obr.order_ref AND o.shop_id = obr.shop_id
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = obr.shop_id AND raw.posting_number = obr.order_ref
    LEFT JOIN (
      SELECT h.*
      FROM order_status_history h
      JOIN (
        SELECT order_id, MAX(observed_at) AS observed_at
        FROM order_status_history
        GROUP BY order_id
      ) latest ON latest.order_id = h.order_id AND latest.observed_at = h.observed_at
    ) osh ON osh.order_id = o.id
  `;
}

export async function backfillOutboundStockLocationsMysql(options = {}) {
  ensureMysqlCutoverEnabled();
  await ensureStockLocationSchemaMysql();
  const apply = options.apply === true || String(options.apply || "").toLowerCase() === "true";
  const force = options.force === true || String(options.force || "").toLowerCase() === "true";
  const limit = Math.max(0, Number(options.limit || 0));
  const targetWhere = force ? "1 = 1" : "(obr.stock_location IS NULL OR obr.stock_location = '' OR obr.stock_location = 'UNKNOWN')";
  const classificationSql = stockLocationClassificationSqlMysql();
  const sourceSql = stockLocationSourceClassificationSqlMysql();
  const joinSql = outboundStockLocationBackfillJoinSqlMysql();
  const limitSql = limit ? "LIMIT ?" : "";
  const params = limit ? [limit] : [];

  const previewRows = await mysqlQuery(`
    SELECT next_stock_location AS stock_location, COUNT(*) AS count
    FROM (
      SELECT obr.id, ${classificationSql} AS next_stock_location
      ${joinSql}
      WHERE ${targetWhere}
      ${limitSql}
    ) classified
    GROUP BY next_stock_location
    ORDER BY next_stock_location
  `, params);

  if (!apply) {
    return {
      ok: true,
      mode: "dry_run",
      force,
      limit,
      outbound: {
        preview: previewRows.map((row) => ({
          stock_location: normalizeStockLocationMysql(row.stock_location),
          count: Number(row.count || 0)
        }))
      },
      inventory_movements: { updated: 0 }
    };
  }

  const candidateRows = await mysqlQuery(`
    SELECT obr.id, ${classificationSql} AS stock_location, ${sourceSql} AS stock_location_source
    ${joinSql}
    WHERE ${targetWhere}
    ORDER BY obr.id ASC
    ${limitSql}
  `, params);

  let outboundUpdated = 0;
  let movementUpdated = 0;
  for (const row of candidateRows) {
    const stockLocation = normalizeStockLocationMysql(row.stock_location);
    const stockLocationSource = String(row.stock_location_source || "legacy_unknown").slice(0, 64);
    const outboundResult = await mysqlExecute(`
      UPDATE outbound_records
      SET stock_location = ?, stock_location_source = ?
      WHERE id = ?
    `, [stockLocation, stockLocationSource, row.id]);
    outboundUpdated += Number(outboundResult?.affectedRows || 0);
    const movementResult = await mysqlExecute(`
      UPDATE inventory_movements im
      JOIN outbound_records obr ON obr.order_item_id = im.related_order_item_id
        AND obr.product_id = im.product_id
        AND obr.order_ref = im.related_posting_number
      SET im.stock_location = obr.stock_location,
        im.stock_location_source = LEFT(CONCAT('outbound_', obr.stock_location_source), 64)
      WHERE obr.id = ?
        AND im.source_type IN ('order_outbound', 'order_outbound_adjustment')
        AND (${force ? "1 = 1" : "im.stock_location IS NULL OR im.stock_location = '' OR im.stock_location = 'UNKNOWN'"})
    `, [row.id]);
    movementUpdated += Number(movementResult?.affectedRows || 0);
    if (Number(movementResult?.affectedRows || 0) === 0) {
      const fallbackMovementResult = await mysqlExecute(`
        UPDATE inventory_movements im
        JOIN outbound_records obr ON obr.order_item_id = im.related_order_item_id
        SET im.stock_location = obr.stock_location,
          im.stock_location_source = LEFT(CONCAT('outbound_order_item_', obr.stock_location_source), 64)
        WHERE obr.id = ?
          AND im.source_type IN ('order_outbound', 'order_outbound_adjustment')
          AND (${force ? "1 = 1" : "im.stock_location IS NULL OR im.stock_location = '' OR im.stock_location = 'UNKNOWN'"})
      `, [row.id]);
      movementUpdated += Number(fallbackMovementResult?.affectedRows || 0);
    }
  }
  const remainingMovementResult = await mysqlExecute(`
    UPDATE inventory_movements im
    JOIN outbound_records obr ON obr.order_item_id = im.related_order_item_id
    SET im.stock_location = obr.stock_location,
      im.stock_location_source = LEFT(CONCAT('outbound_order_item_', obr.stock_location_source), 64)
    WHERE obr.stock_location IN ('LOCAL', 'FBP')
      AND im.source_type IN ('order_outbound', 'order_outbound_adjustment')
      AND (${force ? "1 = 1" : "im.stock_location IS NULL OR im.stock_location = '' OR im.stock_location = 'UNKNOWN'"})
  `);
  movementUpdated += Number(remainingMovementResult?.affectedRows || 0);

  return {
    ok: true,
    mode: "applied",
    force,
    limit,
    outbound: {
      preview: previewRows.map((row) => ({
        stock_location: normalizeStockLocationMysql(row.stock_location),
        count: Number(row.count || 0)
      })),
      updated: outboundUpdated
    },
    inventory_movements: {
      updated: movementUpdated
    }
  };
}

export async function ordersMysql() {
  ensureMysqlCutoverEnabled();
  await ensureProcurementOrderSourceSchemaMysql();
  const rows = await mysqlQuery(`
    SELECT o.*, s.name AS shop_name,
      (SELECT COUNT(*) FROM order_items item_count_oi WHERE item_count_oi.order_id = o.id) AS item_count,
      (SELECT COALESCE(SUM(total_oi.quantity), 0) FROM order_items total_oi WHERE total_oi.order_id = o.id) AS total_quantity,
      (SELECT COALESCE(SUM(revenue_oi.sale_price * revenue_oi.quantity), 0) FROM order_items revenue_oi WHERE revenue_oi.order_id = o.id) AS revenue,
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
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.id) SEPARATOR '||') AS sku_order_item_ids,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.quantity) SEPARATOR '||') AS sku_quantities,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.sale_price, ':', oi.quantity) SEPARATOR '||') AS sku_prices,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)) SEPARATOR '||') AS sku_sale_amounts,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 0
        ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0)
      END) SEPARATOR '||') AS sku_estimated_profits,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0)
        ELSE 0
      END) SEPARATOR '||') AS sku_actual_profits,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 1
        ELSE 0
      END) SEPARATOR '||') AS sku_actual_profit_ready,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), '')) SEPARATOR '||') AS sku_names,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) SEPARATOR '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN op.ozon_product_id IS NOT NULL AND op.ozon_product_id != '' THEN CONCAT(oi.ozon_sku, ':', op.ozon_product_id) END) AS sku_ozon_product_ids,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) AS order_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.image_url, '') END) AS inventory_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', p.id) END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', op.id) END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', sm.id) END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT CONCAT(
        oi.ozon_sku,
        ':',
        COALESCE((
          SELECT SUM(oss_fbs.present)
          FROM ozon_stock_snapshots oss_fbs
          WHERE oss_fbs.shop_id = o.shop_id
            AND oss_fbs.ozon_sku = oi.ozon_sku
            AND oss_fbs.stock_type = 'fbs_virtual'
        ), 0),
        ':',
        COALESCE((
          SELECT SUM(oss_fbp.present)
          FROM ozon_stock_snapshots oss_fbp
          WHERE oss_fbp.shop_id = o.shop_id
            AND oss_fbp.ozon_sku = oi.ozon_sku
            AND oss_fbp.stock_type = 'fbp_real'
        ), 0)
      )) AS sku_stock_summaries,
      GROUP_CONCAT(DISTINCT purchase_info.purchase_order_numbers) AS purchase_order_numbers,
      GROUP_CONCAT(DISTINCT purchase_info.purchase_tracking_numbers) AS purchase_tracking_numbers,
      COUNT(DISTINCT oi.id) AS procurement_total_item_count,
      COUNT(DISTINCT CASE WHEN oipm.id IS NOT NULL OR pr_source.id IS NOT NULL THEN oi.id END) AS procurement_handled_item_count,
      GROUP_CONCAT(DISTINCT COALESCE(oipm.handling_type, CASE WHEN pr_source.id IS NOT NULL THEN 'procurement_request' END)) AS procurement_handling_types,
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
      SELECT ir.product_id,
        GROUP_CONCAT(DISTINCT po.order_no ORDER BY po.order_no SEPARATOR ',') AS purchase_order_numbers,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(ir.note, ''), NULLIF(ir.purchase_url, ''), po.order_no) ORDER BY ir.id SEPARATOR ',') AS purchase_tracking_numbers
      FROM inbound_records ir
      LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
      WHERE ir.purchase_order_id IS NOT NULL
        AND ir.product_id IN (
          SELECT DISTINCT sm_pi.product_id
          FROM order_items oi_pi
          JOIN orders o_pi ON o_pi.id = oi_pi.order_id
          LEFT JOIN sku_mappings sm_pi ON (
            (sm_pi.id = oi_pi.sku_mapping_id OR (sm_pi.shop_id = o_pi.shop_id AND sm_pi.ozon_sku = oi_pi.ozon_sku))
            AND sm_pi.active = 1
          )
          WHERE oi_pi.order_id IN (${cleanIds.map(() => "?").join(",")})
            AND sm_pi.product_id IS NOT NULL
        )
      GROUP BY ir.product_id
    ) purchase_info ON purchase_info.product_id = p.id
    LEFT JOIN procurement_requests pr_source ON pr_source.source_order_item_id = oi.id AND pr_source.status NOT IN ('cancelled')
    LEFT JOIN order_item_procurement_marks oipm ON oipm.order_item_id = oi.id AND oipm.status = 'handled'
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
  await ensureProcurementOrderSourceSchemaMysql();
  const rows = await mysqlQuery(`
    SELECT o.*, s.name AS shop_name,
      (SELECT COUNT(*) FROM order_items item_count_oi WHERE item_count_oi.order_id = o.id) AS item_count,
      (SELECT COALESCE(SUM(total_oi.quantity), 0) FROM order_items total_oi WHERE total_oi.order_id = o.id) AS total_quantity,
      (SELECT COALESCE(SUM(revenue_oi.sale_price * revenue_oi.quantity), 0) FROM order_items revenue_oi WHERE revenue_oi.order_id = o.id) AS revenue,
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
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.id) SEPARATOR '||') AS sku_order_item_ids,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.quantity) SEPARATOR '||') AS sku_quantities,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.sale_price, ':', oi.quantity) SEPARATOR '||') AS sku_prices,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)) SEPARATOR '||') AS sku_sale_amounts,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 0
        ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0)
      END) SEPARATOR '||') AS sku_estimated_profits,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0)
        ELSE 0
      END) SEPARATOR '||') AS sku_actual_profits,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 1
        ELSE 0
      END) SEPARATOR '||') AS sku_actual_profit_ready,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), '')) SEPARATOR '||') AS sku_names,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) SEPARATOR '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN op.ozon_product_id IS NOT NULL AND op.ozon_product_id != '' THEN CONCAT(oi.ozon_sku, ':', op.ozon_product_id) END) AS sku_ozon_product_ids,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) AS order_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.image_url, '') END) AS inventory_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', p.id) END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', op.id) END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', sm.id) END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(stock.fbs_present, 0), ':', COALESCE(stock.fbp_present, 0))) AS sku_stock_summaries,
      GROUP_CONCAT(DISTINCT purchase_info.purchase_order_numbers) AS purchase_order_numbers,
      GROUP_CONCAT(DISTINCT purchase_info.purchase_tracking_numbers) AS purchase_tracking_numbers,
      COUNT(DISTINCT oi.id) AS procurement_total_item_count,
      COUNT(DISTINCT CASE WHEN oipm.id IS NOT NULL OR pr_source.id IS NOT NULL THEN oi.id END) AS procurement_handled_item_count,
      GROUP_CONCAT(DISTINCT COALESCE(oipm.handling_type, CASE WHEN pr_source.id IS NOT NULL THEN 'procurement_request' END)) AS procurement_handling_types,
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
    LEFT JOIN (
      SELECT ir.product_id,
        GROUP_CONCAT(DISTINCT po.order_no ORDER BY po.order_no SEPARATOR ',') AS purchase_order_numbers,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(ir.note, ''), NULLIF(ir.purchase_url, ''), po.order_no) ORDER BY ir.id SEPARATOR ',') AS purchase_tracking_numbers
      FROM inbound_records ir
      LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
      WHERE ir.purchase_order_id IS NOT NULL
      GROUP BY ir.product_id
    ) purchase_info ON purchase_info.product_id = p.id
    LEFT JOIN procurement_requests pr_source ON pr_source.source_order_item_id = oi.id AND pr_source.status NOT IN ('cancelled')
    LEFT JOIN order_item_procurement_marks oipm ON oipm.order_item_id = oi.id AND oipm.status = 'handled'
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN order_marks om ON om.order_id = o.id
    LEFT JOIN order_label_prints olp ON olp.order_id = o.id
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    WHERE o.id IN (${cleanIds.map(() => "?").join(",")})
    GROUP BY o.id
  `, [...cleanIds, ...cleanIds]);
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
    const methods = await activeOrderLogisticsFilterMethodsMysql();
    const rows = await mysqlQuery(`
      SELECT o.id, o.posting_number, o.tracking_number, raw.raw_json
      FROM orders o
      LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      WHERE ${base.where}
      GROUP BY o.id
    `, base.params);
    const resolvedRows = [];
    for (const row of rows) {
      const rule = cachedOrderLogisticsRuleFromRowMysql(row, methods);
      if (!rule?.value || !rule?.label) continue;
      resolvedRows.push({
        id: Number(row.id),
        resolved_logistics_rule_name: rule.label,
        resolved_logistics_rule_value: rule.value
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
  const [rawBase, optionsBase] = await Promise.all([
    orderBaseSqlMysql(query),
    includeLogisticsOptions
      ? orderBaseSqlMysql({ ...query, logisticsMethod: "all", logistics_method: "all" })
      : null
  ]);
  const logisticsMethod = String(query.logisticsMethod || query.logistics_method || "all");
  const reuseLogisticsSummary = includeLogisticsOptions || logisticsMethod !== "all";
  const logisticsSummaryRows = reuseLogisticsSummary ? await loadOrderLogisticsSummaryForBaseMysql(rawBase) : null;
  const logisticsIds = filterOrderIdsByLogisticsMethodMysql(logisticsSummaryRows || [], logisticsMethod);
  const base = withRestrictedOrderIdsMysql(rawBase, logisticsIds);
  const logisticsMethodOptionsPromise = includeLogisticsOptions && optionsBase
    ? orderLogisticsMethodOptionsMysql(optionsBase, logisticsSummaryRows)
    : Promise.resolve([]);
  const countsPromise = includeCounts ? orderPagedSqlCountsMysql(base) : Promise.resolve({});
  const filtered = await orderFilteredSqlMysql(query, base);
  const totalPromise = includeRows
    ? mysqlQueryOne(`SELECT COUNT(*) AS total FROM orders o ${filtered.joins} WHERE ${filtered.where}`, filtered.params)
    : Promise.resolve(null);
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
  const [counts, logisticsMethodOptions, totalRow] = await Promise.all([
    countsPromise,
    logisticsMethodOptionsPromise,
    totalPromise
  ]);
  const total = Number(totalRow?.total ?? counts?.all ?? rows.length ?? 0);
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
      WHERE oi.order_id = o.id
        AND NOT (
          (oi.sku_mapping_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM sku_mappings sm_by_id
            JOIN products p_by_id ON p_by_id.id = sm_by_id.product_id AND p_by_id.active = 1
            WHERE sm_by_id.id = oi.sku_mapping_id AND sm_by_id.active = 1
          ))
          OR EXISTS (
            SELECT 1
            FROM sku_mappings sm_by_sku
            JOIN products p_by_sku ON p_by_sku.id = sm_by_sku.product_id AND p_by_sku.active = 1
            WHERE sm_by_sku.shop_id = o.shop_id
              AND sm_by_sku.ozon_sku = oi.ozon_sku
              AND sm_by_sku.active = 1
          )
        )
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
  const from = normalizeSyncDateMysql(body.from);
  const to = normalizeSyncDateMysql(body.to);
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
      op.id AS online_product_id,
      op.name AS online_product_name,
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

const CUSTOMER_MESSAGE_TYPES = new Set(["order_created", "order_update", "stall_comfort", "delay_comfort", "pickup_notice", "review_request"]);

function customerMessageTypeLabel(type) {
  if (type === "order_created") return "下单感谢";
  if (type === "stall_comfort") return "卡顿安抚";
  if (type === "pickup_notice") return "到货取货通知";
  if (type === "review_request") return "取货后求好评";
  if (type === "delay_comfort") return "延误安抚";
  return "订单动态回复";
}

function customerMessageRecordStatusLabel(status = "") {
  if (status === "sent") return "已发";
  if (status === "copied") return "已复制";
  if (status === "skipped") return "已跳过";
  if (status === "problem") return "已标记";
  if (status === "disabled") return "不发送";
  if (status === "read") return "已读";
  if (status === "unread") return "未读";
  return "仅草稿";
}

function orderCustomerStatusLabel(row = {}) {
  const raw = String(row.status || row.tracking_stage || row.logistics_status || "").trim();
  const value = raw.toLowerCase();
  const map = {
    awaiting_packaging: "等待打包",
    awaiting_deliver: "等待发货",
    posting_registered: "已登记物流",
    sent_by_seller: "商家已发货",
    posting_transferred_to_courier_service: "已交给物流商",
    posting_transferring: "运输中",
    posting_in_carriage: "干线运输中",
    posting_transferring_to_delivery: "转配送中",
    posting_ready_for_pickup: "已到达取货点",
    delivered: "已签收",
    cancelled: "已取消"
  };
  return map[value] || raw || "状态同步中";
}

function orderCustomerStatusLabelRu(row = {}) {
  const raw = String(row.status || row.tracking_stage || row.logistics_status || "").trim();
  const value = raw.toLowerCase();
  const map = {
    awaiting_packaging: "ожидает упаковки",
    awaiting_deliver: "ожидает передачи в доставку",
    posting_registered: "отправление зарегистрировано",
    sent_by_seller: "передан продавцом",
    posting_transferred_to_courier_service: "передан в службу доставки",
    posting_transferring: "в пути",
    posting_in_carriage: "в пути между складами",
    posting_transferring_to_delivery: "передаётся в доставку",
    posting_ready_for_pickup: "готов к получению",
    delivered: "получен",
    cancelled: "отменён"
  };
  if (/[\u3400-\u9fff]/.test(raw)) return "статус обновляется";
  return map[value] || raw || "статус обновляется";
}

function customerMessageDateIso(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value || "").trim();
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return "";
}

function customerMessageRuDate(value) {
  const iso = customerMessageDateIso(value);
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  if (!year || !month || !day) return iso;
  return `${day}.${month}.${year}`;
}

function customerMessageDeliveryWindow(row = {}) {
  const begin = customerMessageDateIso(row.delivery_date_begin);
  const end = customerMessageDateIso(row.delivery_date_end);
  if (begin && end && begin !== end) return `${begin} 至 ${end}`;
  return end || begin || "";
}

function customerMessageRuDeliveryWindow(row = {}) {
  const begin = customerMessageRuDate(row.delivery_date_begin);
  const end = customerMessageRuDate(row.delivery_date_end);
  if (begin && end && begin !== end) return `${begin} - ${end}`;
  return end || begin || "";
}

function customerMessageProductSummary(row = {}) {
  const names = String(row.product_names || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!names.length) return "您购买的商品";
  if (names.length === 1) return names[0];
  return `${names[0]}等 ${names.length} 件商品`;
}

function customerMessageRuProduct(row = {}) {
  const names = String(row.product_names || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item
      .replace(/等\s*\d+\s*件商品/g, "")
      .replace(/[\u3400-\u9fff]/g, "")
      .replace(/[，。；、（）]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim())
    .filter(Boolean);
  if (!names.length) return "ваш товар";
  if (names.length === 1) return names[0];
  const extra = names.length - 1;
  const word = extra === 1 ? "товар" : extra >= 2 && extra <= 4 ? "товара" : "товаров";
  return `${names[0]} и еще ${extra} ${word}`;
}

function customerMessageTemplateVars(row = {}, locale = "ru") {
  const isRu = locale === "ru";
  const deliveryWindow = isRu ? customerMessageRuDeliveryWindow(row) : customerMessageDeliveryWindow(row);
  const trackingNumber = String(row.tracking_number || "").trim();
  return {
    posting_number: row.posting_number || row.order_number || "",
    order_number: row.order_number || row.posting_number || "",
    customer_id: row.customer_unique_id || customerUniqueIdFromPosting(row.posting_number || row.order_number),
    product_summary: isRu ? customerMessageRuProduct(row) : customerMessageProductSummary(row),
    status_label: isRu ? orderCustomerStatusLabelRu(row) : orderCustomerStatusLabel(row),
    shop_name: row.shop_name || "",
    tracking_number: trackingNumber,
    tracking_line: trackingNumber ? (isRu ? `Трек-номер: ${trackingNumber}.` : `物流单号：${trackingNumber}。`) : "",
    delivery_window: deliveryWindow,
    delivery_window_line: deliveryWindow ? (isRu ? `Ориентир по доставке/получению: ${deliveryWindow}.` : `预计送达/取货时间：${deliveryWindow}。`) : "",
    ordered_at: isRu ? customerMessageRuDate(row.ordered_at) : customerMessageDateIso(row.ordered_at),
    quantity: String(row.item_quantity || row.quantity || 1),
    item_quantity: String(row.item_quantity || row.quantity || 1),
    sku: row.skus || row.ozon_sku || ""
  };
}

function cleanCustomerMessageRuText(text = "") {
  return String(text || "")
    .replace(/[\u3400-\u9fff]+/g, "")
    .replace(/[，。；、（）]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function cleanRenderedCustomerMessageTemplate(text = "", locale = "ru") {
  const cleaned = String(text || "")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line) => line && !/^[^:：]{1,24}[:：]\s*[.]?$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return locale === "ru" ? cleanCustomerMessageRuText(cleaned) : cleaned;
}

function renderCustomerMessageTemplate(templateText = "", row = {}, locale = "ru") {
  const vars = customerMessageTemplateVars(row, locale);
  const rendered = String(templateText || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : "";
  });
  return cleanRenderedCustomerMessageTemplate(rendered, locale);
}

function applyCustomerMessageTemplate(row = {}, template = null) {
  if (!template?.template_text) return row;
  const renderedMessage = renderCustomerMessageTemplate(template.template_text, row, "ru") || row.message_text || row.customer_message || "";
  const renderedTranslation = template.template_translation
    ? renderCustomerMessageTemplate(template.template_translation, row, "zh")
    : row.message_translation;
  return {
    ...row,
    customer_message: renderedMessage,
    message_text: renderedMessage,
    message_translation: renderedTranslation || row.message_translation || "",
    template_label: template.label || row.message_type_label || "",
    template_source: "settings"
  };
}

function mergeCustomerMessageTemplatesMysql(templateRows = []) {
  const templatesByScenario = new Map(defaultCustomerMessageTemplatesMysql().map((template) => [template.scenario, { ...template }]));
  for (const row of templateRows) {
    const scenario = String(row.scenario || "").trim();
    if (!scenario) continue;
    const fallback = templatesByScenario.get(scenario) || {};
    const translationFallback = isLegacyCustomerMessageTemplateTranslation(row.template_translation)
      ? fallback.template_translation
      : row.template_translation;
    const splitTemplate = splitCustomerMessageTemplateText(row.template_text || fallback.template_text || "", translationFallback || fallback.template_translation || "");
    const useFallback = isLegacyCustomerMessageTemplateText(splitTemplate.template_text);
    templatesByScenario.set(scenario, {
      ...fallback,
      scenario,
      label: row.label || fallback.label || scenario,
      name: row.label || fallback.name || scenario,
      enabled: Boolean(Number(row.enabled)),
      template_text: useFallback ? fallback.template_text : splitTemplate.template_text,
      template_translation: useFallback ? fallback.template_translation : splitTemplate.template_translation
    });
  }
  return templatesByScenario;
}

async function customerMessageTemplatesByScenarioMysql() {
  const templateRows = await mysqlQuery("SELECT * FROM customer_message_templates");
  return mergeCustomerMessageTemplatesMysql(templateRows);
}

function customerMessageIsPickup(row = {}) {
  const text = `${row.status || ""} ${row.tracking_stage || ""} ${row.logistics_status || ""}`.toLowerCase();
  return text.includes("ready_for_pickup") || text.includes("pickup");
}

function customerMessageIsDelivered(row = {}) {
  const text = `${row.status || ""} ${row.tracking_stage || ""} ${row.logistics_status || ""}`.toLowerCase();
  return text.includes("delivered") || text.includes("签收");
}

function customerMessageIsDelayed(row = {}) {
  if (Number(row.is_overdue || 0)) return true;
  const endTime = row.delivery_date_end ? Date.parse(row.delivery_date_end) : NaN;
  const finished = /delivered|cancelled/i.test(`${row.status || ""} ${row.tracking_stage || ""}`);
  return Number.isFinite(endTime) && endTime < Date.now() && !finished;
}

function customerMessageIsStalled(row = {}) {
  const orderedAt = row.ordered_at ? Date.parse(row.ordered_at) : NaN;
  const finished = /delivered|cancelled/i.test(`${row.status || ""} ${row.tracking_stage || ""}`);
  if (!Number.isFinite(orderedAt) || finished) return false;
  const ageHours = (Date.now() - orderedAt) / 3600000;
  const text = `${row.status || ""} ${row.tracking_stage || ""} ${row.logistics_status || ""}`.toLowerCase();
  return ageHours >= 36 && /awaiting|packaging|deliver|transferring|posting/.test(text);
}

function customerMessageSuggestedType(row = {}) {
  if (customerMessageIsDelivered(row)) return "review_request";
  if (customerMessageIsDelayed(row)) return "delay_comfort";
  if (customerMessageIsPickup(row)) return "pickup_notice";
  if (customerMessageIsStalled(row)) return "stall_comfort";
  if (/awaiting_packaging|awaiting_deliver/i.test(`${row.status || ""} ${row.tracking_stage || ""}`)) return "order_created";
  return "order_update";
}

function buildCustomerMessage(row = {}, requestedType = "order_update") {
  const type = CUSTOMER_MESSAGE_TYPES.has(requestedType) ? requestedType : customerMessageSuggestedType(row);
  const posting = row.posting_number || row.order_number || "";
  const status = orderCustomerStatusLabelRu(row);
  const windowText = customerMessageRuDeliveryWindow(row);
  const product = customerMessageRuProduct(row);
  const tracking = row.tracking_number ? `Трек-номер: ${row.tracking_number}.` : "";
  const shop = row.shop_name || "";

  if (type === "pickup_notice") {
    return cleanCustomerMessageRuText([
      "Здравствуйте!",
      `Ваш заказ ${posting} (${product}) уже можно забрать.`,
      "Проверьте, пожалуйста, код и адрес пункта выдачи в приложении Ozon.",
      "Лучше забрать в ближайшие дни, чтобы заказ не уехал обратно.",
      tracking,
      shop ? `Магазин: ${shop}.` : "",
      "Спасибо, что дождались."
    ].filter(Boolean).join("\n"));
  }

  if (type === "review_request") {
    return cleanCustomerMessageRuText([
      "Здравствуйте!",
      `Спасибо, что забрали заказ ${posting} (${product}).`,
      "Надеемся, всё подошло и покупка будет полезной.",
      "Если будет минутка, будем рады отзыву на Ozon.",
      "А если что-то не так — просто напишите нам, разберёмся."
    ].filter(Boolean).join("\n"));
  }

  if (type === "order_created") {
    return cleanCustomerMessageRuText([
      "Здравствуйте!",
      `Спасибо за заказ ${posting} (${product}).`,
      "Мы его видим, всё в порядке — скоро передадим в обработку.",
      shop ? `Магазин: ${shop}.` : "",
      windowText ? `Ориентир по доставке/получению: ${windowText}.` : "",
      "Если по заказу что-то изменится, мы напишем."
    ].filter(Boolean).join("\n"));
  }

  if (type === "stall_comfort") {
    return cleanCustomerMessageRuText([
      "Здравствуйте!",
      `Видим, что заказ ${posting} (${product}) пока задержался на этапе: ${status}.`,
      windowText ? `Ориентир по доставке/получению сейчас такой: ${windowText}.` : "",
      "Мы уже взяли заказ на контроль. Если движение не появится, дополнительно напишем в поддержку Ozon.",
      tracking,
      "Понимаем, что ждать неприятно. Будем держать вас в курсе."
    ].filter(Boolean).join("\n"));
  }

  if (type === "delay_comfort") {
    return cleanCustomerMessageRuText([
      "Здравствуйте!",
      `По заказу ${posting} (${product}) есть задержка, извините, пожалуйста.`,
      `Сейчас статус: ${status}.`,
      windowText ? `Ozon показывает ориентир: ${windowText}, но движение идёт медленнее обычного.` : "Движение сейчас идёт медленнее обычного.",
      "Мы уже проверяем ситуацию и отправили запрос в поддержку Ozon по логистике.",
      tracking,
      "Как только появится обновление, сразу напишем вам."
    ].filter(Boolean).join("\n"));
  }

  return cleanCustomerMessageRuText([
    "Здравствуйте!",
    `Посмотрели заказ ${posting} (${product}). Сейчас статус: ${status}.`,
    windowText ? `Ориентир по доставке/получению: ${windowText}.` : "",
    tracking,
    shop ? `Магазин: ${shop}.` : "",
    "Если статус изменится, мы вам напишем."
  ].filter(Boolean).join("\n"));
}

function buildCustomerMessageTranslation(row = {}, requestedType = "order_update") {
  const type = CUSTOMER_MESSAGE_TYPES.has(requestedType) ? requestedType : customerMessageSuggestedType(row);
  const posting = row.posting_number || row.order_number || "";
  const status = orderCustomerStatusLabel(row);
  const windowText = customerMessageDeliveryWindow(row);
  const product = customerMessageProductSummary(row);
  const tracking = row.tracking_number ? `物流单号：${row.tracking_number}。` : "";
  const shop = row.shop_name ? `店铺：${row.shop_name}。` : "";
  if (type === "pickup_notice") {
    return [
      "您好！",
      `您的订单 ${posting}（${product}）现在可以取货了。`,
      "请在 Ozon App 里看一下取货码和取货点地址。",
      "建议这几天方便的话就去取，避免订单被退回。",
      tracking,
      shop,
      "谢谢您的等待。"
    ].filter(Boolean).join("\n");
  }
  if (type === "review_request") {
    return [
      "您好！",
      `看到您已经取到订单 ${posting}（${product}），谢谢。`,
      "希望商品是合适、好用的。",
      "如果方便的话，欢迎在 Ozon 留个评价。",
      "如果哪里不合适，也可以直接联系我们，我们会处理。"
    ].filter(Boolean).join("\n");
  }
  if (type === "order_created") {
    return [
      "您好！",
      `感谢您的订单 ${posting}（${product}）。`,
      "我们已经看到订单了，会尽快安排处理。",
      shop,
      windowText ? `目前预计送达/取货时间：${windowText}。` : "",
      "后面如果状态有变化，我们会再同步。"
    ].filter(Boolean).join("\n");
  }
  if (type === "stall_comfort") {
    return [
      "您好！",
      `我们看到订单 ${posting}（${product}）暂时卡在：${status}。`,
      windowText ? `当前预计送达/取货时间：${windowText}。` : "",
      "这个订单我们已经帮您盯着了，如果后面还没有动静，会继续联系 Ozon 客服核实。",
      tracking,
      "让您等着确实不太好，有变化我们会再告诉您。"
    ].filter(Boolean).join("\n");
  }
  if (type === "delay_comfort") {
    return [
      "您好！",
      `订单 ${posting}（${product}）现在有点延误，真的不好意思。`,
      `目前状态是：${status}。`,
      windowText ? `Ozon 当前显示的时间是：${windowText}，但物流进度比正常慢。` : "现在物流进度比正常慢一些。",
      "我们已经在查，也已经联系 Ozon 客服核实物流情况。",
      tracking,
      "有新消息我们会马上同步给您。"
    ].filter(Boolean).join("\n");
  }
  return [
    "您好！",
    `我们看了一下订单 ${posting}（${product}），现在状态是：${status}。`,
    windowText ? `目前预计送达/取货时间：${windowText}。` : "",
    tracking,
    shop,
    "后面有变化的话，我们再同步给您。"
  ].filter(Boolean).join("\n");
}

function customerMessageReason(row = {}, type = "") {
  const targetType = type || customerMessageSuggestedType(row);
  if (targetType === "order_created") return "订单刚进入履约链路，适合先感谢客户下单并说明会尽快处理。";
  if (targetType === "stall_comfort") return "订单停留在同一履约环节较久，适合提前安抚客户。";
  if (targetType === "pickup_notice") return "订单已进入取货/待取货阶段，适合提醒客户尽快取货。";
  if (targetType === "review_request") return "订单已完成履约，适合礼貌邀请客户评价。";
  if (targetType === "delay_comfort") return "订单进度慢于预计时间，适合主动安抚并说明已联系平台客服。";
  return "用于客户催单时快速回复当前订单最新动态。";
}

function customerUniqueIdFromPosting(postingNumber = "") {
  const value = String(postingNumber || "").trim();
  if (!value) return "";
  return value.split("-")[0] || value;
}

function normalizeCustomerMessageRow(row = {}, requestedType = "", templatesByScenario = null) {
  const suggestedType = requestedType && CUSTOMER_MESSAGE_TYPES.has(requestedType) ? requestedType : customerMessageSuggestedType(row);
  const message = buildCustomerMessage(row, suggestedType);
  const translation = buildCustomerMessageTranslation(row, suggestedType);
  const orderStatusLabel = orderCustomerStatusLabel(row);
  const customerUniqueId = row.customer_unique_id || customerUniqueIdFromPosting(row.posting_number || row.order_number);
  const normalized = {
    ...row,
    task_key: `${row.id || row.posting_number || "order"}:${suggestedType}`,
    order_id: Number(row.id || 0),
    customer_unique_id: customerUniqueId,
    customer_thread_key: `${row.shop_id || 0}:${customerUniqueId}`,
    customer_order_count: Number(row.customer_order_count || 1),
    customer_latest_order_at: row.customer_latest_order_at || row.ordered_at || "",
    customer_latest_posting_number: row.customer_latest_posting_number || row.posting_number || "",
    scenario: suggestedType,
    message_type: suggestedType,
    message_type_label: customerMessageTypeLabel(suggestedType),
    status: "draft",
    send_mode: "draft",
    send_mode_label: "仅生成草稿",
    status_label: "仅草稿",
    read_state: row.read_state || "unread",
    read_state_label: row.read_state === "read" ? "已读" : "未读",
    status_label_order: orderStatusLabel,
    delivery_window_text: customerMessageDeliveryWindow(row),
    product_summary: customerMessageProductSummary(row),
    reason: customerMessageReason(row, suggestedType),
    customer_message: message,
    message_text: message,
    message_translation: translation,
    chat_enabled: true,
    urgency: suggestedType === "delay_comfort" ? "warning" : suggestedType === "pickup_notice" ? "success" : "info"
  };
  return applyCustomerMessageTemplate(normalized, templatesByScenario?.get?.(suggestedType));
}

export async function customerMessagesMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureCustomerMessageTablesMysql();
  const messageType = String(query.type || query.message_type || "all");
  const search = String(query.search || query.keyword || "").trim().toLowerCase();
  const shopId = Number(query.shop_id || query.shopId || 0);
  const dateFrom = String(query.date_from || query.dateFrom || "").slice(0, 10);
  const dateTo = String(query.date_to || query.dateTo || "").slice(0, 10);
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || query.limit || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const offset = (page - 1) * pageSize;
  const where = ["1 = 1"];
  const params = [];
  if (shopId) {
    where.push("o.shop_id = ?");
    params.push(shopId);
  }
  if (dateFrom) {
    where.push("DATE(o.ordered_at) >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push("DATE(o.ordered_at) <= ?");
    params.push(dateTo);
  }
  if (search) {
    where.push(`(
      LOWER(o.posting_number) LIKE ?
      OR LOWER(COALESCE(o.order_number, '')) LIKE ?
      OR LOWER(SUBSTRING_INDEX(o.posting_number, '-', 1)) LIKE ?
      OR LOWER(COALESCE(s.name, '')) LIKE ?
      OR EXISTS (
        SELECT 1 FROM order_items oi_search
        WHERE oi_search.order_id = o.id
          AND (LOWER(COALESCE(oi_search.ozon_sku, '')) LIKE ? OR LOWER(COALESCE(oi_search.ozon_name, '')) LIKE ?)
      )
    )`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const totalRow = await mysqlQueryOne(`
    SELECT COUNT(*) AS total
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    WHERE ${where.join(" AND ")}
  `, params);
  const total = Number(totalRow?.total || 0);

  const rows = await mysqlQuery(`
    SELECT o.id, o.shop_id, o.posting_number, SUBSTRING_INDEX(o.posting_number, '-', 1) AS customer_unique_id,
      o.order_number, o.status, o.logistics_status, o.tracking_stage,
      o.tracking_number, o.ordered_at, o.delivered_at, o.sync_state, MAX(s.name) AS shop_name,
      MAX(customer_orders.customer_order_count) AS customer_order_count,
      MAX(customer_orders.customer_latest_order_at) AS customer_latest_order_at,
      MAX(customer_orders.customer_latest_posting_number) AS customer_latest_posting_number,
      MAX(latest.customer_name) AS customer_name,
      MAX(latest.buyer_city) AS buyer_city,
      MAX(latest.buyer_region) AS buyer_region,
      MAX(latest.delivery_date_begin) AS delivery_date_begin,
      MAX(latest.delivery_date_end) AS delivery_date_end,
      MAX(latest.warehouse_name) AS warehouse_name,
      MAX(latest.tpl_provider) AS tpl_provider,
      MAX(raw.raw_json) AS raw_json,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), oi.ozon_sku) ORDER BY oi.id SEPARATOR ', ') AS product_names,
      GROUP_CONCAT(DISTINCT oi.ozon_sku ORDER BY oi.ozon_sku SEPARATOR ', ') AS skus,
      SUM(COALESCE(oi.quantity, 1)) AS item_quantity,
      MAX(COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''))) AS image_url
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    LEFT JOIN (
      SELECT shop_id, SUBSTRING_INDEX(posting_number, '-', 1) AS customer_unique_id,
        COUNT(*) AS customer_order_count,
        MAX(ordered_at) AS customer_latest_order_at,
        SUBSTRING_INDEX(GROUP_CONCAT(posting_number ORDER BY ordered_at DESC, id DESC SEPARATOR ','), ',', 1) AS customer_latest_posting_number
      FROM orders
      WHERE COALESCE(posting_number, '') != ''
      GROUP BY shop_id, SUBSTRING_INDEX(posting_number, '-', 1)
    ) customer_orders ON customer_orders.shop_id = o.shop_id AND customer_orders.customer_unique_id = SUBSTRING_INDEX(o.posting_number, '-', 1)
    LEFT JOIN order_status_history latest ON latest.id = (
      SELECT osh.id
      FROM order_status_history osh
      WHERE osh.order_id = o.id
      ORDER BY osh.observed_at DESC, osh.id DESC
      LIMIT 1
    )
    WHERE ${where.join(" AND ")}
    GROUP BY o.id
    ORDER BY o.ordered_at DESC, o.id DESC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, offset]);

  const templatesByScenario = await customerMessageTemplatesByScenarioMysql();
  const normalizedBase = rows.map((row) => normalizeCustomerMessageRow(enrichOrderLogisticsFromRawForMessage(row), "", templatesByScenario));
  const recordKeys = normalizedBase.map((row) => Number(row.order_id || row.id || 0)).filter(Boolean);
  let latestRecordMap = new Map();
  if (recordKeys.length) {
    const recordRows = await mysqlQuery(`
      SELECT r.*
      FROM customer_message_records r
      JOIN (
        SELECT order_id, scenario, MAX(id) AS id
        FROM customer_message_records
        WHERE order_id IN (${recordKeys.map(() => "?").join(",")})
        GROUP BY order_id, scenario
      ) latest ON latest.id = r.id
    `, recordKeys);
    latestRecordMap = new Map(recordRows.map((record) => [`${record.order_id}:${record.scenario}`, record]));
  }
  let chatThreadMap = new Map();
  if (normalizedBase.length) {
    const postingNumbers = [...new Set(normalizedBase.map((row) => String(row.posting_number || "")).filter(Boolean))];
    const customerKeys = [...new Set(normalizedBase.map((row) => `${Number(row.shop_id || 0)}:${String(row.customer_unique_id || "")}`).filter((key) => !key.endsWith(":")))];
    const chatWhere = [];
    const chatParams = [];
    if (postingNumbers.length) {
      chatWhere.push(`posting_number IN (${postingNumbers.map(() => "?").join(",")})`);
      chatParams.push(...postingNumbers);
    }
    if (customerKeys.length) {
      const customerPairs = customerKeys.map((key) => {
        const [shop, customer] = key.split(":");
        return [Number(shop), customer];
      }).filter(([shop, customer]) => shop && customer);
      if (customerPairs.length) {
        chatWhere.push(`(${customerPairs.map(() => "(shop_id = ? AND customer_unique_id = ?)").join(" OR ")})`);
        for (const [shop, customer] of customerPairs) chatParams.push(shop, customer);
      }
    }
    if (chatWhere.length) {
      const chatRows = await mysqlQuery(`
        SELECT *
        FROM customer_chat_threads
        WHERE ${chatWhere.join(" OR ")}
        ORDER BY COALESCE(last_message_at, updated_at) DESC, id DESC
        LIMIT 500
      `, chatParams);
      chatThreadMap = chatRows.reduce((acc, thread) => {
        const postingKey = `${Number(thread.shop_id || 0)}:${thread.posting_number || ""}`;
        const customerKey = `${Number(thread.shop_id || 0)}:${thread.customer_unique_id || ""}`;
        if (thread.posting_number && !acc.has(postingKey)) acc.set(postingKey, thread);
        if (thread.customer_unique_id && !acc.has(customerKey)) acc.set(customerKey, thread);
        return acc;
      }, new Map());
    }
  }
  const normalized = normalizedBase.map((row) => {
    const record = latestRecordMap.get(`${row.order_id}:${row.scenario}`);
    const readState = record?.read_state || row.read_state || "unread";
    const chatThread = chatThreadMap.get(`${Number(row.shop_id || 0)}:${row.posting_number || ""}`)
      || chatThreadMap.get(`${Number(row.shop_id || 0)}:${row.customer_unique_id || ""}`)
      || null;
    return {
      ...row,
      chat_id: chatThread?.chat_id || "",
      real_chat_available: Boolean(chatThread?.chat_id),
      real_chat_last_message: chatThread?.last_message_text || "",
      real_chat_last_message_at: chatThread?.last_message_at || "",
      real_chat_unread_count: Number(chatThread?.unread_count || 0),
      status: record?.status || row.status,
      status_label: customerMessageRecordStatusLabel(record?.status || row.status),
      read_state: readState,
      read_state_label: readState === "read" ? "已读" : "未读"
    };
  });
  const filtered = messageType === "all"
    ? normalized
    : messageType === "read" || messageType === "unread"
      ? normalized.filter((row) => row.read_state === messageType)
      : messageType === "marked" || messageType === "problem"
        ? normalized.filter((row) => row.status === "problem")
      : normalized.filter((row) => row.message_type === messageType);
  const counts = filtered.reduce((acc, row) => {
    acc[row.message_type] = Number(acc[row.message_type] || 0) + 1;
    acc[row.read_state] = Number(acc[row.read_state] || 0) + 1;
    if (row.status === "problem") acc.marked = Number(acc.marked || 0) + 1;
    return acc;
  }, {});
  return {
    rows: filtered,
    total,
    page,
    pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
    counts,
    generated_at: new Date().toISOString()
  };
}

function enrichOrderLogisticsFromRawForMessage(row = {}) {
  const raw = parseJsonOrNull(row.raw_json) || {};
  const analytics = raw.analytics_data || raw.analytics || {};
  const deliveryMethod = raw.delivery_method || {};
  return {
    ...row,
    delivery_date_begin: row.delivery_date_begin || analytics.delivery_date_begin || raw.delivery_date_begin || "",
    delivery_date_end: row.delivery_date_end || analytics.delivery_date_end || raw.delivery_date_end || "",
    buyer_city: row.buyer_city || analytics.city || raw.customer?.address?.city || "",
    buyer_region: row.buyer_region || analytics.region || raw.customer?.address?.region || "",
    warehouse_name: row.warehouse_name || deliveryMethod.warehouse || analytics.warehouse || "",
    tpl_provider: row.tpl_provider || deliveryMethod.tpl_provider || analytics.tpl_provider || ""
  };
}

export async function previewCustomerMessageMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const orderId = Number(body.order_id || body.orderId || 0);
  if (!orderId) throw new Error("缺少订单 ID");
  const result = await customerMessagesMysql({ search: "", limit: 200, type: "all" });
  const row = result.rows.find((item) => Number(item.id) === orderId);
  if (!row) throw new Error("未找到订单");
  const type = String(body.type || body.message_type || row.message_type || "order_update");
  const templatesByScenario = await customerMessageTemplatesByScenarioMysql();
  return normalizeCustomerMessageRow(row, CUSTOMER_MESSAGE_TYPES.has(type) ? type : row.message_type, templatesByScenario);
}

const DEFAULT_CUSTOMER_MESSAGE_SCENARIOS = [
  { key: "order_created", label: "下单感谢" },
  { key: "order_update", label: "催单回复" },
  { key: "stall_comfort", label: "卡顿安抚" },
  { key: "delay_comfort", label: "延误解释" },
  { key: "pickup_notice", label: "到货取货" },
  { key: "review_request", label: "取货后求好评" }
];

let customerMessageTablesReadyMysql = false;

async function addCustomerMessageColumnMysql(tableName, columnName, definition) {
  try {
    await mysqlExecute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    if (!String(error?.message || "").toLowerCase().includes("duplicate column")) throw error;
  }
}

function customerMessageMysqlDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function ensureCustomerMessageTablesMysql() {
  if (customerMessageTablesReadyMysql) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS customer_message_shop_settings (
      shop_id INT NOT NULL PRIMARY KEY,
      chat_enabled TINYINT(1) NOT NULL DEFAULT 0,
      send_mode VARCHAR(32) NOT NULL DEFAULT 'draft',
      stall_hours INT NOT NULL DEFAULT 36,
      delay_hours_before_due INT NOT NULL DEFAULT 24,
      review_delay_hours INT NOT NULL DEFAULT 48,
      enabled_scenarios TEXT NULL,
      note TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS customer_message_templates (
      scenario VARCHAR(64) NOT NULL PRIMARY KEY,
      label VARCHAR(64) NOT NULL DEFAULT '',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      template_text TEXT NULL,
      template_translation TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS customer_message_records (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT NOT NULL DEFAULT 0,
      posting_number VARCHAR(128) NOT NULL DEFAULT '',
      shop_id INT NOT NULL DEFAULT 0,
      scenario VARCHAR(64) NOT NULL DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      read_state VARCHAR(32) NOT NULL DEFAULT 'unread',
      read_at DATETIME NULL,
      message_text TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_customer_message_records_order (order_id, scenario, id),
      KEY idx_customer_message_records_posting (posting_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS customer_chat_threads (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      shop_id INT NOT NULL DEFAULT 0,
      chat_id VARCHAR(128) NOT NULL DEFAULT '',
      customer_unique_id VARCHAR(128) NOT NULL DEFAULT '',
      posting_number VARCHAR(128) NOT NULL DEFAULT '',
      order_id BIGINT NOT NULL DEFAULT 0,
      title VARCHAR(255) NOT NULL DEFAULT '',
      last_message_text TEXT NULL,
      last_message_at DATETIME NULL,
      unread_count INT NOT NULL DEFAULT 0,
      chat_status VARCHAR(64) NOT NULL DEFAULT '',
      raw_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_customer_chat_thread (shop_id, chat_id),
      KEY idx_customer_chat_thread_posting (shop_id, posting_number),
      KEY idx_customer_chat_thread_customer (shop_id, customer_unique_id),
      KEY idx_customer_chat_thread_last (last_message_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS customer_chat_messages (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      shop_id INT NOT NULL DEFAULT 0,
      chat_id VARCHAR(128) NOT NULL DEFAULT '',
      message_id VARCHAR(128) NOT NULL DEFAULT '',
      direction VARCHAR(32) NOT NULL DEFAULT '',
      sender_name VARCHAR(128) NOT NULL DEFAULT '',
      message_text TEXT NULL,
      message_at DATETIME NULL,
      raw_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_customer_chat_message (shop_id, chat_id, message_id),
      KEY idx_customer_chat_message_thread (shop_id, chat_id, message_at),
      KEY idx_customer_chat_message_at (message_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await addCustomerMessageColumnMysql("customer_message_records", "read_state", "VARCHAR(32) NOT NULL DEFAULT 'unread'");
  await addCustomerMessageColumnMysql("customer_message_records", "read_at", "DATETIME NULL");
  await addCustomerMessageColumnMysql("customer_message_templates", "label", "VARCHAR(64) NOT NULL DEFAULT ''");
  await addCustomerMessageColumnMysql("customer_message_templates", "template_translation", "TEXT NULL");
  customerMessageTablesReadyMysql = true;
}

function defaultCustomerMessageTemplatesMysql() {
  return [
    {
      scenario: "order_created",
      label: "下单感谢",
      name: "下单感谢",
      enabled: true,
      template_text: "Здравствуйте!\nСпасибо за заказ {{posting_number}} ({{product_summary}}).\nМы его видим, всё в порядке — скоро передадим в обработку.\nМагазин: {{shop_name}}.\nЕсли по заказу что-то изменится, мы напишем.",
      template_translation: "您好！\n感谢您的订单 {{posting_number}}（{{product_summary}}）。\n我们已经看到订单了，目前一切正常，会尽快转入处理。\n店铺：{{shop_name}}。\n如果订单有任何变化，我们会再通知您。"
    },
    {
      scenario: "order_update",
      label: "催单回复",
      name: "催单回复",
      enabled: true,
      template_text: "Здравствуйте!\nПосмотрели заказ {{posting_number}} ({{product_summary}}). Сейчас статус: {{status_label}}.\nМагазин: {{shop_name}}.\nЕсли статус изменится, мы вам напишем.",
      template_translation: "您好！\n我们帮您查看了订单 {{posting_number}}（{{product_summary}}），当前状态是：{{status_label}}。\n店铺：{{shop_name}}。\n如果状态有更新，我们会及时告诉您。"
    },
    {
      scenario: "stall_comfort",
      label: "卡顿安抚",
      name: "卡顿安抚",
      enabled: true,
      template_text: "Здравствуйте!\nВидим, что заказ {{posting_number}} ({{product_summary}}) пока задержался на этапе: {{status_label}}.\nМы уже взяли заказ на контроль. Если движение не появится, дополнительно напишем в поддержку Ozon.\nПонимаем, что ждать неприятно. Будем держать вас в курсе.",
      template_translation: "您好！\n我们看到订单 {{posting_number}}（{{product_summary}}）暂时停在：{{status_label}}。\n这个订单我们已经在关注了。如果后续还没有变化，我们会继续联系 Ozon 支持确认。\n理解等待会让人着急，我们会持续跟进并同步给您。"
    },
    {
      scenario: "delay_comfort",
      label: "延误解释",
      name: "延误解释",
      enabled: true,
      template_text: "Здравствуйте!\nПо заказу {{posting_number}} ({{product_summary}}) есть задержка, извините, пожалуйста.\nСейчас статус: {{status_label}}.\nМы уже проверяем ситуацию и отправили запрос в поддержку Ozon по логистике.\nКак только появится обновление, сразу напишем вам.",
      template_translation: "您好！\n您的订单 {{posting_number}}（{{product_summary}}）目前有些延误，真的很抱歉。\n当前状态是：{{status_label}}。\n我们已经在核实，并向 Ozon 物流支持提交了查询。\n一有新的进展，我们会马上告知您。"
    },
    {
      scenario: "pickup_notice",
      label: "到货取货",
      name: "到货取货",
      enabled: true,
      template_text: "Здравствуйте!\nВаш заказ {{posting_number}} ({{product_summary}}) уже можно забрать.\nПроверьте, пожалуйста, код и адрес пункта выдачи в приложении Ozon.\nЛучше забрать в ближайшие дни, чтобы заказ не уехал обратно.\nСпасибо, что дождались.",
      template_translation: "您好！\n您的订单 {{posting_number}}（{{product_summary}}）已经可以取货了。\n请在 Ozon 应用里查看取货码和取货点地址。\n建议这几天方便时尽快领取，避免订单超期退回。\n谢谢您的等待。"
    },
    {
      scenario: "review_request",
      label: "取货后求好评",
      name: "取货后求好评",
      enabled: true,
      template_text: "Здравствуйте!\nСпасибо, что забрали заказ {{posting_number}} ({{product_summary}}).\nНадеемся, всё подошло и покупка будет полезной.\nЕсли будет минутка, будем рады отзыву на Ozon.\nА если что-то не так — просто напишите нам, разберёмся.",
      template_translation: "您好！\n感谢您领取订单 {{posting_number}}（{{product_summary}}）。\n希望商品合适，也能对您有帮助。\n如果您方便的话，我们会很感谢您在 Ozon 留下评价。\n如果有任何问题，也可以直接联系我们，我们会处理。"
    }
  ];
}

function splitCustomerMessageTemplateText(text = "", fallbackTranslation = "") {
  const value = String(text || "");
  const marker = /\n+\s*中文含义[:：]\s*/;
  const parts = value.split(marker);
  return {
    template_text: String(parts[0] || "").trim(),
    template_translation: String(parts[1] || fallbackTranslation || "").trim()
  };
}

function isLegacyCustomerMessageTemplateText(text = "") {
  const value = String(text || "");
  const hasChinese = /[\u3400-\u9fff]/.test(value);
  const hasCyrillic = /[А-Яа-яЁё]/.test(value);
  if (hasChinese && (!hasCyrillic || value.trim().startsWith("您好"))) return true;
  return [
    "Мы уже получили его и скоро передадим в обработку",
    "По заказу {{posting_number}} ({{product_summary}}) сейчас актуальный статус",
    "Приносим извинения за ожидание",
    "Приносим извинения за задержку по заказу",
    "уже доступен для получения",
    "Благодарим вас за покупку в нашем магазине"
  ].some((pattern) => value.includes(pattern));
}

function isLegacyCustomerMessageTemplateTranslation(text = "") {
  const value = String(text || "").trim();
  if (!value) return true;
  return [
    "感谢客户下单。语气轻一点",
    "客户催单时使用",
    "订单卡住时提前安抚",
    "订单确实延误时使用",
    "到货后提醒客户取货",
    "取货后轻轻求评价"
  ].some((pattern) => value.includes(pattern));
}

export async function customerMessageSettingsMysql() {
  ensureMysqlCutoverEnabled();
  await ensureCustomerMessageTablesMysql();
  const [shops, shopSettingRows, templateRows] = await Promise.all([
    shopsMysql(),
    mysqlQuery("SELECT * FROM customer_message_shop_settings"),
    mysqlQuery("SELECT * FROM customer_message_templates")
  ]);
  const shopSettings = new Map(shopSettingRows.map((row) => [Number(row.shop_id), row]));
  const templatesByScenario = mergeCustomerMessageTemplatesMysql(templateRows);
  return {
    scenarios: DEFAULT_CUSTOMER_MESSAGE_SCENARIOS,
    shops: shops.map((shop) => ({
      shop_id: Number(shop.id),
      shop_name: shop.name || shop.shop_name || "",
      chat_enabled: Boolean(Number(shopSettings.get(Number(shop.id))?.chat_enabled || 0)),
      send_mode: shopSettings.get(Number(shop.id))?.send_mode || "draft",
      enabled_scenarios: parseJsonOrNull(shopSettings.get(Number(shop.id))?.enabled_scenarios) || DEFAULT_CUSTOMER_MESSAGE_SCENARIOS.map((item) => item.key),
      stall_hours: Number(shopSettings.get(Number(shop.id))?.stall_hours || 48),
      delay_hours_before_due: Number(shopSettings.get(Number(shop.id))?.delay_hours_before_due || 24),
      review_delay_hours: Number(shopSettings.get(Number(shop.id))?.review_delay_hours || 24),
      note: shopSettings.get(Number(shop.id))?.note || ""
    })),
    templates: DEFAULT_CUSTOMER_MESSAGE_SCENARIOS.map((scenario) => templatesByScenario.get(scenario.key)).filter(Boolean)
  };
}

export async function updateCustomerMessageShopSettingMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureCustomerMessageTablesMysql();
  const shopId = Number(body.shop_id || body.shopId || 0);
  if (!shopId) throw new Error("缺少店铺 ID");
  await mysqlExecute(`
    INSERT INTO customer_message_shop_settings
      (shop_id, chat_enabled, send_mode, stall_hours, delay_hours_before_due, review_delay_hours, enabled_scenarios, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      chat_enabled = VALUES(chat_enabled),
      send_mode = VALUES(send_mode),
      stall_hours = VALUES(stall_hours),
      delay_hours_before_due = VALUES(delay_hours_before_due),
      review_delay_hours = VALUES(review_delay_hours),
      enabled_scenarios = VALUES(enabled_scenarios),
      note = VALUES(note)
  `, [
    shopId,
    body.chat_enabled ? 1 : 0,
    ["none", "draft", "confirm"].includes(String(body.send_mode || "")) ? String(body.send_mode) : "confirm",
    Math.max(1, Number(body.stall_hours || 48)),
    Math.max(1, Number(body.delay_hours_before_due || 24)),
    Math.max(1, Number(body.review_delay_hours || 24)),
    JSON.stringify(Array.isArray(body.enabled_scenarios) ? body.enabled_scenarios : DEFAULT_CUSTOMER_MESSAGE_SCENARIOS.map((item) => item.key)),
    String(body.note || "")
  ]);
  return { ok: true, settings: await customerMessageSettingsMysql() };
}

export async function updateCustomerMessageTemplateMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureCustomerMessageTablesMysql();
  const scenario = String(body.scenario || "").trim();
  if (!scenario) throw new Error("缺少消息场景");
  const fallback = defaultCustomerMessageTemplatesMysql().find((template) => template.scenario === scenario) || {};
  const splitTemplate = splitCustomerMessageTemplateText(body.template_text || fallback.template_text || "", fallback.template_translation || "");
  await mysqlExecute(`
    INSERT INTO customer_message_templates (scenario, label, enabled, template_text, template_translation)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      label = VALUES(label),
      enabled = VALUES(enabled),
      template_text = VALUES(template_text),
      template_translation = VALUES(template_translation)
  `, [
    scenario,
    String(body.label || body.name || fallback.label || scenario),
    body.enabled === false ? 0 : 1,
    splitTemplate.template_text,
    String(body.template_translation || splitTemplate.template_translation || fallback.template_translation || "").trim()
  ]);
  return { ok: true, settings: await customerMessageSettingsMysql() };
}

export async function recordCustomerMessageMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureCustomerMessageTablesMysql();
  const orderId = Number(body.order_id || body.orderId || 0);
  const scenario = String(body.scenario || body.message_type || "order_update");
  const orderRows = orderId ? await mysqlQuery("SELECT id, shop_id, posting_number FROM orders WHERE id = ? LIMIT 1", [orderId]) : [];
  const order = orderRows[0] || {};
  const status = String(body.status || "draft");
  const readState = String(body.read_state || body.readState || (status === "read" ? "read" : "unread"));
  await mysqlExecute(`
    INSERT INTO customer_message_records (order_id, posting_number, shop_id, scenario, status, read_state, read_at, message_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    orderId,
    String(body.posting_number || order.posting_number || ""),
    Number(body.shop_id || order.shop_id || 0),
    scenario,
    status,
    readState === "read" ? "read" : "unread",
    readState === "read" ? customerMessageMysqlDate() : null,
    String(body.message_text || body.customer_message || "")
  ]);
  return { ok: true };
}

export async function customerMessageCustomerOrdersMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  const shopId = Number(query.shop_id || query.shopId || 0);
  const customerId = String(query.customer_id || query.customerUniqueId || query.customer_unique_id || "").trim();
  if (!shopId || !customerId) return { rows: [] };
  const rows = await mysqlQuery(`
    SELECT o.id, o.shop_id, o.posting_number, o.status, o.tracking_stage, o.ordered_at, o.delivered_at,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), oi.ozon_sku) ORDER BY oi.id SEPARATOR ', ') AS product_names,
      GROUP_CONCAT(DISTINCT oi.ozon_sku ORDER BY oi.ozon_sku SEPARATOR ', ') AS skus,
      SUM(COALESCE(oi.quantity, 1)) AS item_quantity,
      MAX(op.image_url) AS image_url
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    WHERE o.shop_id = ? AND SUBSTRING_INDEX(o.posting_number, '-', 1) = ?
    GROUP BY o.id
    ORDER BY o.ordered_at DESC, o.id DESC
    LIMIT 30
  `, [shopId, customerId]);
  return {
    rows: rows.map((row) => ({
      ...row,
      status_label: orderCustomerStatusLabel(row),
      product_summary: customerMessageProductSummary(row),
      item_quantity: Number(row.item_quantity || 0),
      stock_fbp: Number(row.stock_fbp || 0),
      stock_fbs: Number(row.stock_fbs || 0)
    }))
  };
}

function firstTextValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const text = value.map((item) => String(item || "").trim()).filter(Boolean).join("\n").trim();
      if (text) return text;
      continue;
    }
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeCustomerChatTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return customerMessageMysqlDate(date);
}

function normalizeOzonChatThreadForMysql(shop, raw = {}) {
  const chat = raw.chat || raw.dialog || raw.thread || raw;
  const order = raw.order || raw.posting || raw.posting_info || {};
  const lastMessage = raw.last_message || raw.lastMessage || raw.message || {};
  const postingNumber = firstTextValue(raw.posting_number, raw.postingNumber, chat.posting_number, chat.postingNumber, raw.order_number, raw.orderNumber, raw.context?.order_number, raw.context?.orderNumber, chat.context?.order_number, chat.context?.orderNumber, order.posting_number, order.postingNumber, order.number);
  const chatId = firstTextValue(raw.chat_id, raw.chatId, chat.chat_id, chat.chatId, raw.id, chat.id, raw.dialog_id, raw.dialogId);
  const customerUniqueId = firstTextValue(raw.customer_id, raw.customerId, chat.customer_id, chat.customerId, raw.client_id, raw.clientId, raw.buyer_id, raw.buyerId, raw.customer?.id, chat.customer?.id, customerUniqueIdFromPosting(postingNumber));
  const title = firstTextValue(raw.title, chat.title, raw.subject, chat.subject, raw.product_name, raw.productName, order.product_name, order.productName, postingNumber, customerUniqueId);
  const lastText = firstTextValue(lastMessage.text, lastMessage.message, raw.last_message_text, raw.lastMessageText, chat.last_message_text, chat.lastMessageText, raw.last_text, raw.lastText);
  const lastAt = normalizeCustomerChatTimestamp(firstTextValue(lastMessage.created_at, lastMessage.createdAt, lastMessage.date, raw.last_message_at, raw.lastMessageAt, chat.last_message_at, chat.lastMessageAt, raw.updated_at, raw.updatedAt, chat.updated_at, chat.updatedAt, raw.created_at, raw.createdAt));
  return {
    shop_id: Number(shop.id || shop.shop_id || 0),
    chat_id: chatId,
    customer_unique_id: customerUniqueId,
    posting_number: postingNumber,
    title,
    last_message_text: lastText,
    last_message_at: lastAt,
    unread_count: Math.max(0, Number(raw.unread_count || raw.unreadCount || chat.unread_count || chat.unreadCount || raw.unread || 0)),
    chat_status: firstTextValue(raw.status, chat.status, raw.chat_status, raw.chatStatus, chat.chat_status, chat.chatStatus, raw.state, chat.state),
    raw_json: JSON.stringify(raw || {})
  };
}

function normalizeOzonChatMessageForMysql(shop, chatId, raw = {}, index = 0) {
  const message = raw.message || raw.item || raw;
  const id = firstTextValue(raw.message_id, raw.messageId, message.message_id, message.messageId, raw.id, message.id, raw.uuid, message.uuid, `${chatId}:${raw.created_at || raw.createdAt || raw.date || index}`);
  const senderType = String(raw.sender_type || raw.senderType || message.sender_type || message.senderType || raw.author_type || raw.authorType || raw.user?.type || message.user?.type || raw.type || "").toLowerCase();
  const isSeller = raw.is_seller === true || raw.from_seller === true || message.is_seller === true || message.from_seller === true || ["seller", "operator", "support", "store"].includes(senderType);
  const isCustomer = raw.is_customer === true || raw.from_customer === true || message.is_customer === true || message.from_customer === true || ["customer", "buyer", "client", "user"].includes(senderType);
  const direction = isSeller ? "seller" : isCustomer ? "customer" : "system";
  return {
    shop_id: Number(shop.id || shop.shop_id || 0),
    chat_id: String(chatId || ""),
    message_id: id,
    direction,
    sender_name: firstTextValue(raw.sender_name, raw.senderName, message.sender_name, message.senderName, raw.author_name, raw.authorName, raw.user?.name, message.user?.name),
    message_text: firstTextValue(raw.text, message.text, raw.body, message.body, raw.content, message.content, raw.value, message.value, raw.data, message.data),
    message_at: normalizeCustomerChatTimestamp(firstTextValue(raw.created_at, raw.createdAt, message.created_at, message.createdAt, raw.sent_at, raw.sentAt, raw.date, raw.time)),
    raw_json: JSON.stringify(raw || {})
  };
}

async function upsertCustomerChatThreadMysql(thread) {
  if (!thread.chat_id || !thread.shop_id) return false;
  const orderRows = thread.posting_number
    ? await mysqlQuery("SELECT id FROM orders WHERE shop_id = ? AND posting_number = ? LIMIT 1", [thread.shop_id, thread.posting_number])
    : [];
  const orderId = Number(orderRows[0]?.id || 0);
  await mysqlExecute(`
    INSERT INTO customer_chat_threads
      (shop_id, chat_id, customer_unique_id, posting_number, order_id, title, last_message_text, last_message_at, unread_count, chat_status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      customer_unique_id = VALUES(customer_unique_id),
      posting_number = VALUES(posting_number),
      order_id = VALUES(order_id),
      title = VALUES(title),
      last_message_text = VALUES(last_message_text),
      last_message_at = VALUES(last_message_at),
      unread_count = VALUES(unread_count),
      chat_status = VALUES(chat_status),
      raw_json = VALUES(raw_json)
  `, [
    thread.shop_id,
    thread.chat_id,
    thread.customer_unique_id,
    thread.posting_number,
    orderId,
    thread.title,
    thread.last_message_text,
    thread.last_message_at,
    thread.unread_count,
    thread.chat_status,
    thread.raw_json
  ]);
  return true;
}

async function upsertCustomerChatMessagesMysql(messages = []) {
  let saved = 0;
  for (const message of messages) {
    if (!message.shop_id || !message.chat_id || !message.message_id) continue;
    await mysqlExecute(`
      INSERT INTO customer_chat_messages
        (shop_id, chat_id, message_id, direction, sender_name, message_text, message_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        direction = VALUES(direction),
        sender_name = VALUES(sender_name),
        message_text = VALUES(message_text),
        message_at = VALUES(message_at),
        raw_json = VALUES(raw_json)
    `, [
      message.shop_id,
      message.chat_id,
      message.message_id,
      message.direction,
      message.sender_name,
      message.message_text,
      message.message_at,
      message.raw_json
    ]);
    saved += 1;
  }
  return saved;
}

async function refreshCustomerChatThreadLastMessageMysql(shopId, chatId) {
  const rows = await mysqlQuery(`
    SELECT message_text, message_at
    FROM customer_chat_messages
    WHERE shop_id = ? AND chat_id = ? AND COALESCE(message_text, '') <> ''
    ORDER BY COALESCE(message_at, created_at) DESC, id DESC
    LIMIT 1
  `, [Number(shopId || 0), String(chatId || "")]);
  const latest = rows[0];
  if (!latest) return;
  await mysqlExecute(`
    UPDATE customer_chat_threads
    SET last_message_text = ?, last_message_at = ?
    WHERE shop_id = ? AND chat_id = ?
  `, [latest.message_text || "", latest.message_at || null, Number(shopId || 0), String(chatId || "")]);
}

async function refreshCustomerChatThreadOrderContextMysql(shop, chatId, postingNumber) {
  const normalizedPosting = String(postingNumber || "").trim();
  if (!normalizedPosting) return;
  const shopId = Number(shop?.id || shop?.shop_id || 0);
  const orderRows = await mysqlQuery("SELECT id FROM orders WHERE shop_id = ? AND posting_number = ? LIMIT 1", [shopId, normalizedPosting]);
  const orderId = Number(orderRows[0]?.id || 0);
  await mysqlExecute(`
    UPDATE customer_chat_threads
    SET posting_number = ?,
      customer_unique_id = ?,
      order_id = ?
    WHERE shop_id = ? AND chat_id = ?
      AND (posting_number = '' OR posting_number IS NULL)
  `, [normalizedPosting, customerUniqueIdFromPosting(normalizedPosting), orderId, shopId, String(chatId || "")]);
}

export async function syncCustomerChatsMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureCustomerMessageTablesMysql();
  const targetShopId = Number(body.shop_id || body.shopId || 0);
  const settingsRows = await mysqlQuery("SELECT shop_id, chat_enabled FROM customer_message_shop_settings");
  const enabledShopIds = new Set(settingsRows.filter((row) => Number(row.chat_enabled)).map((row) => Number(row.shop_id)));
  const shops = (await shopsMysql()).filter((shop) => {
    const id = Number(shop.id || shop.shop_id || 0);
    if (targetShopId && id !== targetShopId) return false;
    return body.force ? true : enabledShopIds.has(id);
  });
  const limit = Math.min(Math.max(Number(body.limit || 50), 1), 100);
  const historyLimit = Math.min(Math.max(Number(body.history_limit || body.historyLimit || 50), 1), 100);
  const chatFilter = body.filter && typeof body.filter === "object" && !Array.isArray(body.filter)
    ? body.filter
    : body.chat_type || body.chatType
      ? { chat_status: body.chat_status || body.chatStatus || "Opened", chat_type: body.chat_type || body.chatType }
      : null;
  const result = { ok: true, shops: [], threads_synced: 0, messages_synced: 0, errors: [] };
  for (const shop of shops) {
    const shopResult = { shop_id: Number(shop.id), shop_name: shop.name || "", threads_synced: 0, messages_synced: 0, endpoint: "", errors: [] };
    try {
      const list = await fetchOzonChatList(shop, { limit, filter: chatFilter || undefined });
      shopResult.endpoint = list.endpoint || "";
      const chats = Array.isArray(list.chats) ? list.chats : [];
      for (const rawChat of chats) {
        const thread = normalizeOzonChatThreadForMysql(shop, rawChat);
        if (!thread.chat_id) continue;
        if (await upsertCustomerChatThreadMysql(thread)) {
          shopResult.threads_synced += 1;
          result.threads_synced += 1;
        }
        try {
          const historyCursor = firstTextValue(rawChat.last_message_id, rawChat.lastMessageId, rawChat.chat?.last_message_id, rawChat.chat?.lastMessageId);
          const history = await fetchOzonChatHistory(shop, thread.chat_id, { limit: historyLimit, from_message_id: historyCursor });
          const historyMessages = history.messages || [];
          const inferredPostingNumber = firstTextValue(...historyMessages.map((raw) => raw?.context?.order_number || raw?.context?.orderNumber || raw?.posting_number || raw?.postingNumber));
          if (inferredPostingNumber) await refreshCustomerChatThreadOrderContextMysql(shop, thread.chat_id, inferredPostingNumber);
          const messages = historyMessages.map((raw, index) => normalizeOzonChatMessageForMysql(shop, thread.chat_id, raw, index));
          const saved = await upsertCustomerChatMessagesMysql(messages);
          if (saved) await refreshCustomerChatThreadLastMessageMysql(shop.id, thread.chat_id);
          shopResult.messages_synced += saved;
          result.messages_synced += saved;
        } catch (error) {
          shopResult.errors.push(`chat ${thread.chat_id}: ${error?.message || error}`);
        }
      }
    } catch (error) {
      shopResult.errors.push(error?.message || String(error));
    }
    if (shopResult.errors.length) result.errors.push(...shopResult.errors.map((error) => `${shopResult.shop_name || shopResult.shop_id}: ${error}`));
    result.shops.push(shopResult);
  }
  return result;
}

export async function customerChatThreadMessagesMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureCustomerMessageTablesMysql();
  const shopId = Number(query.shop_id || query.shopId || 0);
  const chatId = String(query.chat_id || query.chatId || "").trim();
  if (!shopId || !chatId) return { rows: [], thread: null };
  const threadRows = await mysqlQuery("SELECT * FROM customer_chat_threads WHERE shop_id = ? AND chat_id = ? LIMIT 1", [shopId, chatId]);
  const rows = await mysqlQuery(`
    SELECT *
    FROM customer_chat_messages
    WHERE shop_id = ? AND chat_id = ?
    ORDER BY COALESCE(message_at, created_at) ASC, id ASC
    LIMIT 300
  `, [shopId, chatId]);
  return { thread: threadRows[0] || null, rows };
}

export async function customerChatThreadsMysql(query = {}) {
  ensureMysqlCutoverEnabled();
  await ensureCustomerMessageTablesMysql();
  const shopId = Number(query.shop_id || query.shopId || 0);
  const search = String(query.search || "").trim().toLowerCase();
  const where = ["1 = 1"];
  const params = [];
  if (shopId) {
    where.push("shop_id = ?");
    params.push(shopId);
  }
  if (search) {
    where.push("(LOWER(chat_id) LIKE ? OR LOWER(posting_number) LIKE ? OR LOWER(customer_unique_id) LIKE ? OR LOWER(COALESCE(last_message_text, '')) LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  const rows = await mysqlQuery(`
    SELECT *
    FROM customer_chat_threads
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(last_message_at, updated_at) DESC, id DESC
    LIMIT 200
  `, params);
  return { rows };
}

export async function sendCustomerMessageMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  if (process.env.OZON_CUSTOMER_MESSAGE_SEND_ENABLED !== "1") {
    return { ok: false, __status: 409, error: "真实发送开关未开启，当前仅允许手动测试和复制消息。" };
  }
  return { ok: false, __status: 501, error: "Ozon 聊天发送接口尚未绑定，已阻止发送。" };
}

export async function translateCustomerMessageRuMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  const text = String(body.text || body.message_text || "").trim();
  if (!text) return { text: "", translated_text: "" };
  return {
    text,
    translated_text: text,
    note: "俄语自动翻译接口尚未绑定，当前返回原文，避免误发错误翻译。"
  };
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
  assertFreshRecord(body, existing, "SKU 绑定已被其他用户保存，请刷新后再继续编辑");

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
