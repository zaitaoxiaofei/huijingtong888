const fail=message=>Object.assign(new Error(message),{statusCode:409});
export function allocateBundlePurchaseTotal(context,body){
 const all=context.components||[];
 if(!all.length||all.length>100)throw fail('套装配件数量无效，请重新打开采购记录');
 const byId=new Map(all.map(part=>[Number(part.product_id),part]));
 const inputs=body.mode==='whole'?all.map(part=>({product_id:part.product_id,quantity:Number(body.set_quantity)*Number(part.per_set_quantity)})):body.items;
 if(body.mode==='whole'&&(!Number.isSafeInteger(Number(body.set_quantity))||Number(body.set_quantity)<1))throw fail('请填写大于零的整数套数');
 if(!Array.isArray(inputs)||!inputs.length||inputs.length>100||new Set(inputs.map(item=>Number(item.product_id))).size!==inputs.length)throw fail('请选择实际购买的配件，每个配件只填写一次');
 const selected=inputs.map(item=>{
  const id=Number(item.product_id),quantity=Number(item.quantity),part=byId.get(id);
  if(!part||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)throw fail('请填写所选配件的实际采购数量，不能加入套装外的库存');
  return{product_id:id,quantity,cost:Number(part.purchase_cost)};
 });
 const total=Number(body.total_amount),units=Math.round(total*10000);
 if(!Number.isFinite(total)||total<=0||!Number.isSafeInteger(units)||units<selected.length)throw fail('请填写大于零且可分摊到所选配件的总费用');
 const originalGoods=Math.max(0,Number(context.batch.amount)||0),originalShipping=Math.max(0,Number(context.batch.shipping_amount)||0),originalTotal=originalGoods+originalShipping;
 const shippingUnits=Math.min(units-selected.length,originalTotal>0?Math.round(units*originalShipping/originalTotal):0);
 const weighted=selected.every(item=>Number.isFinite(item.cost)&&item.cost>0);
 const weights=selected.map(item=>item.quantity*(weighted?item.cost:1)),weightSum=weights.reduce((a,b)=>a+b,0);
 function spread(value,minimum){let weight=0,prior=0;const remainder=value-minimum*selected.length;return weights.map((w,index)=>{weight+=w;const next=index===weights.length-1?remainder:Math.round(remainder*weight/weightSum);const amount=minimum+next-prior;prior=next;return amount/10000;});}
 const goods=spread(units-shippingUnits,1),freight=spread(shippingUnits,0);
 return selected.map((item,index)=>({product_id:item.product_id,quantity:item.quantity,amount:goods[index],shipping_amount:freight[index]}));
}
