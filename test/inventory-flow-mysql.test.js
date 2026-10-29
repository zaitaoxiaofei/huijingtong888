import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('new flow center shares physical ledger without replacing old rules; A/B lifecycle and concurrency', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('flow'); fixture.useEnvironment();
  const { query } = fixture;
  const legacy = await import('../src/services/mysql-cutover.js');
  const { inventoryFlow: flow } = await import('../src/services/inventory-flow.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES (1,'default','Default'),(2,'flow-a','A'),(3,'flow-b','B')");
    await query("INSERT INTO people(id,name,role) VALUES (1,'A operator','operations'),(2,'A warehouse','packing'),(3,'B operator','operations')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (2,1,'member',JSON_ARRAY('operations')),(2,2,'member',JSON_ARRAY('packing')),(3,3,'member',JSON_ARRAY('operations'))");
    await legacy.prepareInventoryFlowMysql();
    await query("INSERT INTO shops(id,tenant_id,name,status) VALUES (20,2,'A','active'),(30,3,'B','active')");
    await query("INSERT INTO products(id,tenant_id,name,production_lead_days,warehouse_logistics_days) VALUES (200,2,'A part',7,3),(300,3,'B part',7,3)");
    await query("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,offer_id,active) VALUES (200,2,200,20,'20001','A-1',1),(300,3,300,30,'30001','B-1',1)");
    await query("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES (2,200,'purchase_inbound',200,'posted','LOCAL'),(3,300,'purchase_inbound',999,'posted','LOCAL')");
    await query("INSERT INTO ozon_stock_snapshots(shop_id,product_id,ozon_sku,stock_type,warehouse_id,present,available) VALUES (20,200,'20001','fbp_real','1',0,0)");
    await t.test('scope is from resolved enterprise; foreign products and bindings fail', async () => {
      const data = await flow.list({ tenant_id: 3 }, 2);
      assert.deepEqual(data.rows.map(row => Number(row.id)), [200]);
      assert.equal(data.rows[0].physical_stock, 200);
      await assert.rejects(flow.detail(300, 2), {statusCode:404});
      await assert.rejects(flow.createTask({request_key:'aaaaaaaa-aaaaaaaa',items:[{mapping_id:300,quantity:5}]},2,1));
      assert.equal((await flow.tasks(3)).length,0);
    });
    const request = {request_key:'bbbbbbbb-bbbbbbbb',items:[{mapping_id:200,quantity:300}]};
    await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES (2001,20,'history','delivered','delivered',DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)),(2002,20,'open','awaiting_packaging','awaiting_packaging',UTC_TIMESTAMP())");
    await query("INSERT INTO order_items(order_id,sku_mapping_id,ozon_sku,quantity) VALUES (2001,200,'20001',70),(2002,200,'20001',10)");
    await t.test('real history and current open orders produce 100 safety plus 10 orders, not a double-counted safety target', async () => {
      const p = await flow.detail(200,2);
      assert.equal(p.safety_qty,100);assert.equal(p.order_qty,10);assert.equal(p.free_qty,90);
      await assert.rejects(legacy.syncInventoryFlowStocksMysql({product_id:300},{tenantId:2}),{statusCode:404});
      const result = await legacy.syncInventoryFlowStocksMysql({product_id:200},{tenantId:2});
      assert.equal(result.ok,false);assert.match(result.results[0].message,/真实Ozon凭据/);
      assert.equal((await flow.detail(200,2)).official_qty,0);
    });
    const created = await flow.createTask(request,2,1);
    assert.deepEqual(await flow.createTask(request,2,1),created);
    let task = (await flow.tasks(2))[0];
    const payload = (action, quantity) => ({order_id:task.id,revision:task.revision,action,items:task.items.map(i=>({id:i.id,quantity}))});
    await t.test('applicant cannot warehouse-confirm own task; foreign enterprise cannot mutate', async () => {
      await assert.rejects(flow.mutateTask(payload('lock',90),2,1), /其他仓库/);
      await assert.rejects(flow.mutateTask(payload('lock',90),3,3), {statusCode:404});
    });
    await t.test('partial confirm reserves actual quantity without changing physical or requested quantity', async () => {
      await flow.mutateTask(payload('lock',90),2,2);
      const p = await flow.detail(200,2); assert.equal(p.physical_stock,200);assert.equal(p.locked_qty,90);
      task=(await flow.tasks(2))[0];assert.equal(task.items[0].requested_qty,300);assert.equal(task.items[0].approved_qty,90);
      await assert.rejects(flow.mutateTask(payload('edit',80),2,1), /不能修改/);
    });
    await t.test('duplicate ship cannot subtract stock twice', async () => {
      const responses = await Promise.allSettled([flow.mutateTask(payload('ship'),2,2),flow.mutateTask(payload('ship'),2,2)]);
      assert.equal(responses.filter(r=>r.status==='fulfilled').length,1,responses.filter(r=>r.status==='rejected').map(r=>r.reason.message).join(';'));
      const p=await flow.detail(200,2);assert.equal(p.physical_stock,110);assert.equal(p.locked_qty,0);assert.equal(p.in_transit,90);
      task=(await flow.tasks(2))[0];
    });
    await t.test('less actually shipped adds back local stock with audit, then partial receipt does not invent official stock', async () => {
      await flow.mutateTask({...payload('correct'),transfer_id:task.transfers[0].id,actual_quantity:85,reason:'5件仍在本地'},2,2);
      task=(await flow.tasks(2))[0];const p=await flow.detail(200,2);assert.equal(p.physical_stock,115);assert.equal(p.in_transit,85);
      await flow.mutateTask({...payload('receive'),transfer_id:task.transfers[0].id,received_quantity:25},2,2);
      task=(await flow.tasks(2))[0];assert.equal(task.transfers[0].listed_quantity,25);
      const next=await flow.detail(200,2);assert.equal(next.in_transit,60);assert.equal(next.official_qty,0);
      assert.equal((await flow.history({},3)).length,0);assert.ok((await flow.history({},2)).length>=4);
      assert.equal((await flow.detail(300,3)).physical_stock,999);
    });
    await t.test('settings are versioned, scoped, and do not alter original product lead times', async () => {
      await flow.saveSettings({revision:0,settings:{fbp_days:9,production_days:12}},2,1);
      await assert.rejects(flow.saveSettings({revision:0,settings:{fbp_days:10}},2,1),{statusCode:409});
      assert.equal((await flow.settings(2)).fbp_days,9);assert.equal((await flow.settings(3)).fbp_days,7);
      assert.equal((await query('SELECT production_lead_days FROM products WHERE id=200'))[0].production_lead_days,7);
    });
  } finally { await closeMysqlPool();await fixture.cleanup(); }
});
