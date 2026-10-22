import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { loadOrderProcurementCoverage, procurementQueueSql } from '../../src/services/mysql-order-procurement-coverage.js';
import { ORDER_PROFIT_CALCULATION_SCHEMA } from '../../src/services/order-profit-calculation-schema.js';
import { initializeOrderQueryFacts } from '../../src/services/order-query-facts.js';
import { authorizeBusinessTaskSession } from '../../src/services/business-task-tenant.js';
import { hasPermission, primaryRole, getRoles } from '../../src/shared/permissions.js';
import { isDemoPackageLabelBufferMysql, normalizePackageLabelBufferMysql, orderPackageLabelFailureMysql } from '../../src/services/mysql-order-label-utils.js';
import * as profitVersioning from '../../src/services/order-profit-calculation-versions.js';
import {getProfitFormula,assertProfitFormulaSupported} from '../../src/services/profit-formulas/registry.js';
import { resolveInventoryTenantScope, inventoryTenantSql, assertInventoryRecord, assertInventoryReferences } from '../../src/services/inventory-tenant-scope.js';
import { orderTransportEvidenceSql, automaticCancellationReturnSql } from '../../src/services/order-transport-evidence.js';
import { ORDER_HEATMAP_TENANT_SCHEMA } from '../../src/services/order-heatmap-tenant-schema.js';

