import crypto from "node:crypto";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";


const TAB_KEYS = ['overview', 'all_metrics', 'funnel', 'hot', 'search', 'abc', 'need_promotion', 'card_quality']
const COLLECT_RUN_PREFIX = 'seller_analytics_collect_run:'
const AUTH_BINDING_PREFIX = 'seller_analytics_auth_binding:'
const PLUGIN_STATUS_SETTING_KEY = 'seller_analytics_plugin_status'
const PLUGIN_PREPARE_SETTING_KEY = 'seller_analytics_plugin_prepare'
const DEFAULT_COLLECT_SOURCE_KEYS = TAB_KEYS
const DEFAULT_PAGE_LIMIT = 30
const COLLECT_REQUEST_STALE_MS = 120000
const DEFAULT_AUTO_COLLECT_MAX_PAGES = 500
const PLUGIN_STATUS_STALE_MS = 45000
const DIRECT_COLLECT_BATCH_SIZE = 9
const DIRECT_COLLECT_INITIAL_DELAY_MS = 250
const DIRECT_COLLECT_MIN_DELAY_MS = 180
const DIRECT_COLLECT_MAX_CONCURRENCY = 3
const DIRECT_COLLECT_AUTH_TTL_MS = 24 * 60 * 60 * 1000
const ABC_ANALYSIS_REQUEST_URL = 'https://seller.ozon.ru/api/site/seller-analytics/charts/v3/abc'
const OFFICIAL_ALL_METRICS = [
  'revenue',
  'sold_revenue',
  'revenue_share',
  'search_position',
  'total_views',
  'conv_views_to_order',
  'search_views',
  'conv_search_views_to_cart',
  'hits_search_to_cart',
  'conv_search_views_to_pdp',
  'pdp_views',
  'conv_pdp_views_to_cart',
  'hits_pdp_to_cart',
  'conv_total_views_to_cart',
  'total_hits_to_cart',
  'conv_hits_to_cart_to_order',
  'ordered_units',
  'delivered_units',
  'conv_order_to_purchase',
  'purchased_units',
  'cancelled_units',
  'returned_units',
  'cancelled_units_by_order_date',
  'returned_units_by_order_date',
  'avg_price',
  'discount_share_of_total_gmv',
  'discount_share_of_median_price',
  'price_index',
  'days_in_promo',
  'drr',
  'days_in_trafarets',
  'last_stock',
  'stockout_days',
  'reviews_count',
  'rating',
  'recommended_supply',
  'revenue_dynamics',
  'sold_revenue_dynamics',
  'revenue_share_dynamics',
  'search_position_dynamics',
  'total_views_dynamics',
  'conv_views_to_order_dynamics',
  'search_views_dynamics',
  'conv_search_views_to_cart_dynamics',
  'hits_search_to_cart_dynamics',
  'conv_search_views_to_pdp_dynamics',
  'pdp_views_dynamics',
  'conv_pdp_views_to_cart_dynamics',
  'hits_pdp_to_cart_dynamics',
  'conv_total_views_to_cart_dynamics',
  'total_hits_to_cart_dynamics',
  'conv_hits_to_cart_to_order_dynamics',
  'ordered_units_dynamics',
  'delivered_units_dynamics',
  'conv_order_to_purchase_dynamics',
  'purchased_units_dynamics',
  'cancelled_units_dynamics',
  'returned_units_dynamics',
  'cancelled_units_by_order_date_dynamics',
  'returned_units_by_order_date_dynamics',
  'avg_price_dynamics',
  'discount_share_of_total_gmv_dynamics',
  'discount_share_of_median_price_dynamics',
  'drr_dynamics'
]
const SOURCE_METRICS = {
  overview: ['revenue', 'sold_revenue', 'ordered_units', 'search_position', 'search_views', 'pdp_views', 'conv_pdp_views_to_cart', 'cancelled_units_by_order_date', 'returned_units_by_order_date', 'revenue_dynamics', 'sold_revenue_dynamics', 'ordered_units_dynamics', 'search_position_dynamics', 'search_views_dynamics', 'pdp_views_dynamics', 'conv_pdp_views_to_cart_dynamics', 'cancelled_units_by_order_date_dynamics', 'returned_units_by_order_date_dynamics'],
  all_metrics: OFFICIAL_ALL_METRICS,
  funnel: ['search_views', 'pdp_views', 'hits_pdp_to_cart', 'ordered_units', 'revenue', 'sold_revenue', 'search_views_dynamics', 'pdp_views_dynamics', 'hits_pdp_to_cart_dynamics', 'ordered_units_dynamics', 'revenue_dynamics', 'sold_revenue_dynamics'],
  hot: ['revenue', 'sold_revenue', 'ordered_units', 'revenue_dynamics', 'sold_revenue_dynamics', 'ordered_units_dynamics'],
  search: ['search_position', 'search_views', 'ordered_units'],
  abc: ['revenue', 'sold_revenue', 'ordered_units', 'revenue_share', 'total_views', 'avg_price', 'discount_share_of_total_gmv', 'discount_share_of_median_price', 'price_index', 'drr', 'stockout_days', 'last_stock', 'recommended_supply', 'revenue_dynamics', 'sold_revenue_dynamics', 'ordered_units_dynamics', 'revenue_share_dynamics', 'total_views_dynamics', 'avg_price_dynamics', 'discount_share_of_total_gmv_dynamics', 'discount_share_of_median_price_dynamics', 'drr_dynamics'],
  card_quality: ['pdp_views', 'conv_pdp_views_to_cart', 'ordered_units', 'revenue', 'sold_revenue', 'pdp_views_dynamics', 'conv_pdp_views_to_cart_dynamics', 'ordered_units_dynamics', 'revenue_dynamics', 'sold_revenue_dynamics'],
  need_promotion: ['search_position', 'total_views', 'pdp_views', 'conv_pdp_views_to_cart', 'ordered_units', 'search_position_dynamics', 'total_views_dynamics', 'pdp_views_dynamics', 'conv_pdp_views_to_cart_dynamics', 'ordered_units_dynamics']
}
const TAB_LABELS = {
  overview: '数据概览',
  all_metrics: '所有指标',
  funnel: '销售漏斗',
  hot: '热销榜单',
  search: '搜索',
  abc: 'ABC',
  need_promotion: '需要推广',
  card_quality: '卡片质量'
}
const SOURCE_KEY_TO_TAB_KEY = {
  tab_overview: 'overview',
  tab_all_metrics: 'all_metrics',
  tab_funnel: 'funnel',
  tab_hot: 'hot',
  tab_search: 'search',
  tab_abc: 'abc',
  need_promotion: 'need_promotion',
  card_quality: 'card_quality'
}
const SOURCE_LABEL_TO_TAB_KEY = {
  数据概览: 'overview',
  所有指标: 'all_metrics',
  销售漏斗: 'funnel',
  热销榜单: 'hot',
  搜索: 'search',
  ABC: 'abc',
  需要推广: 'need_promotion',
  卡片质量: 'card_quality'
}
const collectRunStateLocks = new Map()
const directCollectWorkers = new Set()
const directCollectRateState = new Map()
const analysisCache = new Map()
const ANALYSIS_CACHE_TTL_MS = 60000
const ANALYSIS_CACHE_MAX_ENTRIES = 80

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function safeString(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))))
}

function normalizeSellerAnalyticsImageUrl(value) {
  const text = safeString(value)
  if (!text) return ''
  if (/^data:image\//i.test(text)) return text
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return normalizeSellerAnalyticsImageUrl(parsed[0])
      if (parsed && typeof parsed === 'object') {
        return normalizeSellerAnalyticsImageUrl(parsed.url || parsed.image_url || parsed.imageUrl || parsed.src || parsed.link || parsed.href || '')
      }
    } catch {
      return text
    }
  }
  const first = text.includes('||')
    ? text.split(/\s*\|\|\s*/).map((item) => item.trim()).find(Boolean)
    : text.split(/\s*,\s*/).map((item) => item.trim()).find(Boolean)
  return safeString(first || text)
}

function serializeAnalysisProduct(product = {}) {
  return {
    ...product,
    image_url: normalizeSellerAnalyticsImageUrl(product.image_url)
  }
}

function clearAnalysisCache(tenantId = '') {
  const tenantPrefix = safeString(tenantId)
  if (!tenantPrefix) {
    analysisCache.clear()
    return
  }
  for (const key of analysisCache.keys()) {
    if (key.startsWith(`${tenantPrefix}:`)) analysisCache.delete(key)
  }
}

function stableCacheValue(value) {
  if (Array.isArray(value)) return value.map(stableCacheValue)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      const next = value[key]
      if (next !== undefined && next !== null && next !== '') result[key] = stableCacheValue(next)
      return result
    }, {})
  }
  return value
}

function analysisCacheKey(query = {}, tenantId = 'admin') {
  return `${safeString(tenantId) || 'admin'}:${JSON.stringify(stableCacheValue(query))}`
}

function getCachedAnalysis(query = {}, tenantId = 'admin') {
  const key = analysisCacheKey(query, tenantId)
  const cached = analysisCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.createdAt > ANALYSIS_CACHE_TTL_MS) {
    analysisCache.delete(key)
    return null
  }
  return cached.result
}

function setCachedAnalysis(query = {}, tenantId = 'admin', result) {
  const key = analysisCacheKey(query, tenantId)
  analysisCache.set(key, { createdAt: Date.now(), result })
  if (analysisCache.size <= ANALYSIS_CACHE_MAX_ENTRIES) return
  const firstKey = analysisCache.keys().next().value
  if (firstKey) analysisCache.delete(firstKey)
}

function normalizeAbcGrade(value) {
  const raw = safeString(value)
  return raw ? raw.toUpperCase() : ''
}

function stringifyJson(value) {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value)
  } catch (error) {
    return null
  }
}

function parseJson(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch (error) {
    return fallback
  }
}

function Between(from, to) {
  return { __sellerAnalyticsOp: 'between', from, to }
}

function In(values) {
  return { __sellerAnalyticsOp: 'in', values: Array.isArray(values) ? values : [] }
}

function mysqlDateValue(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ')
  return String(value).replace('T', ' ').replace(/\.\d{3}Z$/, '').slice(0, 19)
}

function buildWhereClause(where = {}, alias = '') {
  const clauses = []
  const params = []
  const prefix = alias ? `${alias}.` : ''
  for (const [key, value] of Object.entries(where || {})) {
    if (value && typeof value === 'object' && value.__sellerAnalyticsOp === 'in') {
      const values = value.values.map(safeString).filter(Boolean)
      if (!values.length) {
        clauses.push('1=0')
      } else {
        clauses.push(`${prefix}\`${key}\` IN (${values.map(() => '?').join(',')})`)
        params.push(...values)
      }
      continue
    }
    if (value && typeof value === 'object' && value.__sellerAnalyticsOp === 'between') {
      clauses.push(`${prefix}\`${key}\` BETWEEN ? AND ?`)
      params.push(mysqlDateValue(value.from), mysqlDateValue(value.to))
      continue
    }
    clauses.push(`${prefix}\`${key}\` = ?`)
    params.push(value)
  }
  return {
    sql: clauses.length ? clauses.join(' AND ') : '1=1',
    params
  }
}

function parseJsonColumn(value, fallback = null) {
  return parseJson(value, fallback)
}

const SELLER_ANALYTICS_SNAPSHOT_COLUMNS = [
  'id', 'tenant_id', 'store_id', 'source', 'source_button_label', 'source_button_key',
  'source_context', 'tab_key', 'page_url', 'request_url', 'request_method', 'request_headers',
  'request_body', 'response_status', 'response_headers', 'response_body', 'period_key',
  'captured_at', 'raw_data'
]
const SELLER_ANALYTICS_METRIC_COLUMNS = [
  'id', 'tenant_id', 'store_id', 'snapshot_id', 'tab_key', 'period_key', 'product_id',
  'offer_id', 'sku', 'product_name', 'image_url', 'order_amount', 'order_count',
  'impressions', 'card_views', 'search_position', 'add_to_cart', 'conversion_rate',
  'abc_revenue', 'abc_quantity', 'suggestion', 'raw_data', 'captured_at'
]
const SELLER_ANALYTICS_DIAGNOSIS_COLUMNS = [
  'id', 'tenant_id', 'shop_id', 'biz_date', 'period_key', 'product_id', 'sku', 'offer_id',
  'product_name', 'image_url', 'segment', 'priority', 'score', 'main_problem',
  'recommended_action', 'metrics_json', 'evidence_json', 'diagnosed_at'
]
const SELLER_ANALYTICS_TODO_COLUMNS = [
  'id', 'tenant_id', 'shop_id', 'biz_date', 'period_key', 'product_id', 'sku', 'offer_id',
  'product_name', 'image_url', 'segment', 'priority', 'score', 'problem_type',
  'recommended_action', 'evidence_json', 'status', 'owner', 'action_taken',
  'resolved_at', 'created_at', 'updated_at'
]

async function ensureSellerAnalyticsSchema() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(255) NOT NULL,
      tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin',
      value LONGTEXT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`key\`, tenant_id),
      KEY idx_settings_tenant_updated (tenant_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS seller_analytics_snapshots (
      id VARCHAR(80) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin',
      store_id VARCHAR(80) NULL,
      source VARCHAR(120) NULL,
      source_button_label VARCHAR(120) NULL,
      source_button_key VARCHAR(80) NULL,
      source_context LONGTEXT NULL,
      tab_key VARCHAR(80) NULL,
      page_url TEXT NULL,
      request_url TEXT NULL,
      request_method VARCHAR(16) NULL,
      request_headers LONGTEXT NULL,
      request_body LONGTEXT NULL,
      response_status INT NULL,
      response_headers LONGTEXT NULL,
      response_body LONGTEXT NULL,
      period_key VARCHAR(120) NULL,
      captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_data LONGTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_seller_snapshots_tenant_captured (tenant_id, captured_at),
      KEY idx_seller_snapshots_tenant_tab (tenant_id, tab_key, captured_at),
      KEY idx_seller_snapshots_tenant_period (tenant_id, period_key, captured_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS seller_analytics_product_metrics (
      id VARCHAR(80) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin',
      store_id VARCHAR(80) NULL,
      snapshot_id VARCHAR(80) NOT NULL,
      tab_key VARCHAR(80) NULL,
      period_key VARCHAR(120) NULL,
      product_id VARCHAR(128) NULL,
      offer_id VARCHAR(255) NULL,
      sku VARCHAR(128) NULL,
      product_name VARCHAR(512) NULL,
      image_url TEXT NULL,
      order_amount DECIMAL(18,4) NULL,
      order_count DECIMAL(18,4) NULL,
      impressions DECIMAL(18,4) NULL,
      card_views DECIMAL(18,4) NULL,
      search_position DECIMAL(18,4) NULL,
      add_to_cart DECIMAL(18,4) NULL,
      conversion_rate DECIMAL(18,4) NULL,
      abc_revenue VARCHAR(8) NULL,
      abc_quantity VARCHAR(8) NULL,
      suggestion TEXT NULL,
      raw_data LONGTEXT NULL,
      captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_seller_metrics_tenant_snapshot (tenant_id, snapshot_id),
      KEY idx_seller_metrics_tenant_tab (tenant_id, tab_key, captured_at),
      KEY idx_seller_metrics_sku (tenant_id, sku),
      KEY idx_seller_metrics_offer (tenant_id, offer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS seller_analytics_product_diagnosis (
      id VARCHAR(96) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin',
      shop_id VARCHAR(80) NULL,
      biz_date DATE NULL,
      period_key VARCHAR(120) NULL,
      product_id VARCHAR(128) NULL,
      sku VARCHAR(128) NULL,
      offer_id VARCHAR(255) NULL,
      product_name VARCHAR(512) NULL,
      image_url TEXT NULL,
      segment VARCHAR(80) NULL,
      priority VARCHAR(32) NULL,
      score DECIMAL(18,4) NULL,
      main_problem VARCHAR(255) NULL,
      recommended_action TEXT NULL,
      metrics_json LONGTEXT NULL,
      evidence_json LONGTEXT NULL,
      diagnosed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_seller_diagnosis_tenant_date (tenant_id, biz_date, priority),
      KEY idx_seller_diagnosis_product (tenant_id, sku, offer_id, product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS seller_analytics_operation_todos (
      id VARCHAR(96) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin',
      shop_id VARCHAR(80) NULL,
      biz_date DATE NULL,
      period_key VARCHAR(120) NULL,
      product_id VARCHAR(128) NULL,
      sku VARCHAR(128) NULL,
      offer_id VARCHAR(255) NULL,
      product_name VARCHAR(512) NULL,
      image_url TEXT NULL,
      segment VARCHAR(80) NULL,
      priority VARCHAR(32) NULL,
      score DECIMAL(18,4) NULL,
      problem_type VARCHAR(255) NULL,
      recommended_action TEXT NULL,
      evidence_json LONGTEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'open',
      owner VARCHAR(120) NULL,
      action_taken TEXT NULL,
      resolved_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_seller_todos_tenant_status_date (tenant_id, status, biz_date, priority),
      KEY idx_seller_todos_product (tenant_id, sku, offer_id, product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

function insertSql(table, columns) {
  return `
    INSERT INTO ${table} (${columns.map((column) => `\`${column}\``).join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${columns.filter((column) => column !== 'id').map((column) => `\`${column}\` = VALUES(\`${column}\`)`).join(', ')}
  `
}

function sellerAnalyticsEntityConfig(entityName) {
  if (entityName === 'Setting') return { table: 'settings', columns: null }
  if (entityName === 'SellerAnalyticsSnapshot') return { table: 'seller_analytics_snapshots', columns: SELLER_ANALYTICS_SNAPSHOT_COLUMNS }
  if (entityName === 'SellerAnalyticsProductMetric') return { table: 'seller_analytics_product_metrics', columns: SELLER_ANALYTICS_METRIC_COLUMNS }
  if (entityName === 'SellerAnalyticsProductDiagnosis') return { table: 'seller_analytics_product_diagnosis', columns: SELLER_ANALYTICS_DIAGNOSIS_COLUMNS }
  if (entityName === 'SellerAnalyticsOperationTodo') return { table: 'seller_analytics_operation_todos', columns: SELLER_ANALYTICS_TODO_COLUMNS }
  return { table: 'seller_analytics_product_metrics', columns: SELLER_ANALYTICS_METRIC_COLUMNS }
}

class SellerAnalyticsRepository {
  constructor(entityName) {
    this.entityName = entityName
  }

  async save(payload) {
    await ensureSellerAnalyticsSchema()
    if (Array.isArray(payload)) {
      for (const row of payload) await this.save(row)
      return payload
    }
    if (this.entityName === 'Setting') {
      await mysqlExecute(`
        INSERT INTO settings (\`key\`, tenant_id, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)
      `, [payload.key, payload.tenant_id || 'admin', payload.value, mysqlDateValue(payload.updated_at) || mysqlDateValue(new Date())])
      return payload
    }
    const { table, columns } = sellerAnalyticsEntityConfig(this.entityName)
    await mysqlExecute(insertSql(table, columns), columns.map((column) => {
      const value = payload[column]
      return ['captured_at', 'diagnosed_at', 'resolved_at', 'created_at', 'updated_at'].includes(column) ? mysqlDateValue(value) : value
    }))
    return payload
  }

  async findOne(options = {}) {
    const rows = await this.find({ ...options, take: 1 })
    return rows[0] || null
  }

  async find(options = {}) {
    await ensureSellerAnalyticsSchema()
    if (this.entityName === 'OnlineProduct') return this.findOnlineProducts()
    const { table } = sellerAnalyticsEntityConfig(this.entityName)
    const whereInput = Array.isArray(options.where) ? options.where : [options.where || {}]
    const order = options.order || {}
    const take = Math.max(1, Math.min(Number(options.take || 500), 5000))
    const unionRows = []
    for (const where of whereInput) {
      const { sql, params } = buildWhereClause(where)
      const orderBy = Object.entries(order).length
        ? ` ORDER BY ${Object.entries(order).map(([key, value]) => `\`${key}\` ${String(value).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`).join(', ')}`
        : ''
      const rows = await mysqlQuery(`SELECT * FROM ${table} WHERE ${sql}${orderBy} LIMIT ${take}`, params)
      unionRows.push(...rows)
    }
    const seen = new Set()
    return unionRows.filter((row) => {
      const key = `${row.key || row.id}:${row.tenant_id || ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async findOnlineProducts() {
    try {
      return await mysqlQuery(`
        SELECT
          CAST(id AS CHAR) AS id,
          CAST(shop_id AS CHAR) AS store_id,
          CAST(shop_id AS CHAR) AS shop_id,
          CAST(ozon_product_id AS CHAR) AS product_id,
          CAST(ozon_sku AS CHAR) AS sku,
          offer_id,
          name,
          COALESCE(primary_image, image_url) AS image_url,
          sale_price AS price,
          status,
          raw_json AS raw_data,
          updated_at,
          synced_at AS created_at
        FROM online_products
        WHERE COALESCE(archived, 0) = 0
        ORDER BY updated_at DESC, id DESC
        LIMIT 20000
      `)
    } catch {
      return []
    }
  }

  async count(options = {}) {
    await ensureSellerAnalyticsSchema()
    const { table } = sellerAnalyticsEntityConfig(this.entityName)
    const { sql, params } = buildWhereClause(options.where || {})
    const rows = await mysqlQuery(`SELECT COUNT(*) AS total FROM ${table} WHERE ${sql}`, params)
    return Number(rows[0]?.total || 0)
  }

  async delete(where = {}) {
    await ensureSellerAnalyticsSchema()
    if (this.entityName === 'Setting') {
      const { sql, params } = buildWhereClause(where)
      const result = await mysqlExecute(`DELETE FROM settings WHERE ${sql}`, params)
      return { affected: result.affectedRows || 0 }
    }
    const { table } = sellerAnalyticsEntityConfig(this.entityName)
    const { sql, params } = buildWhereClause(where)
    const result = await mysqlExecute(`DELETE FROM ${table} WHERE ${sql}`, params)
    return { affected: result.affectedRows || 0 }
  }

  createQueryBuilder(alias) {
    return new SellerAnalyticsQueryBuilder(alias)
  }
}

