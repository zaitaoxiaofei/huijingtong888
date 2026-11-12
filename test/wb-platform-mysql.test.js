import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { WB_SCHEMA } from '../src/services/wb-schema.js';
import { createWbPlatform } from '../src/services/wb-platform.js';

test('WB real SQL isolates shops, maps variants to shared products and imports orders idempotently', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async t=>{
  const fixture=await createTenantMysqlFixture('wb_platform');
  try{
    const {query,connection}=fixture;
    for(const sql of WB_SCHEMA)await query(sql);
    await query('ALTER TABLE order_items ADD COLUMN frozen_logistics_rule_id BIGINT UNSIGNED NULL');
    await query("INSERT INTO tenants(id,slug,name,status,shop_limit) VALUES(1,'default','Default','active',10),(2,'a','A','active',10),(3,'b','B','active',10)");
    await query("INSERT INTO people(id,name,active) VALUES(2,'A owner',1),(3,'B owner',1)");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,active) VALUES(2,2,'owner',1),(3,3,'owner',1)");
    await query("INSERT INTO products(id,tenant_id,name,code) VALUES(20,2,'Shared brake pad','BP-A'),(30,3,'Private B product','BP-B')");
    fixture.useEnvironment();
    const runtime=await import('../src/services/mysql-cutover.js');
    await runtime.warmCoreInventoryRuntimeMysql('2');
    await runtime.createInventoryMovementMysql({product_id:20,quantity_delta:100,movement_type:'MANUAL_ADJUST',stock_location:'LOCAL',source_type:'test_opening',source_ref:'opening'},2,'2');
    const remote=[];let state={supplierStatus:'new',wbStatus:'waiting'},reconciles=0,currentId=500;
    const states=new Map([[500,state]]);
    const request=async(a,service,path,options={})=>{
      remote.push({tenant:a.tenant_id,shop:a.shop_id,service,path,options});
      if(path==='/api/v1/seller-info')return {sid:`seller-${a.shop_id}`};
      if(path==='/content/v2/get/cards/list')return {cards:[{nmID:100,vendorCode:'PAD',title:'Brake pad',subjectID:1,sizes:[{chrtID:200,skus:['barcode-200']}]}]};
      if(path==='/api/v3/orders/new')return {orders:[{id:currentId,chrtId:200,nmId:100,article:'PAD',price:240000,currencyCode:643,createdAt:new Date().toISOString(),deliveryType:'fbs',cargoType:1}]};
      if(path==='/api/v3/orders')return {orders:[],next:0};
      if(path==='/api/v3/orders/status')return {orders:options.body.orders.map(id=>({id,...(id===currentId?state:states.get(id))}))};
      return {};
    };
    const service=createWbPlatform({query,transaction:async work=>{await connection.beginTransaction();try{const result=await work(connection);await connection.commit();return result;}catch(error){await connection.rollback();throw error;}},request,reconcileInventory:async(...args)=>{reconciles++;await runtime.reconcileWbOrderInventoryMysql(...args);}});
    const a=await service.saveShop(2,{name:'WB A',user_id:2,wb_token:'secret-A'});
    const b=await service.saveShop(3,{name:'WB B',user_id:3,wb_token:'secret-B'});
    await service.check(2,{shop_id:a.id});await service.check(3,{shop_id:b.id});
    await t.test('a shop token and shop identity cannot be accessed from another tenant',async()=>{
      await assert.rejects(service.account(2,b.id),error=>error.statusCode===404);
      const visible=await service.shops(2);assert.equal(visible.length,1);assert.equal(visible[0].id,a.id);
      assert.ok(!JSON.stringify(visible).includes('secret-A'));assert.ok(!JSON.stringify(visible).includes('secret-B'));
      await assert.rejects(service.saveShop(2,{id:b.id,name:'Hacked',user_id:2,wb_token:'changed'}),error=>error.statusCode===404);
      assert.equal((await service.account(3,b.id)).token,'secret-B');
    });
    await service.syncProducts(2,{shop_id:a.id});
    await t.test('variant binding uses current-tenant products and refuses overwrite',async()=>{
      await assert.rejects(service.bindProduct(2,{shop_id:a.id,nm_id:100,chrt_id:200,product_id:30}),error=>error.statusCode===404);
      await service.bindProduct(2,{shop_id:a.id,nm_id:100,chrt_id:200,product_id:20});
      const mappings=await query('SELECT * FROM sku_mappings WHERE shop_id=?',[a.id]);assert.equal(mappings.length,1);assert.equal(mappings[0].product_id,20);
      assert.equal((await service.products(2,{shop_id:a.id})).rows[0].mappings[0].product_name,'Shared brake pad');
    });
    await t.test('repeated imports create one shared order and retain source currency outside CNY accounting',async()=>{
      await service.syncOrders(2,{shop_id:a.id});await service.syncOrders(2,{shop_id:a.id});
      const orders=await query('SELECT * FROM orders WHERE shop_id=?',[a.id]);assert.equal(orders.length,1);assert.equal(orders[0].status,'awaiting_packaging');
      const items=await query('SELECT * FROM order_items WHERE order_id=?',[orders[0].id]);assert.equal(items.length,1);assert.equal(items[0].ozon_sku,'WB-200');assert.equal(Number(items[0].sale_price),0);
      const visibleRows=await runtime.orderRowsByIdsMysql([orders[0].id],null,'2',{summaryOnly:true,bypassCache:true});
      assert.equal(visibleRows[0].platform,'wb');
      assert.equal(visibleRows[0].wb_supplier_status,'new');
      assert.equal(visibleRows[0].sale_currency,'RUB');
      assert.equal(visibleRows[0].wb_amount,2400);
      assert.equal(visibleRows[0].availableActions.prepare,false);
      assert.ok(reconciles>=2);
      assert.equal((await query('SELECT COUNT(*) AS n FROM outbound_records WHERE shop_id=?',[a.id]))[0].n,1);
      assert.equal(Number((await query('SELECT SUM(quantity_delta) AS qty FROM inventory_movements WHERE product_id=20'))[0].qty),99);
    });
    await t.test('cancellation before handover releases shared inventory exactly once',async()=>{
      state={supplierStatus:'new',wbStatus:'declined_by_client'};states.set(500,state);
      await service.syncOrders(2,{shop_id:a.id});await service.syncOrders(2,{shop_id:a.id});
      assert.equal(Number((await query('SELECT SUM(quantity_delta) AS qty FROM inventory_movements WHERE product_id=20'))[0].qty),100);
      currentId=501;state={supplierStatus:'new',wbStatus:'waiting'};states.set(501,state);
      await service.syncOrders(2,{shop_id:a.id});
    });
    await t.test('handover is not physical acceptance and cancellation retains handover evidence',async()=>{
      state={supplierStatus:'complete',wbStatus:'waiting'};await service.syncOrders(2,{shop_id:a.id});
      assert.equal((await query("SELECT status FROM orders WHERE shop_id=? AND posting_number='WB-501'",[a.id]))[0].status,'awaiting_deliver');
      assert.ok((await query('SELECT handover_at FROM wb_order_details WHERE shop_id=? AND wb_order_id=501',[a.id]))[0].handover_at);
      state={supplierStatus:'complete',wbStatus:'accepted_by_carrier'};await service.syncOrders(2,{shop_id:a.id});
      assert.equal((await query("SELECT status FROM orders WHERE shop_id=? AND posting_number='WB-501'",[a.id]))[0].status,'delivering');
      state={supplierStatus:'cancel',wbStatus:'canceled_by_carrier'};await service.syncOrders(2,{shop_id:a.id});
      assert.equal((await query("SELECT status FROM orders WHERE shop_id=? AND posting_number='WB-501'",[a.id]))[0].status,'cancelled');
      assert.ok((await query('SELECT handover_at FROM wb_order_details WHERE shop_id=? AND wb_order_id=501',[a.id]))[0].handover_at);
      assert.equal(Number((await query('SELECT SUM(quantity_delta) AS qty FROM inventory_movements WHERE product_id=20'))[0].qty),99);
    });
    await t.test('another tenant cannot prepare or inspect the imported shared order',async()=>{
      const order=(await query('SELECT id FROM orders WHERE shop_id=?',[a.id]))[0];const before=remote.length;
      await assert.rejects(service.ownedOrders(3,[order.id]),error=>error.statusCode===404);assert.equal(remote.length,before);
    });
  }finally{const {closeMysqlPool}=await import('../src/mysql-pool.js');await closeMysqlPool();await fixture.cleanup();}
});
