import { hasPermission, isPlatformAdmin } from './permissions.js';

export function canViewDashboardFinance(session = {}) {
  return Boolean(session.tenant?.id) && hasPermission(session, 'finance');
}

// Apply to every section and nested shop row, including cached/partial snapshots.
// Ratios derived from costs are confidential too; sales, orders and ad metrics stay visible.
const privateMetric = /profit|margin|cost|expense|salary|balance|procurement_(?:amount|value)|^total_amount$|^unit_price$|purchase_(?:amount|price|ratio)|(?:shipping|freight|logistics)_(?:amount|ratio)|(?:inventory|in_transit).*value|loss|(?:commission|ozon_service|other)_fee/i;
const metricContainers = new Set(['profit_trend', 'month_shipping_cost', 'aftersales_loss']);
function withoutFinancialMetrics(value) {
  if (Array.isArray(value)) return value.map(withoutFinancialMetrics);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => metricContainers.has(key) || !privateMetric.test(key)).map(([key, item]) => [key, withoutFinancialMetrics(item)]));
}

export function dashboardMetricsForSession(payload = {}, session = {}) {
  return canViewDashboardFinance(session) && payload.financial !== false ? payload : withoutFinancialMetrics(payload);
}

export function dashboardForSession(payload = {}, session = {}) {
  const financial = canViewDashboardFinance(session) && payload.financial !== false;
  const result = { ...dashboardMetricsForSession(payload, session) };
  result.financial = financial;
  if ((!isPlatformAdmin(session) || !financial) && payload.summary?.ai_usage) {
    const keys = new Set(['cost', 'request_count', 'generated_count', 'cost_pending', 'unit_cost', 'cost_source', 'count_basis', 'task_count', 'allocation_method', 'people', 'unit']);
    result.summary = { ...result.summary, ai_usage: { ...Object.fromEntries(Object.entries(payload.summary.ai_usage).filter(([key]) => keys.has(key))), available: false, balance: null } };
  }
  return result;
}
