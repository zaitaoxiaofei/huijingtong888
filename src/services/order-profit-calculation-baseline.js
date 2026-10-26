import { ensureOrderProfitCalculationState, profitCalculationTenantKey } from "./order-profit-calculation-versions.js";
import { registeredProfitFormulaVersions } from "./profit-formulas/registry.js";

const rows = (result) => Array.isArray(result?.[0]) ? result[0] : result;

export async function profitCalculationBaselineAudit(connection, { tablesAvailable = true } = {}) {
  const [projection] = rows(await connection.query(`SELECT COUNT(*) AS item_count,
    COALESCE(SUM(oi.estimated_profit), 0) AS estimated_profit,
    COALESCE(SUM(oi.actual_profit), 0) AS actual_profit,
    COALESCE(SUM(CASE WHEN opi.is_locked = 1 THEN 1 ELSE 0 END), 0) AS locked_count
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id`));
  if (!tablesAvailable) return { ...projection, state_count: 0, revision_count: 0, missing_count: Number(projection.item_count), unsupported_count: 0 };
  const supportedVersions = registeredProfitFormulaVersions();
  const [coverage] = rows(await connection.query(`SELECT COUNT(state.order_item_id) AS state_count,
    COALESCE(SUM(CASE WHEN state.order_item_id IS NULL THEN 1 ELSE 0 END), 0) AS missing_count,
    COALESCE(SUM(CASE WHEN state.formula_version NOT IN (${supportedVersions.map(() => "?").join(",")}) THEN 1 ELSE 0 END), 0) AS unsupported_count
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_profit_calc_state state ON state.order_item_id = oi.id
      AND state.tenant_key = (CASE WHEN s.tenant_id > 0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END) COLLATE utf8mb4_0900_ai_ci`, supportedVersions));
  const [revision] = rows(await connection.query("SELECT COUNT(*) AS revision_count FROM order_profit_calc_revisions"));
  return { ...projection, ...coverage, ...revision };
}

function baselineProjection(row) {
  const pick = (fields) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
  return {
    item: pick(["estimated_profit", "actual_profit", "settlement_state", "frozen_purchase_cost", "frozen_domestic_shipping",
      "frozen_international_shipping", "frozen_logistics_rule_id", "frozen_handling_fee", "estimated_commission", "platform_fee_actual", "aftersale_loss"]),
    breakdown: row.profit_item_id ? pick(["sale_amount_cny", "purchase_cost_cny", "domestic_shipping_cny", "international_shipping_cny",
      "packaging_cost_cny", "commission_rate", "commission_fee_cny", "ozon_service_fee_cny", "return_loss_cny", "advertising_cost_cny",
      "other_fee_cny", "gross_profit_cny", "net_profit_cny", "profit_status", "is_locked", "locked_at", "lock_reason"]) : null
  };
}

// The transaction is supplied by the caller. No recalculation, inventory write,
// finance application or snapshot refresh is allowed in this migration.
export async function baselineProfitCalculationBatch({ query, transaction }, { afterId = 0, limit = 250, write = false } = {}) {
  const batchSize = Math.min(1000, Math.max(1, Number(limit) || 250));
  const candidates = rows(await query(`SELECT oi.id AS order_item_id, oi.order_id, s.tenant_id
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN shops s ON s.id = o.shop_id
    WHERE oi.id > ? ORDER BY oi.id LIMIT ?`, [Number(afterId), batchSize]));
  let initialized = 0;
  if (write && candidates.length) initialized = await transaction(async (connection) => {
    let batchInitialized = 0;
    for (const candidate of candidates) {
      const input = { tenantId: profitCalculationTenantKey(candidate.tenant_id), orderId: Number(candidate.order_id), orderItemId: Number(candidate.order_item_id) };
      // Match the live writer's item -> calc_state lock order, and capture the
      // projection while the item is locked rather than from an earlier scan.
      // Do not lock the joined shop/order rows: that unnecessarily couples
      // unrelated items and creates cycles during a concurrent bulk baseline.
      await connection.query("SELECT id FROM order_items WHERE id = ? FOR UPDATE", [input.orderItemId]);
      const [row] = rows(await connection.query(`SELECT oi.*, opi.id AS profit_item_id,
        opi.sale_amount_cny, opi.purchase_cost_cny, opi.domestic_shipping_cny, opi.international_shipping_cny,
        opi.packaging_cost_cny, opi.commission_rate, opi.commission_fee_cny, opi.ozon_service_fee_cny,
        opi.return_loss_cny, opi.advertising_cost_cny, opi.other_fee_cny, opi.gross_profit_cny, opi.net_profit_cny,
        opi.profit_status, opi.is_locked, opi.locked_at, opi.lock_reason
        FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN shops s ON s.id = o.shop_id
        LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
        WHERE oi.id = ? AND oi.order_id = ?
          AND CASE WHEN s.tenant_id > 0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END = ?`,
      [input.orderItemId, input.orderId, input.tenantId]));
      if (!row) throw new Error("Order ownership changed during profit baseline migration");
      const state = await ensureOrderProfitCalculationState(connection, { ...input, legacy: false });
      if (Number(state.revision_count || 0) > 0) continue;
      const output = baselineProjection(row);
      const hasActual = Number(row.is_locked || 0) === 1 || row.profit_status === "accrued" || row.settlement_state === "accrued";
      await ensureOrderProfitCalculationState(connection, { ...input, legacy: true,
        baselineEstimate: output, baselineActual: hasActual ? output : null,
        rateVersion: row.frozen_logistics_rule_id ? { logistics_rule_id: Number(row.frozen_logistics_rule_id) } : null });
      batchInitialized += 1;
    }
    return batchInitialized;
  });
  return { mode: write ? "write" : "dry_run", matched: candidates.length, initialized,
    next_after_id: candidates.length ? Number(candidates.at(-1).order_item_id) : Number(afterId), complete: candidates.length < batchSize };
}
