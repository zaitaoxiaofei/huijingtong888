import { ensureOrderProfitDailyFx, getOrderProfitDailyFx, orderProfitFxBusinessDate } from "./order-profit-daily-fx.js";
import { dailyFxQuery } from "./order-profit-daily-fx-schema.js";
import { usesDailyProfitFx } from "./profit-formulas/registry.js";
import { moneyToCny } from "./profit-formulas/v2/fx.js";

export const ORDER_PROFIT_FX_POLICY_KEY = "profit.daily_fx_policy.v2";
export const ORDER_PROFIT_FX_STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS order_profit_fx_state (
  tenant_key VARCHAR(128) NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  ordered_business_date DATE NOT NULL,
  signed_business_date DATE NULL,
  order_fx_id BIGINT UNSIGNED NULL,
  signed_fx_id BIGINT UNSIGNED NULL,
  signed_at DATETIME NULL,
  prices_json LONGTEXT NOT NULL,
  state VARCHAR(64) NOT NULL DEFAULT 'awaiting_order_rate',
  last_error_code VARCHAR(128) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_key, order_id),
  UNIQUE KEY uk_order_profit_fx_order (order_id),
  KEY idx_order_profit_fx_pending (state, order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

const parse = value => typeof value === "string" ? JSON.parse(value) : value;
const tenantKey = value => Number(value) > 0 ? String(Number(value)) : "admin";
const utcDate = value => value instanceof Date ? value : new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(value)) ? value : String(value).replace(" ", "T") + "Z");

export async function getOrderProfitFxPolicy(db) {
  const [row] = await dailyFxQuery(db, "SELECT value_json FROM system_settings WHERE `key` = ? LIMIT 1", [ORDER_PROFIT_FX_POLICY_KEY]);
  if (!row) return null;
  const value = parse(row.value_json);
  const boundary = value?.legacy_max_order_id;
  if (value?.version !== "V2" || !["number", "string"].includes(typeof boundary) || !/^\d+$/.test(String(boundary))
    || !Number.isSafeInteger(Number(boundary)) || Number(boundary) < 0 || typeof value.enabled_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?$/.test(value.enabled_at) || !Number.isFinite(utcDate(value.enabled_at).getTime())) {
    throw Object.assign(new Error("每日汇率启用边界无效，请平台管理员核查启用记录"), { code: "ORDER_PROFIT_FX_POLICY_INVALID" });
  }
  return value;
}

export function eligibleForDailyOrderFx(policy, { orderId, orderedAt, verifiedOrderedAt = true }) {
  if (!policy || !verifiedOrderedAt || Number(orderId) <= Number(policy.legacy_max_order_id)) return false;
  const placed = utcDate(orderedAt), activated = utcDate(policy.enabled_at);
  return Number.isFinite(placed.getTime()) && placed >= activated;
}

export async function readOrderProfitFxState(db, tenantId, orderId, { lock = false } = {}) {
  const [row] = await dailyFxQuery(db, `SELECT state.*,
    DATE_FORMAT(ordered_business_date, '%Y-%m-%d') ordered_day,
    DATE_FORMAT(signed_business_date, '%Y-%m-%d') signed_day
    FROM order_profit_fx_state state WHERE tenant_key = ? AND order_id = ?${lock ? " FOR UPDATE" : ""}`, [tenantKey(tenantId), Number(orderId)]);
  if (!row) return null;
  const orderFx = row.order_fx_id ? await getOrderProfitDailyFx(db, row.ordered_day) : null;
  const signedFx = row.signed_fx_id ? await getOrderProfitDailyFx(db, row.signed_day) : null;
  if ((row.order_fx_id && (!orderFx || String(orderFx.id) !== String(row.order_fx_id))) || (row.signed_fx_id && (!signedFx || String(signedFx.id) !== String(row.signed_fx_id)))) {
    throw Object.assign(new Error("订单冻结汇率与档案记录不一致，停止计算"), { code: "ORDER_PROFIT_FX_PIN_MISMATCH" });
  }
  return { ...row, ordered_business_date: row.ordered_day, signed_business_date: row.signed_day,
    prices: parse(row.prices_json), orderFx, signedFx, formulaVersion: "V2" };
}

