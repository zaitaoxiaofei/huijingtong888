import crypto from 'node:crypto';

export const H1_POLICIES=['official-cny-approved-h1-v1','official-cny-zero-payment-h1-v1'];
const parse=x=>typeof x==='string'?JSON.parse(x):x;
const round=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const costFields=['purchase_cost_cny','domestic_shipping_cny','international_shipping_cny','packaging_cost_cny','ozon_service_fee_cny','other_fee_cny','advertising_cost_cny','return_loss_cny'];
const journalKey=j=>JSON.stringify([Number(j.company_id),Number(j.shop_id),j.month_key,j.posting_number,j.sku]);
function latestRecords(records){const grouped=new Map();for(const j of records.filter(isApprovedH1)){const key=journalKey(j);if(!grouped.has(key)||Number(grouped.get(key).id)<Number(j.id))grouped.set(key,j);}return grouped;}
export const isApprovedH1=j=>Number(j.tenant_id)===1&&Number(j.company_id)===1&&[4,5,6].includes(Number(j.shop_id))&&/^2026-0[1-6]$/.test(j.month_key)&&H1_POLICIES.includes(parse(j.after_json)?.policy);
export function approvedH1ProjectionRanges({tenantId,companyId,from,to}){
 if(Number(tenantId)!==1||(companyId&&Number(companyId)!==1)||from>'2026-06-30'||to<'2026-01-01')return [{from,to,approvedH1:false}];
 const ranges=[];
 if(from<'2026-01-01')ranges.push({from,to:'2025-12-31',approvedH1:false});
 ranges.push({from:from<'2026-01-01'?'2026-01-01':from,to:to>'2026-06-30'?'2026-06-30':to,approvedH1:true});
 if(to>'2026-06-30')ranges.push({from:'2026-07-01',to,approvedH1:false});
 return ranges;
}
export async function readApprovedH1(query,{tenantId,companyId,from,to,shopId}){
 if(Number(tenantId)!==1||(companyId&&Number(companyId)!==1)||from>'2026-06'||to<'2026-01')return [];
 const params=[tenantId,from<'2026-01'?'2026-01':from,to>'2026-06'?'2026-06':to];
 if(Number(shopId)>0)params.push(Number(shopId));
 // These approved maintenance batches used Beijing-local MySQL sessions.
 // Preserve their stored wall time with an explicit offset; the column is not UTC.
 const records=await query(`SELECT j.*,DATE_FORMAT(j.created_at,'%Y-%m-%dT%H:%i:%s+08:00') created_at FROM finance_reconciliation_adjustments j JOIN shops s ON s.id=j.shop_id AND (s.tenant_id=j.tenant_id OR s.tenant_id IS NULL)
  WHERE j.tenant_id=? AND j.company_id=1 AND j.month_key>=? AND j.month_key<=? ${Number(shopId)>0?'AND j.shop_id=?':''}
  AND EXISTS(SELECT 1 FROM finance_shop_company_assignments a WHERE a.company_id=j.company_id AND a.shop_id=j.shop_id AND (a.tenant_id=j.tenant_id OR a.tenant_id IS NULL) AND a.effective_from<=LAST_DAY(CONCAT(j.month_key,'-01')) AND (a.effective_to IS NULL OR a.effective_to>=CONCAT(j.month_key,'-01'))) ORDER BY j.id`,params);
 const selected=records.filter(isApprovedH1),ids=[...new Set(selected.flatMap(j=>parse(j.sources_json).map(s=>Number(s.document_id))))];
 if(!ids.length)return [];
 const documents=await query(`SELECT id,shop_key,sha256,original_name,attachment_url FROM finance_import_documents WHERE tenant_id=? AND company_id=1 AND id IN (${ids.map(()=>'?').join(',')})`,[tenantId,...ids]);
 const byId=new Map(documents.map(d=>[Number(d.id),d]));
 return selected.map(j=>({...j,source_valid:parse(j.sources_json).length>0&&parse(j.sources_json).every(s=>{const d=byId.get(Number(s.document_id));return d&&Number(d.shop_key)===Number(j.shop_id)&&d.sha256===s.sha256;}),sources_json:JSON.stringify(parse(j.sources_json).map(s=>{const d=byId.get(Number(s.document_id));return d&&Number(d.shop_key)===Number(j.shop_id)?{...s,original_name:d.original_name,attachment_url:d.attachment_url}:{document_id:s.document_id,sha256:s.sha256,unavailable:true};}))}));
}
export function approvedH1BaselineMatches(record,items){
 const before=parse(record.before_json),ids=before.baseline?.item_ids;
 if(!Array.isArray(ids)||!ids.length||new Set(ids.map(Number)).size!==ids.length||items.length!==ids.length)return false;
 const byId=new Map(items.map(i=>[Number(i.order_item_id),i]));
 const raw=ids.map(id=>byId.get(Number(id))?.adjustment_baseline);
 if(raw.some(i=>!i))return false;
 const hash=crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex');
 return hash===before.baseline_fingerprint;
}
export function withApprovedH1(orders,records){
 const grouped=latestRecords(records);
 const byOrder=new Map();for(const j of grouped.values()){const key=JSON.stringify([Number(j.shop_id),j.month_key,j.posting_number]),list=byOrder.get(key)||[];list.push(j);byOrder.set(key,list);}
 return orders.map(order=>{
  const selected=byOrder.get(JSON.stringify([Number(order.shop_id),order.month_key,order.posting_number]))||[];
  if(!selected.length)return order;
  const items=order.items.map(i=>({...i,costs:{...i.costs},approved_adjustments:[]})),evidence=[];
  let revenueDelta=0,commissionDelta=0;
  for(const j of selected){
   const before=parse(j.before_json),after=parse(j.after_json),ids=before.baseline?.item_ids||[],matched=items.filter(i=>ids.map(Number).includes(Number(i.order_item_id)));
   const valid=j.source_valid!==false&&matched.every(i=>String(i.ozon_sku)===String(j.sku))&&approvedH1BaselineMatches(j,matched)&&after.currency==='CNY'&&[after.net_revenue,after.commission_fee].every(v=>v!=null&&Number.isFinite(Number(v)));
   const record={id:Number(j.id),company_id:Number(j.company_id),shop_id:Number(j.shop_id),month:j.month_key,posting_number:j.posting_number,sku:j.sku,before:before.baseline,after,reason:j.reason,created_at:j.created_at,sources:parse(j.sources_json),status:valid?'applied':'stale'};
   evidence.push(record);for(const i of matched)i.approved_adjustments.push(record);if(!valid)continue;
   const weights=matched.map(i=>Math.max(0,Number(i.item_revenue))),weight=weights.reduce((n,v)=>n+v,0);let revenueUsed=0,commissionUsed=0;
   matched.forEach((i,n)=>{
    const share=weight?weights[n]/weight:1/matched.length,last=n===matched.length-1;
    const revenue=last?round(Number(after.net_revenue)-revenueUsed):round(Number(after.net_revenue)*share),commission=last?round(Number(after.commission_fee)-commissionUsed):round(Number(after.commission_fee)*share);
    revenueUsed=round(revenueUsed+revenue);commissionUsed=round(commissionUsed+commission);
    const totalRevenue=round(revenue+Number(i.compensation_income||0));revenueDelta=round(revenueDelta+totalRevenue-Number(i.billing_revenue));commissionDelta=round(commissionDelta+commission-i.costs.commission_fee);
    i.sales_revenue=revenue;i.billing_revenue=totalRevenue;i.costs.commission_fee=commission;
   });
  }
  return {...order,items,approved_adjustments:evidence,adjustments_included:evidence.some(j=>j.status==='applied'),billing_revenue:round(order.billing_revenue+revenueDelta),sales_revenue:round(order.sales_revenue+revenueDelta),costs:{...order.costs,commission_fee:round(order.costs.commission_fee+commissionDelta)},deltas:{...order.deltas,revenue:round(order.deltas.revenue+revenueDelta),commission_fee:round(order.deltas.commission_fee+commissionDelta)}};
 });
}
export function adjustmentBaseline(row){
 return {item_id:row.order_item_id,sale_amount_cny:row.saved_sale,commission_fee_cny:row.saved_commission,net_profit_cny:row.saved_profit,costs:Object.fromEntries(costFields.map(k=>[k,row['saved_'+k]])),profit_status:row.saved_status,settlement_state:row.saved_settlement};
}

