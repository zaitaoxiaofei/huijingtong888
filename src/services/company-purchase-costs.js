import {reconcileFinanceOrders} from './finance-reconciliation.js';
import {financeDocumentLocation} from '../shared/finance-document-locations.js';
const payload=d=>typeof d.payload_json==='string'?JSON.parse(d.payload_json):d.payload_json||{};
const cents=n=>Math.round(Number(n)*100);
const key=(shop,posting,sku)=>JSON.stringify([Number(shop),String(posting),String(sku)]);
const active=d=>['confirmed','preview'].includes(d.parse_status);
const metric='已售商品采购成本';
export function purchaseCostGroups(documents,period){
 const groups=new Map();for(const doc of documents){if(!active(doc)||doc.month_key<period.from||doc.month_key>period.to||!['sales','order-sales'].includes(payload(doc).kind))continue;const id=doc.shop_key+':'+doc.month_key,g=groups.get(id)||{shop_id:Number(doc.shop_key),month:doc.month_key,documents:[]};g.documents.push(doc);groups.set(id,g);}return [...groups.values()];
}
export function buildCompanyPurchaseCosts({documents,items,period,confirmedOnly=false}){
 const selected=documents.filter(d=>!confirmedOnly||d.parse_status==='confirmed');const earliest=selected.reduce((m,d)=>d.month_key<m?d.month_key:m,period.from);const groups=purchaseCostGroups(selected,{from:earliest,to:period.to}).sort((a,b)=>a.month.localeCompare(b.month)||a.shop_id-b.shop_id),lines=[],issues=[],pending_sources=[];const allocatedQuantities=new Map();
 const internal=new Map();for(const i of items){const k=key(i.shop_id,i.posting_number,i.ozon_sku),a=internal.get(k)||[];a.push(i);internal.set(k,a);}
 const matchedGroups=groups.map(g=>({...g,reconciliation:reconcileFinanceOrders({documents:g.documents.map(d=>({...d,parse_status:'confirmed'})),items:items.filter(i=>Number(i.shop_id)===g.shop_id),month:g.month})}));
 const quantities=new Map();for(const g of matchedGroups)for(const r of g.reconciliation.rows){const k=key(g.shop_id,r.posting_number,r.sku);quantities.set(k,(quantities.get(k)||0)+r.official.sold_quantity);}
 for(const g of matchedGroups){
  const visible=g.month>=period.from;
  const {reconciliation:r}=g,orderDocs=g.documents.filter(d=>payload(d).kind==='order-sales'),monthly=g.documents.filter(d=>payload(d).kind==='sales');
  const base={metric,currency:'CNY',month:g.month,shop_id:g.shop_id,source_type:'purchase-cost',parse_status:confirmedOnly?'confirmed':'calculated',review_status:'pending',linked_evidence:[],cost_basis:'official-sales-month',source_location:{path:'ERP > 订单处理 > 订单历史采购成本',recorded:true,method:'历史成本记录'}};
  const gap=(code,message,extra={})=>{if(!visible)return;issues.push({code,message,shop_id:g.shop_id,month:g.month,...extra});lines.push({...base,amount:null,source:message,amount_status:'missing',...extra});};
  if(!orderDocs.length){if(visible)pending_sources.push({shop_id:g.shop_id,month:g.month});gap('missing-order-report','缺少官方逐单销售凭证，请同步成本来源或上传逐单JSON',{linked_evidence:monthly.map(d=>({document_id:Number(d.id),original_name:d.original_name,display_name:d.original_name,attachment_url:d.attachment_url,source_location:financeDocumentLocation(d)}))});continue;}
  // Costs follow the report's sales cohort, never the order creation month.
  if(monthly.length&&r.controls.some(c=>!c.metric.startsWith('佣金')&&c.monthly_amount!=null&&c.difference!==0)){gap('sales-control-mismatch','逐单报告与销售月报金额不一致，请先核对原件',{linked_evidence:r.controls.flatMap(c=>c.sources)});continue;}
  for(const row of r.rows){
   const found=(internal.get(key(g.shop_id,row.posting_number,row.sku))||[]).filter(i=>!i.authorized_months||i.authorized_months.includes(g.month)),extra={posting_number:row.posting_number,sku:row.sku,sold_quantity:row.official.sold_quantity,returned_quantity:row.official.returned_quantity,document_id:row.sources[0]?.document_id,original_name:row.sources[0]?.original_name,attachment_url:row.sources[0]?.attachment_url,linked_evidence:row.sources.map(s=>({...s,display_name:s.original_name,source_location:financeDocumentLocation(g.documents.find(d=>Number(d.id)===s.document_id))})),item_ids:found.map(i=>Number(i.item_id))};
   if(row.status==='conflict'){gap('conflicting-order-report','逐单报告存在冲突，不重复计入成本',extra);continue;}
   // Refunds alone do not prove physical goods returned to stock. Do not reverse COGS automatically.
   if(row.official.sold_quantity===0){if(visible)lines.push({...base,...extra,amount:0,source:'仅退款记录；采购成本留在原销售月份，不自动冲回库存',amount_status:'calculated',inventory_reversal:'not_assumed'});continue;}
   if(!found.length){gap('unmatched-order','官方货件/SKU未匹配ERP订单',extra);continue;}
   if(new Set(found.map(i=>Number(i.order_id))).size!==1){gap('ambiguous-order','同货件/SKU匹配多个ERP订单，请核对归属',extra);continue;}
   let totalQuantity=0,totalCents=0,missing=false;const origins=[];
   for(const item of found){const q=Number(item.quantity);const stored=item.purchase_cost_cny!=null&&Number(item.purchase_cost_cny)>0?Number(item.purchase_cost_cny):null;
    const frozen=item.frozen_purchase_cost!=null&&Number(item.frozen_purchase_cost)>0?Number(item.frozen_purchase_cost):null;
    if(!Number.isSafeInteger(q)||q<=0||stored==null&&frozen==null||stored!=null&&!Number.isFinite(stored)||frozen!=null&&!Number.isFinite(frozen)){missing=true;break;}
    totalQuantity+=q;totalCents+=cents(stored??frozen*q);origins.push({item_id:Number(item.item_id),quantity:q,amount_cny:(stored!=null?cents(stored):cents(frozen*q))/100,source:stored!=null?'order_profit_items.purchase_cost_cny':'order_items.frozen_purchase_cost'});
   }
   if(missing){gap('missing-historical-cost','订单未保存有效历史采购成本；不使用当前商品价格补算',extra);continue;}
   if(quantities.get(key(g.shop_id,row.posting_number,row.sku))>totalQuantity){gap('quantity-exceeds-order','该货件/SKU跨报告销售数量超过订单数量，请核对重复或更正报告',extra);continue;}
   const allocationKey=key(g.shop_id,row.posting_number,row.sku),previousQuantity=allocatedQuantities.get(allocationKey)||0,nextQuantity=previousQuantity+row.official.sold_quantity;allocatedQuantities.set(allocationKey,nextQuantity);
   const amount=(Math.round(totalCents*nextQuantity/totalQuantity)-Math.round(totalCents*previousQuantity/totalQuantity))/100;
   if(visible)lines.push({...base,...extra,amount,cost_origins:origins,amount_status:'calculated',source:`货件 ${row.posting_number} · SKU ${row.sku} · 销售 ${row.official.sold_quantity} 件；按订单历史成本分摊`,inventory_reversal:row.official.returned_quantity?'not_assumed':null});
  }
 }
 const known=lines.filter(l=>l.amount!=null);return {lines,issues,pending_sources,known_amount_cny:known.reduce((n,l)=>n+cents(l.amount),0)/100,complete:lines.length>0&&!issues.length,matched_rows:known.length};
}
export async function readCompanyPurchaseCosts({query,documents,ctx,period}){
 let reportDocs=documents.filter(d=>active(d)&&payload(d).kind==='order-sales'&&d.month_key>=period.from&&d.month_key<=period.to),byShop=new Map();
 let allDocuments=documents;
 if(reportDocs.length){const history=await query("SELECT * FROM finance_import_documents WHERE tenant_id=? AND company_id=? AND month_key<? AND parse_status IN ('confirmed','preview') AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.kind'))='order-sales' ORDER BY month_key,id",[ctx.tenantId,ctx.companyId,period.from]);allDocuments=[...history,...documents];reportDocs=allDocuments.filter(d=>active(d)&&payload(d).kind==='order-sales'&&d.month_key<=period.to);}
 const assignments=reportDocs.length?await query("SELECT shop_id,DATE_FORMAT(effective_from,'%Y-%m-%d') effective_from,DATE_FORMAT(effective_to,'%Y-%m-%d') effective_to FROM finance_shop_company_assignments WHERE company_id=? AND (tenant_id=? OR (?=1 AND tenant_id IS NULL))",[ctx.companyId,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0]):[];
 for(const d of reportDocs){const set=byShop.get(Number(d.shop_key))||new Set();for(const r of payload(d).order_rows||[])set.add(String(r.posting_number));byShop.set(Number(d.shop_key),set);}
 const items=[];for(const [shop,set]of byShop){const postings=[...set];if(postings.length>60000)throw Object.assign(new Error('采购成本匹配超过60000个货件，请按季度或月份查看'),{statusCode:400});for(let i=0;i<postings.length;i+=500){const batch=postings.slice(i,i+500);
 items.push(...await query(`SELECT o.id order_id,o.shop_id,o.posting_number,oi.id item_id,oi.ozon_sku,oi.quantity,oi.frozen_purchase_cost,opi.purchase_cost_cny
 FROM orders o JOIN shops s ON s.id=o.shop_id JOIN order_items oi ON oi.order_id=o.id LEFT JOIN order_profit_items opi ON opi.order_item_id=oi.id
 WHERE o.shop_id=? AND (s.tenant_id=? OR (?=1 AND s.tenant_id IS NULL)) AND o.posting_number IN (${batch.map(()=>'?').join(',')})
 AND EXISTS(SELECT 1 FROM finance_shop_company_assignments a WHERE a.shop_id=o.shop_id AND a.company_id=? AND (a.tenant_id=? OR (?=1 AND a.tenant_id IS NULL)) AND a.effective_from<=LAST_DAY(CONCAT(?,'-01')) AND (a.effective_to IS NULL OR a.effective_to>=CONCAT(?,'-01'))) ORDER BY o.id,oi.id`,[shop,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0,...batch,ctx.companyId,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0,period.to,period.from]));}}
 for(const item of items)item.authorized_months=[...new Set(reportDocs.filter(d=>Number(d.shop_key)===Number(item.shop_id)&&assignments.some(a=>Number(a.shop_id)===Number(item.shop_id)&&a.effective_from<=d.month_key+'-31'&&(!a.effective_to||a.effective_to>=d.month_key+'-01'))).map(d=>d.month_key))];
 return {reference:buildCompanyPurchaseCosts({documents:allDocuments,items,period}),confirmed:buildCompanyPurchaseCosts({documents:allDocuments,items,period,confirmedOnly:true})};
}
export function summarizePurchaseCostLines(lines){
 const groups=new Map();for(const l of lines){const k=l.shop_id+':'+l.month,g=groups.get(k)||{...l,amount:0,known_amount_cny:0,cost_row_count:0,missing_count:0,linked_evidence:[],cost_origins:undefined,item_ids:undefined,posting_number:undefined,sku:undefined,sold_quantity:0,returned_quantity:0};g.cost_row_count++;g.sold_quantity+=Number(l.sold_quantity||0);g.returned_quantity+=Number(l.returned_quantity||0);if(l.amount==null)g.missing_count++;else g.known_amount_cny+=cents(l.amount);for(const e of l.linked_evidence||[])if(!g.linked_evidence.some(old=>old.document_id===e.document_id))g.linked_evidence.push(e);groups.set(k,g);}
 return [...groups.values()].map(g=>({...g,known_amount_cny:g.known_amount_cny/100,amount:g.missing_count?null:g.known_amount_cny/100,amount_status:g.missing_count?'missing':'calculated',source:`已匹配 ${g.cost_row_count-g.missing_count} 项${g.missing_count?'，缺 '+g.missing_count+' 项':''}`}));
}
