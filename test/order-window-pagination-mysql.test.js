import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {createOrderFixtureSchema,loadTenantOrderService} from './helpers/tenant-order-service.js';
import {withRequestReadCache} from '../src/services/request-read-cache.js';
test('window pagination keeps active totals, deterministic ties, filters, tenant ownership and empty-page fallback',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:90000
},async()=>{
 const f=await createTenantMysqlFixture('window_pages');
 try{
  await createOrderFixtureSchema(f.connection);
  await f.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await f.query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(20,2,'A'),(30,3,'B')");
  const records=Array.from({length:120},(_,index)=>{const id=index+1;return[id,id%11===0?30:id%13===0?10:20,'POST-'+id,id%2?'awaiting_packaging':'awaiting_deliver','2026-10-31 01:00:00'];});
  await f.connection.query('INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES ?',[records]);
  await f.connection.query('INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES ?',[records.map(([id])=>[id,id,'sku-'+id,1,10])]);
  await f.connection.query('INSERT INTO order_label_prints(order_id,printed_at) VALUES ?',[records.filter(([id])=>id%3===0).map(([id])=>[id,'2026-10-31 02:00:00'])]);
  await f.connection.query('INSERT INTO order_marks(order_id,mark_type,note) VALUES ?',[records.filter(([id])=>id%4===0).map(([id])=>[id,'review','check'])]);
  const {service,calls}=loadTenantOrderService(f.connection);service.orderRowsByIdsMysql=async ids=>ids.map(id=>({id}));
  for(const tenant of ['admin','2'])for(const filter of [{status:'all'},{status:'awaiting_packaging'},{status:'awaiting_deliver'},{status:'all',printFilter:'printed'},{status:'all',searchQuery:'POST-1',searchType:'order'}]){
   const baseQuery={...filter,includeCounts:'0',includeLogisticsOptions:'0',dateFrom:'2026-10-01',dateTo:'2026-11-01',pageSize:10};
   const scope=await service.orderListTenantScopeMysql(tenant),base=await service.orderBaseSqlMysql(baseQuery,tenant),where=await service.orderFilteredSqlMysql(baseQuery,base,new Map(),scope);
   const old=(await f.query(`SELECT o.id FROM orders o ${where.joins} WHERE ${where.where} GROUP BY o.id ORDER BY ${service.orderQuickFilterOrderSqlMysql(baseQuery,scope)}`,where.params)).map(row=>row.id);
   for(const page of [1,2,100]){
    const from=calls.length;const result=await withRequestReadCache(()=>service.ordersPagedMysql({...baseQuery,page},tenant));const actual=Array.from(result.rows,row=>row.id);
    assert.deepEqual(actual,old.slice((page-1)*10,page*10));assert.equal(result.total,old.length);
    const statements=calls.slice(from).map(c=>c.sql);
    if(actual.length){assert.ok(statements.some(sql=>sql.includes('COUNT(*) OVER() AS filtered_total')));assert.ok(!statements.some(sql=>sql.includes('COUNT(DISTINCT o.id) AS total')));}
    else assert.ok(statements.some(sql=>sql.includes('COUNT(DISTINCT o.id) AS total')));
   }
  }
 }finally{await f.cleanup();}
});
