import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTenantOrderService} from './helpers/tenant-order-service.js';
import {cachedOrderRead,invalidateOrderReadCache} from '../src/services/order-read-cache.js';
import {invalidateInventoryWorkflow} from '../src/services/inventory-workflow-cache.js';

test('a late old coverage response cannot seed the next inventory revision with stale counts',async()=>{
 invalidateOrderReadCache();let release,marker=1;
 const gate=new Promise(resolve=>{release=resolve;});
 const oldMap=new Map(),newMap=new Map();
 const late=cachedOrderRead('coverage:2:0',async()=>{await gate;return oldMap;});
 invalidateInventoryWorkflow({tenantId:2,productIds:[20]});
 const fresh=await cachedOrderRead('coverage:2:0',async()=>newMap);
 release();const old=await late;
 let queries=0;
 const {service}=loadTenantOrderService({query:async()=>{queries++;return [[{all_count:marker,pending_purchase:marker}]];}},{cachedOrderRead});
 const base={where:'o.shop_id=20',params:[]},scope={id:2,defaultTenant:false};
 assert.equal((await service.orderPagedSqlCountsMysql(base,old,scope)).pending_purchase,1);
 marker=2;
 assert.equal((await service.orderPagedSqlCountsMysql(base,fresh,scope)).pending_purchase,2);
 marker=3;
 assert.equal((await service.orderPagedSqlCountsMysql(base,fresh,scope)).pending_purchase,2,'Same snapshot still reuses its result');
 assert.equal(queries,2);
 invalidateOrderReadCache();
});