class SellerAnalyticsQueryBuilder {
  constructor(alias) {
    this.alias = alias || 'setting'
    this.whereParts = []
    this.params = {}
    this.limit = 50
  }

  where(sql, params = {}) {
    this.whereParts.push(sql)
    Object.assign(this.params, params)
    return this
  }

  andWhere(sql, params = {}) {
    return this.where(sql, params)
  }

  orderBy() {
    return this
  }

  take(limit) {
    this.limit = Math.max(1, Math.min(Number(limit || 50), 100))
    return this
  }

  async getMany() {
    await ensureSellerAnalyticsSchema()
    const tenantId = this.params.tenantId || 'admin'
    const prefix = String(this.params.prefix || `${COLLECT_RUN_PREFIX}%`).replace(/%$/, '')
    return mysqlQuery(`
      SELECT *
      FROM settings
      WHERE tenant_id = ? AND \`key\` LIKE ?
      ORDER BY updated_at DESC
      LIMIT ${this.limit}
    `, [tenantId, `${prefix}%`])
  }
}

const sellerAnalyticsDb = {
  entityMetadatas: [
    { name: 'SellerAnalyticsSnapshot' },
    { name: 'SellerAnalyticsProductMetric' },
    { name: 'SellerAnalyticsProductDiagnosis' },
    { name: 'SellerAnalyticsOperationTodo' },
    { name: 'OnlineProduct' }
  ],
  getRepository(entityName) {
    return new SellerAnalyticsRepository(entityName)
  }
}

function stableId(prefix, parts = []) {
  const hash = crypto.createHash('sha1').update(parts.map((part) => safeString(part)).join('|')).digest('hex').slice(0, 24)
  return `${prefix}_${hash}`
}

async function withCollectRunStateLock(tenantId, work) {
  const key = safeString(tenantId) || 'admin'
  const previous = collectRunStateLocks.get(key) || Promise.resolve()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => {}).then(() => gate)
  collectRunStateLocks.set(key, queued)
  await previous.catch(() => {})
  try {
    return await work()
  } finally {
    release()
    if (collectRunStateLocks.get(key) === queued) {
      collectRunStateLocks.delete(key)
    }
  }
}

function normalizeSellerAnalyticsUrl(value, pageUrl) {
  try {
    return new URL(safeString(value), safeString(pageUrl) || 'https://seller.ozon.ru').toString()
  } catch (error) {
    return ''
  }
}

function parsePositiveInteger(value, fallback, max = 100) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  const raw = safeString(value).toLowerCase()
  return ['1', 'true', 'yes', 'on', 'auto', 'full'].includes(raw)
}

function normalizeCompanyId(value) {
  const raw = safeString(value)
  if (!/^\d{4,12}$/.test(raw)) return ''
  return raw
}

function formatDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function dateDiffDays(from, to) {
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1)
}

function resolveCollectPeriod(payload = {}, now = new Date()) {
  const periodKey = safeString(payload.period_key || payload.periodKey || '7d') || '7d'
  const explicitFrom = safeString(payload.date_from || payload.dateFrom)
  const explicitTo = safeString(payload.date_to || payload.dateTo)
  const yesterday = addDays(now, -1)
  let from
  let to
  if (explicitFrom && explicitTo) {
    from = explicitFrom
    to = explicitTo
  } else if (periodKey === 'today') {
    from = formatDateOnly(now)
    to = from
  } else if (periodKey === 'yesterday') {
    from = formatDateOnly(yesterday)
    to = from
  } else if (periodKey === '28d') {
    to = formatDateOnly(yesterday)
    from = formatDateOnly(addDays(yesterday, -27))
  } else if (periodKey === 'quarter') {
    const month = yesterday.getMonth()
    const quarterStartMonth = Math.floor(month / 3) * 3
    from = formatDateOnly(new Date(yesterday.getFullYear(), quarterStartMonth, 1))
    to = formatDateOnly(yesterday)
  } else if (periodKey === 'year') {
    from = formatDateOnly(new Date(yesterday.getFullYear(), 0, 1))
    to = formatDateOnly(yesterday)
  } else if (periodKey === 'custom') {
    from = safeString(payload.date_from || payload.dateFrom)
    to = safeString(payload.date_to || payload.dateTo)
  } else {
    to = formatDateOnly(yesterday)
    from = formatDateOnly(addDays(yesterday, -6))
  }
  if (!from || !to) {
    const error = new Error('Missing collect period dates')
    error.statusCode = 400
    throw error
  }
  const days = dateDiffDays(from, to)
  const previousTo = formatDateOnly(addDays(new Date(`${from}T00:00:00`), -1))
  const previousFrom = formatDateOnly(addDays(new Date(`${previousTo}T00:00:00`), -(days - 1)))
  return {
    periodKey,
    current_period: { date_from: from, date_to: to },
    previous_period: { date_from: previousFrom, date_to: previousTo }
  }
}

function normalizeDateOnly(value) {
  const raw = safeString(value)
  if (!raw) return ''
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : ''
}

function getSnapshotPeriod(row) {
  const body = parseJson(row?.request_body, {}) || {}
  const period = body.current_period || body.currentPeriod || body.period || {}
  return {
    period_key: safeString(row?.period_key || body.period_key || body.periodKey),
    date_from: normalizeDateOnly(period.date_from || period.dateFrom),
    date_to: normalizeDateOnly(period.date_to || period.dateTo)
  }
}

function parsePageIndex(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function getSnapshotPageIndex(row) {
  const context = parseJson(row?.source_context, {}) || {}
  const endpointType = safeString(context.endpoint_type || context.endpointType)
  if (endpointType === 'totals') return null
  const contextPageIndex = parsePageIndex(context.page_index ?? context.pageIndex)
  if (contextPageIndex !== null) return contextPageIndex
  const body = parseJson(row?.request_body, {}) || {}
  const offset = parsePageIndex(body.offset)
  const limit = parsePositiveInteger(body.limit, DEFAULT_PAGE_LIMIT, 100)
  if (offset !== null && limit > 0) return Math.floor(offset / limit)
  return 0
}

function getHeaderValue(headersInput, name) {
  const headers = parseJson(headersInput, {}) || {}
  const target = safeString(name).toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (safeString(key).toLowerCase() === target) return safeString(value)
  }
  return ''
}

function getPayloadStoreId(payload = {}) {
  return safeString(payload.store_id || payload.storeId) ||
    normalizeCompanyId(getHeaderValue(payload.request_headers || payload.requestHeaders, 'x-o3-company-id'))
}

function getSnapshotEndpointType(row) {
  const context = parseJson(row?.source_context, {}) || {}
  const explicit = safeString(context.endpoint_type || context.endpointType)
  if (explicit) return explicit
  const requestUrl = safeString(row?.request_url || row?.requestUrl).toLowerCase()
  if (requestUrl.includes('/abc')) return 'abc_analysis'
  if (requestUrl.includes('/table/by_sku')) return 'by_sku'
  if (requestUrl.includes('/table/totals')) return 'totals'
  return ''
}

function snapshotsMatchCollectedPageScope(current, candidate) {
  if (!current || !candidate || current.id === candidate.id) return false
  if (safeString(current.tenant_id) !== safeString(candidate.tenant_id)) return false
  if (safeString(current.store_id) !== safeString(candidate.store_id)) return false
  if (safeString(current.tab_key) !== safeString(candidate.tab_key)) return false
  if (safeString(current.source_button_key || current.tab_key) !== safeString(candidate.source_button_key || candidate.tab_key)) return false
  if (getSnapshotEndpointType(current) !== getSnapshotEndpointType(candidate)) return false
  if (getSnapshotPageIndex(current) !== getSnapshotPageIndex(candidate)) return false

  const currentPeriod = getSnapshotPeriod(current)
  const candidatePeriod = getSnapshotPeriod(candidate)
  if (currentPeriod.period_key || candidatePeriod.period_key) {
    return currentPeriod.period_key === candidatePeriod.period_key
  }
  return currentPeriod.date_from === candidatePeriod.date_from && currentPeriod.date_to === candidatePeriod.date_to
}

async function deleteOlderCollectedPageSnapshots(db, snapshot) {
  const endpointType = getSnapshotEndpointType(snapshot)
  if (!endpointType) return { snapshotCount: 0, metricCount: 0 }
  const snapshotRepo = db.getRepository('SellerAnalyticsSnapshot')
  const metricRepo = db.getRepository('SellerAnalyticsProductMetric')
  const where = {
    tenant_id: snapshot.tenant_id,
    tab_key: snapshot.tab_key
  }
  if (snapshot.period_key) where.period_key = snapshot.period_key
  if (snapshot.store_id) where.store_id = snapshot.store_id
  const candidates = await snapshotRepo.find({ where, order: { captured_at: 'DESC' }, take: 5000 })
  const oldIds = candidates
    .filter((candidate) => snapshotsMatchCollectedPageScope(snapshot, candidate))
    .map((candidate) => candidate.id)
    .filter(Boolean)
  if (oldIds.length === 0) return { snapshotCount: 0, metricCount: 0 }
  const metricDelete = await metricRepo.delete({ tenant_id: snapshot.tenant_id, snapshot_id: In(oldIds) })
  const snapshotDelete = await snapshotRepo.delete({ tenant_id: snapshot.tenant_id, id: In(oldIds) })
  return {
    snapshotCount: Number(snapshotDelete.affected || 0),
    metricCount: Number(metricDelete.affected || 0)
  }
}

function getRequestedPageIndex(query = {}) {
  const pageIndex = parsePageIndex(query.page_index ?? query.pageIndex)
  if (pageIndex !== null) return pageIndex
  const page = Number.parseInt(String(query.page ?? ''), 10)
  return Number.isFinite(page) && page > 0 ? page - 1 : null
}

function snapshotMatchesPage(row, query = {}) {
  const requestedPageIndex = getRequestedPageIndex(query)
  if (requestedPageIndex === null) return true
  const context = parseJson(row?.source_context, {}) || {}
  const endpointType = safeString(context.endpoint_type || context.endpointType)
  if (endpointType === 'totals') return true
  return getSnapshotPageIndex(row) === requestedPageIndex
}

function snapshotMatchesPeriod(row, query = {}) {
  const queryPeriodKey = safeString(query.period_key || query.periodKey)
  const queryFrom = normalizeDateOnly(query.date_from || query.dateFrom)
  const queryTo = normalizeDateOnly(query.date_to || query.dateTo)
  if (!queryPeriodKey && !queryFrom && !queryTo) return true
  const snapshotPeriod = getSnapshotPeriod(row)
  if (queryFrom || queryTo) {
    return (!queryFrom || snapshotPeriod.date_from === queryFrom) && (!queryTo || snapshotPeriod.date_to === queryTo)
  }
  return !queryPeriodKey || snapshotPeriod.period_key === queryPeriodKey
}

function getRunSourceKeys(run) {
  return Array.from(new Set((run?.requests || [])
    .map((item) => safeString(item.source_key || item.sourceKey))
    .filter(Boolean)))
}

function getRunPageIndexes(run) {
  return Array.from(new Set((run?.requests || [])
    .filter((item) => item.endpoint_type === 'by_sku')
    .map((item) => parsePageIndex(item.page_index ?? item.pageIndex))
    .filter((value) => value !== null)))
}

function includesAll(source, required) {
  const set = new Set(source)
  return required.every((item) => set.has(item))
}

function collectRunMatchesRequest(run, period, requests, storeId = '') {
  if (!['pending', 'running'].includes(run?.status)) return false
  if (run.current_period?.date_from !== period.current_period.date_from || run.current_period?.date_to !== period.current_period.date_to) return false
  if (safeString(run.store_id || run.storeId) !== safeString(storeId)) return false
  const requestedSources = Array.from(new Set(requests.map((item) => item.source_key).filter(Boolean)))
  const requestedPages = Array.from(new Set(requests
    .filter((item) => item.endpoint_type === 'by_sku')
    .map((item) => parsePageIndex(item.page_index))
    .filter((value) => value !== null)))
  return includesAll(getRunSourceKeys(run), requestedSources) && includesAll(getRunPageIndexes(run), requestedPages)
}

function getSettingKeyForCollectRun(id) {
  return `${COLLECT_RUN_PREFIX}${id}`
}

function getSettingKeyForAuthBinding(storeId) {
  return `${AUTH_BINDING_PREFIX}${safeString(storeId) || 'default'}`
}

function parseSettingValue(row) {
  return parseJson(row?.value, null)
}

function sanitizeAuthHeaders(headers = {}) {
  const allowed = new Set([
    'accept',
    'accept-language',
    'content-type',
    'x-o3-app-name',
    'x-o3-company-id',
    'x-o3-language',
    'x-o3-page-type',
    'user-agent'
  ])
  const result = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = String(key || '').trim()
    const lowerKey = normalizedKey.toLowerCase()
    if (!normalizedKey || !allowed.has(lowerKey)) continue
    result[normalizedKey] = String(value || '')
  }
  return result
}

function normalizeAuthBinding(payload = {}, tenantId = 'admin') {
  const storeId = safeString(payload.store_id || payload.storeId || payload.company_id || payload.companyId || payload.current_company_id || payload.currentCompanyId)
  const cookie = safeString(payload.cookie || payload.cookie_header || payload.cookieHeader)
  const now = new Date().toISOString()
  return {
    tenant_id: safeString(payload.tenant_id || payload.tenantId || tenantId) || 'admin',
    store_id: storeId,
    company_id: storeId,
    shop_name: safeString(payload.shop_name || payload.shopName),
    cookie,
    headers: sanitizeAuthHeaders(payload.headers || payload.request_headers || payload.requestHeaders),
    bound_at: mysqlDateValue(payload.bound_at || payload.boundAt) || now,
    updated_at: now,
    last_ok_at: mysqlDateValue(payload.last_ok_at || payload.lastOkAt) || '',
    last_error: safeString(payload.last_error || payload.lastError),
    last_status: Number(payload.last_status || payload.lastStatus || 0) || 0,
    source: safeString(payload.source || 'plugin-cookie-binding') || 'plugin-cookie-binding'
  }
}

function publicAuthBinding(binding = null) {
  if (!binding) return null
  const updatedMs = binding.updated_at ? new Date(binding.updated_at).getTime() : 0
  const stale = !updatedMs || Date.now() - updatedMs > DIRECT_COLLECT_AUTH_TTL_MS
  return {
    bound: Boolean(binding.cookie),
    store_id: binding.store_id || binding.company_id || '',
    company_id: binding.company_id || binding.store_id || '',
    shop_name: binding.shop_name || '',
    updated_at: binding.updated_at || '',
    bound_at: binding.bound_at || '',
    last_ok_at: binding.last_ok_at || '',
    last_error: binding.last_error || '',
    last_status: binding.last_status || 0,
    stale
  }
}

function emptyAuthBindingStatus(error = null) {
  return {
    bound: false,
    store_id: '',
    company_id: '',
    shop_name: '',
    updated_at: '',
    bound_at: '',
    last_ok_at: '',
    last_error: error ? safeString(error.message || error) : '',
    last_status: 0,
    stale: true
  }
}

async function saveAuthBinding(db, payload = {}, tenantId = 'admin') {
  const binding = normalizeAuthBinding(payload, tenantId)
  if (!binding.store_id) {
    const error = new Error('Missing Ozon company id for auth binding')
    error.statusCode = 400
    throw error
  }
  if (!binding.cookie) {
    const error = new Error('Missing Ozon cookie for auth binding')
    error.statusCode = 400
    throw error
  }
  const repo = db.getRepository('Setting')
  await repo.save({
    key: getSettingKeyForAuthBinding(binding.store_id),
    tenant_id: tenantId,
    value: stringifyJson(binding),
    updated_at: binding.updated_at
  })
  return publicAuthBinding(binding)
}

async function getAuthBinding(db, storeId = '', tenantId = 'admin') {
  const id = safeString(storeId)
  if (!id) return null
  const repo = db.getRepository('Setting')
  const row = await repo.findOne({ where: { key: getSettingKeyForAuthBinding(id), tenant_id: tenantId } })
  const binding = normalizeAuthBinding(parseSettingValue(row), tenantId)
  if (!binding.cookie || !binding.store_id) return null
  const updatedMs = binding.updated_at ? new Date(binding.updated_at).getTime() : 0
  if (!updatedMs || Date.now() - updatedMs > DIRECT_COLLECT_AUTH_TTL_MS) return null
  return binding
}

async function authBindingStatus(db, query = {}, tenantId = 'admin') {
  try {
    const storeId = safeString(query.store_id || query.storeId || query.shop_id || query.shopId || query.company_id || query.companyId)
    if (!storeId) return emptyAuthBindingStatus()
    const repo = db.getRepository('Setting')
    const row = await repo.findOne({ where: { key: getSettingKeyForAuthBinding(storeId), tenant_id: tenantId } })
    const binding = normalizeAuthBinding(parseSettingValue(row), tenantId)
    if (!binding.cookie || !binding.store_id) return emptyAuthBindingStatus()
    return publicAuthBinding(binding) || emptyAuthBindingStatus()
  } catch (error) {
    console.warn('seller analytics auth binding status failed', error)
    return emptyAuthBindingStatus(error)
  }
}

