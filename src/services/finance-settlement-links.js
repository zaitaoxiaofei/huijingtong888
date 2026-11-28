import crypto from 'node:crypto';
const parse=x=>typeof x==='string'?JSON.parse(x):x;
// An omitted financial SKU is not an alias for the reported SKU. Keep the order
// identity and evidence; never create a zero sale or transfer another SKU's cost.
export function financeSettlementLinks({items,official,rawPostings}) {
 const links=[];
 for(const snapshot of rawPostings){
  const raw=parse(snapshot.raw_json),posting=raw.raw||raw,number=String(snapshot.posting_number);
  if(String(posting.posting_number||raw.posting_number)!==number)continue;
  const groups=official.filter(g=>g.posting_number===number&&!g.conflict&&g.sold_quantity>0);if(!groups.length)continue;
  const rows=items.filter(i=>i.posting_number===number);if(new Set(rows.map(i=>Number(i.order_id))).size!==1)continue;
  const products=posting.products,financial=posting.financial_data?.products;if(!Array.isArray(products)||!Array.isArray(financial))continue;
  const candidates=[...new Set(rows.map(i=>String(i.ozon_sku)))].filter(sku=>!official.some(g=>g.posting_number===number&&g.sku===sku));
  for(const sku of candidates){
   const matching=rows.filter(i=>String(i.ozon_sku)===sku),product=products.filter(p=>String(p.sku)===sku),finance=financial.filter(p=>String(p.product_id)===sku);
   if(product.length!==1||finance.length!==1)continue;
   const f=finance[0];if(f.payout==null||f.commission_amount==null||!Number.isFinite(Number(f.payout))||Number(f.payout)!==0||Number(f.commission_amount)!==0)continue;
   const quantity=matching.reduce((n,i)=>n+Number(i.quantity),0);if(!Number.isSafeInteger(quantity)||quantity<=0||quantity!==Number(product[0].quantity))continue;
   if(!groups.some(g=>financial.some(f=>String(f.product_id)===g.sku&&Number.isFinite(Number(f.payout))&&Number(f.payout)!==0)))continue;
   links.push({posting_number:number,sku,item_ids:matching.map(i=>Number(i.item_id)),quantity,status:'not_separately_settled',net_revenue:null,reported_skus:groups.map(g=>g.sku),sources:groups.flatMap(g=>g.sources),evidence:{raw_sha256:crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex'),path:'financial_data.products',payout:0,commission_amount:0},note:'原始订单有该商品；平台财务付款与佣金为零，销售报告未单列该SKU。保留商品与采购成本，不替换SKU、不追加收入'});
  }
 }
 return links;
}