const source = readFileSync(new URL('../../src/services/mysql-cutover.js', import.meta.url), 'utf8');
export function loadOrderHeatmapService(connection, overrides = {}) {
  const heatmap = readFileSync(new URL('../../src/services/order-car-heatmap.js', import.meta.url),'utf8')
    .replace(/^import[^\n]+\r?\n/gm,'').replaceAll('export ','');
  const query=async(sql,params=[])=>(await connection.query(sql,params))[0];
  const context=vm.createContext({Date,Map,Set,Number,String,Object,Array,console,crypto:{createHash},ORDER_HEATMAP_TENANT_SCHEMA,mysqlQuery:query,mysqlExecute:async(sql,params=[])=>(await connection.execute(sql,params))[0],
    resolveInventoryTenantScope:(tenant,run=query)=>resolveInventoryTenantScope(tenant,run),inventoryTenantSql,authorizeBusinessTaskSession,hasPermission,
    ...overrides
  });
  vm.runInContext(heatmap,context);
  return context;
}
export function loadTenantPrintService(connection, overrides = {}) {
  const print = readFileSync(new URL('../../src/services/server-print.js', import.meta.url),'utf8')
    .replace(/^import[^\n]+\r?\n/gm,'').replaceAll('export ','');
  const query=async(sql,params=[])=>(await connection.query(sql,params))[0];
  const context=vm.createContext({Date,Map,Set,Number,String,Object,Array,Buffer,Math,console,setTimeout,clearTimeout,process:{env:{},platform:'fixture'},
    authorizeBusinessTaskSession:session=>authorizeBusinessTaskSession(session,query),hasPermission,...overrides
  });
  vm.runInContext(print,context);
  return context;
}
export function loadOrderProfitWriter(connection) {
  const writer = readFileSync(new URL('../../src/services/mysql-order-profit-version-write.js', import.meta.url),'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm,'').replaceAll('export ','');
  const query=async(sql,params=[])=>(await connection.execute(sql,params))[0];
  const transaction=async action=>{await connection.beginTransaction();try{const result=await action(connection);await connection.commit();return result;}catch(error){await connection.rollback();throw error;}};
  const context=vm.createContext({Date,Map,Set,Number,String,Object,Array,console,...profitVersioning,getProfitFormula,assertProfitFormulaSupported,mysqlQuery:query,withMysqlTransaction:transaction});
  vm.runInContext(writer,context);
  return context;
}
export function orderFunctionSource(name) {
  const match = source.match(new RegExp('^(?:export )?(?:async )?function '+name+'\\([^]*?^}', 'm'));
  if (!match) throw new Error('Order function missing: '+name);
  return match[0].replace(/^export /, '');
}
export async function createOrderFixtureSchema(connection) {
  const schema = readFileSync(new URL('../../scripts/init-mysql-schema.mjs', import.meta.url),'utf8');
  const tables = schema.match(/CREATE TABLE IF NOT EXISTS [\s\S]*?ENGINE=InnoDB[^;]+;/g) || [];
  if (!tables.length) throw new Error('Missing checked-in fixture schema');
  for (const statement of [...ORDER_PROFIT_CALCULATION_SCHEMA, ...tables]) await connection.query(statement.replaceAll("\\`", "`"));
  const exceptionSnapshot = source.match(/CREATE TABLE IF NOT EXISTS exception_workbench_snapshots[\s\S]*?ENGINE=InnoDB[^\r\n]*/)?.[0];
  if (!exceptionSnapshot) throw new Error('Missing exception snapshot schema');
  await connection.query(exceptionSnapshot);
  const extras = [
    "ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'active'",
    'ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL',
    'ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL',
    'ALTER TABLE products ADD COLUMN inventory_number VARCHAR(128) NULL',
    'ALTER TABLE sku_mappings ADD COLUMN person_id BIGINT NULL',
    'ALTER TABLE order_items ADD COLUMN frozen_logistics_rule_id BIGINT NULL',
    'ALTER TABLE products ADD COLUMN inventory_number_category VARCHAR(80) NULL, ADD COLUMN inventory_number_sequence INT NULL',
    'CREATE TABLE IF NOT EXISTS sku_inventory_recipes (id BIGINT PRIMARY KEY AUTO_INCREMENT, shop_id BIGINT,ozon_sku VARCHAR(128),active TINYINT DEFAULT 1,mode VARCHAR(20) DEFAULT \'combo\')',
    'CREATE TABLE IF NOT EXISTS sku_inventory_recipe_items (id BIGINT PRIMARY KEY AUTO_INCREMENT,recipe_id BIGINT,product_id BIGINT,quantity DECIMAL(18,4))',
    "CREATE TABLE IF NOT EXISTS product_components (id BIGINT PRIMARY KEY AUTO_INCREMENT,tenant_id BIGINT NULL,product_id BIGINT,component_product_id BIGINT,quantity DECIMAL(18,4),component_role VARCHAR(20) DEFAULT 'included')"
  ];
  for (const statement of extras) try { await connection.query(statement); } catch (error) { if(error.code!=='ER_DUP_FIELDNAME') throw error; }
  for (const [column,definition] of Object.entries({stock_unit:"VARCHAR(40) DEFAULT 'unit'",inventory_category:'VARCHAR(80)',vehicle_brand:'VARCHAR(80)',fitment_type:'VARCHAR(40)',vehicle_model:'VARCHAR(80)',accessory_name:'VARCHAR(120)',color:'VARCHAR(80)',product_quantity:'INT DEFAULT 1',package_mode:'VARCHAR(40)',package_contents:'TEXT'})) {
    try {await connection.query(`ALTER TABLE products ADD COLUMN ${column} ${definition}`);}catch(error){if(error.code!=='ER_DUP_FIELDNAME')throw error;}
  }
  for (const table of ['inbound_records','purchase_orders','purchase_order_items']) {
    const [columns]=await connection.query('SHOW COLUMNS FROM '+table+' LIKE \'tenant_id\'');
    if (!columns.length) await connection.query('ALTER TABLE '+table+' ADD COLUMN tenant_id BIGINT NULL');
  }
  await initializeOrderQueryFacts(connection);
}
export function loadTenantOrderService(connection, { extraMethods = [], ...overrides }={}) {
  const calls=[];
  const query=async (sql,params=[])=>{calls.push({sql,params:Array.from(params)});return (await connection.query(sql,params))[0];};
  const execute=async (sql,params=[])=>{calls.push({sql,params:Array.from(params)});return (await connection.execute(sql,params))[0];};
  const methods=[
    'isDefaultShopTenantMysql','resolveShopTenantIdMysql','tenantShopPredicateMysql','orderListTenantScopeMysql','orderOwnershipTenantScopeMysql','orderTenantPredicateMysql','assertOrderTaskAccessMysql','orderTenantCoverageMysql','assertTenantOrderListFiltersMysql',
    'orderBaseSqlMysql','orderFilteredSqlMysql','orderQuickFilterOrderSqlMysql','addOrderSearchSqlMysql','orderStatusSqlMysql','orderPagedSqlCountsMysql','ordersPagedMysql','ordersMysql','orderRowsByIdsMysql','orderInventorySortRowsMysql',
    'updateOrderMarkMysql','orderStatusHistoryMysql','orderStatusHistorySummaryMysql','assertOrderBatchOwnershipMysql','markOrderLabelsPrintedMysql','removeFailedOrderLabelPrintBatchMysql','orderPackageLabelMysql','shipOrdersMysql',
    'orderDetailMysql','orderDetailFinanceMysql','orderProfitDetailSnapshotMysql','parseJsonOrNull','parseJsonFallback','sortRowsByInputMysql','trimOrderPostingSuffix',
    ...extraMethods
  ];
  const noop=async()=>{};
  const context=vm.createContext({Date,Map,Set,Number,String,Object,Array,Buffer,console,createHash,authorizeBusinessTaskSession,hasPermission,isDemoPackageLabelBufferMysql,normalizePackageLabelBufferMysql,orderPackageLabelFailureMysql,
    resolveInventoryTenantScope:(tenant,run=query)=>resolveInventoryTenantScope(tenant,run),inventoryTenantSql,assertInventoryRecord,assertInventoryReferences,orderTransportEvidenceSql,automaticCancellationReturnSql,mysqlPoolConnectionAdapter:connection,primaryRole,getRoles,
    withMysqlTransaction:async action=>{await connection.beginTransaction();try{const result=await action(connection);await connection.commit();return result;}catch(error){await connection.rollback();throw error;}},
    mysqlQuery:query,mysqlQueryOne:async(sql,params)=>(await query(sql,params))[0]||null,mysqlExecute:execute,
    ensureMysqlCutoverEnabled(){},mysqlSchemaColumnExists:async(table,column)=>(await query('SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [table,column])).length>0,
    ensureOrderLabelPrintSchemaMysql:noop,ensureSkuInventoryRecipeSchemaMysql:noop,ensureProductCompositionSchemaMysql:noop,ensureProductNamingSchemaMysql:noop,ensureProcurementOrderSourceSchemaMysql:noop,ensureOrderPackageLabelCacheSchemaMysql:noop,
    normalizeSyncDateMysql:value=>String(value||'').slice(0,10),shanghaiDateKeyToUtcDateTimeMysql:(value,days=0)=>value?new Date(new Date(value+'T00:00:00+08:00').getTime()+days*86400000).toISOString().slice(0,19).replace('T',' '):'',
    orderQualityPrefixesMysql:async()=>[],localStockLocationPredicateMysql:()=>"COALESCE(NULLIF(stock_location, ''), 'LOCAL') != 'FBP'",procurementQueueSql,
    normalizeLogisticsServiceClass:value=>value||'all',filterOrderIdsByLogisticsMethodMysql:()=>null,filterOrderIdsByLogisticsCarrierMysql:()=>null,filterOrderIdsByLogisticsServiceClassMysql:()=>null,
    orderLogisticsServiceClassOptions:()=>[],orderLogisticsCarrierOptionsMysql:()=>[],orderLogisticsCarrierMysql:()=>'',orderLogisticsMethodOptionsMysql:async()=>[],loadOrderLogisticsSummaryForBaseMysql:async()=>[],
    withRestrictedOrderIdsMysql:base=>base,sortPagedOrdersMysql:rows=>rows,
    enrichOrderRowsForListMysql:async rows=>rows,enrichOrderLogisticsMysql:async row=>row,
    readableLogisticsTenantScopeMysql:async(tenant,alias)=>({sql:`(${alias}.tenant_id IS NULL AND ${alias}.carrier = 'OGL')`,params:[]}),
    resolveAuditPersonId:async id=>id,resolveExistingPersonId:async id=>id,
    nullableInteger:value=>Number(value)||null,nullableNumber:value=>Number(value)||null,
    normalizeSyncDateTimeMysql:value=>value||'',normalizeShanghaiDateBoundaryMysql:value=>value||'',normalizeMysqlNullableDateTime:value=>value||null,
    chinaDateKeyMysql:value=>String(value||'').slice(0,10),chinaDateSqlMysql:column=>`DATE(${column})`,
    normalizeFinanceBackfillDateMysql:value=>String(value||'').slice(0,10),dateKeyDaysAgoMysql:()=> '2026-10-01',todayDateKeyMysql:()=> '2026-10-05',
    throwIfAbortedMysql(signal){if(signal?.aborted)throw Error('aborted');},textValueMysql:(...values)=>values.find(Boolean)||'',
    invalidateMasterDataCache(){},invalidateMasterDataCachePrefix(){},
    orderProcurementCoverageMysql:async options=>new Map(),
    classifyOrderLogistics:()=>({}),classifyOrderAccountingMysql:async()=>({outcome_type:'active',aftersale_bucket:'none'}),cancellationDisplay:()=>({}),orderOutcomeLabelMysql:()=>'',orderOutcomeHintMysql:()=>'',AFTERSALE_BUCKET_LABELS_MYSQL:{},
    buildOrderProfitDetailSnapshotPayload:()=>({}),readOrderProfitCalculationVersions:async()=>({items:[]}),
    ...overrides
  });
  vm.runInContext(methods.map(orderFunctionSource).join('\n'),context);
  return { service:context,query,calls };
}