export async function approvedH1Report(query,scope,input={}){
 const records=await readApprovedH1(query,scope),ids=[...new Set(records.flatMap(j=>parse(j.before_json).baseline?.item_ids||[]))],items=new Map();
 for(let n=0;n<ids.length;n+=500){const batch=ids.slice(n,n+500);
  const rows=await query(`SELECT oi.id order_item_id,o.shop_id,o.posting_number,DATE_FORMAT(CONVERT_TZ(o.ordered_at,'+00:00','+08:00'),'%Y-%m') ordered_month,oi.ozon_sku,opi.sale_amount_cny saved_sale,opi.commission_fee_cny saved_commission,opi.net_profit_cny saved_profit,opi.profit_status saved_status,oi.settlement_state saved_settlement,${costFields.map(k=>'opi.'+k+' saved_'+k).join(',')}
   FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id LEFT JOIN order_profit_items opi ON opi.order_item_id=oi.id WHERE (s.tenant_id=? OR s.tenant_id IS NULL) AND oi.id IN (${batch.map(()=>'?').join(',')})`,[scope.tenantId,...batch]);
  for(const row of rows)items.set(Number(row.order_item_id),{...row,adjustment_baseline:adjustmentBaseline(row)});
 }
 const latest=latestRecords(records),rows=records.map(j=>{
  const b=parse(j.before_json),a=parse(j.after_json),matched=(b.baseline?.item_ids||[]).map(id=>items.get(Number(id))).filter(Boolean);
  const valid=j.source_valid!==false&&matched.every(i=>Number(i.shop_id)===Number(j.shop_id)&&i.posting_number===j.posting_number&&i.ordered_month===j.month_key&&String(i.ozon_sku)===String(j.sku))&&approvedH1BaselineMatches(j,matched);
  return {id:Number(j.id),shop_id:Number(j.shop_id),month:j.month_key,posting_number:j.posting_number,sku:j.sku,before:b.baseline,after:a,reason:j.reason,created_at:j.created_at,sources:parse(j.sources_json),status:Number(latest.get(journalKey(j)).id)!==Number(j.id)?'superseded':valid?'applied':'stale'};
 });
 const summary={count:rows.length,applied:0,stale:0,superseded:0,revenue_delta:0,commission_delta:0,conditional_profit_delta:0};
 for(const r of rows){summary[r.status]++;if(r.status==='applied'){summary.revenue_delta=round(summary.revenue_delta+r.after.net_revenue-r.before.revenue);summary.commission_delta=round(summary.commission_delta+r.after.commission_fee-r.before.commission);summary.conditional_profit_delta=round(summary.conditional_profit_delta+r.after.net_profit_cny-r.before.profit);}}
 const keyword=String(input.keyword||'').trim().toLowerCase(),filtered=rows.filter(r=>!keyword||[r.id,r.posting_number,r.sku].some(v=>String(v).toLowerCase().includes(keyword))),page=Math.max(1,Math.floor(Number(input.page)||1)),pageSize=50;
 return {summary,rows:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,page_size:pageSize,from:scope.from,to:scope.to};
}
