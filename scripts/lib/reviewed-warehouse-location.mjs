import {createHash} from 'node:crypto';
import {classifyOrderLogistics,orderLogisticsEvidence} from '../../src/services/order-logistics-classification.js';
const fail=message=>{throw new Error(message);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own=(a,s)=>`(${a}.tenant_id=${s.id}${s.isDefault?' OR '+a+'.tenant_id IS NULL':''})`;
const fields='m.id,m.tenant_id,m.product_id,m.shop_id,m.source_type,m.source_ref,m.quantity_delta,m.unit_cost,m.amount,m.status,m.movement_type,m.related_order_item_id,m.stock_location,m.stock_location_source';
export async function inspectWarehouseRepair(db,manifest,{lock=false}={}){
 const id=Number(manifest.tenant_id);if(!Number.isSafeInteger(id)||id<1)fail('Invalid enterprise');
 const [[tenant]]=await db.query('SELECT id,slug,status FROM tenants WHERE id=?',[id]);
 if(!tenant||tenant.status!=='active')fail('Enterprise unavailable');
 const scope={id,isDefault:tenant.slug==='default'};
 const entries=manifest.entries||[],protectedIds=(manifest.protected_ids||[]).map(Number),ids=entries.map(e=>Number(e.id));
 if(!ids.length||ids.length>5000||ids.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(ids).size!==ids.length||protectedIds.some(id=>!Number.isSafeInteger(id)||id<1||ids.includes(id))||new Set(protectedIds).size!==protectedIds.length)fail('Invalid or overlapping manifest');
 if(lock){const productIds=[...new Set(entries.map(e=>Number(e.product_id)))].sort((a,b)=>a-b);await db.query(`SELECT p.id FROM products p WHERE p.id IN (?) AND ${own('p',scope)} ORDER BY p.id FOR UPDATE`,[productIds]);}
 const [rows]=await db.query(`SELECT ${fields} FROM inventory_movements m JOIN products p ON p.id=m.product_id AND ${own('p',scope)} WHERE m.id IN (?) AND ${own('m',scope)} ORDER BY m.id${lock?' FOR UPDATE':''}`,[ids]);
 if(rows.length!==ids.length)fail('Movement ownership or coverage changed');
 const byId=new Map(rows.map(r=>[Number(r.id),r]));
 const inbounds=entries.filter(e=>e.basis==='purchase_receipt').map(e=>Number(e.inbound_id));
 const [receipts]=inbounds.length?await db.query(`SELECT ir.id,ir.product_id,ir.quantity,ir.status FROM inbound_records ir JOIN products p ON p.id=ir.product_id AND ${own('p',scope)} WHERE ir.id IN (?) AND ${own('ir',scope)}${lock?' FOR UPDATE':''}`,[inbounds]):[[]];
 const receiptMap=new Map(receipts.map(r=>[Number(r.id),r]));
 const orderEntries=entries.filter(e=>['order_raw','original_outbound'].includes(e.basis));
 const itemIds=orderEntries.map(e=>Number(e.order_item_id));
 const [orders]=itemIds.length?await db.query(`SELECT oi.id order_item_id,o.id order_id,o.shop_id,o.posting_number,o.status,raw.raw_json FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id AND ${own('s',scope)} LEFT JOIN ozon_orders_raw raw ON raw.store_id=o.shop_id AND BINARY raw.posting_number=BINARY o.posting_number WHERE oi.id IN (?)${lock?' FOR UPDATE':''}`,[itemIds]):[[]];
 const orderMap=new Map();for(const o of orders){if(orderMap.has(Number(o.order_item_id)))fail('Ambiguous raw posting');orderMap.set(Number(o.order_item_id),o);}
 const [originals]=itemIds.length?await db.query(`SELECT ${fields} FROM inventory_movements m JOIN products p ON p.id=m.product_id AND ${own('p',scope)} WHERE ${own('m',scope)} AND m.related_order_item_id IN (?) AND m.source_type IN ('return_in','order_outbound') AND m.status='posted'${lock?' FOR UPDATE':''}`,[itemIds]):[[]];
 const changes=[],already=[];
 for(const e of entries){
  const r=byId.get(Number(e.id));
  if(Number(r.product_id)!==Number(e.product_id)||r.source_type!==e.source_type||r.source_ref!==e.source_ref||Number(r.quantity_delta)!==Number(e.quantity_delta)||String(r.unit_cost)!==String(e.unit_cost)||String(r.amount)!==String(e.amount)||r.status!=='posted')fail(`Movement changed: ${e.id}`);
  if(!['LOCAL','FBP'].includes(e.target))fail('Invalid target warehouse');
  if(e.basis==='purchase_receipt'){
   const ir=receiptMap.get(Number(e.inbound_id));
   if(r.source_type!=='purchase_inbound'||r.source_ref!==`inbound_${e.inbound_id}`||e.target!=='LOCAL'||!ir||Number(ir.product_id)!==Number(r.product_id)||ir.status!=='approved'||Number(ir.quantity)!==Number(r.quantity_delta))fail(`Receipt evidence changed: ${e.id}`);
  }else if(['order_raw','original_outbound'].includes(e.basis)){
   const o=orderMap.get(Number(e.order_item_id));
   if(!o||o.status!=='cancelled'||Number(r.related_order_item_id)!==Number(o.order_item_id)||Number(r.shop_id)!==Number(o.shop_id)||r.source_type!=='return_in'||r.source_ref!==`cancel_${o.order_item_id}`)fail(`Order evidence changed: ${e.id}`);
   const restores=originals.filter(x=>x.source_type==='return_in'&&Number(x.product_id)===Number(r.product_id)&&Number(x.related_order_item_id)===Number(r.related_order_item_id));
   if(restores.length!==1)fail(`Duplicate cancellation restoration: ${e.id}`);
   const c=classifyOrderLogistics(o),v=orderLogisticsEvidence(o),target=c.logistics_fulfillment_type==='fbp'?'FBP':'LOCAL';
   if(!v.warehouseName||!v.deliveryMethodName||target!==e.target)fail(`Raw warehouse evidence changed: ${e.id}`);
   if(e.basis==='original_outbound'){
    const original=originals.filter(x=>x.source_type==='order_outbound'&&Number(x.product_id)===Number(r.product_id)&&Number(x.related_order_item_id)===Number(r.related_order_item_id));
    if(!original.length||original.some(x=>x.stock_location!==e.target)||original.reduce((n,x)=>n-Number(x.quantity_delta),0)!==Number(r.quantity_delta))fail(`Original debit changed: ${e.id}`);
   }
  }else fail('Unsupported evidence basis');
  if(r.stock_location===e.target){already.push(Number(r.id));continue;}
  if(!['UNKNOWN','',null].includes(r.stock_location)||r.stock_location_source!=='legacy_unknown')fail(`Warehouse already changed: ${e.id}`);
  changes.push({id:Number(r.id),product_id:Number(r.product_id),before_location:r.stock_location,before_source:r.stock_location_source,target:e.target,basis:e.basis});
 }
 const [protectedRows]=protectedIds.length?await db.query(`SELECT ${fields} FROM inventory_movements m JOIN products p ON p.id=m.product_id AND ${own('p',scope)} WHERE m.id IN (?) AND ${own('m',scope)} ORDER BY m.id${lock?' FOR UPDATE':''}`,[protectedIds]):[[]];
 if(protectedRows.length!==protectedIds.length)fail('Protected evidence unavailable');
 const productIds=[...new Set(entries.map(e=>Number(e.product_id)))];
 const [current]=await db.query('SELECT * FROM inventory_current WHERE real_product_id IN (?) ORDER BY real_product_id',[productIds]);
 const unchanged=rows.map(({stock_location,stock_location_source,...row})=>row);
 return {scope,changes,already,rows,protectedRows,current,unchanged_digest:digest(unchanged),protected_digest:digest(protectedRows),current_digest:digest(current)};
}
export async function applyWarehouseRepair(db,manifest,{beforeCommit=async()=>{}}={}){
 await db.beginTransaction();
 try{
  const before=await inspectWarehouseRepair(db,manifest,{lock:true});
  await beforeCommit(before);
  for(const change of before.changes){
   const [result]=await db.query("UPDATE inventory_movements SET stock_location=?,stock_location_source='reviewed_warehouse_20261116' WHERE id=? AND stock_location<=>? AND stock_location_source=?",[change.target,change.id,change.before_location,change.before_source]);
   if(result.affectedRows!==1)fail('Concurrent warehouse change');
  }
  const after=await inspectWarehouseRepair(db,manifest,{lock:true});
  if(after.changes.length||before.unchanged_digest!==after.unchanged_digest||before.protected_digest!==after.protected_digest||before.current_digest!==after.current_digest)fail('Repair invariant failed');
  await db.commit();return {changed:before.changes.length,already:before.already.length,warehouses:before.changes.reduce((n,c)=>(n[c.target]=(n[c.target]||0)+1,n),{}),protected_count:before.protectedRows.length,unchanged_digest:after.unchanged_digest,protected_digest:after.protected_digest,current_digest:after.current_digest};
 }catch(e){await db.rollback();throw e;}
}
