import {resolveInventoryTenantScope,inventoryTenantSql} from './inventory-tenant-scope.js';
// Reverse a bounded SKU selection to physical inventory. Virtual parent IDs are
// not purchase items; a SKU recipe overrides its parent's component recipe.
export async function fbpSupplyProductIds(query,rows,tenantId){
 const scope=await resolveInventoryTenantScope(tenantId,query);
 const pairs=[...new Map(rows.map(r=>[`${Number(r.shop_id)}:${r.ozon_sku}`,r])).values()];
 if(!pairs.length||pairs.length>100)throw Object.assign(new Error('请选择1至100个店铺SKU，再按库存汇总需求'),{statusCode:400});
 const args=pairs.flatMap(r=>[Number(r.shop_id),String(r.ozon_sku)]),where=alias=>pairs.map(()=>`(${alias}.shop_id=? AND ${alias}.ozon_sku=?)`).join(' OR ');
 const mappings=await query(`SELECT m.shop_id,m.ozon_sku,m.product_id FROM sku_mappings m JOIN shops s ON s.id=m.shop_id AND ${inventoryTenantSql(scope,'s')}
  JOIN products p ON p.id=m.product_id AND ${inventoryTenantSql(scope,'p')} WHERE m.active=1 AND ${inventoryTenantSql(scope,'m')} AND (${where('m')})
  AND m.id=(SELECT MIN(other.id) FROM sku_mappings other WHERE other.active=1 AND other.shop_id=m.shop_id AND other.ozon_sku=m.ozon_sku AND ${inventoryTenantSql(scope,'other')})`,args);
 const roots=[...new Set(mappings.map(m=>Number(m.product_id)))];
 const [components,recipes]=await Promise.all([
  roots.length?query(`SELECT c.product_id,c.component_product_id,p.id AS owned_product_id FROM product_components c LEFT JOIN products p ON p.id=c.component_product_id AND ${inventoryTenantSql(scope,'p')} WHERE c.product_id IN (${roots.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'c')}`,roots):[],
  query(`SELECT r.shop_id,r.ozon_sku,i.product_id,p.id AS owned_product_id FROM sku_inventory_recipes r JOIN shops s ON s.id=r.shop_id AND ${inventoryTenantSql(scope,'s')}
   JOIN sku_inventory_recipe_items i ON i.recipe_id=r.id LEFT JOIN products p ON p.id=i.product_id AND ${inventoryTenantSql(scope,'p')}
   WHERE r.active=1 AND (${where('r')})`,args)
 ]);
 if([...components,...recipes].some(row=>!row.owned_product_id))throw Object.assign(new Error('SKU库存组成（product_id）包含当前企业不可访问的库存，请在SKU绑定中修正归属后重新提交'),{statusCode:403});
 const ids=new Set();for(const row of pairs){
  const explicit=recipes.filter(r=>Number(r.shop_id)===Number(row.shop_id)&&r.ozon_sku===String(row.ozon_sku));
  if(explicit.length){for(const r of explicit)ids.add(Number(r.product_id));continue;}
  const mapping=mappings.find(m=>Number(m.shop_id)===Number(row.shop_id)&&m.ozon_sku===String(row.ozon_sku));if(!mapping)throw Object.assign(new Error('所选店铺SKU的库存绑定已变化，请在SKU绑定中核对后重新提交'),{statusCode:409});
  const parts=components.filter(c=>Number(c.product_id)===Number(mapping.product_id));
  if(parts.length)for(const part of parts)ids.add(Number(part.component_product_id));else ids.add(Number(mapping.product_id));
 }
 return [...ids].sort((a,b)=>a-b);
}
