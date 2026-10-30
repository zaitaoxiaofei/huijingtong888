import { normalizeVehicleBrand } from '../shared/vehicle-brand.js';
import { inventoryTenantSql } from './inventory-tenant-scope.js';
import { inventoryIdentifierSearch, inventoryNamePattern } from './inventory-search.js';

// Additional product predicates only. Existing page status/date/shop filters still apply.
export function inventoryProductSearch(query, scope, alias = 'p') {
  if (!/^[a-z_]+$/i.test(alias)) throw new Error('Invalid product alias');
  query = { ...query };
  for (const [key, legacy] of Object.entries({inventoryCategory:'inventory_category', productName:'product_name', vehicleBrand:'vehicle_brand', fitmentType:'fitment_type', vehicleModel:'vehicle_model', accessoryName:'accessory_name', process:'surface_process'})) {
    if (!query[key]) query[key] = query[legacy];
  }
  const where = [], params = [];
  const add = (sql, ...values) => { where.push(sql); params.push(...values); };
  for (const [key, column] of [['inventoryCategory','inventory_category'], ['accessoryName','accessory_name'], ['process','surface_process']]) {
    const value = String(query[key] || '').trim();
    if (value) add(`${alias}.${column} = ?`, value);
  }
  const brand = normalizeVehicleBrand(query.vehicleBrand, { strict: false });
  if (brand) add(`${alias}.vehicle_brand = ?`, brand);
  if (['universal','specific'].includes(query.fitmentType)) add(`${alias}.fitment_type = ?`, query.fitmentType);
  const name = String(query.productName || '').trim();
  if (name) add(`${alias}.name LIKE ? ESCAPE '='`, inventoryNamePattern(name));
  for (const [key,column] of [['vehicleModel','vehicle_model'], ['material','material']]) {
    const values = String(query[key] || '').split(',').map(v=>v.trim()).filter(Boolean);
    if (values.length) add(`(${values.map(()=>`CONCAT('/', COALESCE(${alias}.${column}, ''), '/') LIKE ? ESCAPE '='`).join(' OR ')})`, ...values.map(v=>inventoryNamePattern('/'+v+'/')));
  }
  const color = String(query.color || '').trim();
  if (color) add(`CONCAT(',', REPLACE(REPLACE(COALESCE(${alias}.color, ''), '，', ','), '/', ','), ',') LIKE ? ESCAPE '='`, inventoryNamePattern(','+color+','));
  const text = String(query.query || '').trim();
  if (text && query.searchMode === 'inventory_id') {
    const match = inventoryIdentifierSearch(text, 'inventory_id');
    add(`${alias}.id IN (${match.sql})`, ...match.params);
  } else if (text && query.searchMode === 'sku') {
    add(`EXISTS (SELECT 1 FROM sku_mappings search_sm JOIN shops search_shop ON search_shop.id=search_sm.shop_id AND ${inventoryTenantSql(scope,'search_shop')}
      WHERE search_sm.product_id=${alias}.id AND search_sm.active=1 AND ${inventoryTenantSql(scope,'search_sm')}
      AND (search_sm.ozon_sku=? OR search_sm.offer_id=?))`, text, text);
  } else if (text && query.searchMode === 'name') {
    for (const term of text.split(/\s+/)) add(`(${alias}.name LIKE ? ESCAPE '=' OR EXISTS (SELECT 1 FROM product_name_aliases search_alias
      WHERE search_alias.product_id=${alias}.id AND search_alias.active=1 AND ${inventoryTenantSql(scope,'search_alias')} AND search_alias.alias_name LIKE ? ESCAPE '='))`, inventoryNamePattern(term), inventoryNamePattern(term));
  }
  return { sql: where.length ? where.join(' AND ') : '', params };
}

// Filter cached rows before business summaries and pagination; never fetch full product payloads.
export async function filterInventoryProductRows(rows, query, scope, execute) {
  if (!rows.length) return rows;
  const criteria = inventoryProductSearch(query, scope);
  if (!criteria.sql) return rows;
  const matched = await execute(`SELECT p.id FROM products p WHERE ${inventoryTenantSql(scope,'p')} AND ${criteria.sql}`, criteria.params);
  const ids = new Set(matched.map(row=>Number(row.id)));
  return rows.filter(row=>ids.has(Number(row.product_id)));
}
export function inventoryBusinessSearch(query) {
  return ['inventory_id','sku','name'].includes(query.searchMode) ? { ...query, query: '', search: '', inventorySku: query.searchMode === 'sku' ? String(query.query || query.search || '').trim() : '' } : query;
}
