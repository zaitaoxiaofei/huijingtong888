import { inventoryTenantSql } from './inventory-tenant-scope.js';
import { createPhysicalInventoryReader } from '../shared/inventory-composition.js';

export async function loadInventoryComposition(query, scope) {
  const [products, edges] = await Promise.all([
    query(`SELECT p.id,p.name,p.inventory_number,p.code,p.stock_unit,p.active,p.is_accessory FROM products p WHERE ${inventoryTenantSql(scope, 'p')}`),
    query(`SELECT c.product_id,c.component_product_id,c.quantity FROM product_components c
      JOIN products p ON p.id=c.product_id AND ${inventoryTenantSql(scope, 'p')}
      WHERE ${inventoryTenantSql(scope, 'c')}`)
  ]);
  const byId = new Map(products.map(p => [Number(p.id), p]));
  // Request-scoped indexes: rebuild from current owned rows on each read, but
  // never rebuild the entire product/BOM map for every component and parent.
  const components = createPhysicalInventoryReader(products,edges);
  const roots=new Set(edges.map(e=>Number(e.product_id))),reverse=new Map();
  let indexed=false;
  const affected = (id, rootIds) => {
    if(!indexed){
      for(const root of roots){
        if(!byId.has(root))continue;
        try{for(const part of components(root)){
          const leaf=Number(part.id);if(!reverse.has(leaf))reverse.set(leaf,[]);
          reverse.get(leaf).push({...byId.get(root),per_set_quantity:part.per_set_quantity});
        }}catch{/* Invalid compositions remain blocked by components(), not guessed. */}
      }
      indexed=true;
    }
    const selected=rootIds?new Set(rootIds.map(Number)):null;
    return (reverse.get(Number(id))||[]).filter(root=>Number(root.id)!==Number(id)&&(!selected||selected.has(Number(root.id))));
  };
  return { products: byId, edges, components, affected, isBundle: id => roots.has(Number(id)) };
}