// Called before profit/inventory transactions. A missing quote must not prevent
// order ingestion; it leaves an explicit pending state rather than a fallback.
export async function prepareOrderProfitFx(db, input, options = {}) {
  const policy = await getOrderProfitFxPolicy(db);
  if (!policy) {
    const [pinned] = await dailyFxQuery(db, "SELECT formula_version FROM order_profit_calc_state WHERE tenant_key = ? AND order_id = ? LIMIT 1", [tenantKey(input.tenantId), Number(input.orderId)]);
    if (!usesDailyProfitFx(pinned?.formula_version)) return null;
  }
  const existing = await readOrderProfitFxState(db, input.tenantId, input.orderId);
  const legacyItems = async connection => {
    const [legacy] = await dailyFxQuery(connection, `SELECT oi.id FROM order_items oi LEFT JOIN order_profit_calc_state calc
      ON calc.order_item_id = oi.id AND calc.tenant_key = ?
      WHERE oi.order_id = ? AND COALESCE(calc.formula_version, 'V1') NOT IN ('V2', 'V4') LIMIT 1`, [tenantKey(input.tenantId), Number(input.orderId)]);
    return Boolean(legacy);
  };
  if (!existing && await legacyItems(db)) return null;
  if (!existing && !eligibleForDailyOrderFx(policy, input)) return null;
  const orderedDay = existing?.ordered_business_date || orderProfitFxBusinessDate(input.orderedAt);
  let signedDay = existing?.signed_business_date || null, signedAt = existing?.signed_at || null;
  if (!signedDay && input.deliveredAt && !Number.isNaN(utcDate(input.deliveredAt).getTime())) {
    const candidate = orderProfitFxBusinessDate(input.deliveredAt);
    if (candidate >= orderedDay && candidate <= orderProfitFxBusinessDate(new Date(options.now ?? Date.now()))) {
      signedDay = candidate;
      signedAt = utcDate(input.deliveredAt).toISOString().slice(0, 19).replace("T", " ");
    }
  }
  let orderFx = existing?.orderFx || null, signedFx = existing?.signedFx || null, errorCode = null;
  try { orderFx ||= await ensureOrderProfitDailyFx(db, orderedDay, options); }
  catch (error) { errorCode = error.code || "ORDER_PROFIT_DAILY_FX_UNAVAILABLE"; }
  if (signedDay) {
    try { signedFx ||= await ensureOrderProfitDailyFx(db, signedDay, options); }
    catch (error) { errorCode ||= error.code || "ORDER_PROFIT_DAILY_FX_UNAVAILABLE"; }
  }
  const mergePrices = frozen => {
  const currentPrices = new Map((frozen || []).map(item => [String(item.ozon_sku), item]));
  for (const item of input.items || []) {
    const key = String(item.ozon_sku), old = currentPrices.get(key);
    if (old && ["CNY", "RUB"].includes(old.currency) && old.amount !== null && Number.isFinite(old.amount)) continue;
    const currency = String(item.sale_currency || "").trim().toUpperCase();
    const validAmount = item.sale_price_verified !== false && ["string", "number"].includes(typeof item.sale_price) && String(item.sale_price).trim() !== "" && Number.isFinite(Number(item.sale_price));
    currentPrices.set(key, { ozon_sku: key, amount: validAmount ? Number(item.sale_price) : null, currency,
      evidence: item.sale_currency_source || "posting.products.currency_code" });
  }
  return [...currentPrices.values()];
  };
  const persist = async writeDb => {
  // Network calls are complete. The short lock makes first-seen original
  // prices and both dates immutable even under concurrent shop syncs.
  const [owner] = await dailyFxQuery(writeDb, `SELECT o.id FROM orders o JOIN shops s ON s.id = o.shop_id
    WHERE o.id = ? AND (CASE WHEN s.tenant_id > 0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END) = ? FOR UPDATE`, [Number(input.orderId), tenantKey(input.tenantId)]);
  if (!owner) throw Object.assign(new Error("订单不属于当前企业，不能冻结汇率"), { code: "ORDER_PROFIT_FX_OWNERSHIP" });
  if (!existing && await legacyItems(writeDb)) return null;
  const [identity] = await dailyFxQuery(writeDb, "SELECT tenant_key FROM order_profit_fx_state WHERE order_id = ? FOR UPDATE", [Number(input.orderId)]);
  if (identity && identity.tenant_key !== tenantKey(input.tenantId)) throw Object.assign(new Error("订单汇率记录的企业归属冲突，停止计算"), { code: "ORDER_PROFIT_FX_OWNERSHIP" });
  const locked = await readOrderProfitFxState(writeDb, input.tenantId, input.orderId, { lock: true });
  if (locked) {
    orderFx = locked.orderFx || orderFx;
    if (locked.signed_business_date) {
      if (locked.signed_business_date !== signedDay) signedFx = locked.signedFx;
      signedDay = locked.signed_business_date;
      signedAt = locked.signed_at;
    }
    signedFx = locked.signedFx || signedFx;
  }
  const prices = mergePrices(locked?.prices || existing?.prices);
  const state = !orderFx ? "awaiting_order_rate" : !prices.length || prices.some(item => !["CNY", "RUB"].includes(item.currency) || item.amount === null || !Number.isFinite(item.amount))
    ? "awaiting_sale_currency" : signedDay && !signedFx ? "awaiting_signed_rate" : "ready";
  if (state === "awaiting_sale_currency") errorCode = "ORDER_PROFIT_SALE_CURRENCY_UNKNOWN";
  await dailyFxQuery(writeDb, `INSERT INTO order_profit_fx_state
    (tenant_key, order_id, ordered_business_date, signed_business_date, order_fx_id, signed_fx_id, signed_at, prices_json, state, last_error_code)
    SELECT ?, o.id, ?, ?, ?, ?, ?, ?, ?, ? FROM orders o JOIN shops s ON s.id = o.shop_id
    WHERE o.id = ? AND (CASE WHEN s.tenant_id > 0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END) = ?
    ON DUPLICATE KEY UPDATE
      order_fx_id = COALESCE(order_profit_fx_state.order_fx_id, VALUES(order_fx_id)),
      signed_business_date = COALESCE(order_profit_fx_state.signed_business_date, VALUES(signed_business_date)),
      signed_at = COALESCE(order_profit_fx_state.signed_at, VALUES(signed_at)),
      signed_fx_id = IF(order_profit_fx_state.signed_business_date <=> VALUES(signed_business_date), COALESCE(order_profit_fx_state.signed_fx_id, VALUES(signed_fx_id)), order_profit_fx_state.signed_fx_id),
      prices_json = VALUES(prices_json), state = VALUES(state), last_error_code = VALUES(last_error_code), updated_at = CURRENT_TIMESTAMP`,
  [tenantKey(input.tenantId), orderedDay, signedDay, orderFx?.id || null, signedFx?.id || null, signedAt, JSON.stringify(prices), state, errorCode,
    Number(input.orderId), tenantKey(input.tenantId)]);
  return readOrderProfitFxState(writeDb, input.tenantId, input.orderId);
  };
  return db.transaction ? db.transaction(persist) : persist(db);
}

export function orderFxSalePrice(state, sku) {
  const price = state?.prices?.find(item => String(item.ozon_sku) === String(sku));
  if (!state?.orderFx || !price || price.amount === null || !Number.isFinite(price.amount) || !["CNY", "RUB"].includes(price.currency)) return null;
  return moneyToCny(price.amount, price.currency, state.orderFx, { businessDate: state.ordered_business_date });
}

export function pendingOrderFxEstimate(state) {
  return { formulaVersion: "V4", fxPending: true, fxState: state?.state || "awaiting_order_rate", commission: 0, profit: 0 };
}
