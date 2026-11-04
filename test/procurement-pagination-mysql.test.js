import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('FBP receipt pages honor 20/50/100 limits and retain totals on an emptied page', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000},async()=>{
 const f=await createTenantMysqlFixture('procure_pages');f.useEnvironment();const q=f.query;
 const {createFbpReceiptReview}=await import('../src/services/fbp-receipt-review.js');
 const api=await import('../src/services/mysql-cutover.js');const {closeMysqlPool}=await import('../src/mysql-pool.js');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(2,'Warehouse','packing')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,2,'member',JSON_ARRAY('packing'))");
  await api.prepareInventoryFlowMysql();
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A','active'),(30,3,'B','active')");
  await q("INSERT INTO products(id,tenant_id,name) VALUES(200,2,'A stock'),(300,3,'Private B stock')");
  for(let i=1;i<=65;i++)await q("INSERT INTO fbp_transfer_records(id,product_id,shop_id,ozon_sku,quantity,status,shipped_at) VALUES(?,200,20,?,1,'sent','2026-11-01 01:00:00')",[i,'SKU-'+i]);
  await q("INSERT INTO fbp_transfer_records(id,product_id,shop_id,ozon_sku,quantity,status,shipped_at) VALUES(900,300,30,'SECRET',1,'sent','2026-11-01 01:00:00')");
  const service=createFbpReceiptReview({query:async(sql,args=[])=>(await f.connection.query(sql,args))[0]}),session={personId:2,tenant:{id:2,slug:'a',role:'member'}};
  for(const [size,expected]of [[undefined,50],[20,20],[50,50],[100,65],[25,50]]){
   const r=await service.records({pageSize:size},session);assert.equal(r.rows.length,expected);assert.equal(r.total,65);assert.ok(r.rows.every(row=>Number(row.product_id)===200));
  }
  const second=await service.records({page:2,pageSize:20},session);assert.deepEqual(second.rows.map(row=>Number(row.id)),Array.from({length:20},(_,i)=>i+21));assert.equal(second.total,65);
  const empty=await service.records({page:10,pageSize:20},session);assert.equal(empty.rows.length,0);assert.equal(empty.total,65);
 }finally{await closeMysqlPool();await f.cleanup();}
});
