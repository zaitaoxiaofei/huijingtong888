const reads = new Set(['pricing-commissions','catalog/parents','catalog/categories','catalog/schema','workbench-drafts','listing-templates','listing-drafts','listing-source','shops', 'products', 'warehouses', 'categories', 'characteristics', 'publish-errors', 'supply', 'promotions', 'promotion-products', 'prices', 'price-result', 'inventory-usage', 'stocks']);
const writes = new Set(['listing-preview','listing-templates/save','listing-drafts/save','listing-drafts/validate','shops/save', 'check', 'warehouses/save', 'products/sync', 'publish', 'orders/sync', 'orders/prepare', 'orders/stickers', 'supply/action', 'products/bind', 'products/media', 'prices/set', 'promotions/enroll', 'stocks/set']);
export function wbRoutePermission(parts, method) {
  if (parts[0] !== 'api' || parts[1] !== 'wb') return null;
  const path = parts.slice(2).join('/');
  if (method === 'GET' && path === 'inventory-usage') return 'inventory.read';
  if (method === 'GET' && reads.has(path)) return ['supply','shops','pricing-commissions'].includes(path) ? 'orders.read' : 'operations';
  if (method !== 'POST' || !writes.has(path)) return null;
  if (path === 'shops/save' || path === 'check' || path === 'warehouses/save') return 'enterprise.admin';
  if (['orders/prepare', 'orders/stickers', 'supply/action'].includes(path)) return 'packing';
  return 'operations';
}
