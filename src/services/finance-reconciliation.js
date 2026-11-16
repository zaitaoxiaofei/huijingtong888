import crypto from 'node:crypto';
import { validateMonth } from './finance-document-parser.js';

import { FINANCE_CALIBRATION_SCHEMA } from './finance-reconciliation-schema.js';
export { FINANCE_CALIBRATION_SCHEMA };
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const round=x=>Math.round((Number(x)+Number.EPSILON)*100)/100;
const json=x=>typeof x==='string'?JSON.parse(x):x;
const components=['sold','returned','partner','partner_returned','bonus','bonus_returned','sold_quantity','returned_quantity','standard_fee','standard_fee_returned'];
const total=(rows,key)=>round(rows.reduce((n,r)=>n+Number(r[key]),0));
const evidence=d=>({document_id:Number(d.id),original_name:d.original_name,attachment_url:d.attachment_url,sha256:d.sha256});
const net=r=>round(r.sold-r.returned+r.partner-r.partner_returned);
const officialTarget=r=>({sales:r.sold,refunds:r.returned,partner:r.partner,partner_refunds:r.partner_returned,net_revenue:net(r),commission_reduction:round(r.bonus-r.bonus_returned),commission_fee:round(r.standard_fee-r.standard_fee_returned-r.bonus+r.bonus_returned),business_outcome:r.returned_quantity>0?(r.returned_quantity>=r.sold_quantity?'refunded':'partial_refund'):'sale',currency:'CNY'});

