import {billingCostKeys} from './billing-ledger-projection.js';
const round=n=>Math.round((Number(n||0)+Number.EPSILON)*100)/100;
const lossOutcomes=new Set(['rejected_unclaimed','after_delivery_return']);
const sum=(rows,key)=>round(rows.reduce((n,r)=>n+Number(r[key]||0),0));
export function billingDrilldown(orders,query={}){
 const groupBy=['sku','inventory','order'].includes(query.groupBy)?query.groupBy:'order';
 const outcomeType=query.outcomeType||query.outcome_type||'',field=query.field||'purchase_cost';
 const key=(order,item)=>groupBy==='order'?String(order.id):groupBy==='inventory'&&item.product_id?`inventory:${item.product_id}`:`sku:${order.shop_id}:${item.ozon_sku}`;
 const denominators=new Map(),baseQuantities=new Map(),groups=new Map();let matchingOrders=new Set();
 const keyword=String(query.keyword||'').trim().toLowerCase();
 const matches=(order,item)=>!keyword||[order.posting_number,order.shop_name,item.ozon_sku,item.product_name,item.inventory_name,item.inventory_number,item.product_id].some(x=>String(x||'').toLowerCase().includes(keyword));
 const predicate=order=>outcomeType==='returns'?lossOutcomes.has(order.outcome_type):!outcomeType||order.outcome_type===outcomeType;
 for(const order of orders)for(const item of order.items){
  if(query.productId&&Number(item.product_id)!==Number(query.productId))continue;
  if(query.sku&&(String(item.ozon_sku)!==String(query.sku)||Number(order.shop_id)!==Number(query.skuShopId)))continue;
  if(!matches(order,item))continue;
  const id=key(order,item),base=denominators.get(id)||new Set();base.add(order.id);denominators.set(id,base);baseQuantities.set(id,Number(baseQuantities.get(id)||0)+Number(item.quantity||0));
  if(!predicate(order)||(outcomeType==='returns'&&item.billing_return===false))continue;matchingOrders.add(order.id);
  const row=groups.get(id)||{key:id,order_ids:new Set(),shop_ids:new Set(),sku_set:new Set(),order_id:order.id,posting_number:order.posting_number,ordered_at:order.ordered_at,shop_id:order.shop_id,shop_name:order.shop_name,ozon_sku:item.ozon_sku,product_id:item.product_id,inventory_number:item.inventory_number,inventory_name:item.inventory_name,product_name:item.product_name,image_url:item.image_url,quantity:0,quantity_unknown:false,order_amount:0,billing_revenue:0,compensation_income:0,disposed_return:false,pending_order_ids:new Set(),adjustments_included:order.adjustments_included,fee_evidence:order.fee_evidence,reconciliation_status:order.reconciliation_status,original_costs:{},billing_costs:{},items:[]};
  row.order_ids.add(order.id);row.shop_ids.add(order.shop_id);row.sku_set.add(item.ozon_sku);row.quantity+=Number(outcomeType==='returns'?(item.return_quantity??item.quantity):item.quantity||0);if(outcomeType==='returns'&&item.return_quantity_unknown)row.quantity_unknown=true;row.order_amount+=Number(item.sale_price||0)*Number(item.quantity||0);
  const orderWeight=order.items.reduce((n,r)=>n+Number(r.sale_price||0)*Number(r.quantity||0),0),weight=orderWeight?Number(item.sale_price||0)*Number(item.quantity||0)/orderWeight:1/order.items.length;
  row.billing_revenue+=Number(item.billing_revenue??Number(order.billing_revenue||0)*weight);row.compensation_income+=Number(item.compensation_income??Number(order.compensation_income||0)*weight);row.disposed_return||=Boolean(item.disposed_return);
  if(order.reconciliation_status!=='official'&&outcomeType)row.pending_order_ids.add(order.id);
  for(const cost of billingCostKeys){row.billing_costs[cost]=(row.billing_costs[cost]||0)+Number(item.costs[cost]||0);row.original_costs[cost]=(row.original_costs[cost]||0)+Number(item[cost]||0);}
  row.items.push({ozon_sku:item.ozon_sku,product_id:item.product_id,inventory_number:item.inventory_number,inventory_name:item.inventory_name,product_name:item.product_name,image_url:item.image_url,quantity:item.quantity});groups.set(id,row);
 }
 const all=[...groups.values()].map(row=>{
  const costs=Object.fromEntries(billingCostKeys.map(k=>[k,round(row.billing_costs[k])])),net=round(row.billing_revenue-billingCostKeys.reduce((n,k)=>n+costs[k],0));
  return {...row,...row.original_costs,billing_costs:costs,order_count:row.order_ids.size,base_quantity:baseQuantities.get(row.key)||0,quantity:row.quantity_unknown?null:row.quantity,order_rate:row.order_ids.size/(denominators.get(row.key)?.size||1),base_order_count:denominators.get(row.key)?.size||0,rate:row.quantity_unknown?null:row.quantity/(baseQuantities.get(row.key)||1),shop_count:row.shop_ids.size,sku_count:row.sku_set.size,ozon_skus:[...row.sku_set].join('、'),pending_count:row.pending_order_ids.size,net_profit:net,recognized_loss:round(Math.max(0,-net)),goods_loss:costs.purchase_cost,logistics_loss:round(costs.domestic_shipping_cost+costs.international_shipping_cost+costs.aftersale_fee),commission_loss:costs.commission_fee,amount:outcomeType?round(-net):(field==='compensation_income'?round(row.compensation_income):field==='revenue'?round(row.billing_revenue):Number(costs[field]||0)),order_amount:round(row.order_amount),compensation_income:round(row.compensation_income),billing_revenue:round(row.billing_revenue),order_ids:undefined,shop_ids:undefined,sku_set:undefined,pending_order_ids:undefined};
 });
 const summary={order_count:matchingOrders.size,quantity:all.some(r=>r.quantity==null)?null:sum(all,'quantity'),order_amount:sum(all,'order_amount'),net_profit:sum(all,'net_profit'),goods_loss:sum(all,'goods_loss'),logistics_loss:sum(all,'logistics_loss'),commission_loss:sum(all,'commission_loss'),amount:sum(all,'amount'),pending_count:new Set(orders.filter(o=>matchingOrders.has(o.id)&&o.reconciliation_status!=='official').map(o=>o.id)).size};
 const allowed=new Set(['amount','order_count','quantity','rate','order_amount','goods_loss','logistics_loss','commission_loss','net_profit']);
 const sort=allowed.has(query.sortBy)?query.sortBy:outcomeType==='returns'?'quantity':'amount',direction=query.sortOrder==='asc'?1:-1;
 all.sort((a,b)=>a[sort]==null?(b[sort]==null?String(a.key).localeCompare(String(b.key)):1):b[sort]==null?-1:(Number(a[sort]||0)-Number(b[sort]||0))*direction||String(a.key).localeCompare(String(b.key)));
 const page=Math.max(1,Math.floor(Number(query.page)||1)),pageSize=[20,50,100,200].includes(Number(query.pageSize))?Number(query.pageSize):20;
 return {rows:all.slice((page-1)*pageSize,page*pageSize),total:all.length,page,pageSize,group_by:groupBy,summary,source:'billing_projection',cost_field:field};
}

export function withBillingCostAdjustments(orders,expenses){
 return orders.map(order=>{
  const records=expenses.filter(e=>e.source_type==='billing_cost_adjustment'&&Number(e.cost_order_id)===Number(order.id));
  if(!records.length)return order;
  const items=order.items.map(item=>({...item,costs:{...item.costs}}));
  const weights=items.map(r=>Math.max(0,Number(r.allocation_sale??r.sale_price)*Number(r.quantity))),total=weights.reduce((n,v)=>n+v,0);
  for(const expense of records){let used=0;items.forEach((item,index)=>{const amount=index===items.length-1?round(Number(expense.amount_cny)-used):round(Number(expense.amount_cny)*(total?weights[index]/total:1/items.length));used=round(used+amount);item.costs[expense.cost_field]=round(Number(item.costs[expense.cost_field]||0)+amount);});}
  return {...order,items,adjustments_included:true};
 });
}
