import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import test from 'node:test';import mysql from 'mysql2/promise';
import {createOrderFixtureSchema,loadTenantOrderService,loadOrderProfitWriter,loadOrderHeatmapService,loadTenantPrintService} from './helpers/tenant-order-service.js';
import {applyOrderHeatmapTenantSchema,inspectOrderHeatmapTenantSchema} from '../scripts/lib/tenant-order-heatmap-migration.mjs';
import {createOrderRoutes,handleOrderRestRoute} from '../src/server/routes/orders.js';
import {TENANT_INVENTORY_SALES_REFRESH_SCHEMA,refreshInventoryAlertSkuDailyMysqlService,markInventoryAlertSkuDailyDirtyMysqlService} from '../src/services/mysql-inventory-alert-snapshots.js';
import {orderTransportEvidenceSql} from '../src/services/order-transport-evidence.js';
import {getProfitFormula} from '../src/services/profit-formulas/registry.js';
import {resolveOrderLossProfile,buildOrderOutcomeSql} from '../src/services/order-outcome.js';
import {cancellationDisplay} from '../src/services/order-cancellation-display.js';
import {classifyOrderAccounting} from '../src/services/order-outcome.js';
import {getCachedMasterData,invalidateExceptionWorkbenchCache,invalidateMasterDataCachePrefix} from '../src/services/mysql-master-data-cache.js';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET;
test('orders use current enterprise for SQL queries and mutations, including default legacy NULL', {skip:!socketPath&&'Requires isolated MySQL named pipe'},async t=>{
 const database='ozon_orders_tenant_test_'+randomBytes(8).toString('hex');assert.match(database,/^ozon_orders_tenant_test_[a-f0-9]+$/);
 const connection=await mysql.createConnection({socketPath,user:'root',dateStrings:true});let created=false;
 try {assert.equal(Number((await connection.query('SELECT @@skip_networking isolated'))[0][0].isolated),1,'Only the isolated named-pipe instance is permitted');await connection.query('CREATE DATABASE `'+database+'`');created=true;await connection.changeUser({database});await connection.query("SET time_zone='+00:00'");await createOrderFixtureSchema(connection);
 const {service,query,calls}=loadTenantOrderService(connection);
 await query("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
 await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(11,1,'Default'),(20,2,'A'),(30,3,'B')");
 await query("INSERT INTO people(id,name) VALUES(1,'Default operator'),(2,'A operator'),(3,'B secret operator')");
 await query("INSERT INTO tenant_members(tenant_id,person_id,role) VALUES(1,1,'member'),(2,2,'member'),(3,3,'member')");
 await query("INSERT INTO products(id,tenant_id,name,code) VALUES(10,NULL,'Legacy product','P-10'),(11,1,'Default product','P-11'),(20,2,'A product','P-20'),(30,3,'B secret product','P-30')");
 await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,offer_id) VALUES(10,NULL,10,10,'same-sku','legacy-offer'),(11,1,11,11,'same-sku','default-offer'),(20,2,20,20,'same-sku','a-offer'),(30,3,30,30,'same-sku','b-secret-offer'),(21,3,20,30,'poisoned','b-secret-poison')");
 await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(10,10,'same-posting','awaiting_packaging','awaiting_packaging','2026-10-01'),(11,11,'default-posting','delivered','delivered','2026-10-02'),(20,20,'same-posting','awaiting_packaging','awaiting_packaging','2026-10-03'),(21,20,'poisoned-order','awaiting_packaging','awaiting_packaging','2026-10-04'),(30,30,'same-posting','delivered','delivered','2026-10-05')");
 await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(10,10,10,'same-sku',1,10),(11,11,11,'same-sku',1,11),(20,20,20,'same-sku',1,20),(21,21,21,'poisoned',1,21),(30,30,30,'same-sku',1,3000)");
 await t.test('A/B/default paged IDs, totals and status counts cannot read another enterprise',async()=>{
  for(const [tenant,expected]of [['2',[20,21]],['3',[30]],['admin',[10,11]],['1',[10,11]]]) {const r=await service.ordersPagedMysql({includeRows:'0',includeLogisticsOptions:'0'},tenant);assert.equal(r.total,expected.length);assert.equal(r.counts.all,expected.length);const ids=await service.orderBaseSqlMysql({},tenant);const actual=await query('SELECT o.id FROM orders o WHERE '+ids.where,ids.params);assert.deepEqual(actual.map(x=>x.id).sort((a,b)=>a-b),expected);}
 });
 await t.test('shop, search, unbound and sorting do not follow poisoned mapping references',async()=>{
  const params={includeRows:'0',includeLogisticsOptions:'0'};assert.equal((await service.ordersPagedMysql({...params,shopId:'30'},'2')).total,0);
  assert.equal((await service.ordersPagedMysql({...params,searchType:'product',searchQuery:'B secret'},'2')).total,0);
  assert.equal((await service.ordersPagedMysql({...params,searchType:'offer',searchQuery:'b-secret'},'2')).total,0);
  assert.equal((await service.ordersPagedMysql({...params,status:'unbound'},'2')).total,1);
  const rows=await service.orderInventorySortRowsMysql([10,20,21,30],'2');assert.deepEqual(Array.from(rows,row=>row.id).sort(),[20,21]);assert.ok(!JSON.stringify(rows).includes('B secret'));
 });
 await t.test('detail/history/mark reject foreign IDs and default remains scoped',async()=>{
  for(const [tenant,foreign]of [['2',30],['3',20],['admin',20]]) {assert.equal(await service.orderDetailMysql(foreign,tenant),null);assert.deepEqual(Array.from(await service.orderStatusHistoryMysql(foreign,{},tenant)),[]);await assert.rejects(service.updateOrderMarkMysql(foreign,{mark_type:'quality'},1,tenant),/not found/);}
  await service.updateOrderMarkMysql(20,{mark_type:'quality',note:'A-only'},2,'2');assert.equal((await query('SELECT note FROM order_marks WHERE order_id=20'))[0].note,'A-only');
 });
 await t.test('full enrichment and own detail execute real SQL without revealing poisoned products',async()=>{
  const rows=await service.orderRowsByIdsMysql([10,20,21,30],null,'2');assert.deepEqual(Array.from(rows,row=>row.id).sort(),[20,21]);assert.ok(!JSON.stringify(rows).includes('B secret'));assert.ok(!JSON.stringify(rows).includes('b-secret'));
  const detail=await service.orderDetailMysql(20,'2');assert.equal(detail.order.shop_id,20);assert.equal(detail.items[0].product_name,'A product');
  const poisoned=await service.orderDetailMysql(21,'2');assert.equal(poisoned.items[0].product_name,null);
  const legacy=await service.orderDetailMysql(10,'admin');assert.equal(legacy.items[0].product_name,'Legacy product');
 });
 await t.test('mixed print batches fail before any write and failed-batch cleanup stays tenant-owned',async()=>{
  await assert.rejects(service.markOrderLabelsPrintedMysql({order_ids:[20,30]},2,'2'),/不属于/);assert.equal((await query('SELECT COUNT(*) n FROM order_label_prints'))[0].n,0);
  await service.markOrderLabelsPrintedMysql({order_ids:[20]},2,'2');await query("INSERT INTO order_label_prints(order_id,print_batch_id,printed_by_person_id) VALUES(30,'shared-batch',2)");await query("UPDATE order_label_prints SET print_batch_id='shared-batch' WHERE order_id=20");await service.removeFailedOrderLabelPrintBatchMysql({print_batch_id:'shared-batch'},2,'2');assert.deepEqual((await query('SELECT order_id FROM order_label_prints')).map(x=>x.order_id),[30]);
 });
 await t.test('package-label and ship refuse mixed IDs before external Ozon requests',async()=>{
  await assert.rejects(service.orderPackageLabelMysql({order_ids:[20,30]},2,'2'),/不属于/);await assert.rejects(service.shipOrdersMysql({order_ids:[20,30]},2,'2'),/不属于/);
 });
 await t.test('PDF caches verify order plus shop and posting, and never return another shop PDF',async()=>{
  const fetched=[];
  const {service:labels}=loadTenantOrderService(connection,{extraMethods:['activeShopForTenantMysql','loadCachedOrderPackageLabelsMysql','fetchAndCacheOrderPackageLabelMysql','cacheOrderPackageLabelMysql'],
   fetchOzonPackageLabel:async shop=>{fetched.push(shop.id);return Buffer.from('%PDF-A-owned');},isOrderInTransportMysql:()=>false,clearOrderPackageLabelPrefetchTimerMysql(){},mergePdfBuffersMysql:async buffers=>Buffer.concat(buffers)
  });
  await query('INSERT INTO order_package_label_cache(order_id,shop_id,posting_number,label_pdf,label_size) VALUES(20,30,\'same-posting\',?,?)',[Buffer.from('%PDF-B-secret'),13]);
  const own=await labels.orderPackageLabelMysql({order_ids:[20]},2,'2');assert.equal(own.buffer.toString(),'%PDF-A-owned');assert.deepEqual(fetched,[20]);
  const cached=await labels.orderPackageLabelMysql({order_ids:[20]},2,'2');assert.equal(cached.buffer.toString(),'%PDF-A-owned');assert.equal(fetched.length,1);
  await assert.rejects(labels.orderPackageLabelMysql({order_ids:[30]},2,'2'),/不属于/);assert.equal(fetched.length,1);
 });
 await t.test('REST routes derive enterprise from session and ignore submitted tenant',async()=>{
  const seen=[];const req={method:'PUT',_session:{personId:2,tenant:{id:2,slug:'a'}},body:{tenant_id:3,mark_type:'quality'}};
  await handleOrderRestRoute({req,parts:['api','orders','20','mark'],services:{updateOrderMark:async(...args)=>{seen.push(args);return {ok:true};}},readJson:async r=>r.body,json:(_,v)=>v});assert.equal(seen[0][3],'2');
  const routes=createOrderRoutes({services:{orders:async tenant=>tenant}});assert.equal(await routes['GET /api/orders'](req,new URL('http://localhost:8788/api/orders')),'2');
 });
 await t.test('profit recalculation and product batches use owned orders, mappings and products',async()=>{
  const touched=[],snapshots=[];
  const {service:profit}=loadTenantOrderService(connection,{extraMethods:['recalculateOrderProfitMysql','recalculateOrderItemsForMappingMysql','recalculateAllMappedOrderProfitsMysql','recalculateOrderProfitsForProductMysql','forceRecalculateOrderProfitsForProductMysql','normalizeForceRecalculateOrderItemIdsMysql'],
   productForProfitEstimateMysql:async id=>(await query('SELECT * FROM products WHERE id=?',[id]))[0],
   estimatePinnedOrderItemProfit:async()=>({profit:7}),resolveProfitSettlementStatusMysql:()=> 'pending',estimateOrderItemReturnLossMysql:async()=>0,estimatedProfitValueMysql:()=>7,
   persistRecalculatedItemMysql:async({itemId,mapping,product})=>{touched.push({itemId,mapping: mapping.id,product:product.id});await query('UPDATE order_items SET estimated_profit=7 WHERE id=?',[itemId]);},
   syncOutboundForOpenOrdersMysql:async options=>{assert.equal(options.tenantId,2);},refreshTenantOrderAnalyticsMysql:async(id)=>{snapshots.push(id);},applyOzonFinanceToOrdersMysql:async()=>({orders:0,items:0}),refreshOrderProfitDetailSnapshotsMysql:async()=>({})
  });
  await assert.rejects(profit.recalculateOrderProfitMysql(30,{tenantId:'2'}),/not found/);
  assert.equal((await profit.recalculateOrderItemsForMappingMysql(30,{tenantId:'2'})).updated,0);
  assert.equal((await profit.recalculateOrderItemsForMappingMysql(21,{tenantId:'2'})).updated,0);
  assert.equal((await profit.recalculateOrderProfitMysql(20,{tenantId:'2',sync_outbound:false,refresh_snapshots:false})).updated,1);
  assert.equal((await profit.recalculateAllMappedOrderProfitsMysql({},'2')).mappings,1);
  assert.equal((await profit.recalculateOrderProfitsForProductMysql(20,{tenantId:'2'})).eligible_items,1);
  await assert.rejects(profit.forceRecalculateOrderProfitsForProductMysql(30,{order_item_ids:[30]},'2'),/not found/);
  const forced=await profit.forceRecalculateOrderProfitsForProductMysql(20,{order_item_ids:[20,30]},'2');assert.equal(forced.updated,1);assert.deepEqual(Array.from(forced.missing_order_item_ids),[30]);
  assert.ok(touched.length>=3);assert.ok(touched.every(row=>row.itemId===20&&row.product===20&&row.mapping===20));assert.ok(snapshots.every(id=>id===2));
  assert.equal(Number((await query('SELECT estimated_profit FROM order_items WHERE id=30'))[0].estimated_profit),0);
  const written=touched.length;profit.estimatePinnedOrderItemProfit=async()=>{await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');return {profit:7};};
  await assert.rejects(profit.recalculateOrderProfitMysql(20,{tenantId:'2',session:{personId:2,tenant:{id:2,slug:'a'}},sync_outbound:false,refresh_snapshots:false}),/不可用/);assert.equal(touched.length,written);await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
 });
 await t.test('business people directory lists only current active members with enterprise roles and safe identity fields',async()=>{
  const {service:directory}=loadTenantOrderService(connection,{extraMethods:['peopleMysql'],ensurePeopleTimestampSchemaMysql:async()=>{},ensurePeopleRolesSchemaMysql:async()=>{}});
  await query("UPDATE people SET role='admin',roles_json='[\"admin\"]',username='private-a-login',password_hash='private-a-hash' WHERE id=2");await query("UPDATE tenant_members SET business_roles_json='[\"packing\"]' WHERE tenant_id=2 AND person_id=2");
  for(const [tenant,expected]of [['2',[2]],['3',[3]],['admin',[1]]]){const rows=await directory.peopleMysql(tenant);assert.deepEqual(Array.from(rows,row=>row.id),expected);assert.ok(rows.every(row=>!('username'in row)&&!('password_hash'in row)&&!('roles_json'in row)&&!('business_roles_json'in row)));}
  assert.deepEqual(Array.from((await directory.peopleMysql('2'))[0].roles),['packing']);assert.equal((await directory.peopleMysql('2'))[0].role,'packing');
  await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');assert.equal((await directory.peopleMysql('2')).length,0);await query('UPDATE tenant_members SET active=1,business_roles_json=NULL WHERE tenant_id=2 AND person_id=2');await query("UPDATE people SET role='operator',roles_json=NULL WHERE id=2");
 });
 await t.test('long task rechecks subscription and current member roles without a platform bypass',async()=>{
  const a={personId:2,tenant:{id:2,slug:'a',role:'admin'},platform_role:'super_admin',roles:['admin']};
  const scope=await service.orderOwnershipTenantScopeMysql('2');
  await service.assertOrderTaskAccessMysql(scope,{session:a});
  await query("UPDATE people SET role='packing' WHERE id=2");
  await assert.rejects(service.assertOrderTaskAccessMysql(scope,{session:a}),/无权/);
  await service.assertOrderTaskAccessMysql(scope,{session:a},['packing']);
  await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
  await assert.rejects(service.assertOrderTaskAccessMysql(scope,{session:a},['packing']),/不可用/);
  await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');await query("UPDATE people SET role='operator' WHERE id=2");
  await query("UPDATE tenants SET subscription_expires_at='2020-01-01' WHERE id=2");
  await assert.rejects(service.assertOrderTaskAccessMysql(scope,{}),/不可用/);
  await query('UPDATE tenants SET subscription_expires_at=NULL WHERE id=2');
 });
 await t.test('order synchronization uses scoped shops and real order writes, then stops before writes after revocation',async()=>{
  const remote=[],saved=[];
  const {service:sync}=loadTenantOrderService(connection,{extraMethods:['shopsMysql','activeShopForTenantMysql','syncDemoOrdersMysql','syncOzonIncrementalOrdersMysql','syncOzonPostingsByNumberMysql','syncKnownOzonPostingDetailsMysql','emptySyncAggregateMysql','mergeSyncAggregateMysql','mapWithConcurrencyMysql','upsertPostingMysql','orderLifecycleMysql'],
   ensureShopWatermarkSchemaMysql:async()=>{},ensureShopAdvertisingCredentialSchemaMysql:async()=>{},ensureShopUserSchemaMysql:async()=>{},getCachedMasterData:async(_key,load)=>load(),
   fetchOzonPostings:async shop=>{remote.push(shop.id);const current=(await query('SELECT * FROM orders WHERE shop_id=? ORDER BY id LIMIT 1',[shop.id]))[0];return {postings:[{...current,items:[]}],requests:1,ranges:1};},fetchOzonFbpPostings:async()=>({postings:[],requests:1,ranges:1}),mergeOrderPostingLogistics:(_old,value)=>value,
   saveRawPostingMysql:async(shop,posting)=>{saved.push(shop.id);return posting;},isFbpPosting:()=>false,hasMeaningfulPostingMethod:()=>true,orderCancelLossAppliesMysql:async()=>false,recordOrderStatusHistoryMysql:async()=>{},resolveOrderStockLocationMysql:()=>({stockLocation:'LOCAL',stockLocationSource:'fixture'}),accrueDeliveredItemsMysql:async()=>{},isOrderInTransportMysql:()=>false,markInventoryAlertSkuDailyDirtyMysql:async()=>{},invalidateOrderProcurementCoverage(){},syncOutboundForOpenOrdersMysql:async options=>{assert.ok([1,2,3,'admin','2','3'].includes(options.tenantId));},refreshTenantOrderAnalyticsMysql:async id=>{assert.ok([1,2,3,'admin','2','3'].includes(id));}
  });
  for(const [tenant,allowed]of [['2',[20]],['3',[30]],['admin',[10,11]]]) {remote.length=0;saved.length=0;const result=await sync.syncDemoOrdersMysql({tenantId:3,skip_post_processing:true},{tenantId:tenant});assert.deepEqual(Array.from(result.shops,row=>row.shop_id),allowed);assert.deepEqual(remote,allowed);assert.deepEqual(saved,allowed);}
  remote.length=0;await sync.syncOzonIncrementalOrdersMysql({skip_post_processing:true,tenant_id:3},{tenantId:'2'});assert.deepEqual(remote,[20]);
  sync.fetchOzonPostingByNumber=async(shop,posting)=>{remote.push(shop.id);const row=(await query('SELECT * FROM orders WHERE shop_id=? AND posting_number=?',[shop.id,posting]))[0];return row?{...row,items:[]}:null;};
  remote.length=0;const byNumber=await sync.syncOzonPostingsByNumberMysql({posting_numbers:['same-posting'],tenant_id:3},{tenantId:'2'});assert.equal(byNumber.fetched,1);assert.deepEqual(remote,[20]);
  for(const [tenant,allowed]of [['2',[20,20]],['3',[30]],['admin',[11,10]]]){remote.length=0;const known=await sync.syncKnownOzonPostingDetailsMysql({}, {tenantId:tenant});assert.equal(known.candidate_orders,allowed.length);assert.deepEqual(remote.sort(),allowed.sort());}
  remote.length=0;await assert.rejects(sync.syncDemoOrdersMysql({shop_id:30,skip_post_processing:true},{tenantId:'2'}),/不属于/);assert.equal(remote.length,0);
  const before=(await query('SELECT status,last_synced_at FROM orders WHERE id=20'))[0];saved.length=0;
  sync.fetchOzonPostings=async shop=>{await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');return {postings:[{id:20,posting_number:'same-posting',status:'cancelled',items:[]}],requests:1};};
  await assert.rejects(sync.syncDemoOrdersMysql({skip_post_processing:true},{tenantId:'2',session:{personId:2,tenant:{id:2,slug:'a'}}}),/不可用/);
  assert.equal(saved.length,0);assert.deepEqual((await query('SELECT status,last_synced_at FROM orders WHERE id=20'))[0],before);await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
 });
 await t.test('finance sync and V1 settlement preserve shop ownership and record real tenant-keyed revisions',async()=>{
  await query('UPDATE order_items SET frozen_purchase_cost=4 WHERE id=20');await query('UPDATE order_items SET frozen_purchase_cost=1 WHERE id=10');
  for(const [shop,sale,fee]of [[20,20,1],[30,3000,100],[10,10,1]])for(const [type,name,amount]of [['sale_commission','Ozon commission',-2*fee],['delivery_charge','Delivery',-fee],['acquiring','MarketplaceRedistributionOfAcquiringOperation',-.4*fee]])await query('INSERT INTO ozon_finance_items(shop_id,operation_id,posting_number,service_type,service_name,amount_cny,accruals_for_sale_cny,operation_date) VALUES(?,?,?,?,?,?,?,?)',[shop,'fixture-'+type,'same-posting',type,name,amount,sale,'2026-10-03']);
  const remote=[],snapshotTenants=[];
  const writer=loadOrderProfitWriter(connection);
  const {service:finance}=loadTenantOrderService(connection,{extraMethods:['shopsMysql','activeShopForTenantMysql','syncOzonFinanceRawMysql','syncOzonFinanceMysql','applyOzonFinanceToOrdersMysql','financeCategoryTotalsMysql','hasRequiredFinanceBasisMysql','ozonFinanceCategoryMysql','roundMoneyMysql','orderFinanceRowsWithParentAllocationMysql','parentOrderNumberMysql','scaleFinanceRowMysql','lockProfitItemMysql'],
   ensureShopWatermarkSchemaMysql:async()=>{},ensureShopAdvertisingCredentialSchemaMysql:async()=>{},ensureShopUserSchemaMysql:async()=>{},getCachedMasterData:async(_key,load)=>load(),
   fetchOzonFinanceTransactions:async shop=>{remote.push(shop.id);return {operations:[],requests:1,fetched:0};},getProfitFormula,profitCalculationDatabase:writer.profitCalculationDatabase,
   describeCancellation:row=>cancellationDisplay(row,resolveOrderLossProfile(row)),packagingFeeForSaleAmountMysql:async()=>0,refreshOrderProfitDetailSnapshotsMysql:async(_body,id)=>{snapshotTenants.push(id);},
   withVersionedOrderProfitWrite:writer.withVersionedOrderProfitWrite
  });
  const applied=await finance.syncOzonFinanceMysql({shop_id:20,tenantId:3},{tenantId:'2'});assert.equal(applied.applied.items,1);assert.deepEqual(remote,[20]);
  const own=(await query('SELECT actual_profit,settlement_state FROM order_items WHERE id=20'))[0];assert.equal(Number(own.actual_profit),12.6);assert.equal(own.settlement_state,'accrued');
  assert.equal((await query('SELECT COUNT(*) n FROM order_profit_calc_revisions WHERE tenant_key=\'2\' AND order_item_id=20'))[0].n,2);
  assert.equal((await query('SELECT COUNT(*) n FROM order_profit_items WHERE order_item_id=30'))[0].n,0);
  const legacy=await finance.applyOzonFinanceToOrdersMysql({tenantId:'admin'});assert.equal(legacy.items,1);assert.equal((await query('SELECT COUNT(*) n FROM order_profit_calc_revisions WHERE tenant_key=\'admin\' AND order_item_id=10'))[0].n,2);
  assert.ok(snapshotTenants.every(id=>id==='2'||id==='admin'));remote.length=0;await assert.rejects(finance.syncOzonFinanceRawMysql({shop_id:30},{tenantId:'2'}),/不属于/);assert.equal(remote.length,0);
 });
 await t.test('outbound reads stay scoped and cancellation fails closed on a foreign historical item anchor',async()=>{
  const {service:outbound}=loadTenantOrderService(connection,{extraMethods:['syncOutboundForOpenOrdersMysql','orderOutboundSyncScopeMysql','upsertOrderOutboundRecordMysql','revokeShippedCancellationReturnsMysql','recordOrderExceptionMysql','postInventoryMysql','postProductInventoryWithComponentsMysql','desiredProductInventoryMovementRowsMysql','productComponentRowsMysql','applyInventoryCurrentMysql','inventoryDeltasMysql','movementTypeFromSourceMysql','rebuildInventoryCurrentForProductMysql','mysqlConnectionQuery','mysqlConnectionQueryOne','normalizeStockLocationMysql'],
   ensureStockLocationSchemaMysql:async()=>{},inventoryMovementTenantColumnExistsMysql:async()=>true,compactProductImageUrlForListMysql:()=>'',resolveOrderStockLocationMysql:()=>({stockLocation:'LOCAL',stockLocationSource:'fixture'}),isOrderInTransportMysql:row=>/delivering|delivered/.test(row.status||''),invalidateOrderProcurementCoverage(){}
  });
  await query("INSERT INTO inventory_movements(tenant_id,product_id,shop_id,source_type,source_ref,quantity_delta,status,movement_type,related_order_item_id) VALUES(3,30,30,'order_outbound','same-posting',-70,'posted','ORDER_SHIPPED',20),(3,20,30,'manual_adjustment','poisoned-product',999,'posted','MANUAL_ADJUST',NULL)");
  const foreign=await query('SELECT * FROM inventory_movements WHERE tenant_id=3 ORDER BY id');
  const a=await outbound.syncOutboundForOpenOrdersMysql({tenantId:'2'});assert.equal(a.deducted,1);assert.equal(a.pending,1);
  assert.deepEqual((await query('SELECT order_item_id,shop_id,product_id FROM outbound_records')).map(row=>({...row})),[{order_item_id:20,shop_id:20,product_id:20}]);
  assert.deepEqual(await query('SELECT * FROM inventory_movements WHERE tenant_id=3 ORDER BY id'),foreign);
  await outbound.syncOutboundForOpenOrdersMysql({tenantId:'2'});assert.equal((await query("SELECT COUNT(*) n FROM inventory_movements WHERE tenant_id=2 AND source_type='order_outbound'"))[0].n,1);
  assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=20'))[0].available_stock),-1);
  await query("UPDATE orders SET status='cancelled',tracking_stage='cancelled' WHERE id=20");
  const blocked=await outbound.syncOutboundForOpenOrdersMysql({tenantId:'2'});
  assert.deepEqual(Array.from(blocked.cancellation_review_required,row=>row.order_item_id),[20]);
  assert.equal((await query("SELECT COUNT(*) n FROM inventory_movements WHERE tenant_id=2 AND source_ref='cancel_20_20'"))[0].n,0);
  assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=20'))[0].available_stock),-1);
  assert.deepEqual(await query('SELECT * FROM inventory_movements WHERE tenant_id=3 ORDER BY id'),foreign);
  await query("UPDATE inventory_movements SET related_order_item_id=30 WHERE tenant_id=3 AND source_type='order_outbound'");
  const reviewedForeign=await query('SELECT * FROM inventory_movements WHERE tenant_id=3 ORDER BY id');
  await outbound.syncOutboundForOpenOrdersMysql({tenantId:'2'});
  assert.equal(Number((await query("SELECT quantity_delta FROM inventory_movements WHERE tenant_id=2 AND source_ref='cancel_20_20'"))[0].quantity_delta),1);
  assert.deepEqual(await query('SELECT * FROM inventory_movements WHERE tenant_id=3 ORDER BY id'),reviewedForeign);
  assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=20'))[0].available_stock),0);
  await outbound.syncOutboundForOpenOrdersMysql({tenantId:'admin'});
  assert.deepEqual((await query('SELECT order_item_id FROM outbound_records ORDER BY order_item_id')).map(row=>row.order_item_id),[10,11,20]);
  assert.equal((await query('SELECT COUNT(*) n FROM outbound_records WHERE shop_id=30'))[0].n,0);
  await query("UPDATE orders SET status='awaiting_packaging',tracking_stage='awaiting_packaging' WHERE id=20");
 });
 await t.test('outbound list scopes counts, search, legacy movement fallback and poisoned record references',async()=>{
  await query("INSERT INTO online_products(id,shop_id,ozon_sku,name) VALUES(30,30,'same-sku','B secret online')");
  await query("INSERT INTO outbound_records(product_id,shop_id,order_ref,order_item_id,quantity,note) VALUES(30,30,'same-posting',30,1,'B-owned'),(30,20,'same-posting',NULL,1,'poisoned-product'),(20,20,'same-posting',30,1,'poisoned-order-item'),(20,20,'same-posting',NULL,1,'A legacy fallback')");
  await query('UPDATE outbound_records SET online_product_id=30,person_id=3 WHERE order_item_id=20');
  const {service:outbounds}=loadTenantOrderService(connection,{extraMethods:['outboundRecordsMysql','outboundRecordsWhereMysql','outboundRecordsSelectMysql','normalizeStockLocationMysql'],ensureStockLocationSchemaMysql:async()=>{}});
  for(const [tenant,shops,total]of [['2',[20],2],['3',[30],1],['admin',[10,11],2]]){
   const rows=await outbounds.outboundRecordsMysql({paged:'1'},tenant);assert.equal(rows.total,total);assert.ok(rows.rows.every(row=>shops.includes(row.shop_id)));assert.ok(!JSON.stringify(rows).includes('poisoned'));
   if(tenant==='2'){assert.ok(rows.rows.every(row=>row.order_item_id===20));assert.ok(rows.rows.every(row=>row.online_product_id===null&&row.person_id===null));assert.ok(!JSON.stringify(rows).includes('B secret'));}
  }
  assert.equal((await outbounds.outboundRecordsMysql({paged:'1',query:'B secret'},'2')).total,0);assert.equal((await outbounds.outboundRecordsMysql({paged:'1',shopId:30},'admin')).total,0);
 });
 await t.test('successful shipping uses fresh own shop credentials and stops writes when packing permission is revoked',async()=>{
  const remote=[],prefetch=[];
  await query('UPDATE order_items SET ozon_product_id=200020 WHERE id=20');
  const {service:shipping}=loadTenantOrderService(connection,{extraMethods:['activeShopForTenantMysql','shippingProductItemsFromRawPayloadMysql','resolveShippingProductIdMysql','isAwaitingDeliverLikeStatusMysql'],
   fetchOzonPostingByNumber:async shop=>{remote.push(['fetch',shop.id]);return null;},buildLiveShippingProductsMysql:()=>[],shipOzonPosting:async shop=>{remote.push(['ship',shop.id]);},markInventoryAlertSkuDailyDirtyMysql:async()=>{},invalidateOrderProcurementCoverage(){},scheduleOrderPackageLabelPrefetchMysql:rows=>prefetch.push(...rows)
  });
  const result=await shipping.shipOrdersMysql({order_ids:[20],tenant_id:3},2,'2');assert.deepEqual(remote,[['fetch',20],['ship',20]]);assert.equal(result.count,1);assert.equal((await query('SELECT status FROM orders WHERE id=20'))[0].status,'awaiting_deliver');assert.equal(prefetch[0].tenant_id,2);assert.equal((await query('SELECT status FROM orders WHERE id=30'))[0].status,'delivered');
  await query("UPDATE orders SET status='awaiting_packaging',tracking_stage='awaiting_packaging' WHERE id=20");await query("UPDATE people SET role='packing' WHERE id=2");
  shipping.shipOzonPosting=async()=>{await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');};
  await assert.rejects(shipping.shipOrdersMysql({order_ids:[20]},2,'2',{session:{personId:2,tenant:{id:2,slug:'a'}}}),/不可用/);
  assert.equal((await query('SELECT status FROM orders WHERE id=20'))[0].status,'awaiting_packaging');await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');await query("UPDATE people SET role='operator' WHERE id=2");
 });
 await t.test('server print jobs and actual order-label fetch/mark use the fresh enterprise, including queued revocation',async()=>{
  const a={personId:2,tenant:{id:2,slug:'a'},platform_role:'super_admin'},b={personId:3,tenant:{id:3,slug:'b'}},d={personId:1,tenant:{id:1,slug:'default'}};
  const printing=loadTenantPrintService(connection),printed=[],fetched=[];
  printing.executePdfJob=async job=>{printed.push(job.tenant_id);};
  const body={pdf_base64:Buffer.from('%PDF-fixture').toString('base64'),filename:'A-private.pdf',tenant_id:3};
  await printing.serverPrintPdf(body,2,'2',{session:a});await printing.serverPrintPdf({...body,filename:'B-private.pdf'},3,'3',{session:b});
  assert.deepEqual(Array.from((await printing.serverPrintJobs('2',{session:a})).jobs,row=>row.filename),['A-private.pdf']);assert.deepEqual(Array.from((await printing.serverPrintJobs('3',{session:b})).jobs,row=>row.filename),['B-private.pdf']);assert.equal((await printing.serverPrintJobs('admin',{session:d})).jobs.length,0);
  await assert.rejects(printing.serverPrintJobs('admin',{session:a}),/无权/);await assert.rejects(printing.serverPrintPdf(body,2,'3',{session:a}),/无权/);
  const {service:labels}=loadTenantOrderService(connection,{extraMethods:['activeShopForTenantMysql','loadCachedOrderPackageLabelsMysql','fetchAndCacheOrderPackageLabelMysql','cacheOrderPackageLabelMysql'],fetchOzonPackageLabel:async shop=>{fetched.push(shop.id);return Buffer.from('%PDF-A-owned');},isOrderInTransportMysql:()=>false,clearOrderPackageLabelPrefetchTimerMysql(){},mergePdfBuffersMysql:async buffers=>Buffer.concat(buffers)});
  const services={orderPackageLabel:(...args)=>labels.orderPackageLabelMysql(...args),markOrderLabelsPrinted:(...args)=>labels.markOrderLabelsPrintedMysql(...args)};
  const printedLabels=await printing.serverPrintOrderLabels({order_ids:[20],tenant_id:3},2,services,'2',{session:a});assert.deepEqual(Array.from(printedLabels.printed_ids),[20]);assert.equal(printedLabels.job.tenant_id,2);
  const count=printed.length;await assert.rejects(printing.serverPrintOrderLabels({order_ids:[20,30]},2,services,'2',{session:a}),/不属于/);assert.equal(printed.length,count);assert.equal((await query('SELECT COUNT(*) n FROM order_label_prints WHERE order_id=20'))[0].n,1);
  let unblock,started;const begun=new Promise(resolve=>{started=resolve;});printing.executePdfJob=async()=>{started();return new Promise(resolve=>{unblock=resolve;});};
  const first=printing.serverPrintPdf(body,2,'2',{session:a});await begun;
  let remembered;const queuedCreated=new Promise(resolve=>{remembered=resolve;});const remember=printing.rememberJob;printing.rememberJob=job=>{const result=remember(job);remembered();return result;};
  const queued=printing.serverPrintPdf({...body,filename:'never-printed.pdf'},2,'2',{session:a});const denied=assert.rejects(queued,/不可用/);await queuedCreated;await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');unblock();await first;await denied;
  await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');assert.equal((await printing.serverPrintJobs('2',{session:a})).jobs[0].status,'failed');
  await query("UPDATE people SET role='procurement' WHERE id=2");await assert.rejects(printing.serverPrintPdf(body,2,'2',{session:a}),/无权/);await query("UPDATE people SET role='operator' WHERE id=2");
 });
 await t.test('profit analytics rebuild preserves every foreign snapshot and redacts poisoned product grouping',async()=>{
  const refreshed=[];
  const {service:analytics}=loadTenantOrderService(connection,{extraMethods:['refreshProfitAnalyticsSnapshotsMysql','profitOrderedAtUtcRangeMysql','profitTimestampUtcRangeMysql','returnLossTotalSqlMysql'],buildOrderOutcomeSql,ensureProfitAnalyticsSchemaMysql:async()=>{},refreshInventoryAlertSkuDailyMysql:async(_body,id)=>refreshed.push(id)});
  await analytics.refreshProfitAnalyticsSnapshotsMysql({from:'2026-10-01',to:'2026-10-05'},'3');
  const foreign={};for(const table of ['analytics_shop_daily','analytics_product_profit_daily','analytics_sku_profit_daily'])foreign[table]=await query(`SELECT * FROM ${table} WHERE shop_id=30 ORDER BY date_key`);
  const own=await analytics.refreshProfitAnalyticsSnapshotsMysql({from:'2026-10-01',to:'2026-10-05',tenant_id:3},'2');assert.equal(own.shop_rows,2);assert.equal(own.product_rows,1);assert.equal(own.sku_rows,2);
  assert.equal((await query("SELECT product_id FROM analytics_sku_profit_daily WHERE shop_id=20 AND ozon_sku='poisoned'"))[0].product_id,null);
  for(const table of Object.keys(foreign))assert.deepEqual(await query(`SELECT * FROM ${table} WHERE shop_id=30 ORDER BY date_key`),foreign[table]);
  await analytics.refreshProfitAnalyticsSnapshotsMysql({from:'2026-10-01',to:'2026-10-05'},'admin');
  assert.deepEqual((await query('SELECT DISTINCT shop_id FROM analytics_shop_daily ORDER BY shop_id')).map(row=>row.shop_id),[10,11,20,30]);assert.deepEqual(refreshed,[3,2,1]);
 });
 await t.test('profit ranking scopes all dimensions, pagination, search and advertising enrichment, including default legacy shops',async()=>{
  for(const [shop,spend]of [[10,1],[11,2],[20,3],[30,9000]])await query("INSERT INTO ozon_ad_sku_daily(shop_id,date_key,ozon_sku,spend_cny,revenue_cny) VALUES(?,'2026-10-03','same-sku',?,?)",[shop,spend,spend*2]);
  const {service:ranking}=loadTenantOrderService(connection,{extraMethods:['profitRankingMysql','profitOrderedAtUtcRangeMysql','profitTimestampUtcRangeMysql','terminalOrderLossSqlMysql','returnLossTotalSqlMysql','roundMoneyMysql'],buildOrderOutcomeSql});
  for(const fast of ['0','1'])for(const dimension of ['sku','shop','product'])for(const [tenant,shops,products]of [['2',[20],[20,null]],['3',[30],[30]],['admin',[10,11],[10,11]]]){
   const result=await ranking.profitRankingMysql({dimension,fast,from:'2026-10-01',to:'2026-10-05',tenant_id:3},tenant);assert.ok(result.rows.length>0);assert.ok(!JSON.stringify(result).includes(tenant==='3'?'A product':'B secret'));
   for(const row of result.rows){if(dimension==='product')assert.ok(products.includes(row.product_id));else assert.ok(shops.includes(row.shop_id));assert.ok(row.advertising_report_spend<9000||tenant==='3');}
  }
  assert.equal((await ranking.profitRankingMysql({dimension:'shop',shopId:30},'admin')).total,0);
  assert.equal((await ranking.profitRankingMysql({dimension:'product',keyword:'B secret'},'2')).total,0);
  assert.equal((await ranking.profitRankingMysql({dimension:'sku',keyword:'B secret'},'admin')).total,0);
  const page=await ranking.profitRankingMysql({dimension:'sku',pageSize:1,page:2},'2');assert.equal(page.total,2);assert.equal(page.rows.length,1);assert.equal(page.rows[0].shop_id,20);
 });
 await t.test('product order profit and cancellation detail SQL verifies the product plus all owning shops and references',async()=>{
  const {service:details}=loadTenantOrderService(connection,{extraMethods:['productOrderDetailRowsMysql']});
  await assert.rejects(details.productOrderDetailRowsMysql(30,false,{},'2'),/不属于/);await assert.rejects(details.productOrderDetailRowsMysql(20,true,{},'admin'),/不属于/);
  const a=await details.productOrderDetailRowsMysql(20,false,{paged:'1'},'2');assert.equal(a.total,1);assert.equal(a.rows[0].order_id,20);assert.equal(a.rows[0].product_name,'A product');assert.ok(!JSON.stringify(a).includes('B secret'));
  const d=await details.productOrderDetailRowsMysql(10,false,{},'admin');assert.deepEqual(Array.from(d,row=>row.order_id),[10]);
  await query("UPDATE orders SET status='cancelled',tracking_stage='cancelled' WHERE id=20");const cancelled=await details.productOrderDetailRowsMysql(20,true,{paged:'1'},'2');assert.equal(cancelled.total,1);assert.equal(cancelled.rows[0].order_id,20);await query("UPDATE orders SET status='awaiting_packaging',tracking_stage='awaiting_packaging' WHERE id=20");
 });
 await t.test('historical review reads and versioned cleanup affect only selected owned rows, with mixed batches rejected atomically',async()=>{
  await query("UPDATE orders SET status='delivered',tracking_stage='delivered',sync_state='final' WHERE id IN(10,20,30)");
  await query('INSERT INTO order_profit_items(order_item_id,sale_amount_cny,return_loss_cny,net_profit_cny,profit_status) VALUES(10,10,2,8,\'accrued\'),(20,20,3,17,\'accrued\'),(30,3000,500,2500,\'accrued\') ON DUPLICATE KEY UPDATE return_loss_cny=VALUES(return_loss_cny)');
  const writer=loadOrderProfitWriter(connection),scopes=[];
  const {service:history}=loadTenantOrderService(connection,{extraMethods:['historicalProfitReviewMysql','historicalReviewFiltersMysql','historicalReviewRowsSqlMysql','refreshHistoricalReviewDerivedFieldsMysql','historicalReviewBucketMysql','historicalReviewBucketLabelMysql','historicalReviewOrderItemIdsMysql','applyHistoricalProfitReviewActionMysql','upsertHistoricalProfitReviewMysql','recalculateNetProfitWithoutReturnLossMysql','cleanupHistoricalDeliveredReturnLossMysql','cleanupHistoricalUnconfirmedActualProfitMysql','roundMoneyMysql'],withVersionedOrderProfitBatchWrite:writer.withVersionedOrderProfitBatchWrite,refreshTenantOrderAnalyticsMysql:async id=>scopes.push(id),refreshOrderProfitDetailSnapshotsMysql:async(_body,id)=>scopes.push(id)});
  for(const [tenant,expected]of [['2',[20]],['3',[30]],['admin',[10]]]){const review=await history.historicalProfitReviewMysql({},tenant);assert.deepEqual(Array.from(review.rows,row=>row.order_item_id),expected);}
  for(const action of ['keep','reset','clear','recalculate'])await assert.rejects(history.applyHistoricalProfitReviewActionMysql({action,order_item_ids:[20,30]},2,'2'),/不属于/);
  assert.equal((await query('SELECT COUNT(*) n FROM historical_profit_reviews'))[0].n,0);
  await history.applyHistoricalProfitReviewActionMysql({action:'keep',order_item_ids:[20]},2,'2');assert.equal((await query('SELECT review_status FROM historical_profit_reviews WHERE order_item_id=20'))[0].review_status,'kept');
  await history.applyHistoricalProfitReviewActionMysql({action:'reset',order_item_ids:[20]},2,'2');
  const foreign=await query('SELECT * FROM order_profit_items WHERE order_item_id=30');
  await history.applyHistoricalProfitReviewActionMysql({action:'clear',order_item_ids:[20]},2,'2');assert.equal(Number((await query('SELECT return_loss_cny FROM order_profit_items WHERE order_item_id=20'))[0].return_loss_cny),0);assert.deepEqual(await query('SELECT * FROM order_profit_items WHERE order_item_id=30'),foreign);
  assert.equal((await query("SELECT COUNT(*) n FROM order_profit_calc_revisions WHERE tenant_key='2' AND order_item_id=20 AND source='manual_historical_review'"))[0].n,2);
  assert.equal((await history.cleanupHistoricalDeliveredReturnLossMysql({},'2')).updated_items,0);await history.cleanupHistoricalUnconfirmedActualProfitMysql({},'2');assert.deepEqual(await query('SELECT * FROM order_profit_items WHERE order_item_id=30'),foreign);assert.ok(scopes.every(id=>id==='2'));
 });
 await t.test('exception queries, memory and persisted caches, stock calls and state mutations all verify enterprise ownership',async()=>{
  await query("UPDATE order_profit_items SET net_profit_cny=-7 WHERE order_item_id IN(10,20,30)");await query("UPDATE orders SET status='awaiting_packaging',tracking_stage='awaiting_packaging' WHERE id IN(10,20,21,30)");
  const methods=['exceptionWorkbenchMysql','exceptionWorkbenchCacheKeyMysql','exceptionWorkbenchSnapshotKeyMysql','invalidateTenantExceptionWorkbenchMysql','paginateExceptionWorkbenchMysql','buildExceptionWorkbenchMysql','exceptionViewMysql','exceptionShouldBuildOrderTasksMysql','exceptionShouldBuildStockTasksMysql','exceptionOrderCandidateRowsMysql','exceptionOrderIssueCandidateRowsMysql','exceptionOrderSearchSqlMysql','exceptionOrderTasksMysql','exceptionTaskMysql','exceptionOrderContextMysql','firstDelimitedValueMysql','firstMappedValueMysql','profitExceptionBreakdownMysql','exceptionOrderBusinessStatusMysql','exceptionPriorityValueMysql','exceptionTaskStateMapMysql','assertExceptionTaskOwnershipMysql','exceptionTaskMatchesViewMysql','exceptionTaskMatchesSearchMysql','exceptionTaskMatchesDateMysql','exceptionTaskDateMysql','stockAlertSkuTextMysql','fallbackShipDeadlineMysql','daysBetweenMysql','normalizeMysqlDateTime','roundMoneyMysql','updateExceptionTaskStateMysql','upsertExceptionTaskStatesMysql'];
  const stockScopes=[];const {service:exceptions}=loadTenantOrderService(connection,{extraMethods:methods,ensureStockLocationSchemaMysql:async()=>{},ensureProfitAnalyticsSchemaMysql:async()=>{},EXCEPTION_WORKBENCH_CACHE_TTL_MS:45000,EXCEPTION_VIEW_TYPES_MYSQL:{profit:new Set(['profit']),deadline:new Set(['deadline']),deadline_warning:new Set(['deadline_warning']),binding:new Set(['order_binding']),stock:new Set(['order_stock_shortage','stock_local','stock_fbp','stock_fbs','stock_mapping'])},classifyOrderAccounting,cancellationDisplay,EXCEPTION_WORKBENCH_CACHE_TTL_MS:45000,getCachedMasterData,invalidateExceptionWorkbenchCache,invalidateMasterDataCachePrefix,stockAlertsMysql:async(_query,id)=>{stockScopes.push(id);const scope=await service.orderOwnershipTenantScopeMysql(id);return {rows:(await query('SELECT id FROM products WHERE '+service.orderTenantPredicateMysql('products',scope))).map(row=>({product_id:row.id,product_name:'Owned product '+row.id,warnings:[{type:'local',level:'warning',text:'Local shortage'}]}))};}});
  await query('INSERT INTO exception_workbench_snapshots(cache_key,payload_json) VALUES(?,?)',[exceptions.createHash('sha1').update('exception-workbench:{"view":"profit"}').digest('hex'),JSON.stringify({rows:[{orderId:30,subject:'B leaked global snapshot'}]})]);
  invalidateExceptionWorkbenchCache();
  for(const [tenant,expected]of [['2',[20]],['3',[30]],['admin',[10]]])for(let repeat=0;repeat<2;repeat++){
   const payload=await exceptions.exceptionWorkbenchMysql({view:'profit'},tenant);assert.deepEqual(Array.from(payload.rows,row=>row.orderId),expected);assert.ok(!JSON.stringify(payload).includes('B leaked'));assert.equal(payload.counts.profit,1);
  }
  invalidateExceptionWorkbenchCache();assert.deepEqual(Array.from((await exceptions.exceptionWorkbenchMysql({view:'profit'},'2')).rows,row=>row.orderId),[20]);
  for(const view of ['binding','stock','deadline','deadline_warning'])for(const [tenant,allowed]of [['2',[20,21]],['3',[30]],['admin',[10,11]]]){const rows=await exceptions.exceptionOrderCandidateRowsMysql(view,{},tenant);assert.ok(rows.every(row=>allowed.includes(row.id)));assert.ok(!JSON.stringify(rows).includes(tenant==='3'?'A product':'B secret'));}
  assert.equal((await exceptions.exceptionOrderCandidateRowsMysql('binding',{search:'B secret'},'2')).length,0);
  const stock=await exceptions.exceptionWorkbenchMysql({view:'stock',refresh:'1'},'2');assert.ok(stockScopes.every(id=>id===2));assert.ok(stock.rows.every(row=>!row.productId||row.productId===20));
  const before=await query('SELECT * FROM exception_task_states ORDER BY task_id');for(const tenant of ['2','admin'])await assert.rejects(exceptions.updateExceptionTaskStateMysql({task_id:'profit:30:订单利润为负',status:'handled'},2,tenant),/不属于/);await assert.rejects(exceptions.updateExceptionTaskStateMysql({task_id:'untrusted:20:x',status:'handled'},2,'2'),/无效/);assert.deepEqual(await query('SELECT * FROM exception_task_states ORDER BY task_id'),before);
  const options={session:{personId:2,tenant:{id:2,slug:'a'}}};await exceptions.updateExceptionTaskStateMysql({task_id:'profit:20:订单利润为负',status:'handled'},2,'2',options);assert.equal((await exceptions.exceptionWorkbenchMysql({view:'profit'},'2')).total,0);assert.equal((await exceptions.exceptionWorkbenchMysql({view:'profit'},'3')).total,1);
  await exceptions.updateExceptionTaskStateMysql({task_id:'profit:20:订单利润为负',status:'open'},2,'2',options);assert.equal((await exceptions.exceptionWorkbenchMysql({view:'profit'},'2')).total,1);
  invalidateExceptionWorkbenchCache();
 });
 await t.test('heatmap source, title cache, manual confirmation and AI writes remain enterprise-private for identical titles',async()=>{
  await query("UPDATE order_items SET ozon_name='Unrecognized shared title' WHERE id IN(10,20,30)");
  await query("UPDATE people SET role='operator' WHERE id=2");
  const aiCalls=[],contexts=[];let revoke=false;
  const heatmap=loadOrderHeatmapService(connection,{withAiTenantSession:async(session,action,options)=>{contexts.push({person:session.personId,...options});return action();},chatWithAiProvider:async payload=>{aiCalls.push(JSON.stringify(payload));const prompt=payload.messages[1].content;const candidates=JSON.parse(prompt.slice(prompt.indexOf('[{')));if(revoke)await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');return {content:JSON.stringify(candidates.map(row=>({title_hash:row.title_hash,brand:'A AI',model:'A model',product_key:'floor_mat',confidence:.99}))) };}});
  for(const [tenant,expected]of [['2',[20,21]],['3',[30]],['admin',[11,10]]]){
   const source=await heatmap.orderCarHeatmapSourceRows({},tenant);assert.deepEqual(Array.from(source.rows,row=>row.order_id).sort(),expected.sort());assert.ok(!JSON.stringify(source.rows).includes(tenant==='3'?'A product':'B secret'));
   for(const method of ['orderCarHeatmapModelsMysql','orderCarHeatmapProductsMysql','orderCarHeatmapSkusMysql','orderCarHeatmapUnmatchedMysql'])assert.ok((await heatmap[method]({},tenant)).source_rows>0);
  }
  assert.equal((await heatmap.orderCarHeatmapSkusMysql({shopId:30},'admin')).total,0);
  const session={personId:2,tenant:{id:2,slug:'a'}},options={session};
  const a=await heatmap.orderCarHeatmapConfirmTagMysql({title:'Unrecognized shared title',title_hash:'f'.repeat(64),brand:'A-only brand',model:'A model'},2,'2',options);assert.notEqual(a.title_hash,'f'.repeat(64));
  assert.ok((await heatmap.orderCarHeatmapModelsMysql({},'2')).rows.some(row=>row.brand==='A-only brand'));assert.ok(!JSON.stringify(await heatmap.orderCarHeatmapModelsMysql({},'admin')).includes('A-only brand'));
  await heatmap.orderCarHeatmapConfirmTagMysql({title:'Unrecognized shared title',brand:'B-only brand',model:'B model'},3,'3');assert.ok(!JSON.stringify(await heatmap.orderCarHeatmapModelsMysql({},'2')).includes('B-only brand'));
  await query("UPDATE order_items SET ozon_name='Unrecognized B secret title' WHERE id=30");
  const before=await query('SELECT * FROM order_vehicle_title_tags ORDER BY id');
  await assert.rejects(heatmap.orderCarHeatmapConfirmTagMysql({title:'Unrecognized B secret title',brand:'spoofed',model:'spoofed'},2,'2',options),/不存在于当前企业/);assert.deepEqual(await query('SELECT * FROM order_vehicle_title_tags ORDER BY id'),before);
  await heatmap.orderCarHeatmapConfirmTagMysql({title:'Unrecognized shared title',brand:'Default-only',model:'Legacy model'},1,'admin');
  assert.ok(JSON.stringify(await heatmap.orderCarHeatmapModelsMysql({},'admin')).includes('Default-only'));assert.ok(!JSON.stringify(await heatmap.orderCarHeatmapModelsMysql({},'2')).includes('Default-only'));
  await query('DELETE FROM order_vehicle_title_tags WHERE tenant_id=2');
  const classified=await heatmap.orderCarHeatmapAiClassifyMysql({tenant_id:3},'2',options);assert.ok(classified.saved_count>0);assert.ok(aiCalls.every(payload=>!payload.includes('B secret')));assert.deepEqual(contexts,[{person:2,permission:'analytics'}]);
  await query('DELETE FROM order_vehicle_title_tags WHERE tenant_id=2');revoke=true;
  await assert.rejects(heatmap.orderCarHeatmapAiClassifyMysql({},'2',options),/不可用/);assert.equal((await query('SELECT COUNT(*) n FROM order_vehicle_title_tags WHERE tenant_id=2'))[0].n,0);
  await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');await query("UPDATE people SET role='operator' WHERE id=2");
  await assert.rejects(heatmap.orderCarHeatmapAiClassifyMysql({},'2'),/有效企业成员/);
  const rows=await query('SELECT * FROM order_vehicle_title_tags ORDER BY id');const inspected=await inspectOrderHeatmapTenantSchema(query);assert.equal(inspected.tenant_column,true);assert.deepEqual(await query('SELECT * FROM order_vehicle_title_tags ORDER BY id'),rows);
  await query('ALTER TABLE order_vehicle_title_tags DROP INDEX idx_order_vehicle_title_tags_tenant_hash, DROP COLUMN tenant_id');const legacy=await query('SELECT * FROM order_vehicle_title_tags ORDER BY id');
  await assert.rejects(heatmap.orderCarHeatmapModelsMysql({},'2'),/隔离迁移/);
  const cli=fileURLToPath(new URL('../scripts/migrate-tenant-order-heatmap.mjs',import.meta.url)),args=[cli,'--mysql-admin-socket='+socketPath,'--database='+database],cliOptions={encoding:'utf8',env:{...process.env,DB_NAME:'explicit_cli_database_must_win',DB_HOST:'127.0.0.1',DB_PORT:'1',DB_USER:'unused'}};
  const audit=JSON.parse(execFileSync(process.execPath,args,cliOptions));assert.equal(audit.changes_database,false);assert.equal(audit.schema.tenant_column,false);assert.deepEqual(await query('SELECT * FROM order_vehicle_title_tags ORDER BY id'),legacy);
  const applied=JSON.parse(execFileSync(process.execPath,[...args,'--apply'],cliOptions));assert.equal(applied.mode,'apply');assert.equal(applied.data_rows_changed,0);
  const migrated=await query('SELECT * FROM order_vehicle_title_tags ORDER BY id');assert.deepEqual(migrated.map(({tenant_id,...row})=>row),legacy);assert.ok(migrated.every(row=>row.tenant_id===null));await applyOrderHeatmapTenantSchema(query);
 });
 await t.test('sales refresh replaces only owned shops and uses independent tenant freshness with rollback',async()=>{
  await query(TENANT_INVENTORY_SALES_REFRESH_SCHEMA);
  let fail=false;
  const deps=tenantScope=>({tenantScope,normalizeDate:x=>String(x||''),todayDateKey:()=> '2026-10-05',chinaDateSql:column=>`DATE(${column})`,orderedAtUtcRange:(_,from,to)=>({whereSql:'AND o.ordered_at >= ? AND o.ordered_at < DATE_ADD(?,INTERVAL 1 DAY)',params:[from,to]}),transportEvidenceSql:orderTransportEvidenceSql,execute:query,queryOne:async(sql,params)=>(await query(sql,params))[0],invalidateCache(){},transaction:async action=>{await connection.beginTransaction();try{const result=await action({execute:async(sql,params)=>{if(fail&&/INSERT INTO inventory_alert_sku_daily \(/.test(sql))throw Error('injected failure');return connection.execute(sql,params);}});await connection.commit();return result;}catch(error){await connection.rollback();throw error;}}});
  const a=deps({id:2,defaultTenant:false}),b=deps({id:3,defaultTenant:false}),d=deps({id:1,defaultTenant:true});
  await markInventoryAlertSkuDailyDirtyMysqlService(b,'2026-10-05');
  await refreshInventoryAlertSkuDailyMysqlService(b,{from:'2026-10-05',to:'2026-10-05'});
  await markInventoryAlertSkuDailyDirtyMysqlService(b,'2026-10-05');
  await refreshInventoryAlertSkuDailyMysqlService(a,{from:'2026-10-01',to:'2026-10-05'});
  assert.equal((await query('SELECT dirty FROM inventory_alert_tenant_daily_refresh WHERE tenant_id=3 AND date_key=\'2026-10-05\''))[0].dirty,1);
  assert.equal(Number((await query('SELECT SUM(item_quantity) quantity FROM inventory_alert_sku_daily WHERE shop_id=30'))[0].quantity),1);
  assert.equal((await query('SELECT COUNT(*) n FROM inventory_alert_sku_daily WHERE shop_id IN(20,30)'))[0].n,3);
  await refreshInventoryAlertSkuDailyMysqlService(d,{from:'2026-10-01',to:'2026-10-05'});
  assert.equal((await query('SELECT COUNT(*) n FROM inventory_alert_sku_daily WHERE shop_id IN(10,11)'))[0].n,2);
  const before=await query('SELECT * FROM inventory_alert_sku_daily WHERE shop_id=20');fail=true;
  await assert.rejects(refreshInventoryAlertSkuDailyMysqlService(a,{from:'2026-10-03',to:'2026-10-03'}),/injected failure/);assert.deepEqual(await query('SELECT * FROM inventory_alert_sku_daily WHERE shop_id=20'),before);
 });
 }finally{if(created)await connection.query('DROP DATABASE `'+database+'`');await connection.end();}
});
