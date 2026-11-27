import {loadOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
import {inventoryTenantSql} from './inventory-tenant-scope.js';

export function createBundleOrderReconciliation({postMovement,rebuild}){
 return async function reconcile(connection,scope){
  const q=async(sql,args=[])=>(await connection.query(sql,args))[0];
  const coverage=await loadOrderProcurementCoverage(q,'',{tenantId:scope.id,fresh:true});
  const products=new Map((await q(`SELECT p.id,p.purchase_cost FROM products p WHERE ${inventoryTenantSql(scope,'p')}`)).map(p=>[Number(p.id),p]));
  const changed=new Set();
  for(const order of coverage.values()){
   if(!Number(order.needs_fulfillment)||order.stock_location==='FBP')continue;
   const byItem=new Map();
   for(const item of order.items){if(!byItem.has(Number(item.order_item_id)))byItem.set(Number(item.order_item_id),[]);byItem.get(Number(item.order_item_id)).push(item);}
   for(const [itemId,items] of byItem){
    const [owner]=await q(`SELECT oi.sku_mapping_id,o.shop_id,s.platform FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id WHERE oi.id=? AND ${inventoryTenantSql(scope,'s')} FOR UPDATE`,[itemId]);
    if(owner?.platform==='wb')continue;
    const existing=await q(`SELECT im.* FROM inventory_movements im WHERE im.related_order_item_id=? AND im.source_type IN ('order_outbound','order_outbound_adjustment') AND im.status='posted' AND ${inventoryTenantSql(scope,'im')} AND COALESCE(NULLIF(im.stock_location,''),'LOCAL') NOT IN ('FBP','FBO','OGR') FOR UPDATE`,[itemId]);
    if(!owner)throw new Error('订单所属企业已变化，请刷新后重试');
    const desired=new Map();for(const item of items){const id=Number(item.product_id);desired.set(id,{...item,quantity:Number(item.quantity)+(desired.get(id)?.quantity||0)});}
    const ids=new Set([...existing.map(m=>Number(m.product_id)),...desired.keys()]);
    for(const id of ids){
     const item=desired.get(id),target=-Number(item?.quantity||0),current=existing.filter(m=>Number(m.product_id)===id).reduce((n,m)=>n+Number(m.quantity_delta),0);
     if(target===current)continue;
     const unitCost=Number(products.get(id)?.purchase_cost||0);
     const previous=existing.filter(m=>Number(m.product_id)===id);
     if(previous.length){
      await q("UPDATE inventory_movements SET quantity_delta=?,amount=?,source_type='order_outbound',stock_location_source=? WHERE id=?",[target,Math.abs(target)*unitCost,item?.finished_bundle?'bundle_finished':previous[0].stock_location_source==='bundle_finished'?'bundle_finished':'bundle_allocation',previous[0].id]);
      for(const extra of previous.slice(1))await q("UPDATE inventory_movements SET quantity_delta=0,amount=0,source_type='order_outbound_adjustment' WHERE id=?",[extra.id]);
     }else await postMovement(connection,{product_id:id,shop_id:owner.shop_id,sku_mapping_id:owner.sku_mapping_id,source_type:'order_outbound',source_ref:order.posting_number,related_order_item_id:itemId,related_posting_number:order.posting_number,quantity_delta:target-current,stock_location:'LOCAL',stock_location_source:item?.finished_bundle?'bundle_finished':'bundle_allocation',unit_cost:unitCost,amount:Math.abs(target-current)*unitCost,note:'套装成品与散件统一分配'});
     changed.add(id);
    }
   }
  }
  for(const id of changed)await rebuild(connection,id);
 };
}
