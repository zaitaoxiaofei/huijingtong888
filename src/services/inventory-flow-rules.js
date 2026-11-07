import { shanghaiDateKey } from "../shanghai-time.js";

const DAY = 86400000;
export function flowError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
export function whole(value, label = "数量", max = 1000000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw flowError(`${label}须为0至${max}的整数`);
  return number;
}
export function validateFlowSettings(value = {}) {
  const result = {
    local_safety_override: value.local_safety_override == null ? null : whole(value.local_safety_override, '人工本地保障'),
    local_safety_override_note: String(value.local_safety_override_note||'').trim().slice(0,500),
    fbp_days: whole(value.fbp_days ?? 7, "送FBP仓天数", 180),
    production_days: value.production_days == null ? null : whole(value.production_days, "生产天数", 180),
    local_days: value.local_days == null ? null : whole(value.local_days, "送本地仓天数", 180),
    minimum_order: Math.max(1, whole(value.minimum_order ?? 1, "采购起订量")),
    potential_sales: Math.max(1, whole(value.potential_sales ?? 20, "潜力品销量门槛")),
    hit_sales: Math.max(1, whole(value.hit_sales ?? 100, "爆品销量门槛")),
    holidays: []
  };
  if(result.production_days===0)throw flowError("生产周期至少1天，请在本地安全保障规则中修改");
  if (!Array.isArray(value.holidays ?? []) || (value.holidays || []).length > 50) throw flowError("节假日最多设置50个区间");
  for (const holiday of value.holidays || []) {
    const from = String(holiday.from || ""), to = String(holiday.to || "");
    if (![from, to].every(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v) || from > to) throw flowError("节假日开始、结束日期无效，请在周期与规则中修改");
    if ((Date.parse(to) - Date.parse(from)) / DAY > 120) throw flowError("单个节假日区间不能超过120天");
    result.holidays.push({ from, to, name: String(holiday.name || "其他影响").slice(0, 80) });
  }
  return result;
}

// Count the union of non-working dates once, extending the overall lead time.
export function flowLeadDays(base, minimum, holidays = [], today = shanghaiDateKey()) {
  let remaining = Math.max(minimum, base), elapsed = 0;
  const start = Date.parse(`${today}T00:00:00Z`);
  while (remaining > 0 && elapsed < 1000) {
    const date = new Date(start + elapsed * DAY).toISOString().slice(0, 10);
    if (!holidays.some(range => date >= range.from && date <= range.to)) remaining--;
    elapsed++;
  }
  return elapsed;
}

export function classifyFlowSku(sales, createdDays, settings) {
  const weeks = [sales.w1, sales.w2, sales.w3, sales.w4].map(Number);
  if (weeks.every(v => v > 0) && weeks.reduce((a, b) => a + b, 0) >= settings.hit_sales) return "爆品";
  if (weeks[0] > 0 && weeks[1] > 0 && weeks[0] + weeks[1] >= settings.potential_sales) return "潜力品";
  if (createdDays >= 60 && Number(sales.d60) < 5) return "淘汰品";
  return "常规品";
}

export function calculateFlowProduct(product, balance, skus, settings, today) {
  const production = settings.production_days ?? Number(product.production_lead_days ?? 7);
  const local = settings.local_days ?? Number(product.warehouse_logistics_days ?? 2);
  const localDays = flowLeadDays(production + local, 7, settings.holidays, today);
  const fbpDays = flowLeadDays(production + local + settings.fbp_days, 15, settings.holidays, today);
  let localSafety = 0;
  const detailed = skus.map(sku => {
    const perSet = Number(sku.per_set_quantity || 1);
    const daily = Number(sku.sales.fbp14 ?? sku.sales.d14 ?? 0) / 14;
    const historicalDaily = Number(sku.sales.d14 || 0) / 14;
    const localDaily = Number(sku.sales.fbs7 || 0) / 7;
    const available = sku.available == null ? null : Math.max(0, Number(sku.available));
    const coverage = available != null && daily > 0 ? available / daily : null;
    const incoming = Math.max(0, Number(sku.in_transit || 0));
    // Only physically sold FBP stock moves predicted demand away from local stock.
    // Existing in-transit is shown separately, without treating it as already sellable.
    const localNeed = available > 0
      ? historicalDaily * Math.max(0, fbpDays - (historicalDaily > 0 ? available / historicalDaily : fbpDays))
      : localDaily * localDays;
    localSafety += localNeed * perSet;
    const category = classifyFlowSku(sku.sales, Number(product.created_days), settings);
    const fbpTarget = Math.ceil(daily * fbpDays);
    const shortage = available == null ? null : Math.max(0, fbpTarget - available - incoming - Number(sku.committed_qty || 0));
    const recommended = available == null ? null : (shortage > 0 && fbpTarget > 0 ? Math.max(5, Math.ceil(shortage)) : 0);
    return { ...sku, daily_sales: daily, local_daily_sales: localDaily, category,
      coverage_days: coverage, fbp_target: fbpTarget, suggested_qty: recommended,
      status: available == null ? "库存未同步" : available > 0 ? (coverage != null && coverage < fbpDays ? "FBP需补货／本地接替保障" : "FBP可售") : incoming > 0 ? "转FBP运输中" : "本地供货" };
  });
  const recommendedSafety = Math.ceil(localSafety), safety = settings.local_safety_override ?? recommendedSafety;
  const physical = Number(balance.physical_stock), orders = Number(balance.open_order_demand_qty), locked = Number(balance.fbp_reserved_qty);
  const free = Math.max(0, Math.floor(physical - orders - locked - safety));
  const localGap = Math.max(0, Math.ceil(orders + locked + safety - physical));
  const incoming = Number(product.incoming_stock || 0);
  const fbpNeed = detailed.reduce((sum, sku) => sum + Math.max(Number(sku.suggested_qty || 0), Number(sku.pending_qty || 0)) * Number(sku.per_set_quantity), 0);
  const localPurchase = Math.max(0, localGap - incoming);
  const fbpPurchase = Math.max(0, fbpNeed - free - Math.max(0, incoming - localGap));
  return { ...product, physical_stock: physical, order_qty: orders, locked_qty: locked,
    safety_qty: safety, recommended_safety_qty:recommendedSafety, safety_override:settings.local_safety_override??null, free_qty: free, local_gap: localGap, local_purchase: localPurchase,
    fbp_purchase: fbpPurchase, purchase_qty: Math.ceil((localPurchase + fbpPurchase) / settings.minimum_order) * settings.minimum_order,
    local_days: localDays, fbp_days: fbpDays, settings,
    official_qty: detailed.some(sku => sku.present == null) ? null : detailed.reduce((n, sku) => n + Number(sku.present) * Number(sku.per_set_quantity), 0),
    in_transit: detailed.reduce((n, sku) => n + Number(sku.in_transit || 0) * Number(sku.per_set_quantity), 0),
    skus: detailed, needs_review: physical < 0, stock_incomplete: !detailed.length || detailed.some(sku => sku.present == null) };
}