async function savePluginStatus(db, payload = {}, tenantId = 'admin') {
  const repo = db.getRepository('Setting')
  const sellerTab = payload?.seller_tab && typeof payload.seller_tab === 'object'
    ? {
        id: Number(payload.seller_tab.id || 0) || null,
        title: safeString(payload.seller_tab.title),
        url: safeString(payload.seller_tab.url)
      }
    : null
  const status = {
    tenant_id: tenantId,
    seller_missing: payload?.seller_missing === true,
    polling_enabled: payload?.polling_enabled === true,
    plugin_version: safeString(payload?.plugin_version),
    current_company_id: safeString(payload?.current_company_id || payload?.company_id || payload?.store_id),
    seller_tab: sellerTab,
    synced_at: mysqlDateValue(payload?.synced_at) || new Date().toISOString(),
    synced_at_ms: Number(payload?.synced_at_ms || Date.now())
  }
  await repo.save({
    key: PLUGIN_STATUS_SETTING_KEY,
    tenant_id: tenantId,
    value: stringifyJson(status),
    updated_at: new Date()
  })
  return status
}

async function getPluginStatus(db, tenantId = 'admin') {
  const repo = db.getRepository('Setting')
  const row = await repo.findOne({ where: { key: PLUGIN_STATUS_SETTING_KEY, tenant_id: tenantId } })
  const status = parseSettingValue(row)
  if (!status) {
    return {
      ok: false,
      code: 'plugin_offline',
      message: '还没有收到店铺分析插件的状态，请先打开插件和 Ozon 分析页。',
      last_seen_at: null,
      plugin_online: false
    }
  }
  const lastSeenAt = safeString(status.synced_at || row?.updated_at)
  const lastSeenMs = Number(status.synced_at_ms || 0) || (lastSeenAt ? new Date(lastSeenAt).getTime() : 0)
  const pluginOnline = Boolean(lastSeenMs && (Date.now() - lastSeenMs) <= PLUGIN_STATUS_STALE_MS)
  return {
    ...status,
    last_seen_at: lastSeenAt || null,
    plugin_online: pluginOnline,
    stale: !pluginOnline
  }
}

async function validatePluginStatus(db, query = {}, tenantId = 'admin') {
  const status = await getPluginStatus(db, tenantId)
  const expectedStoreId = safeString(query.store_id || query.storeId || query.company_id || query.companyId || query.shop_id || query.shopId)
  const expectedShopName = safeString(query.shop_name || query.shopName)
  const expectedLabel = expectedShopName || (expectedStoreId ? `店铺 ${expectedStoreId}` : '当前店铺')

  if (!status.plugin_online) {
    return {
      ...status,
      ok: false,
      code: 'plugin_offline',
      message: '店铺分析插件暂时没有连上 ERP。',
      detail: '请确认插件已安装并保持启用，然后打开对应店铺的 seller.ozon.ru/app/analytics 页面，等待几秒后再试。'
    }
  }
  if (status.seller_missing || !status.seller_tab?.url) {
    return {
      ...status,
      ok: false,
      code: 'seller_tab_missing',
      message: '插件还没有找到 Ozon 分析页面。',
      detail: '请先打开对应店铺的 seller.ozon.ru/app/analytics 页面，再回来启动采集。'
    }
  }
  if (!expectedStoreId) {
    return {
      ...status,
      ok: false,
      code: 'missing_expected_store',
      message: '当前还没有选中可验证的店铺。',
      detail: '请先在数据分析页面选择店铺，再启动采集。'
    }
  }
  if (!status.current_company_id) {
    return {
      ...status,
      ok: false,
      code: 'missing_plugin_company',
      message: '插件已经连上 Ozon 分析页，但还没识别到当前店铺。',
      detail: '请在 Ozon 分析页停留几秒，必要时刷新页面后再试。'
    }
  }
  if (safeString(status.current_company_id) !== expectedStoreId) {
    return {
      ...status,
      ok: false,
      code: 'company_mismatch',
      message: `当前插件连接的店铺和 ERP 选择的 ${expectedLabel} 不一致。`,
      detail: `ERP 期望店铺 ID：${expectedStoreId}；插件当前店铺 ID：${status.current_company_id}。请切到正确的 Ozon 店铺分析页后再启动采集。`,
      expected_store_id: expectedStoreId
    }
  }
  return {
    ...status,
    ok: true,
    code: 'ready',
    message: `插件校验通过，当前店铺和 ERP 里的 ${expectedLabel} 一致。`,
    detail: '可以开始采集。',
    expected_store_id: expectedStoreId
  }
}

function normalizePrepareRequest(value = null) {
  if (!value || typeof value !== 'object') return null
  return {
    id: safeString(value.id),
    tenant_id: safeString(value.tenant_id || value.tenantId || 'admin') || 'admin',
    status: safeString(value.status || 'pending') || 'pending',
    expected_store_id: safeString(value.expected_store_id || value.expectedStoreId || value.store_id || value.storeId || value.company_id || value.companyId),
    expected_shop_name: safeString(value.expected_shop_name || value.expectedShopName || value.shop_name || value.shopName),
    target_url: safeString(value.target_url || value.targetUrl) || 'https://seller.ozon.ru/app/analytics/graphs',
    current_company_id: safeString(value.current_company_id || value.currentCompanyId),
    error: safeString(value.error),
    created_at: mysqlDateValue(value.created_at || value.createdAt) || new Date().toISOString(),
    updated_at: mysqlDateValue(value.updated_at || value.updatedAt) || new Date().toISOString()
  }
}

async function getPluginPrepareRequest(db, tenantId = 'admin') {
  const repo = db.getRepository('Setting')
  const row = await repo.findOne({ where: { key: PLUGIN_PREPARE_SETTING_KEY, tenant_id: tenantId } })
  return normalizePrepareRequest(parseSettingValue(row))
}

async function savePluginPrepareRequest(db, request, tenantId = 'admin') {
  const repo = db.getRepository('Setting')
  const next = normalizePrepareRequest({ ...request, tenant_id: tenantId, updated_at: new Date().toISOString() })
  await repo.save({
    key: PLUGIN_PREPARE_SETTING_KEY,
    tenant_id: tenantId,
    value: stringifyJson(next),
    updated_at: new Date()
  })
  return next
}

async function preparePlugin(db, payload = {}, tenantId = 'admin') {
  const now = new Date().toISOString()
  const request = {
    id: newId('sap'),
    tenant_id: tenantId,
    status: 'pending',
    expected_store_id: safeString(payload.store_id || payload.storeId || payload.company_id || payload.companyId || payload.shop_id || payload.shopId),
    expected_shop_name: safeString(payload.shop_name || payload.shopName),
    target_url: safeString(payload.target_url || payload.targetUrl) || 'https://seller.ozon.ru/app/analytics/graphs',
    current_company_id: '',
    error: '',
    created_at: now,
    updated_at: now
  }
  return savePluginPrepareRequest(db, request, tenantId)
}

async function claimPluginPrepareRequest(db, tenantId = 'admin') {
  const request = await getPluginPrepareRequest(db, tenantId)
  if (!request || !['pending', 'running'].includes(request.status)) return null
  return savePluginPrepareRequest(db, { ...request, status: 'running', error: '' }, tenantId)
}

async function finishPluginPrepareRequest(db, payload = {}, tenantId = 'admin') {
  const request = await getPluginPrepareRequest(db, tenantId)
  if (!request) return null
  const success = payload?.success !== false
  const currentCompanyId = safeString(payload.current_company_id || payload.currentCompanyId || payload.company_id || payload.companyId)
  const expectedStoreId = safeString(request.expected_store_id)
  const mismatch = success && expectedStoreId && currentCompanyId && expectedStoreId !== currentCompanyId
  return savePluginPrepareRequest(db, {
    ...request,
    status: success ? (mismatch ? 'mismatch' : 'ready') : 'failed',
    current_company_id: currentCompanyId,
    error: success ? '' : safeString(payload.error || 'PREPARE_FAILED')
  }, tenantId)
}

async function saveCollectRunState(db, run) {
  const repo = db.getRepository('Setting')
  const key = getSettingKeyForCollectRun(run.id)
  await repo.save({
    key,
    tenant_id: run.tenant_id || 'admin',
    value: stringifyJson(run),
    updated_at: new Date()
  })
  return run
}

async function loadCollectRunState(db, id, tenantId = 'admin') {
  const repo = db.getRepository('Setting')
  const row = await repo.findOne({ where: { key: getSettingKeyForCollectRun(id), tenant_id: tenantId } })
  return parseSettingValue(row)
}

async function listCollectRuns(db, query = {}, tenantId = 'admin') {
  const repo = db.getRepository('Setting')
  const take = Math.min(Math.max(Number(query.limit || 50), 1), 100)
  const rows = await repo
    .createQueryBuilder('setting')
    .where('setting.tenant_id = :tenantId', { tenantId })
    .andWhere('setting.key LIKE :prefix', { prefix: `${COLLECT_RUN_PREFIX}%` })
    .orderBy('setting.updated_at', 'DESC')
    .take(take)
    .getMany()
  const storeId = safeString(query.store_id || query.storeId || query.shop_id || query.shopId)
  return rows
    .map(parseSettingValue)
    .filter(Boolean)
    .filter((run) => !storeId || safeString(run.store_id || run.storeId) === storeId)
}

function buildCollectRequestBody(sourceKey, endpointType, period, pageIndex = 0, limit = DEFAULT_PAGE_LIMIT) {
  const metrics = SOURCE_METRICS[sourceKey] || []
  const sortKey = sourceKey === 'search'
    ? 'search_views_sort'
    : sourceKey === 'need_promotion'
      ? 'total_views_sort'
      : 'revenue_sort'
  const body = {
    current_period: period.current_period,
    previous_period: period.previous_period,
    filters: { desc_type_ids: [], category_3_ids: [], category_2_ids: [] },
    metrics
  }
  if (endpointType === 'by_sku') {
    body.limit = String(limit)
    body.offset = String(pageIndex * limit)
    body.sort = {
      key: sortKey,
      order: 'desc'
    }
  }
  return body
}

function buildAbcAnalysisRequestBody(period, skus = []) {
  return {
    period: {
      date_from: period.current_period.date_from,
      date_to: period.current_period.date_to
    },
    skus,
    use_realization_price: false
  }
}

function buildCollectRequestHeaders(payload = {}) {
  const companyId = normalizeCompanyId(payload.company_id || payload.companyId || payload.store_client_id || payload.storeClientId)
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-Hans',
    'Content-Type': 'application/json',
    'X-O3-App-Name': 'seller-ui',
    'X-O3-Language': 'zh-Hans',
    'X-O3-Page-Type': 'analytics_graph'
  }
  if (companyId) headers['X-O3-Company-Id'] = companyId
  return headers
}

function buildCollectRequests(payload = {}, period) {
  const sourceKeys = Array.isArray(payload.source_keys || payload.sourceKeys)
    ? payload.source_keys || payload.sourceKeys
    : DEFAULT_COLLECT_SOURCE_KEYS
  const normalizedSourceKeys = sourceKeys.map((key) => safeString(key)).filter((key) => SOURCE_METRICS[key])
  const autoAllPages = parseBoolean(payload.auto_all_pages ?? payload.autoAllPages ?? payload.full_store ?? payload.fullStore)
  const pages = autoAllPages ? 1 : parsePositiveInteger(payload.pages, 1, 10)
  const singlePage = Number.parseInt(String(payload.page ?? payload.current_page ?? payload.currentPage ?? ''), 10)
  const pageIndexes = !autoAllPages && Number.isFinite(singlePage) && singlePage > 0
    ? [singlePage - 1]
    : Array.from({ length: pages }, (_, index) => index)
  const limit = parsePositiveInteger(payload.limit, DEFAULT_PAGE_LIMIT, 100)
  const requestHeaders = buildCollectRequestHeaders(payload)
  const maxPages = parsePositiveInteger(payload.max_pages ?? payload.maxPages, DEFAULT_AUTO_COLLECT_MAX_PAGES, DEFAULT_AUTO_COLLECT_MAX_PAGES)
  const requests = []
  for (const sourceKey of normalizedSourceKeys) {
    requests.push({
      id: newId('sar'),
      source_key: sourceKey,
      source_label: TAB_LABELS[sourceKey] || sourceKey,
      endpoint_type: 'totals',
      request_url: 'https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/totals',
      request_method: 'POST',
      request_headers: requestHeaders,
      request_body: buildCollectRequestBody(sourceKey, 'totals', period, 0, limit),
      status: 'pending',
      attempts: 0
    })
    for (const pageIndex of pageIndexes) {
      requests.push({
        id: newId('sar'),
        source_key: sourceKey,
        source_label: TAB_LABELS[sourceKey] || sourceKey,
        endpoint_type: 'by_sku',
        page_index: pageIndex,
        auto_all_pages: autoAllPages,
        max_pages: maxPages,
        limit,
        request_url: 'https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/by_sku',
        request_method: 'POST',
        request_headers: requestHeaders,
        request_body: buildCollectRequestBody(sourceKey, 'by_sku', period, pageIndex, limit),
        status: 'pending',
        attempts: 0
      })
    }
  }
  return requests
}

function normalizeProbeHeaders(headers = {}) {
  const result = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = String(key || '').trim()
    const lowerKey = normalizedKey.toLowerCase()
    if (!normalizedKey || ['host', 'content-length', 'connection'].includes(lowerKey)) continue
    result[normalizedKey] = String(value || '')
  }
  return result
}

