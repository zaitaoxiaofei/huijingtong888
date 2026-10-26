import { mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import {
  ensureOrderProfitCalculationState,
  getPinnedProfitFormulaVersion,
  recordOrderProfitCalculation,
  retryProfitCalculationTransaction
} from "./order-profit-calculation-versions.js";
import { assertProfitFormulaSupported, getProfitFormula } from "./profit-formulas/registry.js";
import { orderFxSalePrice, pendingOrderFxEstimate, readOrderProfitFxState } from "./order-profit-fx-policy.js";

// Business projections and their audit revision always use the same connection.
export function profitCalculationDatabase(connection) {
  const query = async (sql, params = []) => (await connection.query(sql, params))[0];
  const execute = async (sql, params = []) => (await connection.execute(sql, params))[0];
  return { query, execute, queryOne: async (sql, params = []) => (await query(sql, params))[0] || null };
}

const SNAPSHOT_SQL = `
  SELECT oi.id AS order_item_id, oi.order_id,
    CASE WHEN s.tenant_id > 0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END AS tenant_key,
    o.ordered_at, oi.quantity, oi.sale_price, oi.sku_mapping_id,
    oi.frozen_purchase_cost, oi.frozen_domestic_shipping,
    oi.frozen_international_shipping, oi.frozen_logistics_rule_id,
    oi.frozen_handling_fee, oi.estimated_commission, oi.platform_fee_actual,
    oi.aftersale_loss, oi.estimated_profit, oi.actual_profit, oi.settlement_state,
    opi.sale_amount_cny, opi.purchase_cost_cny, opi.domestic_shipping_cny,
    opi.international_shipping_cny, opi.packaging_cost_cny,
    opi.commission_rate, opi.commission_fee_cny, opi.ozon_service_fee_cny,
    opi.return_loss_cny, opi.advertising_cost_cny, opi.other_fee_cny,
    opi.gross_profit_cny, opi.net_profit_cny, opi.profit_status,
    opi.is_locked, opi.locked_at, opi.lock_reason
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN shops s ON s.id = o.shop_id
  LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
  WHERE oi.id = ?`;

const ESTIMATE_OUTPUT_FIELDS = [
  "order_item_id", "order_id", "quantity", "sale_price", "sku_mapping_id",
  "frozen_purchase_cost", "frozen_domestic_shipping", "frozen_international_shipping",
  "frozen_logistics_rule_id", "frozen_handling_fee", "estimated_commission", "aftersale_loss", "estimated_profit"
];
const ACTUAL_OUTPUT_FIELDS = [
  "order_item_id", "order_id", "actual_profit", "settlement_state", "platform_fee_actual",
  "sale_amount_cny", "purchase_cost_cny", "domestic_shipping_cny", "international_shipping_cny",
  "packaging_cost_cny", "commission_rate", "commission_fee_cny", "ozon_service_fee_cny",
  "return_loss_cny", "advertising_cost_cny", "other_fee_cny", "gross_profit_cny", "net_profit_cny",
  "profit_status", "is_locked", "locked_at", "lock_reason"
];

// The shared business projection contains both layers. Hash only the outputs
// owned by this calculation, so finance changes cannot create estimate revisions.
export function profitCalculationOutputForLayer(layer, snapshot = {}) {
  if (!["estimate", "actual"].includes(layer)) throw new Error("Profit calculation layer must be estimate or actual");
  const fields = layer === "actual" ? ACTUAL_OUTPUT_FIELDS : ESTIMATE_OUTPUT_FIELDS;
  return Object.fromEntries(fields.filter((key) => snapshot[key] !== undefined).map((key) => [key, snapshot[key]]));
}

export async function estimatePinnedOrderItemProfit(orderItemId, input) {
  const calculateV2 = (state, sku) => {
    const convertedPrice = orderFxSalePrice(state, sku);
    if (!state?.orderFx || convertedPrice === null) return pendingOrderFxEstimate(state);
    const original = state.prices.find(price => String(price.ozon_sku) === String(sku));
    return { ...getProfitFormula("V2").estimateItemProfit({ ...input,
      salePrice: convertedPrice,
      product: { ...input.product, pricing_effective_at: input.product?.pricing_effective_at || state.ordered_business_date },
      fx: state.orderFx, orderBusinessDate: state.ordered_business_date, salePriceCurrency: "CNY",
      pricingAmountRub: original.currency === "RUB" ? original.amount : original.amount * Number(state.orderFx.rate)
    }), formulaVersion: "V2", fx: state.orderFx, orderBusinessDate: state.ordered_business_date, salePriceCny: convertedPrice };
  };
  if (!Number(orderItemId)) return input.fxState ? calculateV2(input.fxState, input.ozonSku)
    : { ...getProfitFormula("V1").estimateItemProfit(input), formulaVersion: "V1" };
  const rows = await mysqlQuery(`SELECT oi.order_id, oi.ozon_sku, CASE WHEN s.tenant_id > 0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END AS tenant_key
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN shops s ON s.id = o.shop_id WHERE oi.id = ?`, [Number(orderItemId)]);
  if (!rows[0]) throw new Error("订单商品不存在，无法确定利润公式版本");
  const version = await getPinnedProfitFormulaVersion({ query: mysqlQuery, tenantId: rows[0].tenant_key }, Number(orderItemId));
  if (version === "V2") return calculateV2(input.fxState || await readOrderProfitFxState({ query: mysqlQuery }, rows[0].tenant_key, rows[0].order_id), rows[0].ozon_sku);
  return { ...getProfitFormula(version).estimateItemProfit(input), formulaVersion: version };
}

export async function orderProfitFormulaLabels(orderIds) {
  const ids = [...new Set(orderIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = await mysqlQuery(`SELECT state.order_id,
    GROUP_CONCAT(DISTINCT state.formula_version ORDER BY state.formula_version) AS profit_formula_versions,
    MAX(state.legacy_baseline) AS profit_calculation_legacy
    FROM order_profit_calc_state state
    JOIN orders o ON o.id = state.order_id
    JOIN shops s ON s.id = o.shop_id
    WHERE state.order_id IN (${ids.map(() => "?").join(",")})
      AND state.tenant_key = (CASE WHEN s.tenant_id > 0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END) COLLATE utf8mb4_0900_ai_ci
    GROUP BY state.order_id`, ids);
  return new Map(rows.map((row) => [Number(row.order_id), row]));
}

export async function withVersionedOrderProfitWrite(orderItemId, options, project) {
  const run = async (connection) => {
    const db = profitCalculationDatabase(connection);
    await db.query("SELECT id FROM order_items WHERE id = ? FOR UPDATE", [Number(orderItemId)]);
    const before = await db.queryOne(SNAPSHOT_SQL, [Number(orderItemId)]);
    if (!before) throw new Error("订单商品不存在，无法保存利润计算记录");
    const actualReady = before.profit_status === "accrued" && before.settlement_state === "accrued";
    const state = await ensureOrderProfitCalculationState(connection, {
      tenantId: before.tenant_key, orderId: before.order_id, orderItemId: Number(orderItemId),
      baselineEstimate: before,
      baselineActual: actualReady ? before : null,
      legacy: options.legacy !== false,
      initialFormulaVersion: options.initialFormulaVersion,
      rateVersion: before.frozen_logistics_rule_id || null
    });
    const version = state.formula_version || "V1";
    assertProfitFormulaSupported(version, { operation: options.layer === "actual" ? "finance" : "estimate" });
    const fxState = version === "V2" ? await readOrderProfitFxState(db, before.tenant_key, before.order_id) : null;
    if (version === "V2" && !fxState) throw Object.assign(new Error("每日汇率订单缺少冻结记录，停止计算"), { code: "ORDER_PROFIT_FX_STATE_MISSING" });
    const result = await project({ connection, db, formulaVersion: version });
    const after = await db.queryOne(SNAPSHOT_SQL, [Number(orderItemId)]);
    const layer = options.layer || "estimate";
    const source = options.source || (layer === "actual" ? "ozon_finance" : "order_sync");
    await recordOrderProfitCalculation(connection, {
      tenantId: before.tenant_key, orderId: before.order_id, orderItemId: Number(orderItemId),
      layer, formulaVersion: version,
      inputs: options.inputs || {}, outputs: { ...profitCalculationOutputForLayer(layer, after),
        ...(version === "V2" && layer === "estimate" && after.profit_status === "estimated"
          ? { estimated_breakdown: profitCalculationOutputForLayer("actual", after) } : {}),
        ...(version === "V2" && options.inputs?.fx_attribution ? { fx_attribution: options.inputs.fx_attribution } : {}) },
      rateVersion: options.rateVersion || (fxState ? { logistics_rule_id: after.frozen_logistics_rule_id || null,
        order_fx: fxState.orderFx, signed_fx: fxState.signedFx, state: fxState.state } : layer === "actual" ? { source } : after.frozen_logistics_rule_id || null),
      costVersion: options.costVersion || null,
      source, reason: options.reason || "业务数据同步",
      commandId: options.commandId || null, actorId: options.actorId || null,
      preserveBaseline: false
    });
    return result;
  };
  return options.connection ? run(options.connection) : retryProfitCalculationTransaction(withMysqlTransaction, run, { maxAttempts: 3 });
}

// Existing explicit repair tools retain their scope and SQL, but cannot bypass
// pinned formulas or erase the result they are about to correct.
export async function withVersionedOrderProfitBatchWrite(orderItemIds, options, project) {
  const ids = [...new Set(orderItemIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  const run = async (connection) => {
    const db = profitCalculationDatabase(connection);
    const baselines = [];
    for (const id of ids) {
      await db.query("SELECT id FROM order_items WHERE id = ? FOR UPDATE", [id]);
      const before = await db.queryOne(SNAPSHOT_SQL, [id]);
      if (!before) continue;
      const state = await ensureOrderProfitCalculationState(connection, {
        tenantId: before.tenant_key, orderId: before.order_id, orderItemId: id, legacy: true,
        baselineEstimate: before,
        baselineActual: before.profit_status === "accrued" && before.settlement_state === "accrued" ? before : null,
        rateVersion: before.frozen_logistics_rule_id || null
      });
      assertProfitFormulaSupported(state.formula_version, { operation: options.operation || "historical_repair" });
      baselines.push({ before, state });
    }
    const result = await project({ connection, db });
    for (const { before, state } of baselines) {
      const after = await db.queryOne(SNAPSHOT_SQL, [before.order_item_id]);
      for (const layer of ["estimate", ...(before.settlement_state === "accrued" || after.settlement_state === "accrued" || Number(before.actual_profit) !== Number(after.actual_profit) ? ["actual"] : [])]) {
        const source = options.source || "historical_repair";
        await recordOrderProfitCalculation(connection, {
          tenantId: before.tenant_key, orderId: before.order_id, orderItemId: before.order_item_id,
          layer, formulaVersion: state.formula_version, inputs: options.inputs || {}, outputs: profitCalculationOutputForLayer(layer, after),
          rateVersion: layer === "actual" ? { source } : after.frozen_logistics_rule_id || null,
          source, reason: options.reason || "明确范围的历史利润修订",
          actorId: options.actorId || null, commandId: options.commandId || null
        });
      }
    }
    return result;
  };
  return options.connection ? run(options.connection) : retryProfitCalculationTransaction(withMysqlTransaction, run, { maxAttempts: 3 });
}

export function profitEstimateInputs({ product, mapping, estimated, quantity, salePrice, order, item }) {
  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
  return {
    quantity, sale_price: salePrice,
    product: pick(product, ["id", "purchase_cost", "domestic_shipping", "international_shipping", "purchase_quantity", "handling_fee", "package_weight_g", "length_cm", "width_cm", "height_cm", "exchange_rate", "return_rate", "withdrawal_fee_rate", "advertising_rate", "logistics_rule_id", "resolved_logistics_rule_id", "logistics_rule_carrier", "logistics_rule_channel", "logistics_rule_name", "logistics_rule_base_fee_cny", "logistics_rule_per_gram_cny", "logistics_rule_per_ticket_cny", "logistics_rule_min_weight_g", "logistics_rule_max_weight_g", "logistics_rule_min_price_rub", "logistics_rule_max_price_rub", "ogl_parcel_value_rub", "pricing_effective_at"]),
    mapping: pick(mapping, ["id", "commission_low", "commission_high", "commissions_json", "ozon_commissions_json", "commission_json"]),
    order: pick(order, ["status", "tracking_stage", "logistics_status", "ordered_at", "cancel_reason_id", "cancel_initiator", "cancel_type", "cancelled_after_ship", "outcome_type", "loss_profile_code"]),
    item: pick(item, ["id", "quantity", "sale_price", "order_status", "outcome_type", "loss_profile_code"]),
    estimate: estimated || {}
  };
}
