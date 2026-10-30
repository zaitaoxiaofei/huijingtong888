import {isFbpInventory} from '../shared/inventory-fulfillment.js';
import { flowLeadDays } from './inventory-flow-rules.js';
import { shanghaiDateKey } from '../shanghai-time.js';

const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

export const activeFbpApplications = rows => rows.filter(row => ['draft', 'pending_review', 'approved', 'ozon_created'].includes(row.status));
export const requestedFbpQuantity = rows => activeFbpApplications(rows).reduce((sum, row) => sum + Number(row.requested_quantity || 0), 0);

// Shared read model. Forecasts never post movements or change the ledger revision.
export function buildInventoryFlowSummary(ledger, forecast, orders = [], applications = []) {
  const physical = number(ledger.physical_estimate), demand = number(ledger.open_order_demand), locked = number(ledger.fbp_reserved);
  const complete = forecast && !forecast.stock_incomplete && !forecast.needs_review;
  const safety = complete ? number(forecast.safety_qty) : null;
  const free = [physical, demand, locked, safety].every(value => value !== null) && physical >= 0
    ? Math.max(0, physical - demand - locked - safety) : null;
  return {
    physical, order_demand: demand, locked, safety, free, unoccupied: number(ledger.available_estimate),
    protection_gap: free === null ? null : Math.max(0, demand + locked + safety - physical),
    incoming: number(ledger.incoming_quantity), incoming_assigned: number(ledger.current_incoming),
    order_shortage: number(ledger.current_shortage),
    consumed_7d: forecast?.consumed_7d ?? null, daily_consumption: forecast?.daily_consumption ?? null,
    estimated_dates: forecast?.estimated_dates ?? 0, consumption_from: forecast?.consumption_from,
    consumption_to: forecast?.consumption_to, production_days: forecast?.production_days,
    local_shipping_days: forecast?.local_shipping_days,
    local_days: forecast?.local_days ?? null, fbp_days: forecast?.fbp_days ?? null,
    recommended_safety:forecast?.recommended_safety_qty??safety, safety_override:forecast?.safety_override??null, safety_override_note:forecast?.safety_override_note||'',
    safety_status: safety === null ? '待核对 SKU 绑定、官方库存及销量数据' : '预测保障，不含实际订单需求',
    safety_rows: (forecast?.skus || []).map(row => ({ shop_id: row.shop_id, shop_name: row.shop_name,
      ozon_sku: row.ozon_sku, per_set_quantity: row.per_set_quantity, daily_sales: row.daily_sales,
      local_daily_sales: row.local_daily_sales, coverage_days: row.coverage_days,
      available: row.available, synced_at: row.synced_at, status: row.status })),
    orders, applications,
    purchases: (ledger.purchases || []).filter(row => Number(row.pending_quantity) > 0).map(row => ({
      id: row.id, order_no: row.order_no, person_name: row.person_name,
      purchased_at: row.purchased_at, pending_quantity: row.pending_quantity,unarrived_quantity:row.unarrived_quantity,arrived_quantity:row.arrived_quantity
    })),
    requested: requestedFbpQuantity(applications),
    calculated_at: new Date().toISOString()
  };
}

// Physical consumption is already expanded to this inventory product by the ledger.
export function calculateLocalInventorySafety(ledger, settings = {}, now = new Date()) {
  const today = shanghaiDateKey(now);
  const end = Date.parse(`${today}T00:00:00+08:00`), start = end - 7 * 86400000;
  let consumed = 0, estimatedDates = 0;
  const seen = new Set();
  for (const row of ledger.orders || []) {
    if (!row.entered_transport || isFbpInventory(row.stock_location)) continue;
    const key = `${row.order_id}:${row.order_item_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = row.transport_at || row.ordered_at;
    const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    const at = new Date(normalized || NaN).getTime();
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    consumed += Math.max(0, Number(row.quantity) || 0);
    if (!row.transport_at) estimatedDates++;
  }
  const production = settings.production_days ?? Number(ledger.product.production_lead_days ?? 7);
  const shipping = settings.local_days ?? Number(ledger.product.warehouse_logistics_days ?? 2);
  const days = flowLeadDays(production + shipping, 7, settings.holidays || [], today);
  const recommended=Math.ceil(consumed / 7 * days);
  return { safety_qty: settings.local_safety_override ?? recommended, recommended_safety_qty:recommended,safety_override:settings.local_safety_override??null,safety_override_note:settings.local_safety_override_note||'', local_days: days,
    fbp_days: flowLeadDays(production + shipping + (settings.fbp_days ?? 7), 15, settings.holidays || [], today),
    consumed_7d: consumed, daily_consumption: consumed / 7, estimated_dates: estimatedDates,
    consumption_from: new Date(start).toISOString(), consumption_to: new Date(end).toISOString(),
    production_days: production, local_shipping_days: shipping, stock_incomplete: false, skus: [] };
}
