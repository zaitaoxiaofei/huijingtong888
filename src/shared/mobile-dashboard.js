import { canViewDashboardFinance } from './dashboard-visibility.js';
import { shanghaiDateKey } from '../shanghai-time.js';

const validCalendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number(value.slice(0, 4)) >= 1000
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function normalizeMobileDashboardDate(query = {}, today = shanghaiDateKey()) {
  const keys = ['date', 'dateKey', 'date_key'].filter(key => Object.hasOwn(query, key));
  if (!keys.length) return today;
  const dates = keys.map(key => typeof query[key] === 'string' ? query[key].trim() : query[key]);
  if (dates.some(value => !validCalendarDate(value)) || dates.some(value => value !== dates[0])) {
    throw Object.assign(new Error('查询日期（date）无效，请选择有效的北京时间日期（YYYY-MM-DD）'), { statusCode: 400, code: 'MOBILE_DASHBOARD_DATE_INVALID' });
  }
  if (dates[0] > today) throw Object.assign(new Error('查询日期不能晚于北京时间今天，请选择今天或历史日期'), { statusCode: 400, code: 'MOBILE_DASHBOARD_DATE_FUTURE' });
  return dates[0];
}

export function mobileDashboardPeriod(date) {
  return { month_key: date.slice(0, 7), from: `${date.slice(0, 7)}-01`, to: date, timezone: 'Asia/Shanghai' };
}

// An explicit allow-list: mobile staff responses never contain hidden financial sections.
export function mobileDashboard(payload = {}, session = {}) {
  const financial = canViewDashboardFinance(session);
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
    month_cancelled: trend.month_cancelled_orders ?? outcomes.cancelled_orders,
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
    month_shipping_cost: month.shipping_cost,
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
