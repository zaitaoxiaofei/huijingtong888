import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeFbpReplenishmentItem, normalizeFbpTransferRecord } from '../src/services/mysql-fbp-normalizers.js';
import { inventoryLedgerView } from '../src/services/inventory-ledger-view.js';
import { applyStockAlertQuery } from '../src/services/inventory-alert-utils.js';
import { inventoryProductSearch } from '../src/services/inventory-product-search.js';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const scope = { id: 2, isDefault: false, predicate: (alias = '') => ({ sql: `${alias ? alias + '.' : ''}tenant_id = ?`, params: [2] }) };
const extract = (name, next) => source.slice(source.indexOf(name), source.indexOf(next, source.indexOf(name))).replaceAll('export ', '');
const nullableInteger = value => value == null || value === '' ? null : Number(value);

function commonContext(extra = {}) {
  return vm.createContext({
    ensureMysqlCutoverEnabled() {}, ensureSelectionCreativeSchemaMysql: async () => {}, ensureProductCompositionSchemaMysql: async () => {}, ensureProductNamingSchemaMysql: async () => {}, ensureStockLocationSchemaMysql: async () => {},
    ensureProductNameAliasSchema:async()=>{},readProductIdentity:async(_q,_s,id)=>({id}),recordProductEdit:async()=>{},
    resolveInventoryTenantScope: async () => scope, mysqlSchemaColumnExists: async () => true,
    inventoryTenantSql: (_scope, alias = '') => `${alias ? alias + '.' : ''}tenant_id = 2`,
    assertInventoryRecord: async () => {}, assertInventoryReferences: async () => {}, assertFreshRecord() {},
    nullableInteger, normalizeVehicleBrand: value => value || '', normalizeVehicleModelKey: () => '',
    resolveDevelopmentMeta: () => ({ development_type: 'new', vehicle_brand: '', vehicle_model: '', vehicle_model_key: '' }),
    normalizeOzonCategoryIdMysql: value => value, normalizeOzonCategoryNameMysql: value => value,
    normalizeProductImageUrlMysql: value => value || '', normalizeProductDetailImagesMysql: value => value || '',
    normalizeStockUnitMysql: value => value || '个', normalizeProductionLeadDaysMysql: value => value ?? null, normalizeWarehouseLogisticsDaysMysql: value => value ?? 2,
    recommendShippingMysql: () => 'air_land', currentExchangeRateValueMysql: async () => 11,
    inventoryProductSearch, invalidateOrderReadCache() {},
    ...extra
  });
}

