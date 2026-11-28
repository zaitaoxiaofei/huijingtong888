const reads = new Set(['publish-records','product-operations','product-operation','publish-jobs','publish-job','catalog/brands','catalog/options','card-limits','pricing-commissions','catalog/parents','catalog/categories','catalog/schema','workbench-drafts','listing-templates','listing-drafts','listing-source','shops', 'products', 'warehouses', 'categories', 'characteristics', 'publish-errors', 'supply', 'orders/financial-evidence', 'promotions', 'promotion-products', 'prices', 'price-result', 'inventory-usage', 'stocks']);
const writes = new Set(['orders/recalculate-profit','products/refresh','products/create-inventory','publish-records/sync','publish-records/delete','product-operation/review','product-operation/submit','product-operation/resume','listing-publish/review','listing-publish/submit','listing-publish/resume','listing-barcodes','listing-preview','listing-templates/save','listing-drafts/save','listing-drafts/validate','shops/save', 'check', 'warehouses/save', 'products/sync', 'publish', 'orders/sync', 'orders/sync-media', 'orders/sync-settlement', 'orders/bind-inventory', 'orders/create-inventory', 'orders/prepare', 'orders/stickers', 'supply/action', 'products/bind', 'products/media', 'prices/set', 'promotions/enroll', 'stocks/batch/read','stocks/batch/set','stocks/set']);
export function wbRoutePermission(parts, method) {
  if (parts[0] !== 'api' || parts[1] !== 'wb') return null;
  const path = parts.slice(2).join('/');
  if (method === 'GET' && path === 'inventory-usage') return 'inventory.read';
  if (method === 'GET' && reads.has(path)) return ['supply','shops','pricing-commissions','card-limits','orders/financial-evidence'].includes(path) ? 'orders.read' : 'operations';
  if (method !== 'POST' || !writes.has(path)) return null;
  if (path === 'orders/sync-settlement') return 'finance';
  if (path === 'orders/recalculate-profit') return 'orders.manage';
  if (path === 'orders/sync-media') return 'orders.manage';
  if (['products/bind','products/create-inventory','orders/bind-inventory','orders/create-inventory'].includes(path)) return 'inventory.write';
  if (path === 'shops/save' || path === 'check' || path === 'warehouses/save') return 'enterprise.admin';
  if (['orders/prepare', 'orders/stickers', 'supply/action'].includes(path)) return 'packing';
  return 'operations';
}
