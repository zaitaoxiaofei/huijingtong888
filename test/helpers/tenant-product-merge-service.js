import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadTenantOrderService, orderFunctionSource, createOrderFixtureSchema } from './tenant-order-service.js';
import { productMergeReferenceTenantSql, productMergeReferenceKeyWhere } from '../../src/services/product-merge-tenant-scope.js';

const source = readFileSync(new URL('../../src/services/mysql-cutover.js', import.meta.url), 'utf8');

export async function prepareProductMergeFixture(connection) {
  await createOrderFixtureSchema(connection);
}

export function loadProductMergeFixture(connection, overrides = {}) {
  const followups = [];
  const { service, query, calls } = loadTenantOrderService(connection, {
    extraMethods: ['mysqlConnectionQuery', 'mysqlConnectionQueryOne', 'rebuildInventoryCurrentForProductMysql', 'normalizeMysqlDateTime', 'nullableInteger', 'nullableNumber', 'ensureFbpReplenishmentSchemaMysql', 'ensureFbpReplenishmentBatchSchemaMysql', 'ensureFbpTransferRecordsSchemaMysql', 'productComponentRowsMysql'],
    productMergeReferenceTenantSql, productMergeReferenceKeyWhere,
    productMergeSchemaReadyMysql: false,
    fbpReplenishmentSchemaReadyMysql: false, fbpTransferRecordsSchemaReadyMysql: false,
    normalizeProductImageUrlMysql: value => value || '',
    withProductImageEndpointMysql: row => ({ ...row, image_url: row.image_url ? `/api/products/${row.id}/image` : '' }),
    ensureStockLocationSchemaMysql: async () => {},
    compactProductImageUrlForListMysql: row => row.image_url ? `/api/products/${row.id}/image` : '',
    invalidateOrderProcurementCoverage() {}, invalidateInventoryAlertSalesBindingMysql() {},
    syncOutboundForOpenOrdersMysql: async options => { followups.push(['outbound', options]); },
    recalculateOrderProfitsForProductMysql: async (id, options) => { followups.push(['recalc', id, options]); },
    refreshProfitAnalyticsSnapshotsMysql: async (body, tenant) => { followups.push(['analytics', tenant]); },
    ...overrides
  });
  const constants = ['PRODUCT_MERGE_FIELD_DEFS_MYSQL','PRODUCT_MERGE_REFERENCE_TABLES_MYSQL'].map(name => source.match(new RegExp('const '+name+' = \\[[\\s\\S]*?^\\];','m'))?.[0]);
  if (constants.some(value => !value)) throw new Error('Missing merge registry');
  const start = source.indexOf('async function loadProductsForMergeMysql(');
  const end = source.indexOf('export async function deleteProductMysql(', start);
  vm.runInContext(constants.join('\n')+'\n'+orderFunctionSource('ensureProductMergeSchemaMysql')+'\n'+source.slice(start,end).replace(/^export /gm,''),service);
  // Skip timers/external profit recalculation only; all business reads, locks,
  // updates, rollback and inventory rebuilding execute the production SQL.
  service.scheduleMergePostProcessingMysql = (id, sources, tenant, options) => followups.push(['scheduled', id, [...sources], tenant, options]);
  return { service, query, calls, followups };
}
