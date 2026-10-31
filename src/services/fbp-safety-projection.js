import {loadProductsFbpStockDetails} from './fbp-inventory-display.js';
import {inventoryTenantSql} from './inventory-tenant-scope.js';
import {validateFlowSettings,flowLeadDays} from './inventory-flow-rules.js';
import {orderTransportEvidenceSql} from './order-transport-evidence.js';
import {shanghaiDateKey,shanghaiDateDaysAgo} from '../shanghai-time.js';

// Batch local snapshots, not one forecast/remote API per product. Local-only
// first paint never calls this projection.
export async function loadFbpSafetyProjections(query,products,scope,settingsFor){
 const official=await loadProductsFbpStockDetails(query,products.map(p=>Number(p.id)),scope);
 const pairs=[...new Map([...official.values()].flatMap(v=>v.rows).map(r=>[`${r.shop_id}:${r.ozon_sku}`,r])).values()];
 const index=new Map();
 const dayStart=days=>new Date(`${days?shanghaiDateDaysAgo(days):shanghaiDateKey()}T00:00:00+08:00`).toISOString().slice(0,19).replace('T',' ');
 if(pairs.length){
  const where=(a,b)=>pairs.map(()=>`(${a}=? AND ${b}=?)`).join(' OR '),args=pairs.flatMap(r=>[r.shop_id,r.ozon_sku]);
  const [sales,transit,committed]=await Promise.all([
   query(`SELECT o.shop_id,i.ozon_sku,SUM(i.quantity) AS quantity FROM orders o JOIN shops s ON s.id=o.shop_id AND ${inventoryTenantSql(scope,'s')}
    JOIN order_items i ON i.order_id=o.id WHERE (${where('o.shop_id','i.ozon_sku')}) AND o.ordered_at>=? AND o.ordered_at<?
    AND (LOWER(CONCAT_WS(' ',o.status,o.tracking_stage)) NOT LIKE '%cancel%' OR ${orderTransportEvidenceSql('o')})
    AND EXISTS(SELECT 1 FROM ozon_orders_raw raw WHERE raw.store_id=o.shop_id AND raw.posting_number=o.posting_number AND raw.query_stock_location IN ('FBP','OGR'))
    AND NOT EXISTS(SELECT 1 FROM order_items newer WHERE newer.order_id=i.order_id AND newer.ozon_sku=i.ozon_sku AND newer.id>i.id)
    GROUP BY o.shop_id,i.ozon_sku`,[...args,dayStart(14),dayStart(0)]),
   query(`SELECT f.shop_id,f.ozon_sku,SUM(GREATEST(f.quantity-f.listed_quantity,0)) AS quantity FROM fbp_transfer_records f JOIN shops s ON s.id=f.shop_id AND ${inventoryTenantSql(scope,'s')}
    WHERE (${where('f.shop_id','f.ozon_sku')}) AND f.status IN ('sent','in_transit','received')
    AND (f.product_id IS NULL OR EXISTS(SELECT 1 FROM products p WHERE p.id=f.product_id AND ${inventoryTenantSql(scope,'p')})) GROUP BY f.shop_id,f.ozon_sku`,args),
   query(`SELECT i.shop_id,i.ozon_sku,SUM(GREATEST(0,i.approved_qty+COALESCE((SELECT SUM(a.adjustment_qty) FROM fbp_replenishment_item_adjustments a WHERE a.item_id=i.id),0))) AS quantity
    FROM fbp_replenishment_order_items i JOIN fbp_replenishment_orders o ON o.id=i.order_id AND o.shop_id=i.shop_id JOIN shops s ON s.id=o.shop_id AND ${inventoryTenantSql(scope,'s')}
    WHERE (${where('i.shop_id','i.ozon_sku')}) AND o.status IN ('approved','ozon_created')
    AND (i.product_id IS NULL OR EXISTS(SELECT 1 FROM products p WHERE p.id=i.product_id AND ${inventoryTenantSql(scope,'p')}))
    AND (i.mapping_id IS NULL OR EXISTS(SELECT 1 FROM sku_mappings m WHERE m.id=i.mapping_id AND m.shop_id=i.shop_id AND m.product_id=i.product_id AND ${inventoryTenantSql(scope,'m')}))
    GROUP BY i.shop_id,i.ozon_sku`,args)
  ]);
  for(const [field,rows] of [['sales',sales],['in_transit',transit],['committed_qty',committed]])for(const r of rows){const key=`${r.shop_id}:${r.ozon_sku}`;if(!index.has(key))index.set(key,{});index.get(key)[field]=Number(r.quantity)||0;}
 }
 return new Map(products.map(p=>{
  const cfg=validateFlowSettings(settingsFor(Number(p.id))),days=flowLeadDays((cfg.production_days??Number(p.production_lead_days??7))+(cfg.local_days??Number(p.warehouse_logistics_days??2))+cfg.fbp_days,15,cfg.holidays);
  const stocks=official.get(Number(p.id));const groups=new Map();
  for(const row of stocks?.rows||[]){const key=`${row.shop_id}:${row.ozon_sku}`;if(!groups.has(key))groups.set(key,{...row,available:0});if(row.available!=null)groups.get(key).available+=Number(row.available);}
  const skus=[...groups].map(([key,row])=>{const r=index.get(key)||{};return{...row,available:row.available,fbp_target:Math.ceil((r.sales||0)/14*days),in_transit:r.in_transit||0,committed_qty:r.committed_qty||0};});
  return[Number(p.id),{skus,stock_incomplete:stocks?.incomplete??true}];
 }));
}
