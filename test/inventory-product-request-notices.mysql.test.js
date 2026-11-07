import assert from 'node:assert/strict';
import test from 'node:test';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {writeInventoryProductRequestNotices,inventoryRequestRecipient} from '../src/services/inventory-product-request-notices.js';

test('legacy default ownership and platform identities do not synthesize inventory approval recipients',()=>{
 assert.equal(inventoryRequestRecipient({role:'technical',tenant_role:'owner',business_roles_json:null},{id:1,isDefault:true}),false);
 assert.equal(inventoryRequestRecipient({role:'operations',tenant_role:'member',business_roles_json:['operations']},{id:2,isDefault:false}),false);
 assert.equal(inventoryRequestRecipient({role:'packing',tenant_role:'member',business_roles_json:['packing','manager']},{id:2,isDefault:false}),true);
});

test('inventory request inbox notices are transactional, scoped, deduplicated and close on review',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL'},async()=>{
 const f=await createTenantMysqlFixture('inv_req_notice'),q=f.query,c=f.connection;
 try{
  for(const n of [1,2,3])await q('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)',[n,n===1?'default':'notice-'+n,'Enterprise '+n]);
  for(const [id,role,active] of [[1,'operations',1],[2,'manager',1],[3,'technical',1],[4,'manager',1],[5,'manager',0],[6,'admin',1],[7,'operations',1],[8,'packing',1]])await q('INSERT INTO people(id,name,role,active) VALUES(?,?,?,?)',[id,'Person '+id,role,active]);
  for(const [tenant,id,role,jobs]of [[2,1,'member',['operations']],[2,2,'member',['manager']],[1,3,'owner',null],[3,4,'member',['manager']],[2,5,'member',['manager']],[2,7,'owner',['operations']],[2,8,'member',['packing','manager']]])await q('INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,?,?)',[tenant,id,role,jobs===null?null:JSON.stringify(jobs)]);
  const tenant={id:2,isDefault:false},row={id:101,applicant_id:2,applicant_name:'Person 2',payload_json:JSON.stringify({name:'测试库存'}),status:'pending',revision:1};
  await c.beginTransaction();const first=await writeInventoryProductRequestNotices(c,tenant,row);await c.commit();
  assert.deepEqual(first.map(r=>r.personId).sort((a,b)=>a-b),[2,7,8],'Authorized creator receives their own approval notice');
  let notices=await q('SELECT * FROM system_notifications ORDER BY id');assert.equal(notices.length,3);assert.ok(notices.every(n=>n.tenant_id===2&&n.route==='/inventory/product-requests?requestId=101'));
  await c.beginTransaction();const repeat=await writeInventoryProductRequestNotices(c,tenant,row);await c.commit();assert.equal(repeat.length,0);assert.equal((await q('SELECT * FROM system_notifications')).length,3);
  await c.beginTransaction();await writeInventoryProductRequestNotices(c,tenant,{...row,status:'returned',review_note:'请补充规格',revision:2});await c.commit();
  assert.equal((await q("SELECT * FROM system_notifications WHERE notification_type='inventory_product_request' AND status<>'resolved'")).length,0);
  const returned=await q("SELECT * FROM system_notifications WHERE notification_type='inventory_product_request_result'");assert.equal(returned.length,1);assert.equal(returned[0].recipient_person_id,2);assert.match(returned[0].content,/请补充规格/);
  await c.beginTransaction();await writeInventoryProductRequestNotices(c,tenant,{...row,revision:3});await c.commit();
  assert.equal((await q("SELECT * FROM system_notifications WHERE notification_type='inventory_product_request' AND status='unread'")).length,3);
  await c.beginTransaction();await writeInventoryProductRequestNotices(c,tenant,{...row,status:'approved',revision:4});await c.commit();
  assert.equal((await q("SELECT * FROM system_notifications WHERE notification_type='inventory_product_request' AND status<>'resolved'")).length,0);
  await c.beginTransaction();await writeInventoryProductRequestNotices(c,tenant,{...row,id:102,applicant_id:1});await c.rollback();assert.equal((await q("SELECT * FROM system_notifications WHERE entity_id='102'")).length,0);
  assert.equal((await q('SELECT * FROM system_notifications WHERE tenant_id<>2 OR recipient_person_id IN(3,4,5,6)')).length,0);
 }finally{await f.cleanup();}
});
