export const COLLECT_REQUEST_STALE_MS = 120000;
export const SKU_TRAFFIC_RETENTION_DAYS = 30;
export const SKU_TRAFFIC_METRICS = [
  ['total_views', '总曝光'], ['search_views', '搜索曝光'], ['pdp_views', '商品详情浏览'],
  ['total_hits_to_cart', '总加购次数'], ['ordered_units', '下单件数'],
  ['conv_views_to_order', '曝光至下单转化率'], ['conv_total_views_to_cart', '曝光至加购转化率'],
  ['conv_hits_to_cart_to_order', '加购至下单转化率']
];
export function trafficDate(value) {
  const text = String(value || '');
  const parsed = new Date(text + 'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : '';
}
export function shiftTrafficDate(day, delta) {
  if (!trafficDate(day)) throw new Error('报表日期无效');
  return new Date(Date.parse(day + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}
export function trafficToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
}
export function trafficDays(now = new Date()) {
  const today = trafficToday(now);
  return Array.from({length: SKU_TRAFFIC_RETENTION_DAYS}, (_, index) => shiftTrafficDate(today, index - SKU_TRAFFIC_RETENTION_DAYS));
}
export function dailyTrafficCoverage(run, {allowPartial = false} = {}) {
  const day = trafficDate(run?.current_period?.date_from);
  if (!day || day !== run?.current_period?.date_to) return {ok: false, error: '只接受单个报表日，七天汇总不能拆成每日数据'};
  if (run.status !== 'success') return {ok: false, error: '采集任务尚未完整成功'};
  const pages = (run.requests || []).filter(r => r.source_key === 'all_metrics' && r.endpoint_type === 'by_sku').sort((a,b) => a.page_index - b.page_index);
  if (!pages.length) return {ok: false, error: '缺少 SKU 明细页'};
  for (const [index, page] of pages.entries()) {
    if (page.status !== 'success' || page.page_index !== index || !page.auto_all_pages || !page.snapshot_id || !Number.isInteger(page.returned_count) || page.returned_count < 0) return {ok: false, error: 'SKU 分页不完整或缺少可验证的页记录'};
    const limit = Number(page.limit || 30);
    if (page.returned_count > limit || (index < pages.length - 1 && page.returned_count !== limit)) return {ok: false, error: 'SKU 分页数量不连续'};
  }
  const last = pages.at(-1);
  const incomplete = last.reported_has_more || last.returned_count >= Number(last.limit || 30);
  if (incomplete && !(allowPartial && last.auto_stop_code === 'source_offset_cap')) return {ok: false, error: '采集触及分页上限，未证明全店完整；保留上次成功数据'};
  return {ok: true, complete: !incomplete, day, snapshotIds: pages.map(p => p.snapshot_id), expectedRows: pages.reduce((n,p) => n + p.returned_count, 0)};
}
export function normalizeDailyTrafficMetric(row) {
  const sku = String(row.sku || '').trim();
  if (!sku || sku.length > 128) throw new Error('商品报表的 SKU 编号（sku）缺失或过长。请在 Ozon 店铺分析页核对 SKU 列后重新补采；未发布整日数据');
  const raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
  const metrics = raw?.metrics || raw?.metric || raw || {};
  const result = {sku};
  for (const [key,label] of SKU_TRAFFIC_METRICS) {
    const responseKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = Object.hasOwn(metrics, key) ? metrics[key] : metrics[responseKey];
    if (value === null || value === undefined || value === '') { result[key] = null; continue; }
    const rawValue = typeof value === 'object' ? value.value : value;
    if (typeof value === 'object' && Object.hasOwn(value, 'value') && (rawValue === null || rawValue === '')) { result[key] = null; continue; }
    if (!['number','string'].includes(typeof rawValue) || String(rawValue).trim() === '') throw new Error(`SKU ${sku} 的${label}（${key}）类型无效，请在 Ozon 分析页核对该日报表后补采`);
    const number = Number(rawValue);
    if (!Number.isFinite(number) || number < 0 || number > 1e12) throw new Error(`SKU ${sku} 的${label}（${key}）不是有效非负数，请在 Ozon 分析页核对该日报表后补采；保留原记录`);
    result[key] = number;
  }
  if (SKU_TRAFFIC_METRICS.every(([key]) => result[key] === null)) throw new Error(`SKU ${sku} 未返回曝光、浏览、加购、下单或转化日指标，请刷新 Ozon 分析页后重新补采`);
  return result;
}
export function dailyTrafficSeries(days, rows) {
  const byDay = new Map(rows.map(row => [String(row.date_key), row]));
  return days.map(date_key => ({date_key, available: byDay.has(date_key), ...(byDay.get(date_key) || Object.fromEntries(SKU_TRAFFIC_METRICS.map(([key]) => [key, null])))}));
}
