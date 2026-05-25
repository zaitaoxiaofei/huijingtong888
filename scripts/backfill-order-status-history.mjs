import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { orderStatusHistorySummaryMysql } from "../src/services/mysql-cutover.js";

const batchSize = Math.min(Math.max(Number(process.argv[2] || 500), 50), 2000);
let offset = 0;
let processed = 0;
let inserted = 0;

function parseJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed.raw && typeof parsed.raw === "object" ? parsed.raw : parsed;
  } catch {
    return {};
  }
}

function text(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
}

try {
  while (true) {
    const rows = await mysqlQuery(`
      SELECT o.*, raw.raw_json, raw.substatus
      FROM orders o
      LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      ORDER BY o.id
      LIMIT ${batchSize} OFFSET ${offset}
    `);
    if (!rows.length) break;
    for (const row of rows) {
      const raw = parseJson(row.raw_json);
      const customer = raw.customer || {};
      const address = customer.address || {};
      const analytics = raw.analytics_data || {};
      const financial = raw.financial_data || {};
      const deliveryMethod = raw.delivery_method || {};
      const statusJson = JSON.stringify({
        status: row.status || raw.status || "",
        substatus: row.substatus || raw.substatus || "",
        logistics_status: row.logistics_status || "",
        tracking_stage: row.tracking_stage || "",
        sync_state: row.sync_state || ""
      });
      const result = await mysqlQuery(`
        INSERT INTO order_status_history (
          order_id, shop_id, posting_number, order_number, status, substatus, logistics_status, tracking_stage, sync_state,
          ordered_at, delivered_at, last_status_changed_at,
          customer_id, customer_name, buyer_city, buyer_region, buyer_country, buyer_district, buyer_zip_code, buyer_address_tail,
          delivery_type, delivery_city, delivery_region, delivery_date_begin, delivery_date_end, warehouse_name, tpl_provider, cluster_to,
          snapshot_source, observed_at, observed_hour, raw_status_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill', COALESCE(?, CURRENT_TIMESTAMP), DATE_FORMAT(COALESCE(?, CURRENT_TIMESTAMP), '%Y-%m-%d %H:00:00'), ?)
        ON DUPLICATE KEY UPDATE
          substatus = VALUES(substatus),
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
        row.id,
        row.shop_id,
        row.posting_number,
        row.order_number || "",
        text(row.status, raw.status),
        text(row.substatus, raw.substatus),
        text(row.logistics_status, row.substatus, raw.substatus),
        text(row.tracking_stage, row.status, raw.status),
        text(row.sync_state),
        normalizeDateTime(row.ordered_at || raw.in_process_at || raw.created_at),
        normalizeDateTime(row.delivered_at || raw.delivered_at),
        normalizeDateTime(row.last_status_changed_at || row.updated_at),
        text(customer.customer_id, customer.id, raw.customer_id),
        text(customer.name, raw.customer_name),
        text(address.city, analytics.city),
        text(address.region, analytics.region, row.buyer_region),
        text(address.country),
        text(address.district),
        text(address.zip_code, address.zipCode),
        text(address.address_tail, address.tail),
        text(analytics.delivery_type, raw.delivery_type),
        text(analytics.city, address.city),
        text(analytics.region, address.region),
        normalizeDateTime(analytics.delivery_date_begin || raw.delivery_date_begin),
        normalizeDateTime(analytics.delivery_date_end || raw.delivery_date_end),
        text(deliveryMethod.warehouse, deliveryMethod.name),
        text(deliveryMethod.tpl_provider),
        text(financial.cluster_to),
        normalizeDateTime(row.last_synced_at || row.updated_at || row.created_at),
        normalizeDateTime(row.last_synced_at || row.updated_at || row.created_at),
        statusJson
      ]);
      inserted += Number(result.affectedRows || 0);
      processed += 1;
    }
    offset += rows.length;
  }
  const summary = await orderStatusHistorySummaryMysql();
  console.log(JSON.stringify({ processed, inserted, summary }, null, 2));
} finally {
  await closeMysqlPool();
}
