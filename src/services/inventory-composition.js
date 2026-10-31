import { inventoryTenantSql } from './inventory-tenant-scope.js';
import { physicalInventoryComponents } from '../shared/inventory-composition.js';

export async function loadInventoryComposition(query, scope) {
  const [products, edges] = await Promise.all([
    query(`SELECT p.id,p.name,p.inventory_number,p.code,p.stock_unit,p.active FROM products p WHERE ${inventoryTenantSql(scope, 'p')}`),
    query(`SELECT c.product_id,c.component_product_id,c.quantity FROM product_components c
      JOIN products p ON p.id=c.product_id AND ${inventoryTenantSql(scope, 'p')}
      WHERE ${inventoryTenantSql(scope, 'c')}`)
  ]);
  const byId = new Map(products.map(p => [Number(p.id), p]));
  const components = id => physicalInventoryComponents(id, products, edges);
  const affected = (id, rootIds) => {
    const roots = rootIds ? [...new Set(rootIds.map(Number))] : [...new Set(edges.map(e => Number(e.product_id)))];
    return roots.filter(root => root !== Number(id) && byId.has(root)).flatMap(root => {
      try {
        const part = components(root).find(p => Number(p.id) === Number(id));
        return part ? [{ ...byId.get(root), per_set_quantity: part.per_set_quantity }] : [];
      } catch { return []; }
    });
  };
  return { products: byId, edges, components, affected, isBundle: id => edges.some(e => Number(e.product_id) === Number(id)) };
}
