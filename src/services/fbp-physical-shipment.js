import {loadInventoryComposition} from './inventory-composition.js';
import {finishedMovementSql} from './bundle-finished-stock.js';
import {inventoryTenantSql} from './inventory-tenant-scope.js';
import {loadOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
const fail=message=>Object.assign(new Error(message),{statusCode:409});

// Resolve current, owned physical leaves. A saved recipe owns its composition;
// a virtual parent must never be posted as if it were another physical item.
export async function fbpShipmentParts(query,scope,record){
 const composition=await loadInventoryComposition(query,scope);
 const recipes=record.shop_id&&record.ozon_sku?await query(`SELECT r.id FROM sku_inventory_recipes r JOIN shops s ON s.id=r.shop_id AND ${inventoryTenantSql(scope,'s')} WHERE r.shop_id=? AND r.ozon_sku=? AND r.active=1`,[record.shop_id,record.ozon_sku]):[];
 const roots=recipes.length?await query('SELECT product_id,quantity FROM sku_inventory_recipe_items WHERE recipe_id=?',[recipes[0].id]):[{product_id:record.product_id,quantity:1}];
 if(!roots.length)throw fail('发仓SKU没有有效库存组成，请在库存绑定中补齐实际子库存');
 const leaves=new Map();
 for(const root of roots){
  const units=Number(root.quantity);if(!Number.isSafeInteger(units)||units<=0)throw fail('发仓SKU组成数量无效，请核对库存绑定');
  for(const part of composition.components(Number(root.product_id))){const id=Number(part.id),quantity=(leaves.get(id)?.quantity||0)+units*part.per_set_quantity;
   if(!Number.isSafeInteger(quantity)||quantity>1000000)throw fail('发仓实际库存数量无效，请核对套装组成');
   leaves.set(id,{product_id:id,name:part.name,inventory_number:part.inventory_number,quantity});
  }
 }
 const parts=[...leaves.values()].sort((a,b)=>a.product_id-b.product_id);
 if(!recipes.length&&composition.isBundle(Number(record.product_id)))parts.finishedRoot=composition.products.get(Number(record.product_id));
 return parts;
}

export async function postFbpPhysicalShipment(query,scope,record,quantity,post,{parts:readParts=fbpShipmentParts,coverage:readCoverage=loadOrderProcurementCoverage}={}){
 let parts=await readParts(query,scope,record);
 const root=parts.finishedRoot;
 const lockIds=[...new Set([...parts.map(p=>p.product_id),...(root?[Number(root.id)]:[])])].sort((a,b)=>a-b);
 for(const productId of lockIds)await query(`SELECT id FROM products WHERE id=? AND ${inventoryTenantSql(scope)} FOR UPDATE`,[productId]);
 const baseRef=record.movement_source_ref||`fbp_transfer:${record.id}:outbound`;
 // An assembled kit is already physical stock: consume its free finished
 // units first, and expand only the remaining sets into loose components.
 if(root){
  const posted=await query(`SELECT product_id,quantity_delta FROM inventory_movements WHERE source_type='fbp_transfer_outbound' AND (source_ref=? OR source_ref LIKE ?) AND status='posted' AND ${inventoryTenantSql(scope)} FOR UPDATE`,[baseRef,`${baseRef}:component:%`]);
  if(posted.length){
   const counts=new Map(posted.map(p=>[Number(p.product_id),-Number(p.quantity_delta)])),finished=counts.get(Number(root.id))||0;
   if(parts.every(p=>(counts.get(p.product_id)||0)+finished*p.quantity===quantity*p.quantity))return [];
   throw fail('发仓记录已存在且数量不同，请核对历史发运记录');
  }
  const coverage=await readCoverage(query,'',{fresh:true,productIds:[Number(root.id),...parts.map(p=>p.product_id)],tenantId:scope.id,includeLegacyTenantNull:scope.isDefault});
  const movements=await query(`SELECT quantity_delta,source_type,related_order_item_id FROM inventory_movements im WHERE im.product_id=? AND im.status='posted' AND ${inventoryTenantSql(scope,'im')} AND ${finishedMovementSql('im')} AND UPPER(COALESCE(NULLIF(im.stock_location,''),'LOCAL')) NOT IN ('FBP','FBO','OGR') FOR UPDATE`,[Number(root.id)]);
  const demands=[...coverage.values()].filter(o=>o.needs_fulfillment&&o.stock_location!=='FBP').flatMap(o=>o.items||[]).filter(i=>Number(i.product_id)===Number(root.id));
  if(demands.some(i=>i.quantity_needs_review))throw fail('套装FBS订单需求待核对，请先确认订单库存明细再发仓');
  const open=new Set(demands.map(i=>Number(i.order_item_id)));
  const physical=movements.reduce((n,m)=>n+Number(m.quantity_delta)-(m.source_type==='order_outbound'&&open.has(Number(m.related_order_item_id))?Number(m.quantity_delta):0),0);
  const finished=Math.min(quantity,Math.max(0,Math.floor(physical-demands.reduce((n,d)=>n+Number(d.quantity),0))));
  parts=[...(finished?[{product_id:Number(root.id),name:root.name,inventory_number:root.inventory_number,quantity:1,shipmentSets:finished,finished:true}]:[]),...parts.map(p=>({...p,shipmentSets:quantity-finished})).filter(p=>p.shipmentSets>0)];
 }
 const pending=[];
 for(const part of parts){
  const amount=(part.shipmentSets??quantity)*part.quantity;
  if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000)throw fail('本次发仓实物数量无效，请核对数量和套装组成');
  const sourceRef=parts.length===1&&part.product_id===Number(record.product_id)&&part.quantity===1?baseRef:`${baseRef}:component:${part.product_id}`;
  const prior=await query(`SELECT id,quantity_delta FROM inventory_movements WHERE source_type='fbp_transfer_outbound' AND source_ref=? AND product_id=? AND status='posted' AND ${inventoryTenantSql(scope)} LIMIT 1 FOR UPDATE`,[sourceRef,part.product_id]);
  if(prior.length){if(Number(prior[0].quantity_delta)!==-amount)throw fail('发仓记录已存在且数量不同，请核对历史发运记录');continue;}
  pending.push({...part,amount,sourceRef});
 }
 if(!pending.length)return [];
 const coverage=await readCoverage(query,'',{fresh:true,productIds:pending.map(p=>p.product_id),tenantId:scope.id,includeLegacyTenantNull:scope.isDefault});
 // A transaction may have established an older consistent snapshot while
 // resolving a bundle. Locking reads must see physical writes committed by
 // another shipment before our child lock was acquired.
 const movements=await query(`SELECT product_id,source_type,movement_type,quantity_delta,related_order_item_id,stock_location_source FROM inventory_movements
  WHERE product_id IN (${pending.map(()=>'?').join(',')}) AND status='posted' AND ${inventoryTenantSql(scope)}
  AND UPPER(COALESCE(NULLIF(stock_location,''),'LOCAL')) NOT IN ('FBP','FBO','OGR') FOR UPDATE`,pending.map(p=>p.product_id));
 for(const part of pending){
  const demands=[...coverage.values()].filter(o=>o.needs_fulfillment&&o.stock_location!=='FBP').flatMap(o=>o.items||[]).filter(i=>Number(i.product_id)===part.product_id);
  if(demands.some(i=>i.quantity_needs_review))throw fail(`库存 ${part.inventory_number||part.product_id} 的FBS订单需求待核对，请先在订单库存明细确认后再发仓`);
  const openItems=new Set(demands.map(i=>Number(i.order_item_id)));
  const physical=movements.filter(m=>Number(m.product_id)===part.product_id).reduce((sum,m)=>{
   if(part.finished&&!['bundle_assembly','bundle_disassembly'].includes(m.source_type)&&m.stock_location_source!=='bundle_finished')return sum;
   if(['fbp_replenishment_reserve','fbp_replenishment_reserve_release'].includes(m.source_type)||['ORDER_RESERVED','CANCEL_RESTORE'].includes(m.movement_type))return sum;
   return sum+Number(m.quantity_delta||0)-(m.source_type==='order_outbound'&&openItems.has(Number(m.related_order_item_id))?Number(m.quantity_delta||0):0);
  },0),fbs=demands.reduce((sum,i)=>sum+Number(i.quantity||0),0),available=Math.max(0,physical-fbs);
  if(physical<0||part.amount>available)throw fail(`库存 ${part.inventory_number||part.product_id}（${part.name||'商品'}）本地实物 ${physical} 件，须优先保障FBS ${fbs} 件，可发仓 ${available} 件，本次需 ${part.amount} 件。请先补货或在FBP备货单调整最终发货数量后再确认发货`);
 }
 const result=[];
 for(const part of pending)result.push(await post(part,-part.amount,part.sourceRef));
 return result;
}
