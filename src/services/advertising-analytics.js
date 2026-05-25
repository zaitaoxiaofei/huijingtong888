import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const AD_DAILY_SCHEMA = `
CREATE TABLE IF NOT EXISTS ozon_ad_sku_daily (
  date_key VARCHAR(32) NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  campaign_id VARCHAR(128) NOT NULL DEFAULT '',
  campaign_name VARCHAR(255) NULL,
  campaign_state VARCHAR(64) NULL,
  ad_type VARCHAR(64) NOT NULL DEFAULT 'unknown',
  product_id BIGINT UNSIGNED NULL,
  offer_id VARCHAR(255) NULL,
  product_name VARCHAR(255) NULL,
  spend_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  spend_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  impressions INT NOT NULL DEFAULT 0,
  clicks INT NOT NULL DEFAULT 0,
  orders INT NOT NULL DEFAULT 0,
  units INT NOT NULL DEFAULT 0,
  revenue_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  revenue_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  source VARCHAR(64) NOT NULL DEFAULT 'manual',
  raw_json LONGTEXT NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date_key, shop_id, ozon_sku, campaign_id, ad_type),
  KEY idx_ozon_ad_sku_daily_shop_date (shop_id, date_key),
  KEY idx_ozon_ad_sku_daily_sku_date (shop_id, ozon_sku, date_key),
  KEY idx_ozon_ad_sku_daily_product (product_id, date_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`;

let schemaReady = false;
const PERFORMANCE_API_BASE = "https://api-performance.ozon.ru";
const PERFORMANCE_TIMEOUT_MS = 60000;

async function ensureAdDailySchema() {
  if (schemaReady) return;
  await mysqlExecute(AD_DAILY_SCHEMA);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN campaign_state VARCHAR(64) NULL AFTER campaign_name").catch(ignoreDuplicateColumn);
  schemaReady = true;
}

async function ensurePerformanceCredentialSchema() {
  await mysqlExecute("ALTER TABLE shops ADD COLUMN performance_client_id VARCHAR(128) NULL").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE shops ADD COLUMN performance_client_secret TEXT NULL").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE shops ADD COLUMN performance_client_secret_hint VARCHAR(255) NULL").catch(ignoreDuplicateColumn);
}

