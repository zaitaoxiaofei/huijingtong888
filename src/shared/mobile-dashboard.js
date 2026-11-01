import { hasPermission } from './permissions.js';

// An explicit allow-list: mobile staff responses never contain hidden financial sections.
export function mobileDashboard(payload = {}, session = {}) {
  const financial = Boolean(session.tenant?.id) && hasPermission(session, 'finance');
  const today = payload.commerce?.today || {}, trend = payload.commerce?.profit_trend || {};
  const month = payload.summary?.month_shipping_cost || {}, outcomes = payload.summary?.month_order_outcomes || {};
  const ad = payload.commerce?.advertising?.today || {};
  const metrics = {
    today_revenue: today.effective_revenue ?? today.revenue,
    today_orders: today.effective_orders,
    today_cancelled: today.cancelled_orders,
    today_returns: today.return_quantity,
    ad_roas: ad.roi,
    month_quantity: month.item_quantity,
    month_orders: trend.month_effective_orders ?? outcomes.effective_orders,
    return_rate: payload.summary?.aftersales_loss?.return_rate
  };
  const cancelled = trend.month_cancelled_orders ?? outcomes.cancelled_orders;
  const returned = trend.month_return_orders ?? outcomes.return_orders;
  const effective = metrics.month_orders;
  // Cancellation denominator matches the classified effective/cancelled/return order buckets.
  const denominator = [effective, cancelled, returned].every(v => v != null)
    ? Number(effective) + Number(cancelled) + Number(returned) : null;
  metrics.cancel_rate = denominator > 0 ? Number(cancelled) / denominator : denominator === 0 ? 0 : null;
  if (financial) Object.assign(metrics, {
    today_profit: today.profit,
    month_revenue: trend.month_total_revenue,
    month_profit: trend.month_total_profit,
    month_purchase_cost: month.purchase_cost,
    month_ad_spend: payload.commerce?.advertising?.month?.spend_cny,
    fbp_inventory_value: payload.summary?.fbp_inventory_value
  });
  return {
    date_key: payload.commerce?.date_key,
    snapshot: Object.fromEntries(['status', 'updated_at', 'generated_at', 'partial'].filter(k => payload.snapshot?.[k] !== undefined).map(k => [k, payload.snapshot[k]])),
    financial, metrics, ad_date_key: ad.date_key || payload.commerce?.advertising?.date_key,
    currency: 'CNY'
  };
}