async function probeSellerAnalyticsAuth(payload = {}) {
  const period = resolveCollectPeriod({
    period_key: payload.period_key || payload.periodKey || 'yesterday',
    date_from: payload.date_from || payload.dateFrom,
    date_to: payload.date_to || payload.dateTo
  })
  const companyId = safeString(payload.company_id || payload.companyId || payload.current_company_id || payload.currentCompanyId)
  const cookie = safeString(payload.cookie || payload.cookie_header || payload.cookieHeader)
  if (!cookie) {
    const error = new Error('Missing Ozon cookie')
    error.statusCode = 400
    throw error
  }
  const headers = {
    ...buildCollectRequestHeaders({ company_id: companyId }),
    ...normalizeProbeHeaders(payload.headers || payload.request_headers || payload.requestHeaders),
    Cookie: cookie
  }
  if (companyId) headers['X-O3-Company-Id'] = companyId
  const response = await fetch('https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/totals', {
    method: 'POST',
    headers,
    body: stringifyJson(buildCollectRequestBody('overview', 'totals', period, 0, DEFAULT_PAGE_LIMIT)),
    signal: AbortSignal.timeout(20000)
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch (error) {}
  return {
    ok: response.ok,
    status: response.status,
    status_text: response.statusText,
    company_id: companyId,
    period_key: period.periodKey,
    current_period: period.current_period,
    content_type: response.headers.get('content-type') || '',
    response_keys: json && typeof json === 'object' ? Object.keys(json).slice(0, 20) : [],
    preview: json ? '' : text.slice(0, 500),
    has_json: Boolean(json)
  }
}

function directRateKey(tenantId, storeId) {
  return `${safeString(tenantId) || 'admin'}:${safeString(storeId) || 'default'}`
}

function getDirectRateState(tenantId, storeId) {
  const key = directRateKey(tenantId, storeId)
  const current = directCollectRateState.get(key) || {
    delay_ms: DIRECT_COLLECT_INITIAL_DELAY_MS,
    concurrency: 2,
    consecutive_success: 0,
    consecutive_errors: 0,
    last_status: 0
  }
  current.delay_ms = Math.max(DIRECT_COLLECT_MIN_DELAY_MS, Number(current.delay_ms || DIRECT_COLLECT_INITIAL_DELAY_MS))
  current.concurrency = Math.min(
    DIRECT_COLLECT_MAX_CONCURRENCY,
    Math.max(1, Number(current.concurrency || 2))
  )
  directCollectRateState.set(key, current)
  return current
}

function tuneDirectRate(tenantId, storeId, status, ok) {
  const state = getDirectRateState(tenantId, storeId)
  state.last_status = Number(status || 0)
  if (ok) {
    state.consecutive_success = Number(state.consecutive_success || 0) + 1
    state.consecutive_errors = 0
    state.delay_ms = Math.max(DIRECT_COLLECT_MIN_DELAY_MS, Math.round(Number(state.delay_ms || DIRECT_COLLECT_INITIAL_DELAY_MS) * 0.82))
    if (state.consecutive_success >= 8) {
      state.concurrency = Math.min(DIRECT_COLLECT_MAX_CONCURRENCY, Number(state.concurrency || 1) + 1)
      state.consecutive_success = 0
    }
    return state
  }
  state.consecutive_success = 0
  state.consecutive_errors = Number(state.consecutive_errors || 0) + 1
  if ([401, 403].includes(Number(status))) {
    state.concurrency = 1
    state.delay_ms = Math.max(Number(state.delay_ms || DIRECT_COLLECT_INITIAL_DELAY_MS), 3000)
  } else if (Number(status) === 429) {
    state.concurrency = 1
    state.delay_ms = Math.min(20000, Math.max(5000, Number(state.delay_ms || DIRECT_COLLECT_INITIAL_DELAY_MS) * 2.5))
  } else {
    state.concurrency = Math.max(1, Number(state.concurrency || 1) - 1)
    state.delay_ms = Math.min(10000, Math.max(1000, Number(state.delay_ms || DIRECT_COLLECT_INITIAL_DELAY_MS) * 1.5))
  }
  return state
}

async function updateAuthBindingResult(db, binding, patch = {}, tenantId = 'admin') {
  if (!binding?.store_id) return null
  const repo = db.getRepository('Setting')
  const next = {
    ...binding,
    ...patch,
    updated_at: patch.updated_at !== undefined ? patch.updated_at : (binding.updated_at || new Date().toISOString())
  }
  await repo.save({
    key: getSettingKeyForAuthBinding(binding.store_id),
    tenant_id: tenantId,
    value: stringifyJson(next),
    updated_at: new Date().toISOString()
  })
  return publicAuthBinding(next)
}

async function fetchDirectCollectRequest(db, request, binding, tenantId = 'admin') {
  const storeId = safeString(binding.store_id || binding.company_id)
  const rate = getDirectRateState(tenantId, storeId)
  if (Number(rate.delay_ms || 0) > 0) await sleep(Number(rate.delay_ms || 0))
  const requestUrl = safeString(request.request_url)
  const method = safeString(request.request_method || 'POST').toUpperCase()
  const headers = {
    ...buildCollectRequestHeaders({ company_id: storeId }),
    ...sanitizeAuthHeaders(binding.headers || {}),
    ...sanitizeAuthHeaders(request.request_headers || {}),
    Cookie: binding.cookie
  }
  if (storeId) headers['X-O3-Company-Id'] = storeId
  const response = await fetch(requestUrl, {
    method,
    headers,
    body: method === 'GET' ? undefined : stringifyJson(request.request_body || {}),
    signal: AbortSignal.timeout(30000)
  })
  const text = await response.text()
  let responseBody = text
  try {
    responseBody = text ? JSON.parse(text) : null
  } catch (error) {}
  tuneDirectRate(tenantId, storeId, response.status, response.ok)
  await updateAuthBindingResult(db, binding, response.ok
    ? { last_ok_at: new Date().toISOString(), last_error: '', last_status: response.status }
    : {
        last_error: `HTTP ${response.status}`,
        last_status: response.status,
        ...(response.status === 401 || response.status === 403 ? { updated_at: '' } : {})
      }, tenantId)
  return {
    success: response.ok,
    page_url: 'backend-direct://seller-analytics',
    request_url: requestUrl,
    request_method: method,
    request_headers: headers,
    request_body: request.request_body,
    source_button_label: request.source_label || null,
    source_button_key: request.source_key || null,
    source_context: {
      collection_run_id: request.run_id,
      collection_request_id: request.request_id,
      endpoint_type: request.endpoint_type,
      page_index: request.page_index || 0,
      inferredFrom: 'backend_direct_cookie_binding',
      capturedAt: new Date().toISOString()
    },
    response_status: response.status,
    response_headers: Object.fromEntries(response.headers.entries()),
    response_body: responseBody,
    error: response.ok ? null : `HTTP ${response.status}`
  }
}

async function processDirectCollectRun(db, tenantId = 'admin', storeId = '') {
  const workerKey = `${tenantId}:${safeString(storeId) || 'default'}`
  if (directCollectWorkers.has(workerKey)) return { started: false, reason: 'already_running' }
  const binding = await getAuthBinding(db, storeId, tenantId)
  if (!binding) return { started: false, reason: 'missing_auth_binding' }
  directCollectWorkers.add(workerKey)
  try {
    let idleLoops = 0
    while (idleLoops < 2) {
      const currentBinding = await getAuthBinding(db, storeId, tenantId)
      if (!currentBinding) return { started: true, stopped: 'auth_binding_missing' }
      const rate = getDirectRateState(tenantId, storeId)
      const concurrency = Math.min(DIRECT_COLLECT_MAX_CONCURRENCY, Math.max(1, Number(rate.concurrency || 1)))
      const batchSize = Math.max(DIRECT_COLLECT_BATCH_SIZE, concurrency * 3)
      const requests = await claimNextCollectRequests(db, tenantId, batchSize, {
        store_id: storeId,
        company_id: storeId
      })
      if (!requests.length) {
        idleLoops += 1
        await sleep(1000)
        continue
      }
      idleLoops = 0
      const workers = Array.from({ length: Math.min(concurrency, requests.length) }, async (_, workerIndex) => {
        for (let index = workerIndex; index < requests.length; index += concurrency) {
          const request = requests[index]
          const payload = await fetchDirectCollectRequest(db, request, currentBinding, tenantId).catch((error) => ({
            success: false,
            error: error?.message || String(error)
          }))
          await finishCollectRequest(db, request.run_id, request.request_id, payload, tenantId)
          if ([401, 403].includes(Number(payload.response_status || 0))) {
            throw new Error(`Direct auth rejected: HTTP ${payload.response_status}`)
          }
        }
      })
      await Promise.all(workers)
    }
    return { started: true, stopped: 'queue_empty' }
  } finally {
    directCollectWorkers.delete(workerKey)
  }
}

function startDirectCollectRun(db, tenantId = 'admin', storeId = '') {
  const id = safeString(storeId)
  if (!id) return { started: false, reason: 'missing_store_id' }
  processDirectCollectRun(db, tenantId, id).catch(() => {})
  return { started: true }
}

function getCollectRequestLimit(request = {}) {
  const explicit = parsePositiveInteger(request.limit, 0, 100)
  if (explicit > 0) return explicit
  const body = parseJson(request.request_body, {}) || {}
  return parsePositiveInteger(body.limit, DEFAULT_PAGE_LIMIT, 100)
}

function responseItemCount(value) {
  return getResponseItems(value).length
}

function appendNextAutoPageRequest(run, request, payload) {
  if (!request.auto_all_pages || request.endpoint_type !== 'by_sku') return false
  const pageIndex = parsePageIndex(request.page_index) || 0
  const limit = getCollectRequestLimit(request)
  const count = responseItemCount(payload.response_body || payload.responseBody || payload.data)
  if (count < limit) {
    request.auto_stop_reason = `第 ${pageIndex + 1} 页返回 ${count} 条，少于每页 ${limit} 条`
    return false
  }
  const maxPages = parsePositiveInteger(request.max_pages, DEFAULT_AUTO_COLLECT_MAX_PAGES, DEFAULT_AUTO_COLLECT_MAX_PAGES)
  const nextPageIndex = pageIndex + 1
  if (nextPageIndex >= maxPages) {
    request.auto_stop_reason = `已达到自动采集最大页数 ${maxPages}`
    return false
  }
  const alreadyQueued = (run.requests || []).some((item) =>
    item.source_key === request.source_key &&
    item.endpoint_type === 'by_sku' &&
    parsePageIndex(item.page_index) === nextPageIndex
  )
  if (alreadyQueued) return false
  run.requests.push({
    id: newId('sar'),
    source_key: request.source_key,
    source_label: request.source_label || TAB_LABELS[request.source_key] || request.source_key,
    endpoint_type: 'by_sku',
    page_index: nextPageIndex,
    auto_all_pages: true,
    max_pages: maxPages,
    limit,
    parent_request_id: request.id,
    request_url: request.request_url,
    request_method: request.request_method || 'POST',
    request_headers: { ...(request.request_headers || {}) },
    request_body: buildCollectRequestBody(request.source_key, 'by_sku', run, nextPageIndex, limit),
    status: 'pending',
    attempts: 0
  })
  run.request_count = (run.requests || []).length
  return true
}

async function createCollectRun(db, payload = {}, tenantId = 'admin') {
  return withCollectRunStateLock(tenantId, async () => {
    const period = resolveCollectPeriod(payload)
    const requests = buildCollectRequests(payload, period)
    const storeId = safeString(payload.store_id || payload.storeId || payload.shop_id || payload.shopId || payload.company_id || payload.companyId) || null
    if (requests.length === 0) {
      const error = new Error('Missing collect requests')
      error.statusCode = 400
      throw error
    }
    const activeRuns = await listCollectRuns(db, { limit: 100 }, tenantId)
    const matchingRun = activeRuns.find((run) => collectRunMatchesRequest(run, period, requests, storeId))
    if (matchingRun) return { ...matchingRun, reused: true }
    const now = new Date().toISOString()
    const run = {
      id: newId('sacr'),
      tenant_id: tenantId,
      store_id: storeId,
      status: 'pending',
      period_key: period.periodKey,
      current_period: period.current_period,
      previous_period: period.previous_period,
      request_count: requests.length,
      completed_count: 0,
      failed_count: 0,
      requests,
      created_at: now,
      updated_at: now
    }
    const saved = await saveCollectRunState(db, run)
    return saved
  })
}

async function startDirectCollect(db, payload = {}, tenantId = 'admin') {
  const storeId = safeString(payload.store_id || payload.storeId || payload.shop_id || payload.shopId || payload.company_id || payload.companyId)
  if (!storeId) {
    const error = new Error('Missing store id for direct collect')
    error.statusCode = 400
    throw error
  }
  const binding = await getAuthBinding(db, storeId, tenantId)
  if (!binding) {
    return {
      started: false,
      reason: 'missing_auth_binding',
      auth_binding: emptyAuthBindingStatus()
    }
  }
  return {
    ...startDirectCollectRun(db, tenantId, storeId),
    auth_binding: publicAuthBinding(binding)
  }
}

function normalizeCollectStoreIds(value) {
  const values = Array.isArray(value) ? value : [value]
  return Array.from(new Set(values.map(safeString).filter(Boolean)))
}

function runMatchesAnyStoreId(run, storeIds = []) {
  const normalized = normalizeCollectStoreIds(storeIds)
  if (!normalized.length) return true
  const runStoreId = safeString(run?.store_id || run?.storeId)
  return normalized.includes(runStoreId)
}

async function claimNextCollectRequest(db, tenantId = 'admin', options = {}) {
  return withCollectRunStateLock(tenantId, async () => {
    const requestedStoreIds = normalizeCollectStoreIds([
      options.store_id,
      options.storeId,
      options.shop_id,
      options.shopId,
      options.company_id,
      options.companyId,
      ...(Array.isArray(options.store_ids || options.storeIds) ? (options.store_ids || options.storeIds) : [])
    ])
    const runs = await listCollectRuns(db, { limit: 50 }, tenantId)
    const pendingRuns = runs
      .filter((item) => ['pending', 'running'].includes(item.status))
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    const run = (requestedStoreIds.length
      ? pendingRuns.find((item) => runMatchesAnyStoreId(item, requestedStoreIds))
      : pendingRuns[0]) || null
    if (!run) return null
    const now = Date.now()
    for (const item of run.requests || []) {
      const claimedAt = item.claimed_at ? new Date(item.claimed_at).getTime() : 0
      if (item.status === 'running' && claimedAt && now - claimedAt > COLLECT_REQUEST_STALE_MS) {
        item.status = 'pending'
      }
    }
    const request = (run.requests || []).find((item) => item.status === 'pending')
    if (!request) return null
    request.status = 'running'
    request.attempts = Number(request.attempts || 0) + 1
    request.claimed_at = new Date().toISOString()
    run.status = 'running'
    run.updated_at = new Date().toISOString()
    await saveCollectRunState(db, run)
    return {
      run_id: run.id,
      request_id: request.id,
      source_key: request.source_key,
      source_label: request.source_label,
      endpoint_type: request.endpoint_type,
      page_index: request.page_index || 0,
      request_url: request.request_url,
      request_method: request.request_method,
      request_headers: request.request_headers || {},
      request_body: request.request_body,
      period_key: run.period_key,
      current_period: run.current_period,
      previous_period: run.previous_period
    }
  })
}

async function claimNextCollectRequests(db, tenantId = 'admin', limit = 6, options = {}) {
  const take = parsePositiveInteger(limit, 6, 20)
  const requests = []
  for (let index = 0; index < take; index += 1) {
    const request = await claimNextCollectRequest(db, tenantId, options)
    if (!request) break
    requests.push(request)
  }
  return requests
}

function appendAbcAnalysisRequest(run, request, payload) {
  if (!['abc', 'all_metrics'].includes(request.source_key) || request.endpoint_type !== 'by_sku') return false
  const pageIndex = parsePageIndex(request.page_index) || 0
  const alreadyQueued = (run.requests || []).some((item) =>
    item.source_key === request.source_key &&
    item.endpoint_type === 'abc_analysis' &&
    parsePageIndex(item.page_index) === pageIndex
  )
  if (alreadyQueued) return false
  const responseBody = payload.response_body || payload.responseBody || payload.data
  const skus = extractSkusFromResponse(responseBody)
  if (skus.length === 0) return false
  run.requests.push({
    id: newId('sar'),
    source_key: request.source_key,
    source_label: request.source_label || TAB_LABELS[request.source_key] || request.source_key,
    endpoint_type: 'abc_analysis',
    page_index: pageIndex,
    parent_request_id: request.id,
    request_url: ABC_ANALYSIS_REQUEST_URL,
    request_method: request.request_method || 'POST',
    request_headers: { ...(request.request_headers || {}) },
    request_body: buildAbcAnalysisRequestBody(run, skus),
    status: 'pending',
    attempts: 0
  })
  run.request_count = (run.requests || []).length
  return true
}

async function finishCollectRequest(db, runId, requestId, payload = {}, tenantId = 'admin') {
  return withCollectRunStateLock(tenantId, async () => {
    const run = await loadCollectRunState(db, runId, tenantId)
    if (!run) {
      const error = new Error('Seller analytics collect run not found')
      error.statusCode = 404
      throw error
    }
    const request = (run.requests || []).find((item) => item.id === requestId)
    if (!request) {
      const error = new Error('Seller analytics collect request not found')
      error.statusCode = 404
      throw error
    }
    if (request.status === 'success') return { run, request, snapshot: null, metricCount: 0 }
    const success = payload.success !== false
    let snapshotResult = null
    if (success) {
      snapshotResult = await saveSnapshot(db, {
        source: 'pivot-table-master-controlled',
        source_button_label: request.source_label,
        source_button_key: request.source_key,
        source_context: {
          collection_run_id: run.id,
          collection_request_id: request.id,
          endpoint_type: request.endpoint_type,
          page_index: request.page_index || 0,
          inferredFrom: 'erp_collect_plan'
        },
        tab_key: request.source_key,
        request_url: request.request_url,
        request_method: request.request_method,
        request_headers: request.request_headers || {},
        request_body: request.request_body,
        response_status: payload.response_status || payload.responseStatus,
        response_headers: payload.response_headers || payload.responseHeaders,
        response_body: payload.response_body || payload.responseBody || payload.data,
        period_key: run.period_key,
        page_url: payload.page_url || payload.pageUrl
      }, tenantId)
      request.status = 'success'
      appendNextAutoPageRequest(run, request, payload)
      appendAbcAnalysisRequest(run, request, payload)
    } else {
      request.status = 'failed'
      request.error_message = safeString(payload.error || payload.message || '采集失败')
    }
    request.finished_at = new Date().toISOString()
    run.completed_count = (run.requests || []).filter((item) => item.status === 'success').length
    run.failed_count = (run.requests || []).filter((item) => item.status === 'failed').length
    const doneCount = run.completed_count + run.failed_count
    run.status = doneCount >= Number(run.request_count || 0) ? (run.failed_count > 0 ? 'failed' : 'success') : 'running'
    run.updated_at = new Date().toISOString()
    await saveCollectRunState(db, run)
    let operationTodos = null
    if (run.status === 'success') {
      operationTodos = await refreshOperationTodos(db, {
        period_key: run.period_key,
        date_from: run.current_period?.date_from,
        date_to: run.current_period?.date_to,
        focus_limit: 500
      }, tenantId)
    }
    return { run, request, snapshot: snapshotResult?.snapshot || null, metricCount: snapshotResult?.metricCount || 0, operationTodos }
  })
}

async function retryCollectRun(db, runId, tenantId = 'admin') {
  return withCollectRunStateLock(tenantId, async () => {
    const run = await loadCollectRunState(db, runId, tenantId)
    if (!run) {
      const error = new Error('Seller analytics collect run not found')
      error.statusCode = 404
      throw error
    }
    let resetCount = 0
    for (const request of run.requests || []) {
      if (request.status === 'success') continue
      request.status = 'pending'
      request.error_message = ''
      request.claimed_at = null
      request.finished_at = null
      resetCount += 1
    }
    run.completed_count = (run.requests || []).filter((item) => item.status === 'success').length
    run.failed_count = 0
    run.status = resetCount > 0 ? 'pending' : run.status
    run.updated_at = new Date().toISOString()
    await saveCollectRunState(db, run)
    return { run, resetCount }
  })
}

async function deleteCollectRun(db, runId, tenantId = 'admin') {
  return withCollectRunStateLock(tenantId, async () => {
    const id = safeString(runId)
    if (!id) {
      const error = new Error('Missing collect run id')
      error.statusCode = 400
      throw error
    }
    const run = await loadCollectRunState(db, id, tenantId)
    if (!run) {
      const error = new Error('Seller analytics collect run not found')
      error.statusCode = 404
      throw error
    }
    if (run.status === 'success') {
      const error = new Error('Completed collect runs cannot be deleted')
      error.statusCode = 400
      throw error
    }
    const repo = db.getRepository('Setting')
    const result = await repo.delete({ key: getSettingKeyForCollectRun(id), tenant_id: tenantId })
    return {
      success: true,
      deletedCount: Number(result.affected || 0),
      run
    }
  })
}

function normalizeMetricName(value) {
  return safeString(value)
    .replace(/_sort$/i, '')
    .replace(/_dynamics$/i, '')
    .toLowerCase()
}

function requestMetricsFrom(input = {}) {
  const body = parseJson(input.request_body || input.requestBody, null)
  const metrics = Array.isArray(body?.metrics) ? body.metrics : []
  return metrics.map((item) => safeString(item)).filter(Boolean)
}

function getMetricNameSet(metrics = []) {
  return new Set(metrics.map(normalizeMetricName).filter(Boolean))
}

function onlyMetrics(set, names) {
  const allowed = new Set(names)
  for (const item of set) {
    if (!allowed.has(item)) return false
  }
  return true
}

function inferSourceFromMetrics(metrics = []) {
  const set = getMetricNameSet(metrics)
  if (set.size === 0) return null
  const has = (name) => set.has(name)
  const source = (key) => ({ key, label: TAB_LABELS[key], metrics })

  if (has('delivered_units') || has('conv_hits_to_cart_to_order') || has('total_hits_to_cart') || has('conv_total_views_to_cart')) return source('all_metrics')
  if (has('price_index') || has('drr') || has('stockout_days') || has('recommended_supply') || has('discount_share_of_total_gmv')) return source('abc')
  if (has('cancelled_units_by_order_date') || has('returned_units_by_order_date')) return source('overview')
  if (has('search_views') && has('pdp_views') && has('hits_pdp_to_cart') && has('revenue')) return source('funnel')
  if (has('search_position') && has('total_views') && has('pdp_views') && has('conv_pdp_views_to_cart') && has('ordered_units') && !has('revenue')) return source('need_promotion')
  if (has('pdp_views') && has('conv_pdp_views_to_cart') && has('ordered_units') && has('revenue') && !has('search_views')) return source('card_quality')
  if (has('search_position') && has('search_views') && has('ordered_units') && onlyMetrics(set, ['search_position', 'search_views', 'ordered_units'])) return source('search')
  if (has('revenue') && has('ordered_units') && onlyMetrics(set, ['revenue', 'sold_revenue', 'ordered_units', 'revenue_dynamics', 'sold_revenue_dynamics', 'ordered_units_dynamics'])) return source('hot')
  return null
}

function inferSourceFromRequest(input = {}) {
  return inferSourceFromMetrics(requestMetricsFrom(input))
}

function inferPeriodKey(input = {}) {
  const body = parseJson(input.request_body || input.requestBody, null)
  const period = body?.current_period || body?.currentPeriod
  if (!period?.date_from || !period?.date_to) return ''
  return `${period.date_from}..${period.date_to}`
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value)
    .replace(/\s+/g, '')
    .replace(/[₽¥￥,%]/g, '')
    .replace(',', '.')
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function previousValueFromDynamics(current, dynamics) {
  const currentNumber = toNumber(current)
  const dynamicsNumber = toNumber(dynamics)
  if (currentNumber === null || dynamicsNumber === null) return null
  const divisor = 1 + dynamicsNumber / 100
  if (!Number.isFinite(divisor) || Math.abs(divisor) < 0.000001) return null
  const previous = currentNumber / divisor
  if (Number.isInteger(currentNumber) && Number.isInteger(dynamicsNumber) && dynamicsNumber < 0) {
    const rounded = Math.round(previous)
    if (Math.abs(previous - rounded) < 0.000001) return rounded
    return Math.ceil(previous)
  }
  return previous
}

function ratioDynamicsFromParts(currentRatio, numerator, numeratorDynamics, denominator, denominatorDynamics) {
  const currentRatioNumber = toNumber(currentRatio)
  const numeratorNumber = toNumber(numerator)
  const resolvedNumeratorDynamics = numeratorDynamics ?? (numeratorNumber !== null ? 0 : null)
  const numeratorPrevious = previousValueFromDynamics(numerator, resolvedNumeratorDynamics)
  const denominatorPrevious = previousValueFromDynamics(denominator, denominatorDynamics)
  if (currentRatioNumber === null || numeratorPrevious === null || denominatorPrevious === null) return null
  if (Math.abs(denominatorPrevious) < 0.000001) return null
  const previousRatio = (numeratorPrevious / denominatorPrevious) * 100
  if (Math.abs(previousRatio) < 0.000001) return currentRatioNumber === 0 ? 0 : null
  return Math.round(((currentRatioNumber - previousRatio) / Math.abs(previousRatio)) * 100)
}

function getFirst(source, keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key]
  }
  return undefined
}

