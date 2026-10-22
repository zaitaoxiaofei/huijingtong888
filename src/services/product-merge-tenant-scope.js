import { inventoryTenantSql } from './inventory-tenant-scope.js';

// Product IDs alone cannot authorize a reference: a legacy corrupt row may
// belong to another enterprise while pointing at one of our products.
export function productMergeReferenceTenantSql(scope, key, alias = 'merge_ref') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid merge alias');
  const own = tableAlias => inventoryTenantSql(scope, tableAlias);
  const shop = column => `EXISTS (SELECT 1 FROM shops merge_shop WHERE merge_shop.id = ${column} AND ${own('merge_shop')})`;
  const optional = (column, condition) => `(${column} IS NULL OR ${condition})`;
  const direct = own(alias);
  const ownShop = optional(`${alias}.shop_id`, shop(`${alias}.shop_id`));
  const purchase = column => `EXISTS (SELECT 1 FROM purchase_orders merge_po WHERE merge_po.id = ${column} AND ${own('merge_po')})`;
  const order = column => `EXISTS (SELECT 1 FROM orders merge_order JOIN shops merge_order_shop ON merge_order_shop.id = merge_order.shop_id WHERE merge_order.id = ${column} AND ${own('merge_order_shop')})`;
  const orderItem = (column, sameShop = false) => `EXISTS (SELECT 1 FROM order_items merge_item JOIN orders merge_order ON merge_order.id = merge_item.order_id JOIN shops merge_order_shop ON merge_order_shop.id = merge_order.shop_id WHERE merge_item.id = ${column} AND ${own('merge_order_shop')}${sameShop ? ` AND (${alias}.shop_id IS NULL OR ${alias}.shop_id = merge_order.shop_id)` : ''})`;
  switch (key) {
    case 'child_products': return direct;
    case 'online_products':
    case 'ozon_stock_snapshots':
    case 'analytics_product_profit_daily':
    case 'analytics_sku_profit_daily': return shop(`${alias}.shop_id`);
    case 'sku_mappings': return `${direct} AND ${shop(`${alias}.shop_id`)} AND ${optional(`${alias}.online_product_id`, `EXISTS (SELECT 1 FROM online_products merge_online WHERE merge_online.id = ${alias}.online_product_id AND merge_online.shop_id = ${alias}.shop_id)` )}`;
    case 'procurement_requests': return `${direct}
      AND ${optional(`${alias}.supplier_id`, `EXISTS (SELECT 1 FROM suppliers merge_supplier WHERE merge_supplier.id = ${alias}.supplier_id AND ${own('merge_supplier')})`)}
      AND ${optional(`${alias}.purchase_order_id`, purchase(`${alias}.purchase_order_id`))}
      AND (${alias}.source_order_id IS NULL OR (${alias}.source_type = 'fbp' AND EXISTS (SELECT 1 FROM fbp_replenishment_orders merge_fbp JOIN shops merge_fbp_shop ON merge_fbp_shop.id = merge_fbp.shop_id WHERE merge_fbp.id = ${alias}.source_order_id AND ${own('merge_fbp_shop')})) OR (COALESCE(${alias}.source_type, '') != 'fbp' AND ${order(`${alias}.source_order_id`)}))
      AND (${alias}.source_order_item_id IS NULL OR (${alias}.source_type = 'fbp' AND EXISTS (SELECT 1 FROM fbp_replenishment_order_items merge_fbp_item JOIN fbp_replenishment_orders merge_fbp ON merge_fbp.id = merge_fbp_item.order_id AND merge_fbp.shop_id = merge_fbp_item.shop_id JOIN shops merge_fbp_shop ON merge_fbp_shop.id = merge_fbp.shop_id WHERE merge_fbp_item.id = ${alias}.source_order_item_id AND ${own('merge_fbp_shop')})) OR (COALESCE(${alias}.source_type, '') != 'fbp' AND ${orderItem(`${alias}.source_order_item_id`)}))`;
    case 'inbound_records': return `${direct}
      AND ${optional(`${alias}.purchase_order_id`, purchase(`${alias}.purchase_order_id`))}
      AND ${optional(`${alias}.purchase_order_item_id`, `EXISTS (SELECT 1 FROM purchase_order_items merge_poi JOIN purchase_orders merge_po ON merge_po.id = merge_poi.purchase_order_id WHERE merge_poi.id = ${alias}.purchase_order_item_id AND merge_poi.product_id = ${alias}.product_id AND ${own('merge_poi')} AND ${own('merge_po')})`)}
      AND ${optional(`${alias}.procurement_request_id`, `EXISTS (SELECT 1 FROM procurement_requests merge_pr WHERE merge_pr.id = ${alias}.procurement_request_id AND merge_pr.product_id = ${alias}.product_id AND ${own('merge_pr')})`)}`;
    case 'outbound_records': return `${ownShop} AND ${optional(`${alias}.order_item_id`, `EXISTS (SELECT 1 FROM order_items merge_item JOIN orders merge_order ON merge_order.id = merge_item.order_id JOIN shops merge_order_shop ON merge_order_shop.id = merge_order.shop_id WHERE merge_item.id = ${alias}.order_item_id AND merge_order.shop_id = ${alias}.shop_id AND merge_order.posting_number = ${alias}.order_ref AND ${own('merge_order_shop')})`)}`;
    case 'inventory_movements': return `${direct} AND ${ownShop} AND ${optional(`${alias}.related_order_item_id`, orderItem(`${alias}.related_order_item_id`, true))}`;
    case 'purchase_order_items': return `${direct} AND ${purchase(`${alias}.purchase_order_id`)}`;
    case 'fbp_replenishment_order_items': return `EXISTS (SELECT 1 FROM fbp_replenishment_orders merge_fbp JOIN shops merge_fbp_shop ON merge_fbp_shop.id = merge_fbp.shop_id WHERE merge_fbp.id = ${alias}.order_id AND merge_fbp.shop_id = ${alias}.shop_id AND ${own('merge_fbp_shop')})`;
    case 'fbp_transfer_records': return ownShop;
    default: throw new Error('Unsupported merge reference');
  }
}

export function productMergeReferenceKeyWhere(def, refKey, alias = '') {
  const invalid = message => Object.assign(new Error(message), { statusCode: 409 });
  const columns = Array.isArray(def?.idColumn) ? def.idColumn : [def?.idColumn];
  if (!refKey || typeof refKey !== 'object' || Array.isArray(refKey)
    || Object.keys(refKey).length !== columns.length || columns.some(column => !Object.hasOwn(refKey, column))) throw invalid('Invalid merge reference key');
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw invalid('Invalid merge alias');
  for (const column of columns) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) throw invalid('Invalid merge reference column');
    const value = refKey[column];
    if (column === 'date_key') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw invalid('Invalid merge date key'); }
    else if (column === 'ozon_sku') { if (typeof value !== 'string' || value.length > 128) throw invalid('Invalid merge SKU'); }
    else if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw invalid('Invalid merge record ID');
  }
  return { clause: columns.map(column => `${alias ? `${alias}.` : ''}${column} = ?`).join(' AND '), params: columns.map(column => refKey[column]) };
}
