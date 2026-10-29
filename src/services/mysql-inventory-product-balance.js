import { orderTransportEvidenceSql } from "./order-transport-evidence.js";

const FRESH_SECONDS = 45;
const MAX_STALE_SECONDS = 90;
const BACKGROUND_REFRESH_INTERVAL_MS = 15_000;
const OPEN_STATUS_SQL = `(
  o.status IN ('awaiting_packaging','awaiting_approve','acceptance_in_progress','posting_created',
    'posting_acceptance_in_progress','awaiting_deliver','awaiting_registration',
    'posting_awaiting_registration','posting_registration_error','posting_registered',
    'sent_by_seller','posting_ready_for_pickup','posting_transferred_to_courier_service',
    'posting_transferring','posting_in_carriage','posting_transferring_to_delivery')
  OR o.tracking_stage IN ('awaiting_packaging','awaiting_deliver','awaiting_registration',
    'posting_awaiting_registration','posting_registration_error','posting_registered')
)`;
const pendingRefreshes = new Map();
const lastBackgroundRefresh = new Map();
let invalidationVersion = 0;
const refreshedVersionByTenant = new Map();

export function invalidateInventoryProductBalance() {
  invalidationVersion += 1;
}

const rounded = (value) => Math.round((Number(value) || 0) * 10000) / 10000;

export function buildInventoryProductBalances(productIds, ledgerRows, demandRows, deductionRows, reservationRows) {
  const indexed = (rows) => new Map(rows.map((row) => [Number(row.product_id), row]));
  const ledger = indexed(ledgerRows);
  const demand = indexed(demandRows);
  const deductions = indexed(deductionRows);
  const reservations = indexed(reservationRows);
  return productIds.map((productId) => {
    const id = Number(productId);
    const stock = ledger.get(id) || {};
    const ledgerQty = rounded(stock.ledger_qty);
    const openDeductedQty = rounded(deductions.get(id)?.open_deducted_qty);
    const openDemandQty = rounded(demand.get(id)?.open_demand_qty);
    const fbpReservedQty = Math.max(0, rounded(Math.max(Number(stock.movement_fbp_reserved_qty || 0), Number(reservations.get(id)?.quantity || 0))));
    const physicalStock = rounded(ledgerQty + openDeductedQty);
    return {
      product_id: id,
      ledger_qty: ledgerQty,
      open_deducted_qty: openDeductedQty,
      open_order_demand_qty: Math.max(0, openDemandQty),
      fbp_reserved_qty: fbpReservedQty,
      physical_stock: physicalStock,
      available_stock: Math.max(0, rounded(physicalStock - openDemandQty - fbpReservedQty)),
      inventory_needs_review: physicalStock < 0
    };
  });
}

