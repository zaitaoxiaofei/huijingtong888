import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { applyStockAlertQuery } from '../src/services/inventory-alert-utils.js';
import { getCachedMasterData, invalidateMasterDataCache, invalidateMasterDataCachePrefix } from '../src/services/mysql-master-data-cache.js';

const service = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../frontend/admin/views/inventory/InventoryAlertsPage.vue', import.meta.url), 'utf8');

test('inventory alert base is tenant scoped, reused across filters, and refreshed after writes', async () => {
  const tenantA = 17001;
  const tenantB = 17002;
  const stock = new Map([[tenantA, 5], [tenantB, 9]]);
  const calls = { products: [], coverage: [], summarySkus: [], pageSkus: [], invalidations: 0 };
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {},
    ensureProductNamingSchemaMysql: async () => {},
    ensureOzonStockStorageSchemaMysql: async () => {},
    ensureStockLocationSchemaMysql: async () => {},
    ensureProfitAnalyticsSchemaMysql: async () => {},
    ensureSkuInventoryRecipeSchemaMysql: async () => {},
    ensureProductCompositionSchemaMysql: async () => {},
    mysqlSchemaColumnExists: async () => true,
    resolveShopTenantIdMysql: async (tenantId) => tenantId === 'tenant-a' ? tenantA : tenantB,
    isDefaultShopTenantMysql: async () => false,
    stockedInventoryAlertProductsMysql: async (tenantPk) => {
      calls.products.push(tenantPk);
      return [{ product_id: tenantPk, product_name: `Inventory ${tenantPk}`, production_lead_days: 7 }];
    },
    inventoryAlertProductSalesMysql: async (tenantPk) => [{ product_id: tenantPk, shop_id: tenantPk + 100,
      shop_name: `Shop ${tenantPk}`, ozon_sku: `SKU-${tenantPk}`, recent_7d_qty: 1, recent_15d_qty: 1, recent_30d_qty: 1 }],
    purchasedInventoryInTransitMysql: async () => [],
    orderProcurementCoverageMysql: async ({ productIds, tenantId }) => {
      calls.coverage.push([tenantId, ...productIds]);
      const quantity = stock.get(tenantId);
      return { product_availability: new Map([[tenantId, { physical_stock: quantity, available_stock: quantity }]]) };
    },
    inventoryAlertProductSkusMysql: async (ids, tenantPk, _defaultTenant, summaryOnly) => {
      (summaryOnly ? calls.summarySkus : calls.pageSkus).push([tenantPk, ...ids]);
      return ids.map((id) => ({ product_id: id, mapping_id: id + 1, shop_id: tenantPk + 100,
        shop_name: `Shop ${tenantPk}`, ozon_sku: `SKU-${id}` }));
    },
    getCachedMasterData,
    invalidateMasterDataCache,
    invalidateMasterDataCachePrefix,
    invalidateProcurementCoverageCache: () => { calls.invalidations += 1; },
    applyStockAlertQuery
  });
  const start = service.indexOf('export async function stockAlertsMysql');
  const end = service.indexOf('async function loadFbpStockAlertBaseMysql', start);
  const invalidatorStart = service.indexOf('function invalidateOrderProcurementCoverage()');
  const invalidatorEnd = service.indexOf('function fbpTransferInTransitWhereMysql', invalidatorStart);
  vm.runInContext(service.slice(start, end).replace('export ', ''), context);
  vm.runInContext(service.slice(invalidatorStart, invalidatorEnd), context);
  const query = { mode: 'inventory-alerts', paged: '1', pageSize: 20 };
  try {
    const first = await context.stockAlertsMysql(query, 'tenant-a');
    const filtered = await context.stockAlertsMysql({ ...query, alertType: 'healthy', page: 2 }, 'tenant-a');
    const other = await context.stockAlertsMysql(query, 'tenant-b');
    assert.equal(first.rows[0].available_stock, 5);
    assert.equal(filtered.total, 1);
    assert.equal(other.rows[0].available_stock, 9);
    assert.deepEqual(calls.products, [tenantA, tenantB]);
    assert.deepEqual(calls.coverage, [[tenantA, tenantA], [tenantB, tenantB]]);
    assert.equal(calls.summarySkus.length, 2);
    assert.equal(calls.pageSkus.length, 3);

    const cachedA = await getCachedMasterData(`stock-alerts:inventory-base:v1:${tenantA}`, () => { throw new Error('cache miss'); });
    assert.equal(cachedA.baseRows[0].skus[0].mapping_id, undefined);
    assert.equal(first.rows[0].skus[0].mapping_id, tenantA + 1);

    stock.set(tenantA, 2);
    assert.equal((await context.stockAlertsMysql(query, 'tenant-a')).rows[0].available_stock, 5);
    assert.equal((await context.stockAlertsMysql({ ...query, refresh: '1' }, 'tenant-a')).rows[0].available_stock, 2);
    assert.equal(calls.coverage.length, 3);

    stock.set(tenantB, 1);
    context.invalidateOrderProcurementCoverage();
    assert.equal(calls.invalidations, 1);
    assert.equal((await context.stockAlertsMysql(query, 'tenant-b')).rows[0].available_stock, 1);
    assert.equal(calls.coverage.length, 4);
  } finally {
    invalidateMasterDataCachePrefix('stock-alerts:inventory-base:v1:');
    invalidateMasterDataCachePrefix('stock-alerts:product-sales:v3:');
  }
});

test('inventory edits request a fresh alert base before updating the page', () => {
  assert.match(page, /async function loadPageData\(\{ refresh = false \} = \{\}\)/);
  assert.match(page, /if \(refresh\) params\.set\("refresh", "1"\)/);
  assert.match(page, /@saved="loadPageData\(\{ refresh: true \}\)"/);
  assert.match(page, /@submitted="loadPageData\(\{ refresh: true \}\)"/);
  assert.match(page, /时长已更新，预警线已重新计算"\);\s*await loadPageData\(\{ refresh: true \}\)/);
});