function getFirstFrom(sources, keys) {
  for (const source of sources) {
    const value = getFirst(source, keys)
    if (value !== undefined) return value
  }
  return undefined
}

function getMoneyValue(value) {
  if (value && typeof value === 'object' && value.units !== undefined) {
    return Number(value.units || 0) + Number(value.nanos || 0) / 1000000000
  }
  return value
}

function inferTabKey(input = {}) {
  const inferred = inferSourceFromRequest(input)
  if (inferred?.key) return inferred.key
  const explicit = safeString(input.tab_key || input.tabKey)
  if (TAB_KEYS.includes(explicit)) return explicit
  const sourceKey = safeString(input.source_button_key || input.sourceButtonKey)
  if (SOURCE_KEY_TO_TAB_KEY[sourceKey]) return SOURCE_KEY_TO_TAB_KEY[sourceKey]
  const sourceLabel = safeString(input.source_button_label || input.sourceButtonLabel)
  if (SOURCE_LABEL_TO_TAB_KEY[sourceLabel]) return SOURCE_LABEL_TO_TAB_KEY[sourceLabel]
  const haystack = [input.request_url, input.requestUrl, input.page_url, input.pageUrl, input.url]
    .map((v) => safeString(v).toLowerCase())
    .join(' ')
  if (haystack.includes('abc')) return 'abc'
  if (haystack.includes('search')) return 'search'
  if (haystack.includes('funnel') || haystack.includes('conversion')) return 'funnel'
  if (haystack.includes('hot') || haystack.includes('top')) return 'hot'
  if (haystack.includes('metric')) return 'all_metrics'
  if (haystack.includes('analytics')) return 'overview'
  return explicit || 'overview'
}

function looksLikeMetricRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  if (row.productInfo && row.metrics) return true
  const keys = Object.keys(row)
  if (keys.length === 0) return false
  const lower = keys.map((key) => key.toLowerCase())
  const hasProductIdentity = lower.some((key) =>
    ['sku', 'skuid', 'offer_id', 'offerid', 'product_id', 'productid', 'name', 'title', 'productname'].includes(key)
  )
  const hasMetric = lower.some((key) =>
    key.includes('order') ||
    key.includes('amount') ||
    key.includes('revenue') ||
    key.includes('gmv') ||
    key.includes('view') ||
    key.includes('show') ||
    key.includes('impression') ||
    key.includes('cart') ||
    key.includes('conversion') ||
    key.includes('abc') ||
    key.includes('position')
  )
  return hasProductIdentity && hasMetric
}

function collectMetricRows(value, rows = [], seen = new WeakSet(), depth = 0) {
  if (!value || depth > 8) return rows
  if (typeof value !== 'object') return rows
  if (seen.has(value)) return rows
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) collectMetricRows(item, rows, seen, depth + 1)
    return rows
  }

  if (looksLikeMetricRow(value)) rows.push(value)

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') collectMetricRows(nested, rows, seen, depth + 1)
  }
  return rows
}

function extractSkusFromResponse(value) {
  const skus = []
  const seen = new Set()
  for (const row of getResponseItems(value)) {
    const productInfo = row?.productInfo || row?.product_info || row?.product || {}
    const sku = safeString(getFirstFrom([row, productInfo], ['sku', 'skuid', 'skuId', 'product_sku', 'productSku']))
    if (!sku || seen.has(sku)) continue
    seen.add(sku)
    skus.push(sku)
  }
  return skus
}

function normalizeMetricRow(row, context = {}) {
  const productInfo = row?.productInfo || row?.product_info || row?.product || {}
  const metricInfo = row?.metrics || row?.metric || row || {}
  const sources = [row, productInfo]
  const sku = safeString(getFirstFrom(sources, ['sku', 'skuid', 'skuId', 'product_sku', 'productSku']))
  const offerId = safeString(getFirstFrom(sources, ['offer_id', 'offerId', 'article', 'vendorCode']))
  const productId = safeString(getFirstFrom(sources, ['product_id', 'productId', 'id']))
  const productName = safeString(getFirstFrom(sources, ['product_name', 'productName', 'name', 'title']))
  if (!sku && !offerId && !productId && !productName) return null

  const revenueShare = toNumber(getFirst(metricInfo, ['revenue_share', 'revenueShare']))
  const orderedUnits = toNumber(getFirst(metricInfo, ['ordered_units', 'orderedUnits', 'order_count', 'orderCount', 'orders', 'orderedProducts', 'orderedCount']))
  const abc = getFirst(row, ['abc', 'abcAnalysis', 'abc_analysis'])
  const abcRevenue = normalizeAbcGrade(getFirst(row, ['abc_revenue', 'abcRevenue', 'abcMoney', 'revenueGrade']) || (abc && abc.revenue))
  const abcQuantity = normalizeAbcGrade(getFirst(row, ['abc_quantity', 'abcQuantity', 'abcQty', 'orderedUnitsGrade']) || (abc && abc.quantity))

  return {
    id: newId('sam'),
    tenant_id: context.tenantId,
    store_id: context.storeId || null,
    snapshot_id: context.snapshotId,
    tab_key: context.tabKey,
    period_key: context.periodKey || null,
    product_id: productId || null,
    offer_id: offerId || null,
    sku: sku || null,
    product_name: productName || null,
    image_url: normalizeSellerAnalyticsImageUrl(getFirstFrom(sources, ['image', 'image_url', 'imageUrl', 'photo', 'picture', 'pictures', 'images'])) || null,
    order_amount: toNumber(getMoneyValue(getFirst(metricInfo, ['revenueV2', 'order_amount', 'orderAmount', 'revenue', 'gmv', 'sumGmv', 'orderedAmount']))),
    order_count: orderedUnits,
    impressions: toNumber(getFirst(metricInfo, ['total_views', 'totalViews', 'search_views', 'searchViews', 'impressions', 'shows', 'showCount', 'viewsSearch', 'searchShows'])),
    card_views: toNumber(getFirst(metricInfo, ['pdp_views', 'pdpViews', 'card_views', 'cardViews', 'productCardViews', 'qtyViewPdp', 'views'])),
    search_position: toNumber(getFirst(metricInfo, ['search_position', 'searchPosition', 'position'])),
    add_to_cart: toNumber(getFirst(metricInfo, ['hits_pdp_to_cart', 'hitsPdpToCart', 'hits_search_to_cart', 'hitsSearchToCart', 'total_hits_to_cart', 'totalHitsToCart', 'add_to_cart', 'addToCart', 'cart', 'cartCount'])),
    conversion_rate: toNumber(getFirst(metricInfo, ['conv_pdp_views_to_cart', 'convPdpViewsToCart', 'conv_views_to_order', 'convViewsToOrder', 'conversion_rate', 'conversionRate', 'convToCart', 'convViewToOrder'])),
    abc_revenue: abcRevenue || null,
    abc_quantity: abcQuantity || null,
    suggestion: safeString(getFirst(row, ['suggestion', 'recommendation', 'advice'])) || null,
    raw_data: stringifyJson(row),
    captured_at: context.capturedAt
  }
}

async function saveSnapshot(db, payload = {}, tenantId = 'admin') {
  const snapshotRepo = db.getRepository('SellerAnalyticsSnapshot')
  const metricRepo = db.getRepository('SellerAnalyticsProductMetric')
  const pageUrl = safeString(payload.page_url || payload.pageUrl)
  const rawRequestUrl = safeString(payload.request_url || payload.requestUrl || payload.url)
  const requestUrl = normalizeSellerAnalyticsUrl(rawRequestUrl, pageUrl) || rawRequestUrl || null
  const requestBody = payload.request_body || payload.requestBody || null
  const sourceGuess = inferSourceFromRequest({ ...payload, request_body: requestBody, request_url: requestUrl })
  const payloadSourceContext = payload.source_context || payload.sourceContext || null
  const sourceContext = sourceGuess
    ? {
        ...(payloadSourceContext && typeof payloadSourceContext === 'object' ? payloadSourceContext : {}),
        inferredFrom: 'request_body.metrics',
        label: sourceGuess.label,
        key: sourceGuess.key,
        metrics: sourceGuess.metrics,
        capturedAt: new Date().toISOString()
      }
    : payloadSourceContext
  const responseBody = payload.response_body || payload.responseBody || payload.raw_data || payload.rawData || payload.response || payload.data || payload
  const capturedAt = payload.captured_at ? new Date(payload.captured_at) : new Date()
  const snapshot = {
    id: newId('sas'),
    tenant_id: tenantId,
    store_id: getPayloadStoreId(payload) || null,
    source: safeString(payload.source) || 'pivot-table-master',
    source_button_label: sourceGuess?.label || safeString(payload.source_button_label || payload.sourceButtonLabel) || null,
    source_button_key: sourceGuess?.key || safeString(payload.source_button_key || payload.sourceButtonKey) || null,
    source_context: stringifyJson(sourceContext),
    tab_key: sourceGuess?.key || inferTabKey({ ...payload, request_body: requestBody, request_url: requestUrl }),
    page_url: pageUrl || null,
    request_url: requestUrl,
    request_method: safeString(payload.request_method || payload.requestMethod || payload.method || 'GET').toUpperCase(),
    request_headers: stringifyJson(payload.request_headers || payload.requestHeaders || null),
    request_body: stringifyJson(requestBody),
    response_status: toNumber(payload.response_status || payload.responseStatus),
    response_headers: stringifyJson(payload.response_headers || payload.responseHeaders || null),
    response_body: stringifyJson(responseBody),
    period_key: safeString(payload.period_key || payload.periodKey) || inferPeriodKey({ request_body: requestBody }) || null,
    captured_at: capturedAt,
    raw_data: stringifyJson(responseBody)
  }
  await deleteOlderCollectedPageSnapshots(db, snapshot)
  await snapshotRepo.save(snapshot)

  const rows = collectMetricRows(responseBody)
    .map((row) =>
      normalizeMetricRow(row, {
        tenantId,
        storeId: snapshot.store_id,
        snapshotId: snapshot.id,
        tabKey: snapshot.tab_key,
        periodKey: snapshot.period_key,
        capturedAt
      })
    )
    .filter(Boolean)

  if (rows.length > 0) await metricRepo.save(rows)
  clearAnalysisCache(tenantId)
  return { snapshot, metricCount: rows.length }
}

function decorateSnapshot(row) {
  if (!row) return row
  const sourceGuess = inferSourceFromRequest(row)
  if (!sourceGuess) return row
  const currentContext = parseJson(row.source_context, {}) || {}
  return {
    ...row,
    tab_key: sourceGuess.key || row.tab_key,
    source_button_label: sourceGuess.label || row.source_button_label,
    source_button_key: sourceGuess.key || row.source_button_key,
    source_context: stringifyJson({
      ...currentContext,
      inferredFrom: 'request_body.metrics',
      label: sourceGuess.label,
      key: sourceGuess.key,
      metrics: sourceGuess.metrics
    })
  }
}

function normalizeProductMetricItem(item, tabKey, capturedAt, options = {}) {
  const productInfo = item?.productInfo || item?.product_info || item?.product || {}
  const metrics = item?.metrics || item?.metric || item || {}
  const row = normalizeMetricRow(item, { tenantId: '', snapshotId: '', tabKey, capturedAt })
  if (!row) return null
  const metric = (keys) => getFirst(metrics, keys)
  const number = (keys) => toNumber(getMoneyValue(metric(keys)))
  const revenue = number(['revenueV2', 'revenue', 'order_amount', 'orderAmount'])
  const revenueDynamics = number(['revenue_dynamics', 'revenueDynamics'])
  const soldRevenue = number(['sold_revenue', 'soldRevenue'])
  const soldRevenueDynamics = number(['sold_revenue_dynamics', 'soldRevenueDynamics'])
  const orderedUnits = number(['ordered_units', 'orderedUnits', 'order_count', 'orderCount'])
  const orderedUnitsDynamics = number(['ordered_units_dynamics', 'orderedUnitsDynamics'])
  const cancelledUnits = number(['cancelled_units', 'cancelledUnits', 'cancelled_units_by_order_date', 'cancelledUnitsByOrderDate'])
  const returnedUnits = number(['returned_units', 'returnedUnits', 'returned_units_by_order_date', 'returnedUnitsByOrderDate'])
  const cancelledUnitsByOrderDate = number(['cancelled_units_by_order_date', 'cancelledUnitsByOrderDate'])
  const returnedUnitsByOrderDate = number(['returned_units_by_order_date', 'returnedUnitsByOrderDate'])
  const acceptedUnitsRaw = number(['accepted_units', 'acceptedUnits', 'purchased_units', 'purchasedUnits', 'bought_units', 'boughtUnits'])
  const acceptedUnits = acceptedUnitsRaw ?? (orderedUnits !== null ? Math.max(0, orderedUnits - (cancelledUnits || 0) - (returnedUnits || 0)) : null)
  const acceptedUnitsDynamicsRaw = number(['accepted_units_dynamics', 'acceptedUnitsDynamics', 'purchased_units_dynamics', 'purchasedUnitsDynamics'])
  const acceptedUnitsDynamics = acceptedUnitsDynamicsRaw ?? (
    acceptedUnits !== null && orderedUnits !== null && acceptedUnits === orderedUnits ? orderedUnitsDynamics : null
  )
  const convOrderToAcceptedRaw = number(['conv_ordered_to_accepted', 'convOrderedToAccepted', 'conv_order_to_purchase', 'convOrderToPurchase'])
  const convOrderToAccepted = convOrderToAcceptedRaw ?? (orderedUnits > 0 && acceptedUnits !== null ? (acceptedUnits / orderedUnits) * 100 : orderedUnits === 0 ? 0 : null)
  const totalViews = number(['total_views', 'totalViews'])
  const totalViewsDynamics = number(['total_views_dynamics', 'totalViewsDynamics'])
  const searchViews = number(['search_views', 'searchViews'])
  const searchViewsDynamics = number(['search_views_dynamics', 'searchViewsDynamics'])
  const pdpViews = number(['pdp_views', 'pdpViews'])
  const pdpViewsDynamics = number(['pdp_views_dynamics', 'pdpViewsDynamics'])
  const searchAddToCart = number(['hits_search_to_cart', 'hitsSearchToCart'])
  const searchAddToCartDynamics = number(['hits_search_to_cart_dynamics', 'hitsSearchToCartDynamics'])
  const pdpAddToCart = number(['hits_pdp_to_cart', 'hitsPdpToCart'])
  const pdpAddToCartDynamics = number(['hits_pdp_to_cart_dynamics', 'hitsPdpToCartDynamics'])
  const totalAddToCart = number(['total_hits_to_cart', 'totalHitsToCart'])
  const totalAddToCartDynamics = number(['total_hits_to_cart_dynamics', 'totalHitsToCartDynamics'])
  const convSearchViewsToCart = number(['conv_search_views_to_cart', 'convSearchViewsToCart'])
  const convSearchViewsToPdp = number(['conv_search_views_to_pdp', 'convSearchViewsToPdp'])
  const convPdpViewsToCart = number(['conv_pdp_views_to_cart', 'convPdpViewsToCart'])
  const convViewsToOrder = number(['conv_views_to_order', 'convViewsToOrder'])
  const convTotalViewsToCart = number(['conv_total_views_to_cart', 'convTotalViewsToCart'])
  const convHitsToCartToOrder = number(['conv_hits_to_cart_to_order', 'convHitsToCartToOrder'])
  const discountShare = number(['discount_share_of_total_gmv', 'discountShareOfTotalGmv'])
  const discountShareMedian = number(['discount_share_of_median_price', 'discountShareOfMedianPrice'])
  const drr = number(['drr'])
  const periodDays = Number.isFinite(Number(options.periodDays)) ? Number(options.periodDays) : null
  const promotionDaysRaw = number(['days_in_promo', 'daysInPromo', 'promotion_days', 'promotionDays', 'promo_days', 'promoDays'])
  const cpcPromotionDaysRaw = number(['days_in_trafarets', 'daysInTrafarets', 'days_with_trafarets', 'daysWithTrafarets', 'cpc_promotion_days', 'cpcPromotionDays', 'promotion_days_cpc', 'promotionDaysCpc'])
  return {
    productKey: row.sku || row.offer_id || row.product_id || row.product_name,
    sku: row.sku,
    offer_id: row.offer_id,
    product_id: row.product_id,
    product_name: row.product_name,
    image_url: row.image_url,
    source: tabKey,
    captured_at: capturedAt,
    raw: item,
    metrics: {
      revenue,
      revenueDynamics,
      soldRevenue,
      soldRevenueDynamics,
      revenueShare: number(['revenue_share', 'revenueShare']),
      revenueShareDynamics: number(['revenue_share_dynamics', 'revenueShareDynamics']),
      orderedUnits,
      orderedUnitsDynamics,
      deliveredUnits: number(['delivered_units', 'deliveredUnits']),
      deliveredUnitsDynamics: number(['delivered_units_dynamics', 'deliveredUnitsDynamics']),
      acceptedUnits,
      acceptedUnitsDynamics,
      convOrderToAccepted,
      convOrderToAcceptedDynamics: number(['conv_ordered_to_accepted_dynamics', 'convOrderedToAcceptedDynamics', 'conv_order_to_purchase_dynamics', 'convOrderToPurchaseDynamics']) ?? ratioDynamicsFromParts(convOrderToAccepted, acceptedUnits, acceptedUnitsDynamics, orderedUnits, orderedUnitsDynamics),
      totalViews,
      totalViewsDynamics,
      searchViews,
      searchViewsDynamics,
      pdpViews,
      pdpViewsDynamics,
      searchPosition: number(['search_position', 'searchPosition']),
      searchPositionDynamics: number(['search_position_dynamics', 'searchPositionDynamics']),
      addToCart: number(['hits_pdp_to_cart', 'hitsPdpToCart', 'hits_search_to_cart', 'hitsSearchToCart', 'total_hits_to_cart', 'totalHitsToCart']),
      addToCartDynamics: number(['hits_pdp_to_cart_dynamics', 'hitsPdpToCartDynamics', 'total_hits_to_cart_dynamics', 'totalHitsToCartDynamics']),
      searchAddToCart,
      searchAddToCartDynamics,
      pdpAddToCart,
      pdpAddToCartDynamics,
      totalAddToCart,
      totalAddToCartDynamics,
      convSearchViewsToCart,
      convSearchViewsToCartDynamics: number(['conv_search_views_to_cart_dynamics', 'convSearchViewsToCartDynamics']) ?? ratioDynamicsFromParts(convSearchViewsToCart, searchAddToCart, searchAddToCartDynamics, searchViews, searchViewsDynamics),
      convSearchViewsToPdp,
      convSearchViewsToPdpDynamics: number(['conv_search_views_to_pdp_dynamics', 'convSearchViewsToPdpDynamics']) ?? ratioDynamicsFromParts(convSearchViewsToPdp, pdpViews, pdpViewsDynamics, searchViews, searchViewsDynamics),
      convPdpViewsToCart,
      convPdpViewsToCartDynamics: number(['conv_pdp_views_to_cart_dynamics', 'convPdpViewsToCartDynamics']) ?? ratioDynamicsFromParts(convPdpViewsToCart, pdpAddToCart, pdpAddToCartDynamics, pdpViews, pdpViewsDynamics),
      convViewsToOrder,
      convViewsToOrderDynamics: number(['conv_views_to_order_dynamics', 'convViewsToOrderDynamics']) ?? ratioDynamicsFromParts(convViewsToOrder, orderedUnits, orderedUnitsDynamics, totalViews, totalViewsDynamics),
      convTotalViewsToCart,
      convTotalViewsToCartDynamics: number(['conv_total_views_to_cart_dynamics', 'convTotalViewsToCartDynamics']) ?? ratioDynamicsFromParts(convTotalViewsToCart, totalAddToCart, totalAddToCartDynamics, totalViews, totalViewsDynamics),
      convHitsToCartToOrder,
      convHitsToCartToOrderDynamics: number(['conv_hits_to_cart_to_order_dynamics', 'convHitsToCartToOrderDynamics']) ?? ratioDynamicsFromParts(convHitsToCartToOrder, orderedUnits, orderedUnitsDynamics, totalAddToCart, totalAddToCartDynamics),
      avgPrice: number(['avg_price', 'avgPrice']),
      avgPriceDynamics: number(['avg_price_dynamics', 'avgPriceDynamics']),
      discountShare,
      discountShareDynamics: number(['discount_share_of_total_gmv_dynamics', 'discountShareOfTotalGmvDynamics']),
      discountShareMedian,
      discountShareMedianDynamics: number(['discount_share_of_median_price_dynamics', 'discountShareOfMedianPriceDynamics']),
      drr,
      drrDynamics: number(['drr_dynamics', 'drrDynamics']),
      periodDays,
      promotionDays: promotionDaysRaw,
      cpcPromotionDays: cpcPromotionDaysRaw,
      reviewCount: number(['reviews_count', 'reviewsCount', 'review_count', 'reviewCount', 'reviews']) ?? 0,
      productRating: number(['rating', 'product_rating', 'productRating']) ?? 0,
      stockoutDays: number(['stockout_days', 'stockoutDays']),
      lastStock: number(['last_stock', 'lastStock']),
      recommendedSupply: number(['recommended_supply', 'recommendedSupply']),
      cancelledUnits,
      cancelledUnitsDynamics: number(['cancelled_units_dynamics', 'cancelledUnitsDynamics', 'cancelled_units_by_order_date_dynamics', 'cancelledUnitsByOrderDateDynamics']),
      returnedUnits,
      returnedUnitsDynamics: number(['returned_units_dynamics', 'returnedUnitsDynamics', 'returned_units_by_order_date_dynamics', 'returnedUnitsByOrderDateDynamics']),
      cancelledUnitsByOrderDate,
      cancelledUnitsByOrderDateDynamics: number(['cancelled_units_by_order_date_dynamics', 'cancelledUnitsByOrderDateDynamics']),
      returnedUnitsByOrderDate,
      returnedUnitsByOrderDateDynamics: number(['returned_units_by_order_date_dynamics', 'returnedUnitsByOrderDateDynamics']),
      abcRevenue: safeString(getFirst(item, ['abc_revenue', 'abcRevenue', 'revenueGrade', 'revenue_grade']) || row.abc_revenue).toUpperCase(),
      abcQuantity: safeString(getFirst(item, ['abc_quantity', 'abcQuantity', 'orderedUnitsGrade', 'ordered_units_grade', 'quantityGrade', 'quantity_grade']) || row.abc_quantity).toUpperCase(),
      priceIndex: safeString(metric(['price_index', 'priceIndex'])),
      badge: safeString(productInfo.badge)
    }
  }
}

