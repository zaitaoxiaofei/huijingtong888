import {trafficDerivedMetrics} from '../../../src/shared/sku-traffic-monitor-query.js';
export function trafficRowSeries(row, response) {
  if (!Array.isArray(row.trend_values)) return (row.series || []).filter(day => day.date_key >= response.range_from && day.date_key <= response.date).map(day=>({...day,...trafficDerivedMetrics(day)}));
  if (!Array.isArray(response.series_days) || !Array.isArray(response.series_columns) || row.trend_values.length !== response.series_days.length) throw new Error('SKU趋势日期与数值不一致，请刷新重试');
  return response.series_days.map((date_key,index) => {
    const values=row.trend_values[index];
    if(values!==null&&(!Array.isArray(values)||values.length!==response.series_columns.length))throw new Error('SKU趋势指标数量不一致，请刷新重试');
    const day={date_key,available:values!==null,...Object.fromEntries(response.series_columns.map((key,i)=>[key,values===null?null:values[i]]))};return {...day,...trafficDerivedMetrics(day)};
  });
}
