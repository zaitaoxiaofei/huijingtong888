import {createHash} from 'node:crypto';
const fail=message=>Object.assign(new Error(message),{statusCode:409});
const money=value=>Math.round(Number(value)*10000)/10000;
export function bundleReviewRevision(batch,components){
 return createHash('sha256').update(JSON.stringify({id:batch.id,product_id:batch.product_id,quantity:batch.quantity,amount:batch.amount,shipping_amount:batch.shipping_amount,status:batch.status,received_at:batch.received_at,updated_at:batch.updated_at,components:components.map(p=>[p.product_id,p.per_set_quantity]).sort((a,b)=>a[0]-b[0])})).digest('hex');
}
export function bundleReviewContentRevision(batch,components){
 return bundleReviewRevision({...batch,quantity:null,amount:null,shipping_amount:null,status:null,received_at:null,updated_at:null},components);
}
export function planPurchaseBundleReview(context,body){
 if(body.revision!==context.revision)throw fail('采购批次或套装组成已变化，请重新打开核对');
 if(!['whole','parts'].includes(body.mode))throw fail('请选择整套采购或仅采购部分配件');
 if(typeof body.note!=='string'||!body.note.trim()||body.note.length>500)throw fail('请填写与采购凭证一致的核对说明');

 if(!Array.isArray(body.items)||!body.items.length||body.items.length>100||new Set(body.items.map(i=>Number(i.product_id))).size!==body.items.length)throw fail('请选择实际采购的配件，每个库存只能登记一次');
 const ids=new Set(context.components.map(p=>Number(p.product_id)));
 const items=body.items.map(item=>{
  const id=Number(item.product_id),quantity=Number(item.quantity),amount=Number(item.amount),shipping=Number(item.shipping_amount||0);
  if(!ids.has(id)||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000||!Number.isFinite(amount)||amount<=0||!Number.isFinite(shipping)||shipping<0)throw fail('请按最小实物库存填写实际采购件数、货款和运费；不能加入套装外的库存');
  return{product_id:id,quantity,amount:money(amount),shipping_amount:money(shipping)};
 });
 const amount=money(items.reduce((n,i)=>n+i.amount,0)),shipping=money(items.reduce((n,i)=>n+i.shipping_amount,0));
 if(body.mode==='whole'){
  if(body.allocation_confirmed!==true)throw fail('请明确确认整套采购的配件成本分摊');
  if(items.length!==context.components.length||context.components.some(c=>!items.some(i=>i.product_id===Number(c.product_id)&&i.quantity===Number(context.batch.quantity)*Number(c.per_set_quantity))))throw fail('整套采购须完整保留每个配件及对应换算数量');
  if(Math.abs(amount-Number(context.batch.amount||0))>=0.0001||Math.abs(shipping-Number(context.batch.shipping_amount||0))>=0.0001)throw fail('整套采购分摊后的货款、运费须分别等于原记录，不能增加或减少已付金额');
  return{mode:'whole',items,amount,shipping_amount:shipping};
 }
 if(Math.abs(amount+shipping-Number(context.batch.amount||0)-Number(context.batch.shipping_amount||0))>=0.0001&&body.confirm_amount_change!==true)throw fail('更正后的总金额与原记录不同，请核对凭证并明确确认金额更正；实际退款请走采购对账');
 return{mode:'parts',items,amount,shipping_amount:shipping};
}

export function suggestBundleCostAllocation(batch,components,costs){
 const values=new Map(costs.map(p=>[Number(p.id),Number(p.purchase_cost)]));
 const weights=components.map(c=>Number(c.quantity)*Number(values.get(Number(c.product_id))));
 if(weights.some(w=>!Number.isFinite(w)||w<=0))return components.map(c=>({...c,suggested_amount:null,suggested_shipping_amount:null}));
 const total=weights.reduce((n,w)=>n+w,0);let cumulative=0,goods=0,freight=0;
 return components.map((c,index)=>{cumulative+=weights[index];const nextGoods=Math.round(Number(batch.amount||0)*10000*cumulative/total),nextFreight=Math.round(Number(batch.shipping_amount||0)*10000*cumulative/total);const item={...c,suggested_amount:(nextGoods-goods)/10000,suggested_shipping_amount:(nextFreight-freight)/10000};goods=nextGoods;freight=nextFreight;return item;});
}
