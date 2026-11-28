// FBO fulfillment happened on the platform. Import identity/items only: no local
// shipment, profit calculation, stock movement or new finance accrual is created.
export const fboInventoryExclusionSql = "NOT EXISTS (SELECT 1 FROM ozon_orders_raw fbo_raw WHERE fbo_raw.store_id=o.shop_id AND fbo_raw.posting_number=o.posting_number AND JSON_UNQUOTE(JSON_EXTRACT(fbo_raw.raw_json,'$.fulfillment_schema'))='FBO')";
export async function importFboOrder({transaction,shop,posting,tenantId=shop.tenant_id,allowLegacy=false}) {
 if(posting.fulfillment_schema!=='FBO'||!posting.posting_number||!posting.ordered_at_verified||!Number.isFinite(Date.parse(posting.ordered_at)))throw Error('FBO订单缺少原始货件号或已核实下单时间');
 const items=posting.items||[];if(!items.length||new Set(items.map(i=>String(i.ozon_sku))).size!==items.length||items.some(i=>!i.ozon_sku||!Number.isSafeInteger(Number(i.quantity))||Number(i.quantity)<=0||!Number.isSafeInteger(Number(posting.raw?.products?.find(p=>String(p.sku)===String(i.ozon_sku))?.quantity))||Number(posting.raw?.products?.find(p=>String(p.sku)===String(i.ozon_sku))?.quantity)<=0||i.sale_price_verified!==true||i.sale_currency!=='CNY'||!Number.isFinite(Number(i.sale_price))||Number(i.sale_price)<0))throw Error('FBO商品缺少唯一SKU、有效数量或人民币原始价格，请核对原件');
 return transaction(async db=>{
  const owner=await db.queryOne("SELECT id FROM shops WHERE id=? AND (tenant_id=? OR (?=1 AND tenant_id IS NULL)) AND status='active' AND COALESCE(platform,'ozon')='ozon' FOR UPDATE",[shop.id,tenantId,allowLegacy?1:0]);if(!owner)throw Error('FBO店铺不属于当前企业或已停用');
  const existing=await db.queryOne('SELECT id,status FROM orders WHERE shop_id=? AND posting_number=? FOR UPDATE',[shop.id,posting.posting_number]);
  if(existing){
   const source=await db.queryOne('SELECT raw_json FROM ozon_orders_raw WHERE store_id=? AND posting_number=?',[shop.id,posting.posting_number]);
   const raw=source?(typeof source.raw_json==='string'?JSON.parse(source.raw_json):source.raw_json):null;
   if(raw?.fulfillment_schema!=='FBO')throw Error('已有同号非FBO或来源不明订单，请人工核对履约类型');
   if(existing.status===posting.status)return {inserted:0,updated:0,insertedItems:0,orderId:Number(existing.id),unchanged:true};
   await db.execute('UPDATE orders SET status=?,logistics_status=?,tracking_stage=?,last_synced_at=CURRENT_TIMESTAMP WHERE id=?',[posting.status,posting.status,posting.status,existing.id]);
   await db.execute('UPDATE ozon_orders_raw SET raw_json=? WHERE store_id=? AND posting_number=?',[JSON.stringify(posting),shop.id,posting.posting_number]);
   await history(db,shop,posting,Number(existing.id));
   return {inserted:0,updated:1,insertedItems:0,orderId:Number(existing.id),inventoryWrites:0,financeWrites:0};
  }
  const date=value=>value?new Date(value).toISOString().slice(0,19).replace('T',' '):null;
  const saved=await db.execute("INSERT INTO orders (shop_id,posting_number,order_number,status,logistics_status,tracking_stage,ordered_at,delivered_at,sync_state,last_synced_at,sync_note) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?)",[shop.id,posting.posting_number,posting.order_number,posting.status,posting.status,posting.status,date(posting.ordered_at),date(posting.delivered_at),'pending','FBO平台履约订单；仅补齐订单与原件，销售退款以官方报告核对，成本及利润待核']);
  const orderId=Number(saved.insertId);
  for(const item of items)await db.execute("INSERT INTO order_items (order_id,ozon_sku,ozon_name,quantity,sale_price,settlement_state) VALUES (?,?,?,?,?,'pending')",[orderId,String(item.ozon_sku),String(item.name||''),Number(item.quantity),Number(item.sale_price)]);
  await db.execute('INSERT INTO ozon_orders_raw (store_id,posting_number,raw_json) VALUES (?,?,?) ON DUPLICATE KEY UPDATE raw_json=VALUES(raw_json)',[shop.id,posting.posting_number,JSON.stringify(posting)]);
  await history(db,shop,posting,orderId);
  return {inserted:1,updated:0,insertedItems:items.length,orderId,inventoryWrites:0,financeWrites:0};
 });
}

async function history(db,shop,posting,orderId){
 const now=new Date().toISOString().slice(0,19).replace('T',' '),hour=now.slice(0,13)+':00:00';
 await db.execute('INSERT INTO order_status_history (order_id,shop_id,posting_number,status,logistics_status,tracking_stage,sync_state,observed_at,observed_hour,snapshot_source,raw_status_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[orderId,shop.id,posting.posting_number,posting.status,posting.status,posting.status,'pending',now,hour,'finance_fbo_import',JSON.stringify({fulfillment_schema:'FBO',status:posting.status})]);
}