function pickMetricValue(current, next) {
  if (next === undefined || next === null || next === '') return current
  return next
}

function addRecommendation(list, item) {
  if (!item?.action) return
  if (list.some((existing) => existing.action === item.action && existing.type === item.type)) return
  list.push(item)
}

function getOnlineProductKeys(row) {
  const raw = parseJson(row?.raw_data, {}) || {}
  return [
    row?.sku,
    row?.offer_id,
    row?.product_id,
    raw.sku,
    raw.offer_id,
    raw.product_id,
    raw.id
  ].map(safeString).filter(Boolean)
}

function getOnlineProductContentRating(row) {
  const raw = parseJson(row?.raw_data, {}) || {}
  const rating = raw.content_rating && typeof raw.content_rating === 'object' ? raw.content_rating : null
  if (!rating) return null
  const score = toNumber(rating.rating ?? rating.score)
  return {
    ...rating,
    rating: score,
    scoreText: rating.scoreText || (score === null ? '' : `${score}%`),
    updated_at: raw.content_rating_updated_at || null
  }
}

function onlineProductTimestamp(row) {
  const time = new Date(row?.updated_at || row?.created_at || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function setLatestOnlineProductByKey(map, key, row) {
  const existing = map.get(key)
  if (!existing || onlineProductTimestamp(row) >= onlineProductTimestamp(existing)) map.set(key, row)
}

function stripHtmlText(value) {
  return safeString(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectOnlineTextValues(value, result = []) {
  if (value === undefined || value === null || value === '') return result
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = stripHtmlText(value)
    if (text) result.push(text)
    return result
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectOnlineTextValues(item, result))
    return result
  }
  if (typeof value === 'object') {
    collectOnlineTextValues(value.value ?? value.text ?? value.name ?? value.title ?? value.label ?? value.description, result)
  }
  return result
}

function uniqueOnlineTextList(values, limit = 20) {
  const seen = new Set()
  const result = []
  for (const value of values || []) {
    const text = stripHtmlText(value)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

function findOnlineAttribute(raw, predicate) {
  const sources = [
    raw?.attributes,
    raw?.attribute_values,
    raw?.attributeValues,
    raw?.product?.attributes,
    raw?.details?.attributes,
    raw?.items?.[0]?.attributes
  ]
  for (const source of sources) {
    const attrs = Array.isArray(source) ? source : []
    const found = attrs.find((attr) => predicate(attr || {}))
    if (found) return found
  }
  return null
}

function getOnlineAttributeValues(attr) {
  if (!attr) return []
  return collectOnlineTextValues(attr.values ?? attr.value ?? attr.text ?? attr.name ?? attr.title ?? attr.label ?? attr.description, [])
}

function extractOnlineProductContent(raw = {}) {
  const descriptionAttr = findOnlineAttribute(raw, (attr) => {
    const id = Number(attr.attribute_id ?? attr.id ?? attr.attributeId)
    const name = safeString(attr.name || attr.attribute_name || attr.title || attr.description).toLowerCase()
    return id === 4191 || name.includes('description') || name.includes('описание') || name.includes('简介') || name.includes('商品描述')
  })
  const richContentAttr = findOnlineAttribute(raw, (attr) => {
    const id = Number(attr.attribute_id ?? attr.id ?? attr.attributeId)
    const name = safeString(attr.name || attr.attribute_name || attr.title || attr.description).toLowerCase()
    return id === 11254 || name.includes('rich') || name.includes('json') || name.includes('rich content') || name.includes('рич') || name.includes('富内容') || name.includes('富文本')
  })
  const shortDescriptionAttr = findOnlineAttribute(raw, (attr) => {
    const name = safeString(attr.name || attr.attribute_name || attr.title || attr.description).toLowerCase()
    return name.includes('short description') || name.includes('краткое описание') || name.includes('短简介') || name.includes('简短描述')
  })
  const tagAttr = findOnlineAttribute(raw, (attr) => {
    const name = safeString(attr.name || attr.attribute_name || attr.title || attr.description).toLowerCase()
    return name.includes('hashtag') || name.includes('tag') || name.includes('тег') || name.includes('ключев') || name.includes('标签') || name.includes('关键词')
  })
  const tags = uniqueOnlineTextList([
    ...collectOnlineTextValues(raw.tags, []),
    ...collectOnlineTextValues(raw.hashtags, []),
    ...collectOnlineTextValues(raw.hash_tags, []),
    ...collectOnlineTextValues(raw.keywords, []),
    ...collectOnlineTextValues(raw.search_keywords, []),
    ...getOnlineAttributeValues(tagAttr)
  ])
  const description = uniqueOnlineTextList([
    raw.description,
    raw.description_text,
    raw.product_description,
    raw.rich_description,
    ...getOnlineAttributeValues(descriptionAttr)
  ], 1)[0] || ''
  const richContent = uniqueOnlineTextList([
    raw.json_content,
    raw.jsonContent,
    raw.rich_content,
    raw.richContent,
    raw.rich_description_json,
    raw.rich_content_json,
    raw.content?.json_content,
    raw.content?.rich_content,
    ...getOnlineAttributeValues(richContentAttr)
  ], 1)[0] || ''
  const shortDescription = uniqueOnlineTextList([
    raw.short_description,
    raw.annotation,
    raw.summary,
    ...getOnlineAttributeValues(shortDescriptionAttr)
  ], 1)[0] || ''
  return { tags, description, shortDescription, richContent }
}

function hasRepositoryForEntity(db, entityName) {
  const targetName = safeString(entityName)
  if (!targetName) return false
  const entityMetadatas = Array.isArray(db?.entityMetadatas) ? db.entityMetadatas : []
  return entityMetadatas.some((meta) => safeString(meta?.name) === targetName)
}

function buildOnlineProductProfitInput(online, raw) {
  return {
    ...raw,
    ...online,
    id: online.product_id || raw.product_id || raw.id || online.id,
    product_id: online.product_id || raw.product_id || raw.id || '',
    offer_id: online.offer_id || raw.offer_id || '',
    sku: online.sku || raw.sku || '',
    platform_sku: online.sku || raw.sku || '',
    storeId: online.store_id || raw.storeId || raw.store_id || '',
    store_id: online.store_id || raw.store_id || raw.storeId || '',
    price: online.price ?? raw.price,
    cost: online.cost ?? raw.cost,
    shipping: online.shipping ?? raw.shipping
  }
}

async function enrichProductsWithOnlineProducts(db, tenantId, products, rows = []) {
  if (!Array.isArray(products) || products.length === 0 || !Array.isArray(rows) || rows.length === 0) return products
  const onlineByKey = new Map()
  for (const row of rows) {
    for (const key of getOnlineProductKeys(row)) {
      setLatestOnlineProductByKey(onlineByKey, key, row)
    }
  }
  const canEstimateProfit = hasRepositoryForEntity(db, 'PlatformSkuMapping') && hasRepositoryForEntity(db, 'InternalSku')
  const costMap = canEstimateProfit ? await profitRuntimeService.getInternalSkuCostMap(db, tenantId) : new Map()
  const profitOptions = {
    rubPerCny: 11.0974,
    acquiringPercent: 1,
    withdrawalRate: 0
  }
  for (const product of products) {
    const keys = [product.sku, product.offer_id, product.product_id, product.productKey].map(safeString).filter(Boolean)
    const online = keys.map((key) => onlineByKey.get(key)).find(Boolean)
    if (!online) continue
    const raw = parseJson(online.raw_data, {}) || {}
    const contentRating = getOnlineProductContentRating(online)
    const onlineContent = extractOnlineProductContent(raw)
    const onlineImageUrl = normalizeSellerAnalyticsImageUrl(
      online.primary_image
      || online.image_url
      || raw.primary_image
      || raw.image_url
      || raw.main_image
      || raw.images
      || raw.pictures
    )
    let estimatedProfit = null
    if (canEstimateProfit) {
      try {
        estimatedProfit = await profitRuntimeService.calculateOnlineProductEstimatedProfit(
          db,
          buildOnlineProductProfitInput(online, raw),
          costMap,
          profitOptions,
          tenantId
        )
      } catch (error) {
        estimatedProfit = null
      }
    }
    product.onlineProduct = {
      id: online.id,
      product_id: online.product_id || raw.product_id || raw.id || '',
      offer_id: online.offer_id || raw.offer_id || '',
      sku: online.sku || raw.sku || '',
      name: online.name || raw.name || raw.title || '',
      tags: onlineContent.tags,
      description: onlineContent.description,
      shortDescription: onlineContent.shortDescription,
      richContent: onlineContent.richContent,
      store_id: online.store_id,
      status: online.status,
      image_url: onlineImageUrl,
      price: online.price,
      cost: online.cost,
      shipping: online.shipping,
      supplier_sku: online.supplier_sku || raw.supplier_sku || raw.supplierSku || '',
      supplier_url: online.supplier_url || raw.supplier_url || raw.supplierUrl || '',
      estimatedProfit,
      contentRating
    }
    if (!product.image_url && onlineImageUrl) product.image_url = onlineImageUrl
    product.metrics.onlinePrice = toNumber(online.price ?? raw.price)
    product.metrics.onlineCost = toNumber(online.cost ?? raw.cost) ?? toNumber(estimatedProfit?.purchase_cost)
    product.metrics.onlineShipping = toNumber(online.shipping ?? raw.shipping) ?? toNumber(estimatedProfit?.shipping_fee)
    product.metrics.onlineStatus = online.status || raw.status || null
    product.metrics.onlineProfit = toNumber(estimatedProfit?.profit)
    product.metrics.onlineProfitRate = estimatedProfit ? toNumber(estimatedProfit.profit_rate) : null
    product.metrics.onlineTotalCost = toNumber(estimatedProfit?.cost)
    product.metrics.onlineCommission = toNumber(estimatedProfit?.commission_fee)
    product.metrics.onlineOzonPlatformDeliveryFee = toNumber(estimatedProfit?.ozon_platform_delivery_fee)
    product.metrics.onlineAcquiringFee = toNumber(estimatedProfit?.acquiring_fee)
    product.metrics.onlineWithdrawalFee = toNumber(estimatedProfit?.withdrawal_fee)
    product.metrics.onlineTailDeliveryFee = toNumber(estimatedProfit?.tail_delivery_fee)
    product.metrics.profitMissingParams = Array.isArray(estimatedProfit?.missing) ? estimatedProfit.missing : []
    product.metrics.unmappedInternalSku = Boolean(estimatedProfit?.unmapped_internal_sku)
    product.metrics.internalSku = estimatedProfit?.internal_sku || ''
    product.metrics.internalSkuName = estimatedProfit?.internal_sku_name || ''
    if (estimatedProfit && product.metrics.onlineProfit !== null) {
      product.metrics.estimatedGrossProfit = product.metrics.onlineProfit
      product.metrics.estimatedGrossMargin = product.metrics.onlineProfitRate !== null
        ? product.metrics.onlineProfitRate * 100
        : null
    } else if (product.metrics.onlinePrice !== null && (product.metrics.onlineCost !== null || product.metrics.onlineShipping !== null)) {
      const cost = product.metrics.onlineCost || 0
      const shipping = product.metrics.onlineShipping || 0
      product.metrics.estimatedGrossProfit = product.metrics.onlinePrice - cost - shipping
      product.metrics.estimatedGrossMargin = product.metrics.onlinePrice > 0
        ? (product.metrics.estimatedGrossProfit / product.metrics.onlinePrice) * 100
        : null
    }
    if (contentRating) {
      product.metrics.contentRatingScore = contentRating.rating
      product.metrics.contentRatingUpdatedAt = contentRating.updated_at
    }
    const priceIndex = safeString(raw.advanced_price_indexes?.color_index || raw.price_indexes?.color_index || raw.price_indexes?.price_index)
    if (priceIndex && !product.metrics.priceIndex) product.metrics.priceIndex = priceIndex
  }
  return products
}

function buildProductRecommendations(product) {
  const m = product.metrics || {}
  const recommendations = []
  let score = 0
  const add = (points, type, action, reason, evidence) => {
    score += points
    addRecommendation(recommendations, { type, action, reason, evidence, points })
  }

  const exposure = m.searchViews || m.totalViews || 0
  const orderedUnits = m.orderedUnits || 0
  const pdpViews = m.pdpViews || 0
  const addToCart = m.addToCart || 0
  const returns = (m.returnedUnitsByOrderDate || 0) + (m.returnedUnits || 0)
  const cancellations = (m.cancelledUnitsByOrderDate || 0) + (m.cancelledUnits || 0)
  const priceIndex = safeString(m.priceIndex).toLowerCase()
  const hasSearchClickRate = hasAdviceMetric(m.convSearchViewsToPdp)
  const hasCardCartRate = hasAdviceMetric(m.convPdpViewsToCart)
  const hasContentRating = hasAdviceMetric(m.contentRatingScore)

  if (exposure < 20 && orderedUnits <= 0) {
    add(18, '搜索流量', '搜不到/曝光低：校准类目、类型和核心属性', 'Ozon 会先在名称、类目、品牌、描述、颜色、尺寸、材质、类型和属性中匹配搜索词。曝光偏低时，优先不要只改后台名称，要确认类目和可评分属性能支撑前台标题与搜索匹配。', `曝光 ${formatMetricForAdvice(exposure)}，订单 ${formatMetricForAdvice(orderedUnits)}`)
  }
  if (m.searchPosition > 100 && exposure >= 100) {
    add(18, '搜索流量', '搜索匹配弱：补搜索词到属性、描述和标签', '搜索位置靠后但仍有曝光，说明商品进入结果池后竞争力不足。Ozon 的参数分值是当前搜索结果内的相对分，应该优先补权重高且短板明显的类目、商品类型、品牌、属性和描述。', `搜索位置 ${formatMetricForAdvice(m.searchPosition)}，搜索曝光 ${formatMetricForAdvice(m.searchViews)}`)
  }
  if ((m.searchViews >= 100 || m.totalViews >= 200) && (pdpViews <= 10 || (hasSearchClickRate && m.convSearchViewsToPdp < 5))) {
    add(22, '点击表现', '有曝光无点击：重做主图、价格标签和前台标题依据', '商品已经被看到，但卡片访问少。优先检查主图、价格/促销徽章、配送承诺，以及类目/属性是否能生成买家一眼能懂的前台标题。', `曝光 ${formatMetricForAdvice(exposure)}，卡片访问 ${formatMetricForAdvice(pdpViews)}，曝点 ${formatMetricForAdvice(m.convSearchViewsToPdp)}%`)
  }
  if (exposure >= 100 && orderedUnits <= 0) {
    add(18, '转化表现', '有流量无成交：拆查点击、加购和下单三段', '不要直接把问题归因到价格。先看曝光到点击、点击到加购、加购到下单分别卡在哪一层，再决定改主图、富内容、价格、配送还是活动。', `曝光 ${formatMetricForAdvice(exposure)}，卡片访问 ${formatMetricForAdvice(pdpViews)}，加购 ${formatMetricForAdvice(addToCart)}，订单 ${formatMetricForAdvice(orderedUnits)}`)
  }
  if (pdpViews >= 20 && (!hasCardCartRate || m.convPdpViewsToCart < 5)) {
    add(22, '转化表现', '卡片承接弱：补详情图、富内容、评价和适配说明', '卡片访问不低但加购偏弱，说明买家进来后没有被说服。优先补能降低疑虑的信息：使用场景、尺寸/适配、材质、包装、评价和富内容。', `卡片访问 ${formatMetricForAdvice(pdpViews)}，加购转化 ${formatMetricForAdvice(m.convPdpViewsToCart)}%`)
  }
  if (hasContentRating && m.contentRatingScore < 40) {
    add(24, '转化表现', '内容评级低：按媒体45/特征30/描述25补齐', '内容评级低于40属于低档。优先拆成三块处理：图片/视频是否足够，类目特征是否填满，描述是否在101-500字符且有富内容。', `内容评级 ${formatMetricForAdvice(m.contentRatingScore)}`)
  } else if (hasContentRating && m.contentRatingScore < 80) {
    add(14, '转化表现', '内容评级基础：补特征和富内容冲80分', '40-79只是基础档。继续补满可评分特征、图文/视频和富内容，通常比单纯改标题更能提升搜索匹配与详情承接。', `内容评级 ${formatMetricForAdvice(m.contentRatingScore)}`)
  }
  if (addToCart > 0 && orderedUnits <= 0) {
    add(20, '转化表现', '加购未下单：检查价格、运费、优惠门槛和配送时效', '用户已经表达购买意图但没有下单，优先看最终到手价、配送速度、优惠门槛和竞品价格指数。', `加购 ${formatMetricForAdvice(addToCart)}，订单 ${formatMetricForAdvice(orderedUnits)}，价格指数 ${m.priceIndex || '-'}`)
  }
  if ((m.revenueDynamics || 0) <= -50 || (m.orderedUnitsDynamics || 0) <= -50) {
    add(20, '销售表现', '销量下滑：对照曝光、点击、库存和价格指数', '销售明显下滑时，不要只看订单。先定位是搜索曝光掉了、点击掉了、详情承接掉了、库存断了，还是价格/促销/配送提升因素变弱。', `销售额变化 ${formatMetricForAdvice(m.revenueDynamics)}%，订单变化 ${formatMetricForAdvice(m.orderedUnitsDynamics)}%`)
  }
  if ((m.revenue || 0) > 0 && orderedUnits > 0 && recommendations.length === 0) {
    add(8, '销售表现', '已有成交基础：保持库存并小幅测试促销放量', '商品已经跑通下单链路，可以围绕高相关搜索词、促销活动或本地配送做小范围放量测试。', `销售额 ${formatMetricForAdvice(m.revenue)}，订单 ${formatMetricForAdvice(orderedUnits)}`)
  }
  if ((m.drr || 0) >= 20) {
    add(18, '广告表现', '推广低效：按点击概率和下单概率重筛词/降出价', '付费推广会影响最终排序，但推广评分还取决于点击概率、下单概率、点击出价和下单出价。DRR偏高时先停低转化词，不要只加预算。', `DRR ${formatMetricForAdvice(m.drr)}%，推广天数 ${formatMetricForAdvice(m.cpcPromotionDays)}`)
  }
  if ((m.cpcPromotionDays || 0) > 0 && orderedUnits <= 0 && exposure >= 50) {
    add(18, '广告表现', '推广有曝光无成交：收预算并回查词包', '有推广或曝光但没有订单，说明付费流量没有闭环。先回查投放词、主图点击和详情承接，再决定是否继续放量。', `推广天数 ${formatMetricForAdvice(m.cpcPromotionDays)}，曝光 ${formatMetricForAdvice(exposure)}，订单 ${formatMetricForAdvice(orderedUnits)}`)
  }
  if ((m.stockoutDays || 0) > 0 || (m.recommendedSupply || 0) > 0) {
    add(16, '库存表现', '库存风险：先补可售库存再放广告', '断货会影响可售率和错失销售，也会让广告/搜索流量无法承接。先补货或暂停放量，避免把预算打到无货商品上。', `断货天数 ${formatMetricForAdvice(m.stockoutDays)}，建议补货 ${formatMetricForAdvice(m.recommendedSupply)}`)
  }
  if (returns > 0 || cancellations > 0) {
    add(16, '售后表现', '售后风险：检查描述、尺寸图、包装和适配说明', '退货或取消已经出现，需要确认买家预期和实物是否一致。优先补尺寸、适配车型/场景、包装保护和质量说明。', `退货 ${formatMetricForAdvice(returns)}，取消 ${formatMetricForAdvice(cancellations)}`)
  }
  if ((m.productRating || 0) > 0 && m.productRating < 4.5) {
    add(14, '售后表现', '评价信任弱：定位差评原因并补图文说明', '评价会影响买家信任和搜索表现。评分偏低时，优先从差评原因反推描述、尺寸、适配和质量说明。', `评分 ${formatMetricForAdvice(m.productRating)}，评价数 ${formatMetricForAdvice(m.reviewCount)}`)
  } else if (orderedUnits > 0 && (m.reviewCount || 0) < 3) {
    add(10, '售后表现', '评价样本少：引导买家补图文评价', '商品已出单但评价样本少，搜索和转化信任不足。优先争取带图/视频的真实评价。', `订单 ${formatMetricForAdvice(orderedUnits)}，评价数 ${formatMetricForAdvice(m.reviewCount)}`)
  }
  if (priceIndex === 'unfavorable' || ((m.discountShare || 0) >= 55 && orderedUnits <= 1)) {
    add(16, '利润表现', '利润风险：重算售价、折扣和广告空间', '价格指数不利会拖累提升因素，折扣过高又可能牺牲利润。需要一起看售价、折扣、成本、广告和订单增量。', `折扣占比 ${formatMetricForAdvice(m.discountShare)}%，价格指数 ${m.priceIndex || '-'}`)
  }
  if (m.estimatedGrossMargin !== null && m.estimatedGrossMargin !== undefined && m.estimatedGrossMargin < 10) {
    add(22, '利润表现', '利润过薄：调价、控广告或改组合装', '按在线售价和本地成本/物流估算，利润空间偏薄。优先算清佣金、物流、广告后再决定是否降价。', `估算毛利率 ${formatMetricForAdvice(m.estimatedGrossMargin)}%`)
  }
  if (product.onlineProduct && m.onlinePrice !== null && m.onlinePrice !== undefined && Array.isArray(m.profitMissingParams) && m.profitMissingParams.length > 0) {
    add(10, '利润表现', '补齐成本、佣金和物流参数', '已拿到在线商品价格，但利润估算仍缺少必要参数。', m.profitMissingParams.slice(0, 3).join('、'))
  } else if (product.onlineProduct && m.onlinePrice !== null && m.onlinePrice !== undefined && !product.onlineProduct.estimatedProfit && m.onlineCost === null && m.onlineShipping === null) {
    add(10, '利润表现', '补齐成本、佣金和物流参数', '已拿到在线商品价格，但缺少成本/物流，利润诊断还不能闭环。', `在线售价 ${formatMetricForAdvice(m.onlinePrice)}`)
  }

  const priority = score >= 55 ? 'high' : score >= 28 ? 'medium' : 'low'
  return {
    score: Math.min(score, 100),
    priority,
    recommendations: recommendations.sort((a, b) => b.points - a.points).slice(0, 4)
  }
}

function priorityRank(priority) {
  if (priority === 'high') return 3
  if (priority === 'medium') return 2
  return 1
}

function inferOperationSegment(product = {}, recommendation = {}) {
  const m = product.metrics || {}
  const exposure = m.searchViews || m.totalViews || 0
  const pdpViews = m.pdpViews || 0
  const addToCart = m.addToCart || 0
  const orderedUnits = m.orderedUnits || 0
  const returns = (m.returnedUnitsByOrderDate || 0) + (m.returnedUnits || 0)
  const cancellations = (m.cancelledUnitsByOrderDate || 0) + (m.cancelledUnits || 0)
  if ((m.stockoutDays || 0) > 0 || (m.recommendedSupply || 0) > 0) return 'inventory_risk'
  if (m.estimatedGrossMargin !== null && m.estimatedGrossMargin !== undefined && m.estimatedGrossMargin < 10) return 'profit_risk'
  if ((m.drr || 0) >= 20) return 'ad_efficiency_risk'
  if (returns > 0 || cancellations > 0 || ((m.productRating || 0) > 0 && m.productRating < 4.5)) return 'aftersales_risk'
  if (addToCart > 0 && orderedUnits <= 0) return 'order_gap'
  if (pdpViews >= 20 && addToCart <= 0) return 'detail_gap'
  if (exposure >= 100 && pdpViews <= 10) return 'click_gap'
  if (exposure < 20 && orderedUnits <= 0) return 'traffic_gap'
  if ((m.revenue || 0) > 0 && orderedUnits > 0 && priorityRank(product.priority) <= 1) return 'scale_candidate'
  return safeString(recommendation.type) ? 'diagnosis_followup' : 'watchlist'
}

function operationBizDateFromQuery(query = {}, analysis = {}) {
  const explicit = normalizeDateOnly(query.biz_date || query.bizDate || query.date_to || query.dateTo)
  if (explicit) return explicit
  const latest = normalizeDateOnly(analysis?.summary?.latestCapturedAt)
  return latest || formatDateOnly(new Date())
}

function operationShopId(product = {}, query = {}) {
  return safeString(query.shop_id || query.shopId || query.store_id || query.storeId || product.store_id || product.shop_id)
}

function productIdentity(product = {}) {
  return safeString(product.sku || product.offer_id || product.product_id || product.productKey || product.product_name)
}

function buildOperationRowsFromAnalysis(analysis = {}, query = {}, tenantId = 'admin') {
  const products = Array.isArray(analysis.focusProducts) ? analysis.focusProducts : []
  const now = new Date()
  const nowText = now.toISOString()
  const bizDate = operationBizDateFromQuery(query, analysis)
  const periodKey = safeString(query.period_key || query.periodKey || analysis?.summary?.periodKey || '7d') || '7d'
  const diagnosisRows = []
  const todoRows = []
  for (const product of products) {
    const identity = productIdentity(product)
    if (!identity) continue
    const recommendations = Array.isArray(product.recommendations) ? product.recommendations : []
    const firstRecommendation = recommendations[0] || {}
    const segment = inferOperationSegment(product, firstRecommendation)
    const shopId = operationShopId(product, query) || null
    const diagnosisId = stableId('sad', [tenantId, shopId, bizDate, periodKey, identity])
    diagnosisRows.push({
      id: diagnosisId,
      tenant_id: tenantId,
      shop_id: shopId,
      biz_date: bizDate,
      period_key: periodKey,
      product_id: safeString(product.product_id || product.productId) || null,
      sku: safeString(product.sku) || null,
      offer_id: safeString(product.offer_id || product.offerId) || null,
      product_name: safeString(product.product_name || product.productName) || null,
      image_url: safeString(product.image_url || product.imageUrl) || null,
      segment,
      priority: product.priority || 'low',
      score: Number(product.score || 0),
      main_problem: safeString(firstRecommendation.type || segment) || segment,
      recommended_action: safeString(firstRecommendation.action) || null,
      metrics_json: stringifyJson(product.metrics || {}),
      evidence_json: stringifyJson({ recommendations }),
      diagnosed_at: now
    })
    for (const recommendation of recommendations.slice(0, 3)) {
      const todoSegment = inferOperationSegment(product, recommendation)
      todoRows.push({
        id: stableId('sato', [tenantId, shopId, bizDate, periodKey, identity, todoSegment, recommendation.type, recommendation.action]),
        tenant_id: tenantId,
        shop_id: shopId,
        biz_date: bizDate,
        period_key: periodKey,
        product_id: safeString(product.product_id || product.productId) || null,
        sku: safeString(product.sku) || null,
        offer_id: safeString(product.offer_id || product.offerId) || null,
        product_name: safeString(product.product_name || product.productName) || null,
        image_url: safeString(product.image_url || product.imageUrl) || null,
        segment: todoSegment,
        priority: product.priority || 'low',
        score: Number(product.score || recommendation.points || 0),
        problem_type: safeString(recommendation.type || todoSegment) || todoSegment,
        recommended_action: safeString(recommendation.action || recommendation.reason) || null,
        evidence_json: stringifyJson({
          reason: recommendation.reason || '',
          evidence: recommendation.evidence || '',
          metrics: product.metrics || {}
        }),
        status: 'open',
        owner: null,
        action_taken: null,
        resolved_at: null,
        created_at: nowText,
        updated_at: nowText
      })
    }
  }
  return { diagnosisRows, todoRows, bizDate, periodKey }
}

async function refreshOperationTodos(db, query = {}, tenantId = 'admin') {
  const analysisQuery = {
    ...query,
    page: query.page || 1,
    product_limit: query.product_limit || query.productLimit || 100,
    focus_limit: query.focus_limit || query.focusLimit || 500,
    limit: query.limit || 500
  }
  const analysis = await getAnalysis(db, analysisQuery, tenantId)
  const { diagnosisRows, todoRows, bizDate, periodKey } = buildOperationRowsFromAnalysis(analysis, analysisQuery, tenantId)
  const diagnosisRepo = db.getRepository('SellerAnalyticsProductDiagnosis')
  const todoRepo = db.getRepository('SellerAnalyticsOperationTodo')
  await diagnosisRepo.delete({ tenant_id: tenantId, biz_date: bizDate, period_key: periodKey })
  await todoRepo.delete({ tenant_id: tenantId, biz_date: bizDate, period_key: periodKey, status: 'open' })
  if (diagnosisRows.length) await diagnosisRepo.save(diagnosisRows)
  if (todoRows.length) await todoRepo.save(todoRows)
  return {
    success: true,
    bizDate,
    periodKey,
    diagnosisCount: diagnosisRows.length,
    todoCount: todoRows.length
  }
}

async function listOperationTodos(db, query = {}, tenantId = 'admin') {
  const repo = db.getRepository('SellerAnalyticsOperationTodo')
  const where = { tenant_id: tenantId }
  const status = safeString(query.status || 'open')
  const bizDate = normalizeDateOnly(query.biz_date || query.bizDate)
  const periodKey = safeString(query.period_key || query.periodKey)
  const segment = safeString(query.segment)
  if (status && status !== 'all') where.status = status
  if (bizDate) where.biz_date = bizDate
  if (periodKey) where.period_key = periodKey
  if (segment) where.segment = segment
  const take = Math.min(Math.max(Number(query.limit || 100), 1), 500)
  const rows = await repo.find({ where, order: { biz_date: 'DESC', score: 'DESC', updated_at: 'DESC' }, take })
  return rows.sort((a, b) =>
    priorityRank(b.priority) - priorityRank(a.priority) ||
    Number(b.score || 0) - Number(a.score || 0) ||
    String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
  )
}

function hasAdviceMetric(value) {
  if (value === undefined || value === null || value === '') return false
  return Number.isFinite(Number(value))
}

function formatMetricForAdvice(value) {
  if (value === undefined || value === null || value === '') return '-'
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return Number.isInteger(number) ? String(number) : number.toFixed(2)
}

function mergeProductMetric(product, metricItem, snapshot) {
  product.sku = product.sku || metricItem.sku
  product.offer_id = product.offer_id || metricItem.offer_id
  product.product_id = product.product_id || metricItem.product_id
  product.product_name = product.product_name || metricItem.product_name
  product.image_url = product.image_url || metricItem.image_url
  product.latestCapturedAt = product.latestCapturedAt && product.latestCapturedAt > snapshot.captured_at ? product.latestCapturedAt : snapshot.captured_at
  product.sources.add(metricItem.source)
  product.sourceLabels.add(TAB_LABELS[metricItem.source] || metricItem.source)
  product.tabs[metricItem.source] = {
    label: TAB_LABELS[metricItem.source] || metricItem.source,
    metrics: metricItem.metrics,
    captured_at: snapshot.captured_at
  }
  for (const [key, value] of Object.entries(metricItem.metrics)) {
    product.metrics[key] = pickMetricValue(product.metrics[key], value)
  }
}

function getProductMatchKeys(input = {}) {
  const keys = []
  const push = (prefix, value) => {
    const text = safeString(value)
    if (text) keys.push(`${prefix}:${text}`)
  }
  push('sku', input.sku)
  push('offer', input.offer_id)
  push('product', input.product_id)
  if (!keys.length) push('fallback', input.productKey || input.product_name)
  return keys
}

function getFirstProfileText(...values) {
  for (const value of values) {
    const text = safeString(value)
    if (text) return text
  }
  return ''
}

function getPostingProductMatchKeys(product = {}) {
  return getProductMatchKeys({
    sku: product.sku || product.sku_id || product.skuId,
    offer_id: product.offer_id || product.offerId || product.article,
    product_id: product.product_id || product.productId,
    product_name: product.name || product.product_name
  })
}

function getPostingProductAmount(product = {}, financialProduct = null) {
  const quantity = Math.max(1, Number(product.quantity || financialProduct?.quantity || 1) || 1)
  const rawPrice = product.price ?? product.offer_price ?? product.customer_price ?? financialProduct?.price ?? financialProduct?.old_price
  const price = toNumber(rawPrice) || 0
  return Number((price * quantity).toFixed(2))
}

function addProfileDimension(map, key, amount) {
  const name = safeString(key)
  if (!name) return
  const entry = map.get(name) || { name, orderCount: 0, salesAmount: 0 }
  entry.orderCount += 1
  entry.salesAmount = Number((entry.salesAmount + amount).toFixed(2))
  map.set(name, entry)
}

function finalizeProfileDimension(map, totalOrders, totalSales, limit = 8) {
  return Array.from(map.values())
    .sort((a, b) => b.orderCount - a.orderCount || b.salesAmount - a.salesAmount || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((item) => ({
      ...item,
      orderShare: totalOrders > 0 ? Number(((item.orderCount / totalOrders) * 100).toFixed(1)) : 0,
      salesShare: totalSales > 0 ? Number(((item.salesAmount / totalSales) * 100).toFixed(1)) : 0
    }))
}

function getFinancialProductMap(posting = {}) {
  const map = new Map()
  const products = Array.isArray(posting.financial_data?.products) ? posting.financial_data.products : []
  for (const product of products) {
    for (const key of getPostingProductMatchKeys(product)) {
      if (!map.has(key)) map.set(key, product)
    }
  }
  return map
}

function makeCustomerProfileSeed() {
  return {
    orderCount: 0,
    salesAmount: 0,
    regionMap: new Map(),
    cityMap: new Map(),
    countryMap: new Map(),
    customerMap: new Map(),
    orders: []
  }
}

async function enrichProductsWithCustomerProfile(db, tenantId, products, query = {}) {
  if (!Array.isArray(products) || products.length === 0 || !hasRepositoryForEntity(db, 'FbsPosting')) return products
  const productIndex = new Map()
  for (const product of products) {
    for (const key of getProductMatchKeys(product)) {
      if (!productIndex.has(key)) productIndex.set(key, product)
    }
  }
  if (productIndex.size === 0) return products
  const dateFrom = normalizeDateOnly(query.date_from || query.dateFrom)
  const dateTo = normalizeDateOnly(query.date_to || query.dateTo)
  const baseWhere = { tenant_id: tenantId }
  let where = baseWhere
  if (dateFrom && dateTo) {
    const from = new Date(`${dateFrom}T00:00:00`)
    const to = new Date(`${dateTo}T23:59:59`)
    where = [
      { ...baseWhere, in_process_at: Between(from, to) },
      { ...baseWhere, updated_at: Between(from, to) }
    ]
  }
  let rows = []
  try {
    rows = await db.getRepository('FbsPosting').find({
      where,
      order: { in_process_at: 'DESC', updated_at: 'DESC' },
      take: 2000
    })
  } catch (error) {
    return products
  }
  const profileByProduct = new Map()
  for (const row of rows) {
    const posting = parseJson(row.raw_data, {}) || {}
    const productsInOrder = Array.isArray(posting.products) ? posting.products : []
    if (productsInOrder.length === 0) continue
    const analytics = posting.analytics_data || {}
    const customer = posting.customer || {}
    const address = customer.address || {}
    const addressee = posting.addressee || {}
    const region = getFirstProfileText(analytics.region, address.region, address.district)
    const city = getFirstProfileText(analytics.city, address.city)
    const country = getFirstProfileText(address.country)
    const financialMap = getFinancialProductMap(posting)
    const matchedProducts = new Set()
    let matchedAmount = 0
    for (const orderProduct of productsInOrder) {
      const matchKeys = getPostingProductMatchKeys(orderProduct)
      const product = matchKeys.map((key) => productIndex.get(key)).find(Boolean)
      if (!product || matchedProducts.has(product)) continue
      matchedProducts.add(product)
      const financialProduct = matchKeys.map((key) => financialMap.get(key)).find(Boolean)
      const amount = getPostingProductAmount(orderProduct, financialProduct)
      matchedAmount += amount
      const profile = profileByProduct.get(product.productKey) || makeCustomerProfileSeed()
      const customerKey = getFirstProfileText(customer.customer_id) || [getFirstProfileText(customer.name, addressee.name), region, city].filter(Boolean).join('|')
      profile.orderCount += 1
      profile.salesAmount = Number((profile.salesAmount + amount).toFixed(2))
      if (customerKey) profile.customerMap.set(customerKey, (profile.customerMap.get(customerKey) || 0) + 1)
      addProfileDimension(profile.regionMap, region, amount)
      addProfileDimension(profile.cityMap, city, amount)
      addProfileDimension(profile.countryMap, country, amount)
      if (profile.orders.length < 12) {
        profile.orders.push({
          postingNumber: getFirstProfileText(row.posting_number, posting.posting_number),
          orderNumber: getFirstProfileText(row.order_number, posting.order_number),
          region,
          city,
          country,
          customerName: getFirstProfileText(customer.name, addressee.name),
          customerId: getFirstProfileText(customer.customer_id),
          isLegal: analytics.is_legal === true,
          isPremium: analytics.is_premium === true,
          paymentType: getFirstProfileText(analytics.payment_type_group_name),
          deliveryType: getFirstProfileText(analytics.delivery_type),
          provider: getFirstProfileText(analytics.tpl_provider),
          status: getFirstProfileText(row.status, posting.status),
          substatus: getFirstProfileText(row.substatus, posting.substatus),
          inProcessAt: row.in_process_at || posting.in_process_at || null,
          amount,
          productName: getFirstProfileText(orderProduct.name, orderProduct.offer_id, orderProduct.sku)
        })
      }
      profileByProduct.set(product.productKey, profile)
    }
  }
  for (const product of products) {
    const profile = profileByProduct.get(product.productKey)
    if (!profile || profile.orderCount <= 0) continue
    product.customerProfile = {
      orderCount: profile.orderCount,
      salesAmount: profile.salesAmount,
      customerCount: profile.customerMap.size,
      repeatCustomerCount: Array.from(profile.customerMap.values()).filter((count) => count > 1).length,
      repeatOrderCount: Array.from(profile.customerMap.values()).filter((count) => count > 1).reduce((sum, count) => sum + count, 0),
      regions: finalizeProfileDimension(profile.regionMap, profile.orderCount, profile.salesAmount, 8),
      cities: finalizeProfileDimension(profile.cityMap, profile.orderCount, profile.salesAmount, 8),
      countries: finalizeProfileDimension(profile.countryMap, profile.orderCount, profile.salesAmount, 5),
      orders: profile.orders
    }
  }
  return products
}

function normalizeTotalsMetricItem(totals, tabKey, capturedAt, options = {}) {
  const metricItem = normalizeProductMetricItem({
    productInfo: {
      name: '总计和平均值'
    },
    metrics: totals || {}
  }, tabKey, capturedAt, options)
  if (!metricItem) return null
  return {
    productKey: `__totals__:${tabKey || 'unknown'}`,
    sku: '',
    offer_id: '',
    product_id: '',
    product_name: '总计和平均值',
    image_url: '',
    metrics: metricItem.metrics,
    tabs: {},
    sources: [tabKey],
    sourceLabels: [TAB_LABELS[tabKey] || tabKey],
    latestCapturedAt: capturedAt,
    score: 0,
    priority: 'low',
    recommendations: [],
    isTotalsRow: true
  }
}

function getResponseItems(value) {
  const body = parseJson(value, null)
  if (Array.isArray(body?.items)) return body.items
  if (Array.isArray(body?.result?.items)) return body.result.items
  const rows = collectMetricRows(body)
  if (rows.length > 0) return rows
  return []
}

function getResponseTotals(value) {
  const body = parseJson(value, null)
  if (body?.metrics) return body.metrics
  if (body?.result?.metrics) return body.result.metrics
  if (body?.result && typeof body.result === 'object' && !Array.isArray(body.result) && !body.result.items) {
    return body.result
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && !body.items && !body.result) {
    return body
  }
  return null
}

function getSnapshotPeriodDays(row) {
  const period = getSnapshotPeriod(row)
  if (!period.date_from || !period.date_to) return null
  return dateDiffDays(period.date_from, period.date_to)
}

function normalizeAnalysisSort(query = {}) {
  const key = safeString(query.sort_key || query.sortKey)
  const order = safeString(query.sort_order || query.sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc'
  if (!key) return { key: 'score', order: 'desc' }
  if (key === 'score' || key === 'latestCapturedAt' || key.startsWith('metric:')) return { key, order }
  return { key: 'score', order: 'desc' }
}

function getAnalysisSortValue(product, sortKey) {
  if (sortKey === 'score') return toNumber(product.score) || 0
  if (sortKey === 'latestCapturedAt') {
    const time = product.latestCapturedAt ? new Date(product.latestCapturedAt).getTime() : null
    return Number.isFinite(time) ? time : null
  }
  if (sortKey.startsWith('metric:')) {
    return toNumber(product.metrics?.[sortKey.slice('metric:'.length)])
  }
  return null
}

function compareAnalysisProducts(a, b, sort) {
  const av = getAnalysisSortValue(a, sort.key)
  const bv = getAnalysisSortValue(b, sort.key)
  if (av === null && bv !== null) return 1
  if (av !== null && bv === null) return -1
  if (av !== null && bv !== null && av !== bv) {
    return sort.order === 'asc' ? av - bv : bv - av
  }
  return Number(b.score || 0) - Number(a.score || 0) || Number(b.metrics?.revenue || 0) - Number(a.metrics?.revenue || 0)
}

function analysisProductMatchesKeyword(product, keyword) {
  const q = safeString(keyword).trim().toLowerCase()
  if (!q) return true
  return [
    product.product_name,
    product.sku,
    product.offer_id,
    product.product_id,
    ...(product.sourceLabels || []),
    ...(product.recommendations || []).flatMap((item) => [item.type, item.action, item.reason, item.evidence])
  ].some((value) => safeString(value).toLowerCase().includes(q))
}

async function getAnalysis(db, query = {}, tenantId = 'admin') {
  const cached = getCachedAnalysis(query, tenantId)
  if (cached) {
    if (query.profile === '1' || query.debug === '1') {
      console.info(`[seller-analytics] analysis cache hit tenant=${tenantId}`)
    }
    return cached
  }
  const timings = {}
  const startedAt = Date.now()
  let stageAt = startedAt
  const mark = (name) => {
    const now = Date.now()
    timings[name] = now - stageAt
    stageAt = now
  }
  const hasProductPage = query.page !== undefined && query.page !== null && query.page !== ''
  const requestedProductPage = Math.max(1, Number.parseInt(String(query.page || 1), 10) || 1)
  const productLimit = Math.min(
    Math.max(Number.parseInt(String(query.product_limit || query.productLimit || DEFAULT_PAGE_LIMIT), 10) || DEFAULT_PAGE_LIMIT, 1),
    100
  )
  const focusLimit = Math.min(
    Math.max(Number.parseInt(String(query.focus_limit || query.focusLimit || 200), 10) || 200, 1),
    500
  )
  const rows = await listSnapshots(db, {
    limit: query.limit || 500,
    period_key: query.period_key || query.periodKey,
    date_from: query.date_from || query.dateFrom,
    date_to: query.date_to || query.dateTo,
    store_id: query.store_id || query.storeId || query.shop_id || query.shopId,
    page_index: query.page_index ?? query.pageIndex,
    page: query.page,
    all_pages: hasProductPage
  }, tenantId)
  mark('snapshots')
  const tabFilter = safeString(query.tab_key || query.tabKey)
  const productsByKey = new Map()
  const productIndex = new Map()
  const totalsBySource = {}
  const collectedPageIndexes = new Set()

  for (const snapshot of rows) {
    const decorated = decorateSnapshot(snapshot)
    if (tabFilter && decorated.tab_key !== tabFilter) continue
    const collectedPageIndex = getSnapshotPageIndex(decorated)
    if (collectedPageIndex !== null) collectedPageIndexes.add(collectedPageIndex)
    const items = getResponseItems(decorated.response_body || decorated.raw_data)
    const totals = getResponseTotals(decorated.response_body || decorated.raw_data)
    const periodDays = getSnapshotPeriodDays(decorated)
    if (totals) {
      const totalsRow = normalizeTotalsMetricItem(totals, decorated.tab_key || 'overview', decorated.captured_at, { periodDays })
      totalsBySource[decorated.tab_key || 'unknown'] = {
        label: TAB_LABELS[decorated.tab_key] || decorated.source_button_label || decorated.tab_key,
        metrics: totals,
        row: totalsRow,
        captured_at: decorated.captured_at
      }
    }
    for (const item of items) {
      const metricItem = normalizeProductMetricItem(item, decorated.tab_key || 'overview', decorated.captured_at, { periodDays })
      if (!metricItem?.productKey) continue
      const matchKeys = getProductMatchKeys(metricItem)
      const existingProduct = matchKeys.map((key) => productIndex.get(key)).find(Boolean) || productsByKey.get(metricItem.productKey)
      const product = existingProduct || {
        productKey: metricItem.productKey,
        sku: '',
        offer_id: '',
        product_id: '',
        product_name: '',
        image_url: '',
        metrics: {},
        tabs: {},
        sources: new Set(),
        sourceLabels: new Set(),
        latestCapturedAt: null
      }
      mergeProductMetric(product, metricItem, decorated)
      productsByKey.set(metricItem.productKey, product)
      productsByKey.set(product.productKey, product)
      for (const key of getProductMatchKeys(product)) productIndex.set(key, product)
      for (const key of matchKeys) productIndex.set(key, product)
    }
  }

  const products = Array.from(new Set(productsByKey.values())).map((product) => {
    product.sources = Array.from(product.sources)
    product.sourceLabels = Array.from(product.sourceLabels)
    return product
  })
  mark('normalize')
  const analyzedProducts = products.map((product) => {
    const analysis = buildProductRecommendations(product)
    return {
      ...product,
      score: analysis.score,
      priority: analysis.priority,
      recommendations: analysis.recommendations
    }
  })
  const keyword = query.keyword ?? query.search ?? query.q
  const matchedProducts = analyzedProducts.filter((product) => analysisProductMatchesKeyword(product, keyword))
  const analysisSort = normalizeAnalysisSort(query)
  matchedProducts.sort((a, b) => compareAnalysisProducts(a, b, analysisSort))
  mark('rank')
  const pagedProducts = hasProductPage
    ? matchedProducts.slice((requestedProductPage - 1) * productLimit, requestedProductPage * productLimit)
    : matchedProducts
  const focusProducts = matchedProducts.slice(0, focusLimit)
  const enrichmentTargets = Array.from(new Set([...pagedProducts, ...focusProducts]))
  let onlineProductRows = []
  if (enrichmentTargets.length > 0) {
    try {
      onlineProductRows = await db.getRepository('OnlineProduct').find({ where: { tenant_id: tenantId } })
    } catch (error) {
      onlineProductRows = []
    }
  }
  await enrichProductsWithOnlineProducts(db, tenantId, enrichmentTargets, onlineProductRows)
  mark('online')
  await enrichProductsWithCustomerProfile(db, tenantId, enrichmentTargets, query)
  mark('customer')
  for (const product of enrichmentTargets) {
    const analysis = buildProductRecommendations(product)
    product.score = analysis.score
    product.priority = analysis.priority
    product.recommendations = analysis.recommendations
  }
  mark('rerank')

  const recommendations = pagedProducts.flatMap((product) =>
    product.recommendations.map((recommendation) => ({
      ...recommendation,
      productKey: product.productKey,
      sku: product.sku,
      offer_id: product.offer_id,
      product_name: product.product_name,
      image_url: normalizeSellerAnalyticsImageUrl(product.image_url),
      priority: product.priority,
      score: product.score,
      sourceLabels: product.sourceLabels
    }))
  ).sort((a, b) => b.score - a.score || b.points - a.points)
  const serializedFocusProducts = focusProducts.map((product) => ({
    productKey: product.productKey,
    sku: product.sku,
    offer_id: product.offer_id,
    product_id: product.product_id,
    product_name: product.product_name,
    image_url: normalizeSellerAnalyticsImageUrl(product.image_url),
    metrics: product.metrics,
    sourceLabels: product.sourceLabels,
    score: product.score,
    priority: product.priority,
    recommendations: product.recommendations
  }))

  const totals = Object.values(totalsBySource).map((item) => item.metrics || {})
  const maxMetric = (keys) => Math.max(0, ...totals.map((metrics) => toNumber(getFirst(metrics, keys)) || 0))
  const activeTotals = tabFilter
    ? totalsBySource[tabFilter]?.row
    : totalsBySource.all_metrics?.row || Object.values(totalsBySource).find((item) => item?.row)?.row || null
  const sortedCollectedPageIndexes = Array.from(collectedPageIndexes).sort((a, b) => a - b)
  const maxCollectedPageIndex = sortedCollectedPageIndexes.length > 0
    ? sortedCollectedPageIndexes[sortedCollectedPageIndexes.length - 1]
    : -1
  const result = {
    summary: {
      snapshotCount: rows.length,
      productCount: matchedProducts.length,
      pageProductCount: pagedProducts.length,
      collectedPageCount: sortedCollectedPageIndexes.length,
      collectedPageIndexes: sortedCollectedPageIndexes,
      nextCollectPage: maxCollectedPageIndex + 2,
      sortKey: analysisSort.key,
      sortOrder: analysisSort.order,
      recommendationCount: recommendations.length,
      highPriorityCount: matchedProducts.filter((item) => item.priority === 'high').length,
      mediumPriorityCount: matchedProducts.filter((item) => item.priority === 'medium').length,
      revenue: maxMetric(['revenue']),
      orderedUnits: maxMetric(['orderedUnits', 'ordered_units']),
      totalViews: maxMetric(['totalViews', 'total_views', 'searchViews', 'search_views']),
      pdpViews: maxMetric(['pdpViews', 'pdp_views']),
      latestCapturedAt: rows[0]?.captured_at || null,
      sourceCount: Object.keys(totalsBySource).length
    },
    products: pagedProducts.map(serializeAnalysisProduct),
    focusProducts: serializedFocusProducts,
    recommendations,
    totalsRow: activeTotals,
    totalsBySource
  }
  timings.total = Date.now() - startedAt
  if (query.profile === '1' || query.debug === '1' || timings.total >= 300) {
    console.info(`[seller-analytics] analysis tenant=${tenantId} products=${matchedProducts.length} page=${requestedProductPage} ${JSON.stringify(timings)}`)
  }
  setCachedAnalysis(query, tenantId, result)
  return result
}

async function listMetrics(db, query = {}, tenantId = 'admin') {
  const repo = db.getRepository('SellerAnalyticsProductMetric')
  const where = { tenant_id: tenantId }
  const tabKey = safeString(query.tab_key || query.tabKey)
  if (tabKey) where.tab_key = tabKey
  const take = Math.min(Math.max(Number(query.limit || 100), 1), 500)
  return await repo.find({ where, order: { captured_at: 'DESC', created_at: 'DESC' }, take })
}

async function listSnapshots(db, query = {}, tenantId = 'admin') {
  const repo = db.getRepository('SellerAnalyticsSnapshot')
  const where = { tenant_id: tenantId }
  const tabKey = safeString(query.tab_key || query.tabKey)
  const storeId = safeString(query.store_id || query.storeId || query.shop_id || query.shopId)
  if (tabKey) where.tab_key = tabKey
  if (storeId) where.store_id = storeId
  const take = Math.min(Math.max(Number(query.limit || 50), 1), 1000)
  const rows = await repo.find({ where, order: { captured_at: 'DESC', created_at: 'DESC' }, take })
  return rows
    .map(decorateSnapshot)
    .filter((row) => snapshotMatchesPeriod(row, query) && (query.all_pages || snapshotMatchesPage(row, query)))
}

async function deleteSnapshot(db, id, tenantId = 'admin') {
  const snapshotId = safeString(id)
  if (!snapshotId) {
    const error = new Error('Missing snapshot id')
    error.statusCode = 400
    throw error
  }
  const snapshotRepo = db.getRepository('SellerAnalyticsSnapshot')
  const metricRepo = db.getRepository('SellerAnalyticsProductMetric')
  const snapshot = await snapshotRepo.findOne({ where: { id: snapshotId, tenant_id: tenantId } })
  if (!snapshot) {
    const error = new Error('Seller analytics snapshot not found')
    error.statusCode = 404
    throw error
  }
  const metricDelete = await metricRepo.delete({ tenant_id: tenantId, snapshot_id: snapshotId })
  const snapshotDelete = await snapshotRepo.delete({ tenant_id: tenantId, id: snapshotId })
  clearAnalysisCache(tenantId)
  return {
    success: true,
    deletedSnapshotCount: Number(snapshotDelete.affected || 0),
    deletedMetricCount: Number(metricDelete.affected || 0)
  }
}

async function deleteSnapshots(db, ids = [], tenantId = 'admin') {
  const snapshotIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map(safeString).filter(Boolean)))
  if (snapshotIds.length === 0) {
    const error = new Error('Missing snapshot ids')
    error.statusCode = 400
    throw error
  }
  const snapshotRepo = db.getRepository('SellerAnalyticsSnapshot')
  const metricRepo = db.getRepository('SellerAnalyticsProductMetric')
  const snapshots = await snapshotRepo.find({ where: { tenant_id: tenantId, id: In(snapshotIds) } })
  const foundIds = snapshots.map((row) => row.id)
  if (foundIds.length === 0) {
    return { success: true, deletedSnapshotCount: 0, deletedMetricCount: 0 }
  }
  const metricDelete = await metricRepo.delete({ tenant_id: tenantId, snapshot_id: In(foundIds) })
  const snapshotDelete = await snapshotRepo.delete({ tenant_id: tenantId, id: In(foundIds) })
  clearAnalysisCache(tenantId)
  return {
    success: true,
    deletedSnapshotCount: Number(snapshotDelete.affected || 0),
    deletedMetricCount: Number(metricDelete.affected || 0)
  }
}

async function getSummary(db, tenantId = 'admin') {
  const [snapshots, metrics] = await Promise.all([
    db.getRepository('SellerAnalyticsSnapshot').find({ where: { tenant_id: tenantId }, order: { captured_at: 'DESC' }, take: 1 }),
    db.getRepository('SellerAnalyticsProductMetric').find({ where: { tenant_id: tenantId }, take: 5000 })
  ])
  const skuSet = new Set(metrics.map((row) => row.sku || row.offer_id || row.product_id || row.product_name).filter(Boolean))
  return {
    snapshotCount: await db.getRepository('SellerAnalyticsSnapshot').count({ where: { tenant_id: tenantId } }),
    metricCount: await db.getRepository('SellerAnalyticsProductMetric').count({ where: { tenant_id: tenantId } }),
    productCount: skuSet.size,
    latestCapturedAt: snapshots[0]?.captured_at || null
  }
}

export {
  authBindingStatus,
  claimPluginPrepareRequest,
  claimNextCollectRequest,
  claimNextCollectRequests,
  createCollectRun,
  deleteCollectRun,
  deleteSnapshot,
  deleteSnapshots,
  ensureSellerAnalyticsSchema,
  finishCollectRequest,
  getAnalysis,
  getPluginPrepareRequest,
  getSummary,
  inferSourceFromMetrics,
  inferSourceFromRequest,
  listCollectRuns,
  listMetrics,
  listOperationTodos,
  getPluginStatus,
  listSnapshots,
  normalizeSellerAnalyticsUrl,
  refreshOperationTodos,
  preparePlugin,
  finishPluginPrepareRequest,
  probeSellerAnalyticsAuth,
  resolveCollectPeriod,
  retryCollectRun,
  saveAuthBinding,
  savePluginStatus,
  saveSnapshot,
  startDirectCollect,
  validatePluginStatus,
  sellerAnalyticsDb
};
