import { closeMysqlConnection, createMysqlConnection } from "./mysql-runtime.mjs";

const SECTION_DIVIDER = "=".repeat(100);
const PREVIEW_LIMIT = 20;

const audits = [
  {
    key: "duplicate-active-shop-sku-mappings",
    title: "Duplicate active SKU mappings by shop_id + ozon_sku",
    sql: `
      SELECT
        sm.shop_id,
        sm.ozon_sku,
        COUNT(*) AS active_mapping_count,
        GROUP_CONCAT(sm.id ORDER BY sm.id) AS mapping_ids,
        GROUP_CONCAT(sm.product_id ORDER BY sm.id) AS product_ids
      FROM sku_mappings sm
      WHERE sm.active = 1
      GROUP BY sm.shop_id, sm.ozon_sku
      HAVING COUNT(*) > 1
      ORDER BY active_mapping_count DESC, sm.shop_id, sm.ozon_sku
    `
  },
  {
    key: "duplicate-active-shop-sku-product-mappings",
    title: "Duplicate active SKU mappings by shop_id + ozon_sku + product_id",
    sql: `
      SELECT
        sm.shop_id,
        sm.ozon_sku,
        sm.product_id,
        COUNT(*) AS duplicate_rows,
        GROUP_CONCAT(sm.id ORDER BY sm.id) AS mapping_ids
      FROM sku_mappings sm
      WHERE sm.active = 1
      GROUP BY sm.shop_id, sm.ozon_sku, sm.product_id
      HAVING COUNT(*) > 1
      ORDER BY duplicate_rows DESC, sm.product_id
    `
  },
  {
    key: "products-with-duplicated-fbp-join-risk",
    title: "Products whose active mapping rows exceed distinct shop-sku pairs",
    sql: `
      SELECT
        sm.product_id,
        p.code AS inventory_id,
        p.name AS product_name,
        COUNT(*) AS mapping_rows,
        COUNT(DISTINCT CONCAT(sm.shop_id, '#', sm.ozon_sku)) AS distinct_shop_sku_count,
        SUM(COALESCE(stock_snapshot.fbp_stock, 0)) AS fbp_stock_by_current_logic
      FROM sku_mappings sm
      LEFT JOIN products p ON p.id = sm.product_id
      LEFT JOIN (
        SELECT
          shop_id,
          ozon_sku,
          SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_stock
        FROM ozon_stock_snapshots
        GROUP BY shop_id, ozon_sku
      ) stock_snapshot
        ON stock_snapshot.shop_id = sm.shop_id
       AND stock_snapshot.ozon_sku = sm.ozon_sku
      WHERE sm.active = 1
      GROUP BY sm.product_id, p.code, p.name
      HAVING mapping_rows > distinct_shop_sku_count
      ORDER BY (mapping_rows - distinct_shop_sku_count) DESC, fbp_stock_by_current_logic DESC
    `
  },
  {
    key: "inventory-current-vs-posted-movements",
    title: "Products whose inventory_current.available_stock differs from posted movement sum",
    sql: `
      SELECT
        p.id AS product_id,
        p.code AS inventory_id,
        p.name AS product_name,
        COALESCE(ic.available_stock, 0) AS inventory_current_available,
        COALESCE(mv.posted_qty, 0) AS movement_sum_available,
        COALESCE(ic.available_stock, 0) - COALESCE(mv.posted_qty, 0) AS diff
      FROM products p
      LEFT JOIN inventory_current ic
        ON ic.real_product_id = p.id
      LEFT JOIN (
        SELECT
          product_id,
          COALESCE(SUM(quantity_delta), 0) AS posted_qty
        FROM inventory_movements
        WHERE status = 'posted'
        GROUP BY product_id
      ) mv
        ON mv.product_id = p.id
      WHERE p.active = 1
        AND COALESCE(p.product_type, 'main') <> 'selection'
        AND COALESCE(ic.available_stock, 0) <> COALESCE(mv.posted_qty, 0)
      ORDER BY ABS(diff) DESC, p.id DESC
    `
  },
  {
    key: "inventory-current-with-nonzero-segmented-states",
    title: "Products carrying reserved, damaged, or in-transit stock",
    sql: `
      SELECT
        p.id AS product_id,
        p.code AS inventory_id,
        p.name AS product_name,
        COALESCE(ic.available_stock, 0) AS available_stock,
        COALESCE(ic.reserved_stock, 0) AS reserved_stock,
        COALESCE(ic.damaged_stock, 0) AS damaged_stock,
        COALESCE(ic.in_transit_stock, 0) AS in_transit_stock
      FROM inventory_current ic
      JOIN products p ON p.id = ic.real_product_id
      WHERE p.active = 1
        AND (
          COALESCE(ic.reserved_stock, 0) <> 0
          OR COALESCE(ic.damaged_stock, 0) <> 0
          OR COALESCE(ic.in_transit_stock, 0) <> 0
        )
      ORDER BY
        ABS(COALESCE(ic.reserved_stock, 0))
        + ABS(COALESCE(ic.damaged_stock, 0))
        + ABS(COALESCE(ic.in_transit_stock, 0)) DESC,
        p.id DESC
    `
  },
  {
    key: "merge-history-summary",
    title: "Recent product merge history",
    sql: `
      SELECT
        h.id AS merge_history_id,
        h.created_at,
        h.target_product_id,
        h.target_product_name,
        h.status,
        JSON_LENGTH(h.source_product_ids_json) AS source_count
      FROM product_merge_history h
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT 100
    `
  },
  {
    key: "merged-targets-with-duplicate-active-mappings",
    title: "Merged target products that currently have duplicate active shop-sku mappings",
    sql: `
      SELECT
        h.id AS merge_history_id,
        h.created_at,
        h.target_product_id,
        p.code AS inventory_id,
        p.name AS product_name,
        sm.shop_id,
        sm.ozon_sku,
        COUNT(*) AS active_mapping_count
      FROM product_merge_history h
      JOIN products p ON p.id = h.target_product_id
      JOIN sku_mappings sm ON sm.product_id = h.target_product_id AND sm.active = 1
      WHERE h.status = 'merged'
      GROUP BY h.id, h.created_at, h.target_product_id, p.code, p.name, sm.shop_id, sm.ozon_sku
      HAVING COUNT(*) > 1
      ORDER BY h.created_at DESC, active_mapping_count DESC
    `
  }
];

function summarizeRowCount(rows) {
  const count = Array.isArray(rows) ? rows.length : 0;
  return `${count} row${count === 1 ? "" : "s"}`;
}

function printSection(title, rows) {
  console.log(SECTION_DIVIDER);
  console.log(title);
  console.log(`Rows: ${summarizeRowCount(rows)}`);
  if (!rows.length) {
    console.log("No rows returned.");
    return;
  }
  console.table(rows.slice(0, PREVIEW_LIMIT));
  if (rows.length > PREVIEW_LIMIT) {
    console.log(`Preview limited to first ${PREVIEW_LIMIT} rows.`);
  }
}

async function main() {
  let connection;
  try {
    connection = await createMysqlConnection({ multipleStatements: false });
    await connection.query("SET time_zone = '+00:00'");
    console.log("Inventory merge risk audit");
    console.log(`Generated at: ${new Date().toISOString()}`);
    for (const audit of audits) {
      const [rows] = await connection.query(audit.sql);
      printSection(audit.title, rows);
    }
  } finally {
    await closeMysqlConnection(connection);
  }
}

main().catch((error) => {
  console.error("Inventory merge risk audit failed.");
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
