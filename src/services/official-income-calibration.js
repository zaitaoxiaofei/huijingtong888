import crypto from 'node:crypto';
import {reconcileFinanceOrders,FINANCE_CALIBRATION_SCHEMA} from './finance-reconciliation.js';
import {OFFICIAL_INCOME_POLICY,officialIncomeIdentity,officialIncomeReturns} from './billing-approved-h1.js';
import {validateMonth} from './finance-document-parser.js';
const parse=x=>typeof x==='string'?JSON.parse(x):x;
const round=x=>Math.round((Number(x)+Number.EPSILON)*100)/100;
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(message,statusCode=409)=>{throw Object.assign(new Error(message),{statusCode});};

export function officialIncomePreview({documents,orders,companyTax,reportPriority=false}){
 const docs=documents.filter(d=>['preview','confirmed'].includes(d.parse_status));
 const months=[...new Set(docs.filter(d=>parse(d.payload_json).kind==='order-sales').map(d=>d.month_key))].sort();
 const official=new Map(),controls=[];
 for(const month of months){
  const selected=docs.filter(d=>d.month_key===month),sources=selected.filter(d=>parse(d.payload_json).kind==='order-sales');
  const identity=Boolean(companyTax)&&sources.every(d=>{const p=parse(d.payload_json);return p.currency==='CNY'&&p.buyer_tax_number===companyTax&&p.month===month;});
  const report=reconcileFinanceOrders({documents:selected.map(d=>({...d,parse_status:'confirmed'})),items:[],month});
  const sales=report.controls.filter(c=>c.metric!=='佣金（扣退佣及减免）'),commission=report.controls.filter(c=>c.metric==='佣金（扣退佣及减免）');
  const salesOK=identity&&sales.length>=3&&sales.every(c=>c.difference===0)&&!report.conflicts.length;
  const commissionOK=commission.length>0&&commission.every(c=>c.difference===0);
  controls.push({month,sales_ok:salesOK,commission_ok:commissionOK,controls:report.controls});
  for(const r of report.rows){
   const key=JSON.stringify([r.posting_number,r.sku]);let g=official.get(key);
   if(!g){g={revenue:0,commission:0,sold:0,returned:0,sources:[],holds:[],notes:[]};official.set(key,g);}
   g.revenue=round(g.revenue+r.target.net_revenue);g.commission=round(g.commission+r.target.commission_fee);g.sold+=r.official.sold_quantity;g.returned+=r.official.returned_quantity;
   g.sources.push(...r.sources.map(s=>({...s,month})));
   if(!salesOK)g.holds.push(`${month}销售原件身份、月报控制或重叠原件待核`);
   if(!commissionOK)(reportPriority?g.notes:g.holds).push(`${month}佣金凭证与逐单合计待核`);
  }
 }
 const rows=[];
 for(const order of orders){
  const groups=new Map();for(const item of order.items){const sku=String(item.ozon_sku),list=groups.get(sku)||[];list.push(item);groups.set(sku,list);}
  for(const [sku,items]of groups){
   const g=official.get(JSON.stringify([order.posting_number,sku])),holds=[...(g?.holds||[])];
   const before={revenue:round(items.reduce((n,i)=>n+Number(i.sales_revenue),0)),commission:round(items.reduce((n,i)=>n+Number(i.costs.commission_fee),0))};
   const quantity=items.reduce((n,i)=>n+Number(i.quantity),0);
   if(!g)holds.push('缺少对应货件/SKU的官方逐单原件，不把未知收入或佣金补0');
   if(g&&(g.sold!==quantity||g.returned>g.sold))holds.push('订单数量与官方累计成交数量待核，请先核对商品行或部分成交');
   if(g&&items.some(i=>i.official_return_flag)&&g.returned===0)holds.push('已有售后记录，但现有报告尚未列退款，暂不恢复已处置收入');
   const baseline=items.map(i=>i.adjustment_baseline);
   if(baseline.some(i=>!i))holds.push('缺少原账保护快照，请重新读取订单');
   const key=hash([order.shop_id,order.month_key,order.posting_number,sku]);
   const original={item_ids:items.map(i=>Number(i.order_item_id)),revenue:round(items.reduce((n,i)=>n+Number(i.saved_sale??Number(i.sale_price)*Number(i.quantity)),0)),commission:round(items.reduce((n,i)=>n+Number(i.saved_commission??i.commission_fee),0))};
   const target=g?{policy:OFFICIAL_INCOME_POLICY,currency:'CNY',net_revenue:g.revenue,commission_fee:g.commission,scope:'income_and_commission_only_other_costs_frozen',fx_policy:'official_contract_cny_no_reconversion',business_outcome:g.returned?'refund_net':'sale',report_priority:reportPriority}:null;
   const protectedCosts=items.map(i=>[Number(i.order_item_id),Object.fromEntries(Object.entries(i.costs).filter(([k])=>k!=='commission_fee').sort(([a],[b])=>a.localeCompare(b)))]);
   const prior=(order.approved_adjustments||[]).filter(a=>a.sku===sku).map(a=>[a.id,a.status]);
   const fingerprint=hash(baseline),protection=hash(protectedCosts),identity=officialIncomeIdentity(items),returns=officialIncomeReturns(items),token=hash([key,before,target,g?.sources||[],holds,g?.notes||[],fingerprint,protection,identity,returns,prior]);
   const changed=Boolean(target&&(before.revenue!==target.net_revenue||before.commission!==target.commission_fee));
   rows.push({key,token,order_id:order.id,shop_id:order.shop_id,month:order.month_key,posting_number:order.posting_number,sku,item_ids:original.item_ids,before,original_before:original,target,sources:g?.sources||[],holds:[...new Set(holds)],notes:[...new Set(g?.notes||[])],changed,can_adjust:changed&&!holds.length,baseline_fingerprint:fingerprint,protected_cost_fingerprint:protection,identity_fingerprint:identity,return_fingerprint:returns,previous_adjustment_id:prior.length?Math.max(...prior.map(a=>Number(a[0]))):null});
  }
 }
 return {rows,controls,note:'官方合同CNY收入、退货和净佣金配套核对；只追加调整，原账、旧汇率、采购成本和其他费用保留。下单月与原件报告月份分别保留。'};
}

