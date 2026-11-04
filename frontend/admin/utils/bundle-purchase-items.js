import {inventoryPurchaseQuantity} from '../../../src/shared/inventory-supply-plan.js';

// Purchase quantities belong to physical inventory records, never to virtual sets.
export function bundlePurchaseItems(components, states, {freePurchase=false}={}) {
 const byId=new Map(states.map(row=>[Number(row.product_id),row]));
 const rows=components.map(part=>{
  const id=Number(part.product_id||part.id),workflow=byId.get(id);
  const quantity=workflow?inventoryPurchaseQuantity(workflow.supply_plan):null;
  if(quantity===null)throw new Error(`「${part.name||id}」的采购需求尚未读取完整，请刷新需求后重试`);
  return {...part,product_id:id,product_name:part.name,workflow,quantity};
 });
 const missing=rows.filter(row=>row.quantity>0);
 if(missing.length||!freePurchase)return missing;
 return rows.map(row=>({...row,quantity:Number(row.per_set_quantity)}));
}