function balanceQueries(tenantId, includeLegacyTenantNull, productIds) {
  const tenant = Number(tenantId);
  if (!Number.isSafeInteger(tenant) || tenant <= 0) throw new Error("企业 ID 无效");
  const ids = [...new Set(productIds.map(Number))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("库存商品 ID 无效");
  const productSql = ids.join(",");
  const scope = (alias) => `(${alias}.tenant_id = ${tenant}${includeLegacyTenantNull ? ` OR ${alias}.tenant_id IS NULL` : ""})`;
  const openOrder = `${OPEN_STATUS_SQL}
    AND LOWER(CONCAT_WS(' ', o.status, o.tracking_stage, o.logistics_status)) NOT REGEXP 'cancel|return|reject|delivered|dispute|arbitration'
    AND NOT ${orderTransportEvidenceSql("o")}
    AND NOT EXISTS (SELECT 1 FROM ozon_orders_raw raw
      WHERE raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
        AND raw.query_stock_location = 'FBP')`;
  return [
    `SELECT im.product_id,
      SUM(CASE WHEN im.movement_type IN ('ORDER_RESERVED', 'CANCEL_RESTORE') THEN 0 ELSE im.quantity_delta END) AS ledger_qty,
      SUM(CASE WHEN im.movement_type = 'ORDER_RESERVED' THEN ABS(im.quantity_delta)
        WHEN im.movement_type = 'CANCEL_RESTORE' THEN -ABS(im.quantity_delta) ELSE 0 END) AS movement_fbp_reserved_qty
      FROM inventory_movements im
      JOIN products p ON p.id = im.product_id AND p.active = 1 AND ${scope("p")}
      WHERE im.product_id IN (${productSql}) AND im.status = 'posted'
        AND COALESCE(NULLIF(im.stock_location, ''), 'LOCAL') != 'FBP'
        AND (im.source_type IS NULL OR im.source_type NOT IN ('fbp_replenishment_reserve', 'fbp_replenishment_reserve_release'))
        AND ${scope("im")}
      GROUP BY im.product_id`,
    `SELECT cp.id AS product_id, SUM(oi.quantity * COALESCE(ri.quantity, pc.quantity, 1)) AS open_demand_qty
      FROM orders o
      JOIN shops sh ON sh.id = o.shop_id AND ${scope("sh")}
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN sku_mappings direct_mapping ON direct_mapping.id = oi.sku_mapping_id
        AND direct_mapping.shop_id = o.shop_id AND direct_mapping.active = 1 AND ${scope("direct_mapping")}
      LEFT JOIN (SELECT shop_id, ozon_sku, MIN(id) AS id FROM sku_mappings fallback_source
        WHERE active = 1 AND ${scope("fallback_source")} GROUP BY shop_id, ozon_sku) fallback_mapping
        ON fallback_mapping.shop_id = o.shop_id AND fallback_mapping.ozon_sku = oi.ozon_sku
      JOIN sku_mappings sm ON sm.id = COALESCE(direct_mapping.id, fallback_mapping.id) AND ${scope("sm")}
      JOIN products p ON p.id = sm.product_id AND p.active = 1 AND ${scope("p")}
      LEFT JOIN sku_inventory_recipes recipe ON recipe.shop_id = o.shop_id AND recipe.ozon_sku = oi.ozon_sku
        AND recipe.active = 1 AND recipe.mode = 'combo'
      LEFT JOIN sku_inventory_recipe_items ri ON ri.recipe_id = recipe.id
      LEFT JOIN product_components pc ON pc.product_id = p.id AND recipe.id IS NULL AND ${scope("pc")}
      JOIN products cp ON cp.id = CASE WHEN recipe.id IS NOT NULL THEN ri.product_id
        WHEN pc.component_product_id IS NOT NULL THEN pc.component_product_id ELSE p.id END
        AND cp.active = 1 AND ${scope("cp")}
      WHERE cp.id IN (${productSql}) AND ${openOrder}
      GROUP BY cp.id`,
    `SELECT im.product_id, SUM(-im.quantity_delta) AS open_deducted_qty
      FROM orders o
      JOIN shops sh ON sh.id = o.shop_id AND ${scope("sh")}
      JOIN order_items oi ON oi.order_id = o.id
      JOIN inventory_movements im ON im.related_order_item_id = oi.id
        AND im.source_type IN ('order_outbound', 'order_outbound_adjustment') AND im.status = 'posted'
        AND COALESCE(NULLIF(im.stock_location, ''), 'LOCAL') != 'FBP' AND ${scope("im")}
      JOIN products p ON p.id = im.product_id AND p.active = 1 AND ${scope("p")}
      WHERE im.product_id IN (${productSql}) AND ${openOrder}
      GROUP BY im.product_id`,
    `SELECT i.product_id,
      SUM(GREATEST(i.approved_qty + COALESCE((SELECT SUM(a.adjustment_qty)
        FROM fbp_replenishment_item_adjustments a WHERE a.item_id = i.id), 0), 0)) AS quantity
      FROM fbp_replenishment_order_items i
      JOIN fbp_replenishment_orders o ON o.id = i.order_id
      JOIN shops sh ON sh.id = o.shop_id AND ${scope("sh")}
      JOIN products p ON p.id = i.product_id AND p.active = 1 AND ${scope("p")}
      WHERE o.status IN ('approved', 'ozon_created') AND i.product_id IN (${productSql})
      GROUP BY i.product_id`
  ];
}

export { balanceQueries as inventoryProductBalanceQueries };

function completeRows(rows, productIds) {
  const byId = new Map(rows.map((row) => [Number(row.product_id), row]));
  if (byId.size !== productIds.length || productIds.some((id) => !byId.has(id))) return null;
  for (const row of rows) {
    if (![row.physical_stock, row.available_stock, row.open_order_demand_qty, row.fbp_reserved_qty].every((value) => Number.isFinite(Number(value)))) return null;
  }
  return byId;
}

export async function loadInventoryProductBalances(query, withTransaction, tenantId, includeLegacyTenantNull, productIds, { forceRefresh = false, onRefreshed = null } = {}) {
  const ids = [...new Set(productIds.map(Number))].sort((a, b) => a - b);
  if (!ids.length) return new Map();
  const sql = balanceQueries(tenantId, includeLegacyTenantNull, ids);
  const placeholders = ids.map(() => "?").join(",");
  const read = async () => query(`SELECT product_id, ledger_qty, open_deducted_qty, open_order_demand_qty,
    fbp_reserved_qty, physical_stock, available_stock, inventory_needs_review, refreshed_at,
    TIMESTAMPDIFF(SECOND, refreshed_at, UTC_TIMESTAMP()) AS age_seconds
    FROM inventory_product_balance WHERE tenant_id = ? AND product_id IN (${placeholders})`, [tenantId, ...ids]);
  const key = `${tenantId}:${ids.join(",")}`;
  const refresh = (refreshKey, background = false) => {
    const pending = pendingRefreshes.get(refreshKey);
    if (pending) return pending.promise;
    if (background && Date.now() - (lastBackgroundRefresh.get(refreshKey) || 0) < BACKGROUND_REFRESH_INTERVAL_MS) return null;
    if (background) lastBackgroundRefresh.set(refreshKey, Date.now());
    const version = invalidationVersion;
    const work = (async () => {
      try {
        const source = await Promise.all(sql.map((statement) => query(statement)));
        const calculated = buildInventoryProductBalances(ids, ...source);
        await withTransaction(async (connection) => {
          await connection.execute(`DELETE FROM inventory_product_balance WHERE tenant_id = ? AND product_id IN (${placeholders})`, [tenantId, ...ids]);
          for (let offset = 0; offset < calculated.length; offset += 100) {
            const chunk = calculated.slice(offset, offset + 100);
            const tuples = chunk.map(() => "(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())").join(",");
            const values = chunk.flatMap((row) => [tenantId, row.product_id, row.ledger_qty, row.open_deducted_qty,
              row.open_order_demand_qty, row.fbp_reserved_qty, row.physical_stock, row.available_stock,
              row.inventory_needs_review ? 1 : 0]);
            await connection.execute(`INSERT INTO inventory_product_balance
              (tenant_id, product_id, ledger_qty, open_deducted_qty, open_order_demand_qty,
                fbp_reserved_qty, physical_stock, available_stock, inventory_needs_review, refreshed_at)
              VALUES ${tuples}`, values);
          }
        });
        const stored = completeRows(await read(), ids);
        if (!stored) throw new Error("企业库存余额汇总写入不完整");
        if (version === invalidationVersion) refreshedVersionByTenant.set(Number(tenantId), version);
        if (typeof onRefreshed === "function") onRefreshed();
        return stored;
      } finally {
        if (pendingRefreshes.get(refreshKey)?.promise === work) pendingRefreshes.delete(refreshKey);
      }
    })();
    pendingRefreshes.set(refreshKey, { promise: work, version });
    return work;
  };
  const existingRows = completeRows(await read(), ids);
  const age = existingRows ? Math.max(...[...existingRows.values()].map((row) => Number(row.age_seconds))) : Infinity;
  const dirty = (refreshedVersionByTenant.get(Number(tenantId)) ?? 0) !== invalidationVersion;
  if (!forceRefresh && existingRows && Number.isFinite(age) && age <= FRESH_SECONDS && !dirty) return existingRows;
  if (!forceRefresh && existingRows && Number.isFinite(age) && age <= MAX_STALE_SECONDS) {
    const work = refresh(key, true);
    if (work) void work.catch((error) => {
      console.warn(`[inventory-balance] background refresh failed: ${String(error?.code || error?.name || "unknown")}`);
    });
    return existingRows;
  }
  const pending = pendingRefreshes.get(key);
  if (pending && forceRefresh) await pending.promise.catch(() => {});
  return refresh(key);
}
