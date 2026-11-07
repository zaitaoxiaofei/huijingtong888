import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createProfitRoutes } from '../src/server/routes/profit.js';

test('monthly billing reads only the current enterprise, including every financial appendix', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated MySQL named pipe'
}, async t => {
  const fixture = await createTenantMysqlFixture('monthly_billing');
  let closeMysqlPool;
  const originalFetch = globalThis.fetch;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw Error('External requests forbidden in financial read tests'); };
    ({ closeMysqlPool } = await import('../src/mysql-pool.js'));
    const { monthlyBillingDetailsMysql, monthlyBillingOrderDetailsMysql } = await import('../src/services/mysql-cutover.js');
    const { ensureFinanceCenterSchema } = await import('../src/services/finance-center.js');
    const q = fixture.query;
    // Match the runtime component migration required by scoped reads.
    await q('CREATE TABLE product_components(id BIGINT PRIMARY KEY AUTO_INCREMENT,tenant_id BIGINT,product_id BIGINT,component_product_id BIGINT)');
    await q("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
    await q("INSERT INTO people(id,name,role) VALUES(1,'Default','admin'),(2,'A owner','operations'),(3,'B secret','operations')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role) VALUES(1,1,'owner'),(2,2,'owner'),(3,3,'owner')");
    await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(10,NULL,'Legacy','active'),(11,1,'Default','active'),(20,2,'A','active'),(30,3,'B secret','active')");
    await ensureFinanceCenterSchema();
    await q("DELETE FROM finance_companies");
    await q("INSERT INTO finance_companies(id,tenant_id,name) VALUES(1,NULL,'Legacy'),(2,2,'A'),(3,3,'B secret'),(4,1,'Default explicit')");
    await fixture.connection.query(`CREATE TABLE ai_image_usage_events(id BIGINT PRIMARY KEY AUTO_INCREMENT,tenant_id VARCHAR(80),person_id BIGINT,requested_count INT,status VARCHAR(32),job_no VARCHAR(80),item_no VARCHAR(80),operation VARCHAR(32),started_at DATETIME);
      CREATE TABLE ai_variant_lab_batch_jobs(tenant_id VARCHAR(80),job_no VARCHAR(80),created_by_person_id BIGINT);
      CREATE TABLE ai_variant_lab_batch_items(tenant_id VARCHAR(80),job_no VARCHAR(80),item_no VARCHAR(80),status VARCHAR(32),updated_at DATETIME)`);
    for (const [id, tenant, key, owner] of [[10,null,'admin',1],[11,1,'admin',1],[20,2,'2',2],[30,3,'3',3]]) {
      await q("INSERT INTO products(id,tenant_id,name,code,purchase_cost) VALUES(?,?,?,?,2)", [id,tenant,`Product ${id}`,`P-${id}`]);
      await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku) VALUES(?,?,?,?,'same-sku')", [id,tenant,id,id]);
      await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at,delivered_at) VALUES(?,?,'same-posting','delivered','delivered','2026-10-03','2026-10-04')", [id,id]);
      await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(?,?,?,'same-sku',1,?,?)", [id,id,id,id,id/2]);
      await q("INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at) VALUES(?,?,?,'purchased','2026-10-03')", [id,tenant,`PO-${id}`]);
      await q("INSERT INTO purchase_order_items(id,tenant_id,purchase_order_id,product_id,actual_quantity,amount,shipping_amount,status) VALUES(?,?,?,?,?, ?,1,'purchased')", [id,tenant,id,id,id,id*2]);
      await q("INSERT INTO inbound_records(id,tenant_id,product_id,quantity,amount,status,approved_at) VALUES(?,?,?,?,?,'approved','2026-10-03')", [id,tenant,id,id,id*2]);
      await q("INSERT INTO inbound_records(id,tenant_id,product_id,quantity,amount,status) VALUES(?,?,?,?,?,'pending_arrival')", [id+100,tenant,id,id,id*2]);
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status) VALUES(?,?,'fixture',?,'LOCAL','posted')", [tenant,id,id]);
      await q("INSERT INTO ozon_stock_snapshots(shop_id,ozon_sku,product_id,stock_type,present) VALUES(?,'same-sku',?,'fbp_real',?)", [id,id,id]);
      await q("INSERT INTO ai_image_usage_events(tenant_id,person_id,requested_count,status,job_no,item_no,operation,started_at) VALUES(?,?,?,'success',?,'same-item','submit','2026-10-03')", [key,owner,id,`job-${id}`]);
    }
    await q("INSERT INTO finance_expenses(id,tenant_id,company_id,shop_id,expense_date,category,amount_cny) VALUES(10,NULL,1,10,'2026-10-03','salary',10),(11,1,4,11,'2026-10-03','salary',11),(20,2,2,20,'2026-10-03','salary',20),(30,3,3,30,'2026-10-03','salary',3000),(21,2,2,NULL,'2026-10-03','office',7),(22,2,3,NULL,'2026-10-03','office',9000),(23,2,2,30,'2026-10-03','office',9000)");
    const range = { from:'2026-10-01',to:'2026-10-05' };
    await t.test('A/B/default summaries, expenses, stocks, procurement and AI remain owned', async () => {
      for (const [tenant, ids] of [['admin',[10,11]],['2',[20]],['3',[30]]]) {
        const value = await monthlyBillingDetailsMysql(range, tenant), selected = value.selected;
        assert.deepEqual(value.shops.map(s=>Number(s.id)).sort((a,b)=>a-b), ids);
        assert.deepEqual(selected.shops.map(s=>Number(s.shop_id)).sort((a,b)=>a-b), ids);
        const sum = ids.reduce((a,b)=>a+b,0);
        assert.equal(selected.procurement_inventory.purchase_quantity,sum);
        assert.equal(selected.procurement_inventory.inbound_quantity,sum);
        assert.equal(selected.procurement_inventory.local_inventory_quantity,sum);
        assert.equal(selected.procurement_inventory.fbp_inventory_quantity,sum);
        assert.equal(selected.procurement_inventory.in_transit_quantity,sum);
        assert.equal(selected.ai_usage.request_count,sum);
        assert.equal(selected.summary.salary_expense,tenant==='3'?3000:sum);
        if(tenant==='2') {assert.equal(selected.summary.manual_expense,7);assert.ok(!JSON.stringify(value).includes('B secret'));}
      }
    });
    await t.test('paged rows and counts, settlement HAVING, search and forced foreign shop stay scoped', async () => {
      for (const [tenant,ids] of [['admin',[10,11]],['2',[20]],['3',[30]]]) {
        for(const settlementState of ['', 'pending_estimate']) {
          const r=await monthlyBillingOrderDetailsMysql({...range,settlementState},tenant);
          assert.equal(r.total,ids.length);assert.deepEqual(r.rows.map(row=>row.order_id).sort((a,b)=>a-b),ids);
        }
      }
      assert.equal((await monthlyBillingOrderDetailsMysql({...range,shopId:30},'2')).total,0);
      assert.equal((await monthlyBillingOrderDetailsMysql({...range,keyword:'B secret'},'2')).total,0);
      const foreign=await monthlyBillingDetailsMysql({...range,shopId:30},'2');assert.equal(foreign.selected.summary.salary_expense,0);assert.deepEqual(foreign.selected.expenses,[]);
    });
    await t.test('calendar-month includeOrders uses the same enterprise scope',async()=>{
      const r=await monthlyBillingDetailsMysql({year:2026,fromMonth:10,toMonth:10,month:10,includeOrders:'1'},'2');
      assert.deepEqual(r.selected.orders.map(row=>row.order_id),[20]);assert.equal(r.selected.ai_usage.request_count,20);
    });
    await t.test('cross-enterprise child references do not disclose product or cost identity',async()=>{
      await q("UPDATE sku_mappings SET product_id=30 WHERE id=20");
      const r=await monthlyBillingOrderDetailsMysql(range,'2');assert.ok(!JSON.stringify(r).includes('Product 30'));
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status) VALUES(2,30,'fixture',900,'LOCAL','posted')");
      const summary=(await monthlyBillingDetailsMysql(range,'2')).selected.procurement_inventory;assert.equal(summary.local_inventory_quantity,20);
    });
    await t.test('mislinked AI people are anonymized without losing current-enterprise cost',async()=>{
      await q("INSERT INTO ai_image_usage_events(tenant_id,person_id,requested_count,status,job_no,item_no,operation,started_at) VALUES('2',3,4,'success','foreign-person','same-item','submit','2026-10-03')");
      await q("INSERT INTO ai_variant_lab_batch_jobs VALUES('2','same-job',3),('3','same-job',3)");
      await q("INSERT INTO ai_variant_lab_batch_items VALUES('2','same-job','legacy-item','image_done','2026-10-03')");
      const ai=(await monthlyBillingDetailsMysql(range,'2')).selected.ai_usage;
      assert.equal(ai.request_count,25);assert.equal(ai.cost,0.95);assert.ok(!JSON.stringify(ai).includes('B secret'));
      assert.equal(ai.people.find(row=>row.person_id===null).request_count,5);
      await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      const historical=(await monthlyBillingDetailsMysql(range,'2')).selected.ai_usage;
      assert.equal(historical.people.find(row=>row.person_id===2).person_name,'A owner');
    });
    await t.test('request tenant selectors cannot replace authenticated enterprise',async()=>{
      const seen=[];const routes=createProfitRoutes({services:{monthlyBillingDetails:async(...args)=>seen.push(args),monthlyBillingOrders:async(...args)=>seen.push(args)}});
      const req={_session:{personId:2,tenant:{id:2,slug:'a'}}};const url=new URL('http://localhost:8788/api/monthly-billing-details?tenant_id=3');
      await routes['GET /api/monthly-billing-details'](req,url);await routes['GET /api/monthly-billing-orders'](req,url);
      assert.deepEqual(seen.map(args=>args[1]),['2','2']);assert.throws(()=>routes['GET /api/monthly-billing-details']({},url),/企业上下文/);
    });
  } finally { globalThis.fetch=originalFetch;await closeMysqlPool?.();await fixture.cleanup(); }
});
