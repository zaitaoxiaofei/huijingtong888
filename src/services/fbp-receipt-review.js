import { loadProductFbpStocks } from './fbp-inventory-display.js';
import { inventoryProductSearch } from './inventory-product-search.js';
import { fbpReceiptEvidence } from '../shared/fbp-receipt-evidence.js';
import { mysqlQuery } from '../mysql-pool.js';
import { resolveInventoryTenantScope, inventoryTenantSql, assertInventoryRecord } from './inventory-tenant-scope.js';
import { authorizeBusinessTaskSession } from './business-task-tenant.js';
import { hasPermission } from '../shared/permissions.js';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const stamp = value => value ? new Date(typeof value === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value.replace(' ', 'T') + 'Z' : value).getTime() : NaN;
const pair = row => `${row.shop_id}:${row.ozon_sku}`;
// Capture only at an actual dispatch transaction. GET requests never invent a
// historical baseline; old shipments without one remain explicitly unknown.
export async function captureFbpReceiptBaseline(q, scope, transferId) {
  const [record] = await q(`SELECT f.id,f.product_id,f.shop_id,f.ozon_sku FROM fbp_transfer_records f
    JOIN shops s ON s.id=f.shop_id AND ${inventoryTenantSql(scope,'s')}
    JOIN products p ON p.id=f.product_id AND ${inventoryTenantSql(scope,'p')} WHERE f.id=?`, [transferId]);
  if (!record?.shop_id || !record.ozon_sku) return;
  const previous = await q("SELECT id FROM inventory_flow_events WHERE tenant_id=? AND product_id=? AND action='fbp_receipt_baseline' AND JSON_EXTRACT(detail_json,'$.transfer_id')=? LIMIT 1", [scope.id,record.product_id,record.id]);
  if (previous.length) return;
  const [stock] = await q("SELECT SUM(present) AS present,MIN(synced_at) AS synced_at FROM ozon_stock_snapshots WHERE shop_id=? AND ozon_sku=? AND stock_type='fbp_real'", [record.shop_id,record.ozon_sku]);
  await q("INSERT INTO inventory_flow_events(tenant_id,product_id,action,detail_json) VALUES(?,?,'fbp_receipt_baseline',?)", [scope.id,record.product_id,JSON.stringify({transfer_id:record.id,shop_id:record.shop_id,ozon_sku:record.ozon_sku,present:stock?.present == null ? null : Number(stock.present),synced_at:stock?.synced_at||null})]);
}

