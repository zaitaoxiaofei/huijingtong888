// Candidate selection only narrows the scan; the canonical mapping/recipe and
// historical-evidence predicates still decide the final demand rows.
export function procurementDemandCandidates({demandIds,stockIds,tenantScope}){
 const mapping=`cm.active=1 AND cm.product_id IN (${demandIds})${tenantScope('cm.tenant_id')}`;
 return `SELECT ci.id FROM sku_mappings cm JOIN order_items ci ON ci.sku_mapping_id=cm.id
   JOIN orders co ON co.id=ci.order_id AND co.shop_id=cm.shop_id
   JOIN shops cs ON cs.id=co.shop_id${tenantScope('cs.tenant_id')} WHERE ${mapping}
 UNION SELECT ci.id FROM sku_mappings cm JOIN order_items ci ON ci.ozon_sku=cm.ozon_sku
   JOIN orders co ON co.id=ci.order_id AND co.shop_id=cm.shop_id
   JOIN shops cs ON cs.id=co.shop_id${tenantScope('cs.tenant_id')} WHERE ${mapping}
 UNION SELECT ci.id FROM sku_inventory_recipe_items cri JOIN sku_inventory_recipes cr ON cr.id=cri.recipe_id
   JOIN order_items ci ON ci.ozon_sku=cr.ozon_sku JOIN orders co ON co.id=ci.order_id AND co.shop_id=cr.shop_id
   JOIN shops cs ON cs.id=co.shop_id${tenantScope('cs.tenant_id')}
   WHERE cr.active=1 AND cr.mode='combo' AND cri.product_id IN (${demandIds})
 UNION SELECT related_order_item_id AS id FROM inventory_movements WHERE product_id IN (${stockIds})${tenantScope()}
   AND status='posted' AND source_type='order_outbound' AND related_order_item_id IS NOT NULL`;
}