// One document can have several legitimate lines for the same shipment/SKU.
// Aggregate within a document, then compare overlapping documents; never sum two exports blindly.
export function reconcileFinanceOrders({documents,items,history=[],month}){
 const docs=documents.filter(d=>d.parse_status==='confirmed'&&d.month_key===month),groups=new Map(),duplicates=[],conflicts=[];
 for(const d of docs){const p=json(d.payload_json);if(p.kind!=='order-sales')continue;
  const local=new Map();for(const r of p.order_rows){const key=hash([r.posting_number,r.sku]);let g=local.get(key);if(!g){g={posting_number:r.posting_number,sku:r.sku,...Object.fromEntries(components.map(k=>[k,0])),sources:[{...evidence(d),rows:[]}]};local.set(key,g);}for(const k of components)g[k]=round(g[k]+r[k]);g.sources[0].rows.push(r.row_number);}
  for(const [key,g]of local){const old=groups.get(key);if(!old){groups.set(key,g);continue;}const same=components.every(k=>old[k]===g[k]);old.sources.push(...g.sources);if(same)duplicates.push({key,sources:g.sources});else{old.conflict=true;conflicts.push({key,posting_number:g.posting_number,sku:g.sku,sources:old.sources,note:'同月份同货件/SKU的逐单报告金额冲突，请核对原件，不自动选择版本'});}}
 }
 const monthly=docs.filter(d=>json(d.payload_json).kind==='sales'),controls=[];
 const official=[...groups.values()];
 for(const d of monthly){const facts=json(d.payload_json).facts;for(const [metric,value]of [['已确认商品销售额',total(official,'sold')],['销售退回冲减额',total(official,'returned')],['合作伙伴补贴收入',round(total(official,'partner')-total(official,'partner_returned'))]]){const f=facts.find(f=>f.metric===metric);controls.push({metric,detail_amount:official.length?value:null,monthly_amount:f?.amount??null,difference:official.length&&f?round(value-f.amount):null,sources:[evidence(d),...docs.filter(d=>json(d.payload_json).kind==='order-sales').map(evidence)]});}}
 const commissionDocs=docs.filter(d=>(json(d.payload_json).facts||[]).some(f=>f.metric==='佣金'&&f.currency==='CNY'));
 if(commissionDocs.length){const amount=round(commissionDocs.reduce((s,d)=>s+json(d.payload_json).facts.filter(f=>f.metric==='佣金'&&f.currency==='CNY').reduce((n,f)=>n+f.amount,0),0));const detailed=round(total(official,'standard_fee')-total(official,'standard_fee_returned')-total(official,'bonus')+total(official,'bonus_returned'));controls.push({metric:'佣金（扣退佣及减免）',detail_amount:official.length?detailed:null,monthly_amount:amount,difference:official.length?round(detailed-amount):null,sources:[...commissionDocs.map(evidence),...docs.filter(d=>json(d.payload_json).kind==='order-sales').map(evidence)]});}
 const controlsOK=official.length>0&&monthly.length>0&&controls.length>0&&controls.every(c=>c.difference===0)&&!conflicts.length;
 const internal=new Map();for(const item of items){const key=hash([item.posting_number,String(item.ozon_sku)]);const list=internal.get(key)||[];list.push(item);internal.set(key,list);}
 const latest=new Map();for(const h of history)if(!latest.has(h.row_key)||Number(latest.get(h.row_key).id)<Number(h.id))latest.set(h.row_key,h);
 const rows=[];for(const [key,g]of groups){const found=internal.get(key)||[],orderIds=[...new Set(found.map(i=>Number(i.order_id)))];const ambiguous=orderIds.length>1;
  const baseline=found.length?{order_ids:orderIds,item_ids:found.map(i=>Number(i.item_id)).sort((a,b)=>a-b),revenue:round(found.reduce((s,i)=>s+Number(i.sale_amount_cny??(Number(i.sale_price)*Number(i.quantity))),0)),status:found.map(i=>[Number(i.item_id),i.order_status,i.settlement_state,i.profit_status||null]),commission:found.every(i=>i.commission_fee_cny!=null||i.estimated_commission!=null)?round(found.reduce((s,i)=>s+Number(i.commission_fee_cny??i.estimated_commission),0)):null,purchase_cost_known:found.every(i=>Number(i.purchase_cost_cny??(Number(i.frozen_purchase_cost)*Number(i.quantity)))>0)}:null;
  const previous=latest.get(key),target=officialTarget(g),already=previous?json(previous.after_json):null;
  const baselineHash=hash(baseline);const sourceHash=hash(g.sources.map(s=>[s.document_id,s.sha256,s.rows]));const token=hash([month,key,baselineHash,sourceHash,target,previous?.id||null]);
  const current=already||baseline&&{net_revenue:baseline.revenue,business_outcome:'待按官方销售核对'};
  const stale=Boolean(previous&&(json(previous.before_json).baseline_hash!==baselineHash||hash(already)!==hash(target)));
  const needsChange=!already||hash(already)!==hash(target)||stale;
  const issues=[];if(!found.length)issues.push('内部订单或SKU未匹配');if(ambiguous)issues.push('货件号对应多个内部订单，须先核对');if(g.conflict)issues.push('逐单原件冲突');if(!baseline?.purchase_cost_known)issues.push('采购成本/已售成本待核，利润未核定');if(g.returned_quantity>0)issues.push('退款已列，实物是否回库存仍待核');if(stale)issues.push('原订单或官方金额已变化，需要重新预览');
  rows.push({key,posting_number:g.posting_number,sku:g.sku,official:g,target,baseline,current,effective:already,previous_adjustment_id:previous?.id||null,token,stale,difference:baseline?round(target.net_revenue-baseline.revenue):null,commission_difference:baseline?.commission!=null?round(target.commission_fee-baseline.commission):null,issues,sources:g.sources,can_adjust:controlsOK&&found.length>0&&!ambiguous&&!g.conflict&&needsChange,needs_change:needsChange,status:g.conflict?'conflict':!found.length?'unmatched':already&&!stale?'calibrated':'pending'});
 }
 const unmatchedInternal=[];for(const [key,found]of internal){if(groups.has(key))continue;const ordered=found.some(i=>String(i.ordered_month)===month);if(ordered)unmatchedInternal.push({posting_number:found[0].posting_number,sku:String(found[0].ozon_sku),note:'本月下单但未在本月逐单销售报告找到；可能跨月/未成交，不能补零',order_ids:[...new Set(found.map(i=>Number(i.order_id)))],sources:monthly.map(evidence)});}
 const gaps=[];if(official.length&&!commissionDocs.length)gaps.push({code:'commission-voucher',message:'佣金费用凭证尚未提供；逐单报告所列金额可核对，费用凭证仍待补，不据此认定最终利润',sources:docs.filter(d=>json(d.payload_json).kind==='order-sales').map(evidence)});if(!official.length)gaps.push({code:'order_sales',message:'缺少本店本月官方逐单销售报告，SKU汇总月报不能代替逐单匹配',sources:monthly.map(evidence)});if(!monthly.length)gaps.push({code:'monthly_sales',message:'缺少本店本月销售月报，用于核对逐单金额总额',sources:docs.filter(d=>json(d.payload_json).kind==='order-sales').map(evidence)});if(controls.some(c=>c.difference!==0))gaps.push({code:'control',message:'逐单明细与月报尚未核对一致，暂不能确认调整',sources:controls.flatMap(c=>c.sources)});if(conflicts.length)gaps.push({code:'conflict',message:'重叠逐单报告冲突，请核对并处理原件',sources:conflicts.flatMap(c=>c.sources)});
 return {month,rows,controls,duplicates,conflicts,gaps,unmatched_internal:unmatchedInternal,history,summary:{official_orders:new Set(official.map(r=>r.posting_number)).size,official_rows:official.length,matched_rows:rows.filter(r=>r.baseline).length,unmatched_rows:rows.filter(r=>!r.baseline).length,adjusted_rows:rows.filter(r=>r.effective).length,sales:official.length?total(official,'sold'):null,refunds:official.length?total(official,'returned'):null,net_partner:official.length?round(total(official,'partner')-total(official,'partner_returned')):null,net_revenue:official.length?round(total(official,'sold')-total(official,'returned')+total(official,'partner')-total(official,'partner_returned')):null,commission:official.length?round(total(official,'standard_fee')-total(official,'standard_fee_returned')-total(official,'bonus')+total(official,'bonus_returned')):null,complete_controls:controlsOK,final_profit:null},note:'校准确认更新本公司的逐单对账账簿；原始订单、冻结利润和历史公式不改写。缺费用与库存衔接时利润仍未核定。'};
}

