export const SKU_TRAFFIC_OPERATION_METRICS = [
  ['total_views','总曝光'],['search_views','搜索曝光'],['pdp_views','详情浏览'],
  ['total_hits_to_cart','加购次数'],['ordered_units','下单件数'],
  ['conv_views_to_order','曝光至下单转化率 %'],['conv_total_views_to_cart','曝光至加购率 %'],
  ['conv_hits_to_cart_to_order','加购至下单率 %'],['detail_view_rate','详情浏览率（浏览/曝光）%'],
  ['search_share','搜索曝光占比 %'],['pdp_order_rate','浏览→下单率（件数口径）%']
];
export const SKU_TRAFFIC_PRIMARY_RATE_KEYS=['search_share','detail_view_rate','pdp_order_rate'];
export function trafficDerivedMetrics(row={}) {
 const ratio=(a,b)=>row.available===false||row[a]===null||row[a]===undefined||row[b]===null||row[b]===undefined||!Number.isFinite(Number(row[a]))||!Number.isFinite(Number(row[b]))||Number(row[b])<=0?null:Number(row[a])/Number(row[b])*100;
 return {search_share:ratio('search_views','total_views'),detail_view_rate:ratio('pdp_views','total_views'),pdp_order_rate:ratio('ordered_units','pdp_views')};
}
export function normalizeTrafficMonitorQuery(body={}) {
  const invalid=message=>{throw Object.assign(new Error(message),{statusCode:400});};
  const rangeDays=Number(body.range_days||15);
  if(![1,7,15,30].includes(rangeDays))invalid('统计范围请选择1天、7天、15天或30天');
  const metricKeys=new Set(SKU_TRAFFIC_OPERATION_METRICS.map(([key])=>key));
  const sort=String(body.sort_key||'total_views'),direction=String(body.sort_order||'desc');
  if(!metricKeys.has(sort)||!['asc','desc'].includes(direction))invalid('请选择有效的运营指标和排序方向');
  const searchBy=String(body.search_by||'all');
  if(!['all','sku','offer_id','inventory','inventory_id','inventory_name','product_name'].includes(searchBy))invalid('请选择有效的搜索字段');
  let filters=body.filters||[];
  if(typeof filters==='string'){try{filters=JSON.parse(filters);}catch{invalid('筛选条件格式错误');}}
  if(!Array.isArray(filters)||filters.length>8)invalid('最多组合8项指标条件');
  filters=filters.map(rule=>{
    if(!metricKeys.has(rule?.metric)||!['gt','gte','lt','lte','eq'].includes(rule?.op))invalid('筛选条件包含不支持的指标或比较方式');
    if(!['number','string'].includes(typeof rule.value)||String(rule.value).trim()===''||!Number.isFinite(Number(rule.value))||Number(rule.value)<0||Number(rule.value)>1e12)invalid('指标条件请输入有效非负数');
    return {metric:rule.metric,op:rule.op,value:Number(rule.value)};
  });
  return {rangeDays,sort,direction,searchBy,exact:body.exact===true||String(body.exact)==='1',keyword:String(body.query||'').trim().slice(0,128),filters};
}
