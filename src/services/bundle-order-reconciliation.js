import {loadOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
import {inventoryTenantSql} from './inventory-tenant-scope.js';

const ORDER_ITEM_BATCH_SIZE = 500;

export function createBundleOrderReconciliation({postMovement,rebuild}){
 return async function reconcile(connection,scope,markTiming){
  const q=async(sql,args=[])=>(await connection.query(sql,args))[0];
  const coverage=await loadOrderProcurementCoverage(q,'',{tenantId:scope.id,fresh:true,outboundOnly:true});
  markTiming?.("inventory_outbound_demand_projection");
  const pendingItems=[];
  for(const order of coverage.values()){
   if(!Number(order.needs_fulfillment)||order.stock_location==='FBP')continue;
   const byItem=new Map();
   for(const item of order.items){
    const itemId=Number(item.order_item_id);
    if(!byItem.has(itemId))byItem.set(itemId,[]);
    byItem.get(itemId).push(item);
   }
   for(const [itemId,items] of byItem)pendingItems.push({itemId,items,postingNumber:order.posting_number});
  }
  if(!pendingItems.length)return;

  const products=new Map((await q(`SELECT p.id,p.purchase_cost FROM products p WHERE ${inventoryTenantSql(scope,'p')}`)).map(p=>[Number(p.id),p]));
  const changed=new Set();
  for(let offset=0;offset<pendingItems.length;offset+=ORDER_ITEM_BATCH_SIZE){
   const batch=pendingItems.slice(offset,offset+ORDER_ITEM_BATCH_SIZE);
   const itemIds=batch.map(item=>item.itemId);
   const placeholders=itemIds.map(()=>'?').join(',');
   const ownerRows=await q(`SELECT oi.id AS order_item_id,oi.sku_mapping_id,o.shop_id,s.platform
    FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id
    WHERE oi.id IN (${placeholders}) AND ${inventoryTenantSql(scope,'s')} ORDER BY oi.id FOR UPDATE`,itemIds);
   const owners=new Map(ownerRows.map(owner=>[Number(owner.order_item_id),owner]));
   if(itemIds.some(id=>!owners.has(id)))throw new Error('订单所属企业已变化，请刷新后重试');
   const localItems=batch.filter(({itemId})=>owners.get(itemId).platform!=='wb');
   const localIds=localItems.map(item=>item.itemId);
   if(!localIds.length)continue;
   const movements=await q(`SELECT im.id,im.related_order_item_id,im.product_id,im.quantity_delta,im.stock_location_source
    FROM inventory_movements im WHERE im.related_order_item_id IN (${localIds.map(()=>'?').join(',')})
    AND im.source_type IN ('order_outbound','order_outbound_adjustment') AND im.status='posted'
    AND ${inventoryTenantSql(scope,'im')} AND COALESCE(NULLIF(im.stock_location,''),'LOCAL') NOT IN ('FBP','FBO','OGR')
    ORDER BY im.id FOR UPDATE`,localIds);
   const movementsByItem=new Map();
   for(const movement of movements){
    const itemId=Number(movement.related_order_item_id),productId=Number(movement.product_id);
    if(!movementsByItem.has(itemId))movementsByItem.set(itemId,new Map());
    const byProduct=movementsByItem.get(itemId);
    if(!byProduct.has(productId))byProduct.set(productId,[]);
    byProduct.get(productId).push(movement);
   }
   for(const {itemId,items,postingNumber} of localItems){
    const owner=owners.get(itemId),existing=movementsByItem.get(itemId);
    const desired=new Map();for(const item of items){const id=Number(item.product_id);desired.set(id,{...item,quantity:Number(item.quantity)+(desired.get(id)?.quantity||0)});}
    const ids=new Set([...(existing?.keys()||[]),...desired.keys()]);
    for(const id of ids){
     const previous=existing?.get(id)||[];
     const item=desired.get(id),target=-Number(item?.quantity||0),current=previous.reduce((n,m)=>n+Number(m.quantity_delta),0);
     if(target===current)continue;
     const unitCost=Number(products.get(id)?.purchase_cost||0);
     if(previous.length){
      await q("UPDATE inventory_movements SET quantity_delta=?,amount=?,source_type='order_outbound',stock_location_source=? WHERE id=?",[target,Math.abs(target)*unitCost,item?.finished_bundle?'bundle_finished':previous[0].stock_location_source==='bundle_finished'?'bundle_finished':'bundle_allocation',previous[0].id]);
      for(const extra of previous.slice(1))await q("UPDATE inventory_movements SET quantity_delta=0,amount=0,source_type='order_outbound_adjustment' WHERE id=?",[extra.id]);
     }else await postMovement(connection,{product_id:id,shop_id:owner.shop_id,sku_mapping_id:owner.sku_mapping_id,source_type:'order_outbound',source_ref:postingNumber,related_order_item_id:itemId,related_posting_number:postingNumber,quantity_delta:target-current,stock_location:'LOCAL',stock_location_source:item?.finished_bundle?'bundle_finished':'bundle_allocation',unit_cost:unitCost,amount:Math.abs(target-current)*unitCost,note:'套装成品与散件统一分配'});
     changed.add(id);
    }
   }
  }
  for(const id of changed)await rebuild(connection,id);
 };
}