export function createFbpReceiptReview({query=mysqlQuery}={}) {
  async function records(params, session) {
    const current=await authorizeBusinessTaskSession(session,query);
    if(!hasPermission(current,'inventory.read'))throw Object.assign(new Error('需要本企业库存查看权限'),{statusCode:403});
    const scope=await resolveInventoryTenantScope(current.tenant.id,query),page=Math.max(1,Number(params.page)||1),id=Number(params.product_id)||0;
    if(id)await assertInventoryRecord(scope,'product',id,query);
    const bindings=id?(await loadProductFbpStocks(query,id,scope)).rows:[];
    const related=[...new Map(bindings.map(row=>[pair(row),row])).values()];
    const productFilter=id?`AND (f.product_id=?${related.length?' OR '+related.map(()=>'(f.shop_id=? AND f.ozon_sku=?)').join(' OR '):''})`:'';
    const onlyOpen=params.all!=='1';
    const criteria=inventoryProductSearch(params,scope,'p');
    const fromSql=`FROM fbp_transfer_records f JOIN products p ON p.id=f.product_id AND ${inventoryTenantSql(scope,'p')}
      JOIN shops s ON s.id=f.shop_id AND ${inventoryTenantSql(scope,'s')}
      WHERE f.status NOT IN ('draft','cancelled','closed') ${productFilter} ${criteria.sql?'AND ('+criteria.sql+')':''}
      ${onlyOpen?'AND f.quantity>f.listed_quantity':''}`;
    const args=[...(id?[id,...related.flatMap(r=>[r.shop_id,r.ozon_sku])]:[]),...criteria.params];
    if(params.summary_only==='1'){
      const [summary]=await query(`SELECT COUNT(*) AS total,COALESCE(SUM(GREATEST(f.quantity-f.listed_quantity,0)),0) AS pending_quantity ${fromSql}`,args);
      return {rows:[],total:Number(summary?.total||0),pending_quantity:Number(summary?.pending_quantity||0)};
    }
    const rows=await query(`SELECT COUNT(*) OVER() AS total,f.*,p.name AS product_name,p.inventory_number,s.name AS shop_name,
      CONCAT('/api/products/',p.id,'/image?thumb=1') AS image_url ${fromSql} ORDER BY f.shipped_at,f.id LIMIT 50 OFFSET ?`,[...args,(page-1)*50]);
    if(!rows.length)return {rows:[],total:0};
    const productIds=[...new Set(rows.map(r=>Number(r.product_id)))];
    const pairs=[...new Map(rows.map(r=>[pair(r),r])).values()];
    const [events,stocks,settingsRows,overlaps]=await Promise.all([
      query(`SELECT action,detail_json,created_at FROM inventory_flow_events WHERE tenant_id=? AND product_id IN (${productIds.map(()=>'?').join(',')}) AND action IN ('fbp_receipt_baseline','fbp_arrival_time','fbp_receipt_confirm') ORDER BY id DESC LIMIT 5000`,[scope.id,...productIds]),
      query(`SELECT shop_id,ozon_sku,SUM(present) AS present,MIN(synced_at) AS synced_at FROM ozon_stock_snapshots WHERE stock_type='fbp_real' AND (${pairs.map(()=>'(shop_id=? AND ozon_sku=?)').join(' OR ')}) GROUP BY shop_id,ozon_sku`,pairs.flatMap(r=>[r.shop_id,r.ozon_sku])),
      query(`SELECT product_id,settings_json FROM inventory_flow_settings WHERE tenant_id=? AND product_id IN (0,${productIds.map(()=>'?').join(',')})`,[scope.id,...productIds]),
      query(`SELECT f.shop_id,f.ozon_sku,COUNT(*) AS open_batches FROM fbp_transfer_records f JOIN shops s ON s.id=f.shop_id AND ${inventoryTenantSql(scope,'s')} WHERE f.status NOT IN ('draft','cancelled','closed') AND f.quantity>f.listed_quantity AND (${pairs.map(()=>'(f.shop_id=? AND f.ozon_sku=?)').join(' OR ')}) GROUP BY f.shop_id,f.ozon_sku`,pairs.flatMap(r=>[r.shop_id,r.ozon_sku]))
    ]);
    const settingsMap=new Map(settingsRows.map(row=>[Number(row.product_id),parse(row.settings_json)]));
    const baseline=new Map(),arrival=new Map(),confirmations=new Map();
    for(const event of events){const value=parse(event.detail_json),target=event.action==='fbp_receipt_baseline'?baseline:event.action==='fbp_arrival_time'?arrival:confirmations;if(!target.has(Number(value.transfer_id)))target.set(Number(value.transfer_id),value);}
    const stockMap=new Map(stocks.map(r=>[pair(r),r]));
    const windows=rows.filter(r=>baseline.get(Number(r.id))?.synced_at&&stockMap.get(pair(r))?.synced_at);
    // Count each sold SKU once even if a kit has multiple component outbounds.
    const consumption=windows.length?await query(`SELECT r.shop_id,r.ozon_sku,oi.id,MAX(oi.quantity) AS quantity,MIN(r.created_at) AS consumed_at
      FROM outbound_records r JOIN order_items oi ON oi.id=r.order_item_id AND oi.ozon_sku=r.ozon_sku JOIN orders o ON o.id=oi.order_id AND o.shop_id=r.shop_id
      JOIN shops s ON s.id=o.shop_id AND ${inventoryTenantSql(scope,'s')}
      WHERE r.status='deducted' AND r.stock_location='FBP' AND (${windows.map(()=>'(r.shop_id=? AND r.ozon_sku=? AND r.created_at>? AND r.created_at<=?)').join(' OR ')})
      GROUP BY r.shop_id,r.ozon_sku,oi.id`,windows.flatMap(r=>[r.shop_id,r.ozon_sku,baseline.get(Number(r.id)).synced_at,stockMap.get(pair(r)).synced_at])):[];
    const orderIds=[...new Set(rows.filter(r=>r.source_type==='fbp_replenishment').map(r=>Number(String(r.source_ref).split(':')[1])).filter(Boolean))];
    const orders=orderIds.length?await query(`SELECT o.id,o.order_no,o.created_at,o.submitted_at FROM fbp_replenishment_orders o JOIN shops s ON s.id=o.shop_id AND ${inventoryTenantSql(scope,'s')} WHERE o.id IN (${orderIds.map(()=>'?').join(',')})`,orderIds):[];
    const siblings=orderIds.length?await query(`SELECT f.source_ref FROM fbp_transfer_records f JOIN shops s ON s.id=f.shop_id AND ${inventoryTenantSql(scope,'s')} WHERE f.source_type='fbp_replenishment' AND f.listed_quantity>0 AND CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(f.source_ref,':',2),':',-1) AS UNSIGNED) IN (${orderIds.map(()=>'?').join(',')})`,orderIds):[];
    return {rows:rows.map(row=>{
      const base=baseline.get(Number(row.id)),stock=stockMap.get(pair(row));
      const consumed=consumption.filter(r=>pair(r)===pair(row)&&stamp(r.consumed_at)>stamp(base?.synced_at)&&stamp(r.consumed_at)<=stamp(stock?.synced_at)).reduce((s,r)=>s+Number(r.quantity),0);
      const orderId=row.source_type==='fbp_replenishment'?Number(String(row.source_ref).split(':')[1]):null,order=orders.find(o=>Number(o.id)===orderId);
      const days=settingsMap.get(Number(row.product_id))?.fbp_days??settingsMap.get(0)?.fbp_days??7;
      const estimated={...row,expected_arrival_at:row.expected_arrival_at||(Number.isFinite(stamp(row.shipped_at))?new Date(stamp(row.shipped_at)+Number(days)*86400000).toISOString():null)};
      return {...row,...fbpReceiptEvidence(estimated,base,stock,consumed),recorded_expected_arrival_at:row.expected_arrival_at||null,overlapping_batches:Number(overlaps.find(other=>pair(other)===pair(row))?.open_batches||0),order_id:orderId,order_no:order?.order_no,application_at:order?.submitted_at||order?.created_at||row.created_at,
        arrival_at:arrival.get(Number(row.id))?.arrival_at||confirmations.get(Number(row.id))?.arrival_at||row.closed_at||null,sibling_received:siblings.some(s=>s.source_ref!==row.source_ref&&Number(String(s.source_ref).split(':')[1])===orderId)};
    }),total:Number(rows[0]?.total)||0};
  }
  return {records};
}
