import test from 'node:test';
import assert from 'node:assert/strict';
import {withRequestReadCache,memoRequestRead} from '../src/services/request-read-cache.js';
import {loadTenantOrderService} from './helpers/tenant-order-service.js';
test('request memo coalesces concurrent reads but never survives another request, failure or tenant context',async()=>{
 let reads=0;
 await withRequestReadCache(async()=>{const load=async()=>++reads;assert.deepEqual(await Promise.all([memoRequestRead('a',load),memoRequestRead('a',load)]),[1,1]);await withRequestReadCache(async()=>assert.equal(await memoRequestRead('a',load),1));await assert.rejects(memoRequestRead('failed',async()=>{throw Error('denied');}),/denied/);assert.equal(await memoRequestRead('failed',load),2);});
 assert.equal(await withRequestReadCache(()=>memoRequestRead('a',async()=>++reads)),3);
 const values=await Promise.all([2,3].map(tenant=>withRequestReadCache(async()=>{await Promise.resolve();return memoRequestRead('tenant',async()=>tenant);})));assert.deepEqual(values,[2,3]);
 await memoRequestRead('a',async()=>++reads);await memoRequestRead('a',async()=>++reads);assert.equal(reads,5);
});
test('order and logistics scopes share one active-enterprise lookup, and revocation is checked on the next request',async()=>{
 let active=true,idReads=0,slugReads=0;
 const {service}=loadTenantOrderService({query:async(sql)=>{
  if(sql.includes("SELECT id FROM tenants WHERE id")){idReads++;return [active?[{id:2}]:[]];}
  if(sql.includes('SELECT slug FROM tenants')){slugReads++;return [[{slug:'customer'}]];}
  return [[{found:1}]];
 }},{mysqlSchemaColumnExists:async()=>true,extraMethods:['logisticsTenantScopeMysql']});
 await withRequestReadCache(async()=>{const [order,left,right]=await Promise.all([service.orderListTenantScopeMysql('2'),service.logisticsTenantScopeMysql('2','left_rule'),service.logisticsTenantScopeMysql('2','right_rule')]);assert.equal(order.id,2);assert.equal(left.tenantId,2);assert.match(right.sql,/right_rule\.tenant_id/);});
 assert.equal(idReads,1);assert.equal(slugReads,1);active=false;
 await assert.rejects(withRequestReadCache(()=>service.orderListTenantScopeMysql('2')),/企业上下文无效/);assert.equal(idReads,2);
});