export function createOfficialIncomeCalibration({query,execute,getDocs,shopsFor,writePeriod,readProjection}){
 let ready;
 async function scope(input,ctx){
  const month=validateMonth(input.month),shop=Number(input.shop_id);
  if(Number(ctx.tenantId)!==1||Number(ctx.companyId)!==1||![4,5,6].includes(shop))fail('当前官方收入校准仅开放上海主体已核验的Mart、S、X店铺',403);
  if(!(await shopsFor(ctx,{from:month,to:month})).some(s=>Number(s.id)===shop))fail('店铺在所选下单月份不属于当前公司',403);
  const ids=input.item_ids;
  if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(i=>!Number.isSafeInteger(Number(i))||Number(i)<=0)||new Set(ids.map(Number)).size!==ids.length)fail('请选择1—200个不同的订单商品行（item_ids），再读取官方收入预览',400);
  ready||=execute(FINANCE_CALIBRATION_SCHEMA).catch(e=>{ready=null;throw e;});await ready;
  return {month,shop,ids:ids.map(Number)};
 }
 async function read(input,ctx,reader=query,lock=false){
  const {month,shop,ids}=await scope(input,ctx);
  const owned=await reader(`SELECT oi.id,o.id order_id FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id WHERE oi.id IN (${ids.map(()=>'?').join(',')}) AND o.shop_id=? AND (s.tenant_id=? OR (?=1 AND s.tenant_id IS NULL)) AND DATE_FORMAT(CONVERT_TZ(o.ordered_at,'+00:00','+08:00'),'%Y-%m')=?${lock?' FOR UPDATE':''}`,[...ids,shop,ctx.tenantId,Number(ctx.s.tenant.slug==='default'),month]);
  if(owned.length!==ids.length)fail('商品行不属于本公司所选店铺和下单月份，请重新选择',403);
  const orderIds=[...new Set(owned.map(i=>Number(i.order_id)))];
  if(lock){
   const assignments=await reader(`SELECT shop_id FROM finance_shop_company_assignments WHERE company_id=? AND shop_id=? AND (tenant_id=? OR (?=1 AND tenant_id IS NULL)) AND effective_from<=LAST_DAY(CONCAT(?,'-01')) AND (effective_to IS NULL OR effective_to>=CONCAT(?,'-01')) FOR SHARE`,[ctx.companyId,shop,ctx.tenantId,Number(ctx.s.tenant.slug==='default'),month,month]);
   if(!assignments.length)fail('公司店铺归属已变化，请重新读取校准范围',403);
   await reader(`SELECT oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN order_profit_items p ON p.order_item_id=oi.id WHERE o.id IN (${orderIds.map(()=>'?').join(',')}) FOR UPDATE`,orderIds);
   await reader(`SELECT order_id FROM ozon_return_observations WHERE tenant_id=? AND shop_id=? AND order_id IN (${orderIds.map(()=>'?').join(',')}) FOR SHARE`,[ctx.tenantId,shop,...orderIds]);
   const numbers=await reader(`SELECT posting_number,order_number FROM orders WHERE id IN (${orderIds.map(()=>'?').join(',')})`,orderIds);
   const postings=[...new Set(numbers.flatMap(o=>[o.posting_number,o.order_number||o.posting_number.replace(/-[^-]+$/,'')]))];
   await reader(`SELECT id FROM ozon_finance_items WHERE shop_id=? AND posting_number IN (${postings.map(()=>'?').join(',')}) FOR SHARE`,[shop,...postings]);
  }
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
  const to=parts.year+'-'+parts.month;
  const documents=(await getDocs(ctx,{from:month,to},reader,lock)).filter(d=>Number(d.shop_key)===shop);
  const history=await reader(`SELECT * FROM finance_reconciliation_adjustments WHERE tenant_id=? AND company_id=? AND shop_id=? AND month_key=? ORDER BY id${lock?' FOR UPDATE':''}`,[ctx.tenantId,ctx.companyId,shop,month]);
  const last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
  const orders=await readProjection({from:month+'-01',to:last,shopId:shop,tenantId:ctx.tenantId,defaultTenant:ctx.s.tenant.slug==='default',companyId:ctx.companyId,orderIds},reader);
  const result=officialIncomePreview({documents,orders,companyTax:ctx.c.tax_number,reportPriority:input.official_report_priority===true});
  const selected=new Set(ids);result.rows=result.rows.filter(r=>r.item_ids.some(i=>selected.has(i)));
  return {...result,history};
 }
 return {
  preview:read,
  async confirm(input,ctx){
   const {month,shop}=await scope(input,ctx),reason=String(input.reason||'').trim();
   if(input.acknowledge!==true||reason.length<4||reason.length>1000)fail('请确认按官方报告配对调整，并填写4—1000字调整依据',400);
   if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>200||new Set(input.rows.map(r=>r.key)).size!==input.rows.length||input.rows.some(r=>!/^([a-f0-9]{64})$/.test(r.key||'')||!/^([a-f0-9]{64})$/.test(r.token||'')))fail('预览标识无效，请重新预览',400);
   return writePeriod(ctx,month,async db=>{
    const report=await read(input,ctx,db.query,true),ids=[];let reused=0;
    for(const entry of input.rows){
     const prior=report.history.find(r=>r.row_key===entry.key&&r.confirmation_key===entry.token);
     if(prior){ids.push(Number(prior.id));reused++;continue;}
     const row=report.rows.find(r=>r.key===entry.key);
     if(!row?.can_adjust||row.token!==entry.token)fail('原账、有效金额、原件或待核状态已变化，未追加任何调整；请重新预览');
     const before={baseline:row.original_before,effective:row.before,baseline_fingerprint:row.baseline_fingerprint,protected_cost_fingerprint:row.protected_cost_fingerprint,identity_fingerprint:row.identity_fingerprint,return_fingerprint:row.return_fingerprint};
     const saved=await db.execute(`INSERT INTO finance_reconciliation_adjustments (tenant_id,company_id,shop_id,month_key,row_key,confirmation_key,previous_id,posting_number,sku,before_json,after_json,sources_json,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,[ctx.tenantId,ctx.companyId,shop,month,row.key,row.token,row.previous_adjustment_id,row.posting_number,row.sku,JSON.stringify(before),JSON.stringify(row.target),JSON.stringify(row.sources),reason,ctx.s.personId]);
     ids.push(Number(saved.insertId));
    }
    return {ok:true,adjustment_ids:ids,reused,note:report.note};
   });
  }
 };
}
