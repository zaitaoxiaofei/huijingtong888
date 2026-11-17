import {inventoryTenantSql} from './inventory-tenant-scope.js';

// Existing parent entries are not prepacked stock. Only explicit conversions
// and finished-unit outbound entries enter this ledger; rollout starts at zero.
export const finishedMovementSql = alias => `(${alias}.source_type IN ('bundle_assembly','bundle_disassembly') OR ${alias}.stock_location_source='bundle_finished')`;
export async function loadBundleFinishedStocks(query, scope) {
 return query(`SELECT im.product_id,SUM(im.quantity_delta) AS ledger FROM inventory_movements im
  JOIN products p ON p.id=im.product_id AND ${inventoryTenantSql(scope,'p')}
  WHERE ${inventoryTenantSql(scope,'im')} AND im.status='posted'
  AND COALESCE(NULLIF(im.stock_location,''),'LOCAL') NOT IN ('FBP','FBO','OGR')
  AND ${finishedMovementSql('im')} GROUP BY im.product_id`);
}

export {allocateBundleFinishedDemands} from '../shared/bundle-finished-stock.js';