export function createFinanceReconciliation({query,execute,getDocs,shopsFor,writePeriod}){
 let schema;
 const ready=()=>schema||=(execute(FINANCE_CALIBRATION_SCHEMA).catch(e=>{schema=null;throw e;}));
 async function context(input,ctx){const month=validateMonth(input.month),shop=Number(input.shop_id);if(!Number.isSafeInteger(shop)||shop<=0)fail('请选择实际店铺（shop_id），公司共用流水请在结算与回款中查看');const shops=await shopsFor(ctx,{from:month,to:month});if(!shops.some(s=>Number(s.id)===shop))fail('所选店铺在该月不属于当前公司',403);await ready();return {month,shop};}
 async function read(input,ctx,reader=query,lock=false){
  const {month,shop}=await context(input,ctx);const documents=(await getDocs(ctx,{from:month,to:month},reader,lock)).filter(d=>Number(d.shop_key)===shop);
  const postings=[...new Set(documents.flatMap(d=>json(d.payload_json).order_rows||[]).map(r=>r.posting_number))];if(postings.length>20000)fail('单月货件超过20000，请拆分对账');
  const start=new Date(`${month}-01T00:00:00+08:00`),end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1)-8*3600000);
  const params=[shop,ctx.tenantId,Number(ctx.s.tenant.slug==='default'),start,end,...postings];
  const items=await reader(`SELECT o.id order_id,o.posting_number,o.status order_status,
   DATE_FORMAT(CONVERT_TZ(o.ordered_at,'+00:00','+08:00'),'%Y-%m') ordered_month,
   oi.id item_id,oi.ozon_sku,oi.quantity,oi.sale_price,oi.settlement_state,oi.frozen_purchase_cost,oi.estimated_commission,
   opi.sale_amount_cny,opi.profit_status,opi.purchase_cost_cny,opi.commission_fee_cny
   FROM orders o JOIN shops s ON s.id=o.shop_id JOIN order_items oi ON oi.order_id=o.id LEFT JOIN order_profit_items opi ON opi.order_item_id=oi.id
   WHERE o.shop_id=? AND (s.tenant_id=? OR (?=1 AND s.tenant_id IS NULL)) AND ((o.ordered_at>=? AND o.ordered_at<?)${postings.length?` OR o.posting_number IN (${postings.map(()=>'?').join(',')})`:''}) ORDER BY o.id,oi.id LIMIT 30001${lock?' FOR UPDATE':''}`,params);
  if(items.length>30000)fail('单月内部商品行超过30000，请缩小核对范围');
  const history=await reader(`SELECT * FROM finance_reconciliation_adjustments WHERE tenant_id=? AND company_id=? AND shop_id=? AND month_key=? ORDER BY id DESC`,[ctx.tenantId,ctx.companyId,shop,month]);
  return {...reconcileFinanceOrders({documents,items,history,month}),company_id:ctx.companyId,shop_id:shop};
 }
 return {report:read,
  async history(ctx,period){await ready();return query('SELECT * FROM finance_reconciliation_adjustments WHERE tenant_id=? AND company_id=? AND month_key>=? AND month_key<=? ORDER BY id',[ctx.tenantId,ctx.companyId,period.from,period.to]);},
  async preview(input,ctx){const report=await read(input,ctx);const keys=input.row_keys;if(!Array.isArray(keys)||!keys.length||keys.length>200||new Set(keys).size!==keys.length)fail('请选择1—200条不同的对账明细');const rows=keys.map(k=>report.rows.find(r=>r.key===k));if(rows.some(r=>!r||!r.can_adjust))fail('所选明细有原件冲突、控制差额、未匹配或已校准项，请先处理后重新预览',409);return {rows,note:report.note};},
  async confirm(input,ctx){
   const {month,shop}=await context(input,ctx);const reason=String(input.reason||'').trim();if(input.acknowledge!==true||reason.length<4||reason.length>1000)fail('请填写4—1000字调整依据，并勾选确认调整对账账簿');
   if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>200||input.rows.some(r=>!/^([a-f0-9]{64})$/.test(r.key||'')||!/^([a-f0-9]{64})$/.test(r.token||''))||new Set(input.rows.map(r=>r.key)).size!==input.rows.length)fail('校准预览标识无效，请重新预览');
   return writePeriod(ctx,month,async db=>{
    const result=await read(input,ctx,db.query,true),ids=[];let reused=0;
    for(const selected of input.rows){
     const existing=result.history.find(h=>h.row_key===selected.key&&h.confirmation_key===selected.token);if(existing){ids.push(Number(existing.id));reused++;continue;}
     const row=result.rows.find(r=>r.key===selected.key);if(!row||!row.can_adjust||row.token!==selected.token)fail('订单、原件或调整记录已变化，请刷新并重新预览，未写入任何调整',409);
     const before={baseline:row.baseline,baseline_hash:hash(row.baseline),effective:row.effective};
     const saved=await db.execute(`INSERT INTO finance_reconciliation_adjustments (tenant_id,company_id,shop_id,month_key,row_key,confirmation_key,previous_id,posting_number,sku,before_json,after_json,sources_json,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[ctx.tenantId,ctx.companyId,shop,month,row.key,row.token,row.previous_adjustment_id,row.posting_number,row.sku,JSON.stringify(before),JSON.stringify(row.target),JSON.stringify(row.sources),reason,ctx.s.personId]);ids.push(Number(saved.insertId));
    }
    return {ok:true,adjustment_ids:ids,reused,note:'已确认对账调整并保存原值及来源，未覆盖订单冻结利润'};
   });
  }
 };
}
