const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export function purchaseOrderDate(value){
 if(!value)return '';
 if(value instanceof Date)return Number.isFinite(value.getTime())?formatter.format(value):'';
 const text=String(value).trim(),date=new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)?text:text.replace(' ','T')+'Z');
 return Number.isFinite(date.getTime())?formatter.format(date):'';
}
export function historicalPurchaseAverage(purchases=[]){
 const eligible=purchases.filter(r=>Number(r.actual_quantity)>0&&Number(r.amount)>0&&Number.isFinite(Number(r.amount))&&Number.isFinite(Number(r.actual_quantity)));
 const quantity=eligible.reduce((n,r)=>n+Number(r.actual_quantity),0),amount=eligible.reduce((n,r)=>n+Number(r.amount),0);
 return quantity?{unit_cost:Number((amount/quantity).toFixed(4)),quantity,amount,records:eligible.length}:null;
}
export function purchaseBackfillGroups(ledger){
 const groups=new Map();
 for(const order of ledger.orders||[]){
  if(!order.entered_transport||order.stock_location==='FBP'||!(Number(order.missing_purchase_quantity)>0))continue;
  const date=purchaseOrderDate(order.ordered_at);
  if(!groups.has(date))groups.set(date,[]);groups.get(date).push(order);
 }
 return [...groups].sort(([a],[b])=>a.localeCompare(b)).flatMap(([date,orders])=>{
  const chunks=[];for(let i=0;i<orders.length;i+=500){const part=orders.slice(i,i+500);chunks.push({date,order_item_ids:part.map(o=>Number(o.order_item_id)),missing_quantity:part.reduce((n,o)=>n+Number(o.missing_purchase_quantity),0)});}return chunks;
 });
}