function ignoreDuplicateColumn(error) {
  const message = String(error?.message || "").toLowerCase();
  if (!message.includes("duplicate column")) throw error;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSortOrder(value) {
  return String(value || "").toLowerCase() === "asc" ? "ASC" : "DESC";
}

function pagination(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize || query.page_size || 30)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function buildDateRange(query = {}) {
  return {
    from: String(query.from || dateDaysAgo(13)).slice(0, 10),
    to: String(query.to || todayKey()).slice(0, 10)
  };
}

function buildAdDailyWhere(query = {}) {
  const where = [];
  const params = [];
  const { from, to } = buildDateRange(query);

  where.push("ad.date_key >= ?");
  params.push(from);
  where.push("ad.date_key <= ?");
  params.push(to);

  const shopId = query.shopId || query.shop_id;
  if (shopId && String(shopId) !== "all") {
    where.push("ad.shop_id = ?");
    params.push(Number(shopId));
  }

  const keyword = String(query.keyword || "").trim();
  if (keyword) {
    where.push(`(
      ad.ozon_sku LIKE ?
      OR ad.offer_id LIKE ?
      OR ad.product_name LIKE ?
      OR ad.campaign_name LIKE ?
      OR s.name LIKE ?
    )`);
    const like = `%${keyword}%`;
    params.push(like, like, like, like, like);
  }

  return {
    sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
    from,
    to
  };
}

function rowMetrics(row = {}) {
  const spendRub = toNumber(row.spend_rub);
  const spendCny = toNumber(row.spend_cny);
  const clicks = toNumber(row.clicks);
  const impressions = toNumber(row.impressions);
  const orders = toNumber(row.orders);
  const revenueRub = toNumber(row.revenue_rub);
  const revenueCny = toNumber(row.revenue_cny);

  return {
    ...row,
    spend_rub: spendRub,
    spend_cny: spendCny,
    impressions,
    clicks,
    orders,
    units: toNumber(row.units),
    revenue_rub: revenueRub,
    revenue_cny: revenueCny,
    ctr: impressions ? clicks / impressions : 0,
    cpc_rub: clicks ? spendRub / clicks : 0,
    cpc_cny: clicks ? spendCny / clicks : 0,
    acos: revenueRub ? spendRub / revenueRub : 0,
    roas: spendRub ? revenueRub / spendRub : 0,
    conversion_rate: clicks ? orders / clicks : 0
  };
}

export async function advertisingDailyMysql(query = {}) {
  await ensureAdDailySchema();
  const { sql, params, from, to } = buildAdDailyWhere(query);
  const { page, pageSize, offset } = pagination(query);
  const sortBy = String(query.sortBy || query.sort_by || "spend_rub");
  const sortable = new Map([
    ["date_key", "last_date"],
    ["spend_rub", "spend_rub"],
    ["spend_cny", "spend_cny"],
    ["impressions", "impressions"],
    ["clicks", "clicks"],
    ["orders", "orders"],
    ["revenue_rub", "revenue_rub"],
    ["revenue_cny", "revenue_cny"],
    ["acos", "acos"],
    ["roas", "roas"]
  ]);
  const orderField = sortable.get(sortBy) || "spend_rub";
  const sortOrder = normalizeSortOrder(query.sortOrder || query.sort_order);

  const countRows = await mysqlQuery(`
    SELECT COUNT(*) AS total
    FROM (
      SELECT ad.shop_id, ad.ozon_sku
      FROM ozon_ad_sku_daily ad
      JOIN shops s ON s.id = ad.shop_id
      ${sql}
      GROUP BY ad.shop_id, ad.ozon_sku
    ) grouped
  `, params);
  const total = Number(countRows?.[0]?.total || 0);

  const rows = await mysqlQuery(`
    SELECT
      ad.shop_id,
      MAX(s.name) AS shop_name,
      ad.ozon_sku,
      MAX(COALESCE(ad.offer_id, sm.offer_id, op.offer_id, '')) AS offer_id,
      MAX(COALESCE(ad.product_name, sm.display_name, op.name, p.name, '')) AS product_name,
      MAX(COALESCE(oi_img.image_url, op.image_url, op.primary_image, op_offer.image_url, op_offer.primary_image, p.image_url, '')) AS image_url,
      MAX(COALESCE(ad.product_id, sm.product_id, op.product_id)) AS product_id,
      MIN(ad.date_key) AS first_date,
      MAX(ad.date_key) AS last_date,
      COUNT(DISTINCT ad.date_key) AS active_days,
      COUNT(DISTINCT NULLIF(ad.campaign_id, '')) AS campaign_count,
      GROUP_CONCAT(DISTINCT NULLIF(ad.campaign_state, '') ORDER BY ad.campaign_state SEPARATOR ', ') AS campaign_states,
      GROUP_CONCAT(DISTINCT NULLIF(ad.ad_type, '') ORDER BY ad.ad_type SEPARATOR ', ') AS ad_types,
      COALESCE(SUM(ad.spend_rub), 0) AS spend_rub,
      COALESCE(SUM(ad.spend_cny), 0) AS spend_cny,
      COALESCE(SUM(ad.impressions), 0) AS impressions,
      COALESCE(SUM(ad.clicks), 0) AS clicks,
      COALESCE(SUM(ad.orders), 0) AS orders,
      COALESCE(SUM(ad.units), 0) AS units,
      COALESCE(SUM(ad.revenue_rub), 0) AS revenue_rub,
      COALESCE(SUM(ad.revenue_cny), 0) AS revenue_cny,
      CASE WHEN COALESCE(SUM(ad.revenue_rub), 0) > 0 THEN COALESCE(SUM(ad.spend_rub), 0) / COALESCE(SUM(ad.revenue_rub), 0) ELSE 0 END AS acos,
      CASE WHEN COALESCE(SUM(ad.spend_rub), 0) > 0 THEN COALESCE(SUM(ad.revenue_rub), 0) / COALESCE(SUM(ad.spend_rub), 0) ELSE 0 END AS roas
    FROM ozon_ad_sku_daily ad
    JOIN shops s ON s.id = ad.shop_id
    LEFT JOIN sku_mappings sm ON sm.shop_id = ad.shop_id AND sm.ozon_sku = ad.ozon_sku AND sm.active = 1
    LEFT JOIN online_products op ON op.shop_id = ad.shop_id AND op.ozon_sku = ad.ozon_sku
    LEFT JOIN online_products op_offer ON op_offer.shop_id = ad.shop_id AND op_offer.offer_id = COALESCE(NULLIF(ad.offer_id, ''), sm.offer_id)
    LEFT JOIN products p ON p.id = COALESCE(ad.product_id, sm.product_id, op.product_id)
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, MAX(NULLIF(oi.ozon_image_url, '')) AS image_url
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE COALESCE(oi.ozon_image_url, '') != ''
      GROUP BY o.shop_id, oi.ozon_sku
    ) oi_img ON oi_img.shop_id = ad.shop_id AND oi_img.ozon_sku = ad.ozon_sku
    ${sql}
    GROUP BY ad.shop_id, ad.ozon_sku
    ORDER BY ${orderField} ${sortOrder}, ad.shop_id ASC, ad.ozon_sku ASC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, offset]);

  return {
    rows: rows.map((row, index) => ({ rank: offset + index + 1, ...rowMetrics(row) })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    from,
    to
  };
}

export async function advertisingDailySummaryMysql(query = {}) {
  await ensureAdDailySchema();
  const { sql, params, from, to } = buildAdDailyWhere(query);
  const rows = await mysqlQuery(`
    SELECT
      COUNT(DISTINCT ad.shop_id) AS shop_count,
      COUNT(DISTINCT ad.ozon_sku) AS sku_count,
      COUNT(DISTINCT NULLIF(ad.campaign_id, '')) AS campaign_count,
      COALESCE(SUM(ad.spend_rub), 0) AS spend_rub,
      COALESCE(SUM(ad.spend_cny), 0) AS spend_cny,
      COALESCE(SUM(ad.impressions), 0) AS impressions,
      COALESCE(SUM(ad.clicks), 0) AS clicks,
      COALESCE(SUM(ad.orders), 0) AS orders,
      COALESCE(SUM(ad.units), 0) AS units,
      COALESCE(SUM(ad.revenue_rub), 0) AS revenue_rub,
      COALESCE(SUM(ad.revenue_cny), 0) AS revenue_cny
    FROM ozon_ad_sku_daily ad
    JOIN shops s ON s.id = ad.shop_id
    ${sql}
  `, params);
  return { ...rowMetrics(rows?.[0] || {}), from, to };
}

export async function advertisingDailyDetailsMysql(query = {}) {
  await ensureAdDailySchema();
  const { sql, params, from, to } = buildAdDailyWhere(query);
  const where = [sql ? sql.replace(/^WHERE\s+/i, "") : "1=1"];
  const detailParams = [...params];

  if (query.ozon_sku) {
    where.push("ad.ozon_sku = ?");
    detailParams.push(String(query.ozon_sku));
  }

  const rows = await mysqlQuery(`
    SELECT
      ad.*,
      s.name AS shop_name,
      COALESCE(ad.product_name, sm.display_name, op.name, p.name, '') AS resolved_product_name,
      COALESCE(oi_img.image_url, op.image_url, op.primary_image, op_offer.image_url, op_offer.primary_image, p.image_url, '') AS image_url
    FROM ozon_ad_sku_daily ad
    JOIN shops s ON s.id = ad.shop_id
    LEFT JOIN sku_mappings sm ON sm.shop_id = ad.shop_id AND sm.ozon_sku = ad.ozon_sku AND sm.active = 1
    LEFT JOIN online_products op ON op.shop_id = ad.shop_id AND op.ozon_sku = ad.ozon_sku
    LEFT JOIN online_products op_offer ON op_offer.shop_id = ad.shop_id AND op_offer.offer_id = COALESCE(NULLIF(ad.offer_id, ''), sm.offer_id)
    LEFT JOIN products p ON p.id = COALESCE(ad.product_id, sm.product_id, op.product_id)
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, MAX(NULLIF(oi.ozon_image_url, '')) AS image_url
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE COALESCE(oi.ozon_image_url, '') != ''
      GROUP BY o.shop_id, oi.ozon_sku
    ) oi_img ON oi_img.shop_id = ad.shop_id AND oi_img.ozon_sku = ad.ozon_sku
    WHERE ${where.join(" AND ")}
    ORDER BY ad.date_key DESC, ad.spend_rub DESC, ad.campaign_name ASC
    LIMIT 500
  `, detailParams);

  return { rows: rows.map(rowMetrics), from, to };
}

export async function upsertAdvertisingDailyRowsMysql(body = {}) {
  await ensureAdDailySchema();
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { inserted: 0, updated: 0, total: 0 };

  let affected = 0;
  for (const row of rows) {
    const shopId = Number(row.shop_id || row.shopId || body.shop_id || body.shopId);
    const dateKey = String(row.date_key || row.date || body.date_key || body.date || "").slice(0, 10);
    const ozonSku = String(row.ozon_sku || row.ozonSku || "").trim();
    if (!shopId || !dateKey || !ozonSku) {
      const error = new Error("shop_id, date_key/date and ozon_sku are required for every advertising row");
      error.status = 400;
      throw error;
    }

    const rawJson = row.raw_json
      ? (typeof row.raw_json === "string" ? row.raw_json : JSON.stringify(row.raw_json))
      : JSON.stringify(row);

    const result = await mysqlExecute(`
      INSERT INTO ozon_ad_sku_daily (
        date_key, shop_id, ozon_sku, campaign_id, campaign_name, campaign_state, ad_type,
        product_id, offer_id, product_name, spend_rub, spend_cny, impressions,
        clicks, orders, units, revenue_rub, revenue_cny, source, raw_json, synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        campaign_name = VALUES(campaign_name),
        campaign_state = VALUES(campaign_state),
        product_id = VALUES(product_id),
        offer_id = VALUES(offer_id),
        product_name = VALUES(product_name),
        spend_rub = VALUES(spend_rub),
        spend_cny = VALUES(spend_cny),
        impressions = VALUES(impressions),
        clicks = VALUES(clicks),
        orders = VALUES(orders),
        units = VALUES(units),
        revenue_rub = VALUES(revenue_rub),
        revenue_cny = VALUES(revenue_cny),
        source = VALUES(source),
        raw_json = VALUES(raw_json),
        synced_at = VALUES(synced_at),
        updated_at = NOW()
    `, [
      dateKey,
      shopId,
      ozonSku,
      String(row.campaign_id || row.campaignId || ""),
      row.campaign_name || row.campaignName || null,
      row.campaign_state || row.campaignState || null,
      String(row.ad_type || row.adType || "unknown"),
      row.product_id || row.productId || null,
      row.offer_id || row.offerId || null,
      row.product_name || row.productName || null,
      toNumber(row.spend_rub || row.spendRub),
      toNumber(row.spend_cny || row.spendCny),
      Math.round(toNumber(row.impressions)),
      Math.round(toNumber(row.clicks)),
      Math.round(toNumber(row.orders)),
      Math.round(toNumber(row.units)),
      toNumber(row.revenue_rub || row.revenueRub),
      toNumber(row.revenue_cny || row.revenueCny),
      String(row.source || body.source || "manual"),
      rawJson
    ]);
    affected += Number(result.affectedRows || 0);
  }

  return {
    total: rows.length,
    inserted_or_updated: rows.length,
    affected_rows: affected
  };
}

export async function advertisingPilotShopMysql() {
  await ensurePerformanceCredentialSchema();
  const rows = await mysqlQuery(`
    SELECT id, name
    FROM shops
    WHERE LOWER(name) LIKE '%vibermart%'
       OR LOWER(name) LIKE '%vibe mart%'
       OR LOWER(name) LIKE '%ruvibe%'
    ORDER BY
      CASE
        WHEN LOWER(name) LIKE '%vibermart%' THEN 1
        WHEN LOWER(name) LIKE '%vibe mart%' THEN 2
        WHEN LOWER(name) LIKE '%ruvibe%' THEN 3
        ELSE 9
      END,
      id
    LIMIT 1
  `);
  return rows?.[0] || null;
}

export async function syncAdvertisingDailyFromOzonMysql(body = {}, options = {}) {
  await ensureAdDailySchema();
  await ensurePerformanceCredentialSchema();
  const { from, to } = buildDateRange(body);
  const shopId = Number(body.shop_id || body.shopId || 0);
  const shops = await mysqlQuery(`
    SELECT *
    FROM shops
    WHERE status = 'active'
      AND (? = 0 OR id = ?)
    ORDER BY id
  `, [shopId, shopId]);

  let totalRows = 0;
  let imported = 0;
  const results = [];
  const errors = [];

  for (const shop of shops) {
    const clientId = String(shop.performance_client_id || "").trim();
    const clientSecret = String(shop.performance_client_secret || "").trim();
    if (!clientId || !clientSecret) {
      errors.push(`${shop.name || shop.id}: 缺少 Ozon Performance API Client ID / Secret`);
      results.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, imported: 0, status: "missing_credentials" });
      continue;
    }

    try {
      const token = await fetchPerformanceToken({ clientId, clientSecret }, options);
      const campaigns = await fetchPerformanceCampaigns(token, options);
      const selectedCampaigns = filterCampaigns(campaigns, body);
      if (!selectedCampaigns.length) {
        results.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, imported: 0, status: "no_campaigns" });
        continue;
      }

      const reportRows = await fetchPerformanceSkuStats(token, {
        from,
        to,
        campaigns: selectedCampaigns,
        signal: options.signal
      });
      const normalized = reportRows
        .map((row) => normalizePerformanceAdRow(row, shop, selectedCampaigns))
        .filter((row) => row.date_key && row.shop_id && row.ozon_sku && row.ozon_sku !== "0");

      totalRows += reportRows.length;
      if (normalized.length) {
        const result = await upsertAdvertisingDailyRowsMysql({
          source: "ozon_performance_api",
          rows: normalized
        });
        imported += Number(result.total || normalized.length);
      }
      results.push({
        shop_id: shop.id,
        shop_name: shop.name,
        campaigns: selectedCampaigns.length,
        fetched: reportRows.length,
        imported: normalized.length,
        status: "ok"
      });
    } catch (error) {
      errors.push(`${shop.name || shop.id}: ${error.message}`);
      results.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, imported: 0, status: "error", error: error.message });
    }
  }

  return {
    from,
    to,
    total_rows: totalRows,
    imported,
    results,
    errors
  };
}

async function fetchPerformanceToken(credentials, options = {}) {
  const data = await performanceRequest("/api/client/token", {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: "client_credentials"
  }, { ...options, auth: false });
  const token = data.access_token || data.token || data.result?.access_token;
  if (!token) throw new Error("Performance API 没有返回 access_token");
  return token;
}

async function fetchPerformanceCampaigns(token, options = {}) {
  const candidates = [
    ["/api/client/campaign", "GET", null],
    ["/api/client/campaign?advObjectType=SKU", "GET", null],
    ["/api/client/campaign?advObjectType=PRODUCT", "GET", null]
  ];
  const campaigns = [];
  let lastError = null;
  for (const [path, method, payload] of candidates) {
    try {
      const data = await performanceRequest(path, payload, { ...options, token, method });
      const rows = normalizeCampaignResponse(data);
      for (const campaign of rows) if (campaign.id) campaigns.push(campaign);
    } catch (error) {
      lastError = error;
    }
  }
  const unique = new Map(campaigns.map((campaign) => [String(campaign.id), campaign]));
  if (!unique.size && lastError) throw lastError;
  return [...unique.values()];
}

function normalizeCampaignResponse(data = {}) {
  const raw = data.list || data.campaigns || data.items || data.result?.list || data.result?.campaigns || data.result?.items || data.result || [];
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((item) => ({
    id: String(item.id || item.campaign_id || item.campaignId || ""),
    title: String(item.title || item.name || item.campaign_name || item.campaignName || ""),
    state: String(item.state || item.status || ""),
    advObjectType: String(item.advObjectType || item.adv_object_type || item.type || "")
  })).filter((item) => item.id);
}

function filterCampaigns(campaigns = [], body = {}) {
  const explicit = (body.campaign_ids || body.campaignIds || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (explicit.length) {
    const allowed = new Set(explicit);
    return campaigns.filter((campaign) => allowed.has(String(campaign.id)));
  }
  const includeInactive = body.include_inactive ?? body.includeInactive;
  if (includeInactive !== false) return campaigns;
  return campaigns.filter((campaign) => {
    const state = String(campaign.state || "").toLowerCase();
    return !["archived", "stopped", "deleted"].some((value) => state.includes(value));
  });
}

async function fetchPerformanceSkuStats(token, options = {}) {
  const campaigns = options.campaigns || [];
  const rows = [];
  const windows = splitDateRange(options.from, options.to, 62);
  for (const window of windows) {
    for (let index = 0; index < campaigns.length; index += 10) {
      const chunk = campaigns.slice(index, index + 10);
      try {
        const report = await createAndFetchPerformanceReport(token, {
          campaigns: chunk.map((campaign) => String(campaign.id)),
          dateFrom: window.from,
          dateTo: window.to,
          groupBy: "DATE"
        }, options);
        rows.push(...flattenPerformanceReportRows(report, chunk));
      } catch (error) {
        if (!isMissingReportError(error) || chunk.length <= 1) throw error;
        for (const campaign of chunk) {
          try {
            const report = await createAndFetchPerformanceReport(token, {
              campaigns: [String(campaign.id)],
              dateFrom: window.from,
              dateTo: window.to,
              groupBy: "DATE"
            }, options);
            rows.push(...flattenPerformanceReportRows(report, [campaign]));
          } catch (singleError) {
            if (!isMissingReportError(singleError)) throw singleError;
          }
        }
      }
    }
  }
  return rows;
}

async function createAndFetchPerformanceReport(token, payload, options = {}) {
  const createPayload = {
    campaigns: payload.campaigns,
    dateFrom: payload.dateFrom,
    dateTo: payload.dateTo,
    groupBy: payload.groupBy
  };
  const createCandidates = [
    "/api/client/statistics/products/json",
    "/api/client/statistics/json"
  ];
  let lastError = null;
  for (const path of createCandidates) {
    let createData = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        createData = await performanceRequest(path, createPayload, { ...options, token });
        break;
      } catch (error) {
        lastError = error;
        if (!isActiveReportLimitError(error)) break;
        await sleep(10000 + attempt * 5000);
      }
    }

    if (!createData) continue;
    const uuid = createData.UUID || createData.uuid || createData.report_id || createData.result?.UUID || createData.result?.uuid;
    if (!uuid) return createData;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pathCandidates = [
        `/api/client/statistics/report?UUID=${encodeURIComponent(uuid)}`,
        `/api/client/statistics/${encodeURIComponent(uuid)}`
      ];
      for (const reportPath of pathCandidates) {
        try {
          const data = await performanceRequest(reportPath, null, { ...options, token, method: "GET" });
          if (isReportReady(data)) return data;
        } catch (error) {
          lastError = error;
        }
      }
      await sleep(5000);
    }
  }

  throw lastError || new Error("无法创建 Ozon Performance 统计报表");
}

function splitDateRange(from, to, maxDays = 62) {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  if (!start || !end || start > end) return [{ from, to }];
  const windows = [];
  let cursor = start;
  while (cursor <= end) {
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + Number(maxDays || 62) - 1);
    if (windowEnd > end) windowEnd.setTime(end.getTime());
    windows.push({ from: formatDateKey(cursor), to: formatDateKey(windowEnd) });
    cursor = new Date(windowEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

function parseDateKey(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function isActiveReportLimitError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("активных запрос") || message.includes("active request") || message.includes("active statistics");
}

function isMissingReportError(error) {
  return String(error?.message || "").toLowerCase().includes("report not found");
}

function isReportReady(data = {}) {
  const state = String(data.state || data.status || data.result?.state || data.result?.status || "").toLowerCase();
  if (["error", "failed"].some((value) => state.includes(value))) throw new Error(`Ozon Performance 报表生成失败: ${state}`);
  if (!state) return true;
  return ["ok", "done", "success", "ready", "completed"].some((value) => state.includes(value));
}

function flattenPerformanceReportRows(data = {}, campaigns = []) {
  const campaignById = new Map(campaigns.map((campaign) => [String(campaign.id), campaign]));
  const groupedRows = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (!value || typeof value !== "object" || !value.report) continue;
    const rows = Array.isArray(value.report?.rows) ? value.report.rows : [];
    const campaign = campaignById.get(String(key)) || { id: String(key), title: value.title || "" };
    for (const row of rows) {
      groupedRows.push({
        ...row,
        campaign_id: String(key),
        campaign_name: campaign.title || value.title || "",
        campaign
      });
    }
  }
  if (groupedRows.length) return groupedRows;

  const candidates = [
    data.rows,
    data.items,
    data.result?.rows,
    data.result?.items,
    data.result?.data,
    data.data,
    Array.isArray(data) ? data : null
  ].filter(Boolean);
  const sourceRows = candidates.find(Array.isArray) || [];
  const flattened = [];
  for (const row of sourceRows) {
    collectReportRows(row, {}, flattened);
  }
  return flattened.map((row) => ({
    ...row,
    campaign: campaignById.get(String(row.campaign_id || row.campaignId || row.id || ""))
  }));
}

function collectReportRows(node, inherited, target) {
  if (!node || typeof node !== "object") return;
  const current = { ...inherited, ...node };
  const children = [
    node.rows,
    node.items,
    node.products,
    node.skus,
    node.children
  ].filter(Array.isArray).flat();

  if (!children.length) {
    target.push(current);
    return;
  }

  const nextInherited = { ...current };
  delete nextInherited.rows;
  delete nextInherited.items;
  delete nextInherited.products;
  delete nextInherited.skus;
  delete nextInherited.children;
  for (const child of children) collectReportRows(child, nextInherited, target);
}

function normalizePerformanceAdRow(row = {}, shop = {}, campaigns = []) {
  const campaignId = String(row.campaign_id || row.campaignId || row.campaign?.id || row.id || "").trim();
  const campaign = row.campaign || campaigns.find((item) => String(item.id) === campaignId) || {};
  const dateKey = normalizePerformanceDate(row.date || row.date_key || row.day || row.period || row.period_from || row.createdAt);
  const sku = String(row.sku || row.ozon_sku || row.product_sku || row.productSku || row.ad_sku || row.id_sku || "").trim();
  return {
    date_key: dateKey,
    shop_id: Number(shop.id),
    ozon_sku: sku,
    campaign_id: campaignId || String(campaign.id || ""),
    campaign_name: row.campaign_name || row.campaignName || campaign.title || "",
    campaign_state: row.campaign_state || row.campaignState || campaign.state || "",
    ad_type: row.ad_type || row.adType || campaign.advObjectType || "performance",
    offer_id: row.offer_id || row.offerId || "",
    product_name: row.product_name || row.productName || row.title || row.name || "",
    spend_rub: firstNumber(row.moneySpent, row.expense, row.spend, row.spend_rub, row.cost, row.consumption),
    impressions: Math.round(firstNumber(row.views, row.impressions, row.shows, row.show)),
    clicks: Math.round(firstNumber(row.clicks, row.click)),
    orders: Math.round(firstNumber(row.orders, row.orders_count, row.ordersCount)),
    units: Math.round(firstNumber(row.units, row.quantity, row.qty)),
    revenue_rub: firstNumber(row.ordersMoney, row.modelsMoney, row.product_gmv, row.revenue, row.sales, row.attributedRevenue, row.money_income, row.orderRevenue),
    source: "ozon_performance_api",
    raw_json: row
  };
}

function normalizePerformanceDate(value) {
  const text = String(value || "").trim();
  const ruMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ruMatch) return `${ruMatch[3]}-${ruMatch[2]}-${ruMatch[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text.slice(0, 10);
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(String(value).replace(",", ".").replace(/[^\d.-]/g, ""));
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

async function performanceRequest(path, payload, options = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal.reason || new Error("广告同步已取消"));
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), PERFORMANCE_TIMEOUT_MS);
  const method = String(options.method || (payload == null ? "GET" : "POST")).toUpperCase();
  try {
    const response = await fetch(`${PERFORMANCE_API_BASE}${path}`, {
      method,
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: payload == null || method === "GET" ? undefined : JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const message = data.message || data.error || data.raw || `HTTP ${response.status}`;
      throw new Error(`Performance API ${path} failed: ${message}`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Performance API ${path} 请求超时`);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