test('actual tenant product entry separates consumables while retaining their component/accessory role', async () => {
  for (const type of ['normal', 'single', 'combo', 'accessory', 'consumable', 'all']) {
    const calls = [];
    const context = commonContext({ mysqlQuery: async sql => { calls.push(sql); return []; }, mysqlQueryOne: async () => ({ total: 0 }), fbpTransferInTransitWhereMysql: () => "status='sent'", localStockLocationPredicateMysql: () => "stock_location='LOCAL'" });
    vm.runInContext(extract('async function tenantProductsMysql(', 'export async function productsMysql('), context);
    const result = await context.tenantProductsMysql({ inventoryType: type, paged: '1' }, '2');
    assert.equal(result.total, 0);
    const sql = calls[0];
    assert.match(sql, /p\.is_consumable/);
    if (['normal', 'single', 'combo'].includes(type)) assert.match(sql, /COALESCE\(p\.is_consumable, 0\) = 0/);
    else if (type === 'consumable') { assert.match(sql, /p\.is_consumable = 1/); assert.doesNotMatch(sql, /p\.is_accessory = [01]|COALESCE\(p\.is_accessory, 0\) = 0/); }
    else if (type === 'accessory') { assert.match(sql, /p\.is_accessory = 1/); assert.doesNotMatch(sql, /is_consumable[^,]* = 0/); }
    if (type === 'single') assert.match(sql, /NOT EXISTS \(SELECT 1 FROM product_components pc_filter/);
    if (type === 'combo') assert.match(sql, /AND EXISTS \(SELECT 1 FROM product_components pc_filter/);
  }
});

test('creation persists independent class and component flags without dropping composition', async () => {
  for (const flag of [undefined, 0, 1]) {
    let insert, savedComponents;
    const context = commonContext({
      prepareInventoryProductCreationMysql: async () => {}, normalizeStructuredNamingMysql: () => null,
      mysqlConnectionQuery: async () => [], mysqlConnectionQueryOne: async () => ({ id: 7 }),
      normalizePurchasePlanMysql: () => ({}), saveProductComponentsTxMysql: async (_c, _id, items) => { savedComponents = items; },
      maybeCreateProcurementForProductMysql: async () => null,
      withMysqlTransaction: async fn => fn({ execute: async (sql, values) => { insert = { sql, values }; return [{ insertId: 9 }]; } })
    });
    vm.runInContext(extract('export async function createProductMysql(', 'export async function addSelectionToInventoryMysql('), context);
    const components = [{ component_product_id: 41, quantity: 2 }];
    const result = await context.createProductMysql({ name: '气泡袋', owner_person_id: 7, selection_id: 'SEL-9', code: 'P-9', is_accessory: 1, is_consumable: flag, composition_items: components }, null, '2');
    const columns = insert.sql.match(/INSERT INTO products \(([^]*?)\)\s*VALUES/)[1].split(',').map(item => item.trim());
    assert.equal(columns.length, insert.values.length);
    assert.equal(insert.values[columns.indexOf('is_consumable')], flag === 1 ? 1 : 0);
    assert.equal(insert.values[columns.indexOf('is_accessory')], 1);
    assert.equal(result.is_consumable, flag === 1 ? 1 : 0);
    assert.deepEqual(savedComponents, components);
  }
});

test('editing preserves omitted consumable status and changes it without rebinding or synchronizing stock', async () => {
  for (const [oldFlag, requested, expected] of [[1, undefined, 1], [0, 1, 1], [1, 0, 0]]) {
    const writes = []; let synchronized = 0, invalidated = 0;
    const existing = { id: 9, is_consumable: oldFlag, product_type: 'main', selection_status: 'listed', created_by_person_id: 7 };
    const context = commonContext({
      mysqlConnectionQuery: async () => [], mysqlConnectionQueryOne: async (_c, sql) => sql.includes('SELECT id, updated_at') ? existing : { id: 7 },
      withMysqlTransaction: async fn => fn({ execute: async (sql, values) => { writes.push({ sql, values }); return [{ affectedRows: 1 }]; } }),
      isProductImageEndpointMysql: () => false, syncOutboundForOpenOrdersMysql: async () => { synchronized++; },
      invalidateInventoryAlertSalesBindingMysql() {}, invalidateFbpPlanningCachesMysql() { invalidated++; }, invalidateMasterDataCachePrefix() {}
    });
    vm.runInContext(extract('export async function updateProductMysql(', 'export async function updateProductComponentsMysql('), context);
    const result = await context.updateProductMysql(9, { name: '香薰片', owner_person_id: 7, is_accessory: 1, is_consumable: requested }, '2');
    const update = writes.find(row => row.sql.includes('UPDATE products SET'));
    assert(update);
    const flagIndex = (update.sql.slice(0, update.sql.indexOf('is_consumable = ?')).match(/\?/g) || []).length;
    assert.equal(update.values[flagIndex], expected);
    assert.equal(result.is_consumable, expected);
    assert.equal(synchronized, 0, 'class-only edits must not recreate stock movements');
    assert.equal(invalidated, oldFlag === expected ? 0 : 1);
    assert.equal(writes.filter(row => row.sql.startsWith('DELETE FROM inventory_alert_base_snapshots')).length, oldFlag === expected ? 0 : 1);
  }
});

test('list, detail, warehouse ledger and FBP DTOs expose the class without filtering physical usage', () => {
  const context = commonContext({ shouldServeProductImageThroughEndpointMysql: () => false });
  vm.runInContext(extract('function compactProductListRowMysql(', 'function normalizeStockUnitMysql('), context);
  assert.equal(context.compactProductListRowMysql({ id: 9, is_consumable: 1, is_accessory: 1 }).is_consumable, 1);
  assert.equal(context.compactProductListRowMysql({ id: 9 }).is_consumable, 0);
  assert.equal(inventoryLedgerView({ product: { id: 9, is_consumable: 1 } }).product.is_consumable, 1);
  for (const normalize of [normalizeFbpReplenishmentItem, normalizeFbpTransferRecord]) assert.equal(normalize({ product_id: 9, is_consumable: 1 }).is_consumable, 1);
  const products = [{ product_id: 9, is_consumable: 1, skus: [{ shop_id: 1, ozon_sku: '9', fbp_snapshot_count: 1, fbp_present: 10, fbp_available: 10 }] }];
  assert.equal(applyStockAlertQuery(products, { mode: 'fbp' }).rows[0].is_consumable, 1);
  const componentWriter = extract('async function postProductInventoryWithComponentsMysql(', 'async function desiredProductInventoryMovementRowsMysql(');
  assert.doesNotMatch(componentWriter, /is_consumable/);
  const detail = extract('export async function selectionProductMysql(', 'export async function productImageMysql(');
  assert.match(detail, /p\.stock_unit, p\.is_accessory, p\.is_consumable/);
});
