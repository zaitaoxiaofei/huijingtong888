import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { orderFunctionSource } from './helpers/tenant-order-service.js';

test('combined order requests start fresh enterprise coverage and logistics together without changing counts',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});const started=[];const scope={id:2,defaultTenant:false};const counts={all:17,pending_purchase:3};
 const c=vm.createContext({
  ensureMysqlCutoverEnabled(){},orderListTenantScopeMysql:async()=>scope,assertTenantOrderListFiltersMysql(){},
  ensureOrderLabelPrintSchemaMysql:async()=>{},ensureSkuInventoryRecipeSchemaMysql:async()=>{},ensureProductCompositionSchemaMysql:async()=>{},ensureProductNamingSchemaMysql:async()=>{},
  orderBaseSqlMysql:async()=>({where:'o.shop_id=20',params:[]}),normalizeLogisticsServiceClass:()=> 'all',
  loadOrderLogisticsSummaryForBaseMysql:async(base,tenant)=>{assert.equal(tenant,'2');started.push('logistics');await gate;return [];},
  orderTenantCoverageMysql:async current=>{assert.equal(current,scope);started.push('coverage');await gate;return new Map();},
  filterOrderIdsByLogisticsMethodMysql:()=>null,filterOrderIdsByLogisticsCarrierMysql:()=>null,filterOrderIdsByLogisticsServiceClassMysql:()=>null,
  withRestrictedOrderIdsMysql:base=>base,orderLogisticsMethodOptionsMysql:async()=>[],
  orderPagedSqlCountsMysql:async()=>counts,orderFilteredSqlMysql:async()=>({where:'o.shop_id=20',params:[],joins:''}),
  mysqlQueryOne:async()=>({total:17}),orderLogisticsCarrierOptionsMysql:()=>[],orderLogisticsServiceClassOptions:()=>[]
 });
 vm.runInContext(orderFunctionSource('ordersPagedMysql'),c);
 const pending=c.ordersPagedMysql({includeRows:'0',includeCounts:'1',includeLogisticsOptions:'1'},'2');
 try{await new Promise(setImmediate);assert.deepEqual(started.sort(),['coverage','logistics']);}finally{release();}
 const result=await pending;assert.equal(result.counts,counts);assert.equal(result.total,17);assert.equal(result.rows.length,0);
});
