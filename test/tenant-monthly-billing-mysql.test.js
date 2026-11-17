import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import {noteBillingSourceMutation} from '../src/services/billing-overview-cache.js';
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
    const { monthlyBillingDetailsMysql, monthlyBillingOrderDetailsMysql, monthlyBillingSourceRecordsMysql, financeInventoryCapitalMysql, financeInventoryCapitalDetailsMysql, prepareInventoryFlowMysql } = await import('../src/services/mysql-cutover.js');
    const { ensureFinanceCenterSchema } = await import('../src/services/finance-center.js');
    const q = async(sql,params=[])=>{const result=await fixture.query(sql,params);noteBillingSourceMutation(sql,result);return result;};
    // Match the runtime component migration required by scoped reads.
    await prepareInventoryFlowMysql();
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
      await q('UPDATE products SET inventory_number=? WHERE id=?',[`STOCK-${id}`,id]);
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
    await t.test('settled orders reuse saved results instead of current price or frozen cost',async()=>{
      const filters={from:'2026-08-01',to:'2026-08-31',includeAppendices:'0'};
      await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(940,20,'SETTLED-SAVED','delivered','delivered','2026-08-10')");
      await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,frozen_purchase_cost,settlement_state) VALUES(940,940,20,'same-sku',1,999,99,'accrued')");
      await q("INSERT INTO order_profit_items(order_item_id,sale_amount_cny,purchase_cost_cny,net_profit_cny,profit_status) VALUES(940,123.45,20,17.5,'accrued')");
      for(let read=0;read<2;read++){const report=(await monthlyBillingDetailsMysql(filters,'2')).selected.summary;assert.equal(report.revenue,123.45);assert.equal(report.purchase_cost,20);assert.equal(report.profit,17.5);}
      const stored=await q('SELECT sale_amount_cny,purchase_cost_cny,net_profit_cny FROM order_profit_items WHERE order_item_id=940');assert.equal(Number(stored[0].sale_amount_cny),123.45);assert.equal(Number(stored[0].net_profit_cny),17.5);
      await q('DELETE FROM order_profit_items WHERE order_item_id=940');await q('DELETE FROM order_items WHERE id=940');await q('DELETE FROM orders WHERE id=940');
    });
    await t.test('on-demand appendices equal the full report and skip order-profit ranking reads',async()=>{
      const filters={from:'2026-10-01',to:'2026-10-05',companyId:2};
      const full=await monthlyBillingDetailsMysql(filters,'2');
      const only=await monthlyBillingDetailsMysql({...filters,appendicesOnly:'1'},'2');
      assert.deepEqual(only.procurement_inventory,full.selected.procurement_inventory);assert.deepEqual(only.ai_usage,full.selected.ai_usage);
      assert.equal(only.selected,undefined);
      const main=await monthlyBillingDetailsMysql({...filters,includeAppendices:'0'},'2');assert.deepEqual(main.selected.summary,full.selected.summary);assert.deepEqual(main.selected.procurement_inventory,{});
      await assert.rejects(monthlyBillingDetailsMysql({...filters,companyId:3,appendicesOnly:'1'},'2'),{statusCode:404});
      await assert.rejects(monthlyBillingDetailsMysql({appendicesOnly:'1'},'2'),{statusCode:400});
    });
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
      const overview=await monthlyBillingDetailsMysql({year:2026,fromMonth:10,toMonth:10,month:10,overviewOnly:'1'},'2');
      for(const key of ['revenue','net_profit','salary_expense','manual_expense','order_count'])assert.equal(overview.selected.summary[key],r.selected.summary[key],key);
      assert.deepEqual(overview.selected.procurement_inventory,{});assert.deepEqual(overview.selected.ai_usage,{});
    });
    await t.test('current inventory is an independent enterprise snapshot without purchasing history',async()=>{
      const snapshot=await financeInventoryCapitalMysql({tenant_id:3},'2');
      const expected=(await monthlyBillingDetailsMysql(range,'2')).selected.procurement_inventory;
      for(const key of ['inventory_total_value','local_inventory_value','fbp_inventory_value','in_transit_value','local_inventory_quantity'])assert.equal(snapshot[key],expected[key],key);
      assert.equal(snapshot.purchase_total_amount,undefined);assert.equal(snapshot.snapshot_basis,'current');assert.ok(snapshot.snapshot_at);
    });
    await t.test('capital detail rows reconcile to every category and preserve stock identities',async()=>{
      for(const [tenant,ids] of [['admin',[10,11]],['2',[20]],['3',[30]]]){
        const summary=await financeInventoryCapitalMysql({},tenant);
        for(const kind of ['local','fbp','transit']){
          const result=await financeInventoryCapitalDetailsMysql({kind,pageSize:100,tenant_id:3},tenant);
          assert.deepEqual(result.rows.map(r=>r.product_id).sort((a,b)=>a-b),ids);
          assert.equal(result.rows.reduce((n,r)=>n+r.quantity,0),summary.categories[kind].quantity);
          assert.equal(result.rows.reduce((n,r)=>n+r.inventory_value,0),summary.categories[kind].value);
          assert.equal(result.total,ids.length);
          for(const row of result.rows)assert.equal(row.inventory_number,`STOCK-${row.product_id}`);
          if(tenant==='2')assert.ok(!JSON.stringify(result).includes('B secret'));
        }
      }
      const search=await financeInventoryCapitalDetailsMysql({kind:'local',query:'STOCK-20'},'2');
      assert.equal(search.total,1);assert.equal(search.rows[0].product_id,20);
      assert.equal((await financeInventoryCapitalDetailsMysql({query:'%'},'2')).total,0);
      assert.equal((await financeInventoryCapitalDetailsMysql({query:'STOCK-30'},'2')).total,0);
      await assert.rejects(financeInventoryCapitalDetailsMysql({kind:'toString'},'2'),{statusCode:400});
      const first=await financeInventoryCapitalDetailsMysql({kind:'local',pageSize:1},'admin');
      const second=await financeInventoryCapitalDetailsMysql({kind:'local',pageSize:1,page:2},'admin');
      assert.equal(first.total,2);assert.notEqual(first.rows[0].row_id,second.rows[0].row_id);
    });
    await t.test('capital uses recorded cost versions, flags missing bindings and historical locations',async()=>{
      await q("INSERT INTO purchase_cost_versions(tenant_id,product_id,version_no,source_key,landed_unit_cost,status) VALUES(2,20,1,'capital-test',3.125,'active'),(3,20,9,'foreign-cost',900,'active')");
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status) VALUES(2,20,'legacy-test',1,'UNKNOWN','posted')");
      const local=await financeInventoryCapitalDetailsMysql({kind:'local'},'2');
      assert.equal(local.rows[0].quantity,21);assert.equal(local.rows[0].unit_cost,3.125);assert.equal(local.rows[0].inventory_value,65.625);
      assert.equal(local.rows[0].cost_basis,'purchase_version');assert.equal(local.rows[0].unclassified_movements,1);
      await q("INSERT INTO ozon_stock_snapshots(shop_id,ozon_sku,stock_type,present) VALUES(20,'unmapped-a','fbp_real',7)");
      await q("INSERT INTO online_products(id,shop_id,ozon_sku,name,archived) VALUES(920,20,'unmapped-a','Bind source A',0),(930,30,'unmapped-a','Foreign source B',0)");
      const fbp=await financeInventoryCapitalDetailsMysql({kind:'fbp'},'2');
      const unknown=fbp.rows.find(r=>r.ozon_sku==='unmapped-a');
      assert.equal(Number(unknown.online_product_id),920);assert.equal(Number(unknown.shop_id),20);
      await q("UPDATE online_products SET archived=1 WHERE id=920");
      const archived=await financeInventoryCapitalDetailsMysql({kind:'fbp',review:'binding'},'2');
      assert.equal(archived.rows[0].online_product_id,null);
      await q("UPDATE online_products SET archived=0 WHERE id=920");

      assert.equal(unknown.product_id,null);assert.equal(unknown.inventory_number,null);assert.equal(unknown.cost_missing,true);
      for(const review of ['cost','binding']){
        const filtered=await financeInventoryCapitalDetailsMysql({kind:'fbp',review,pageSize:1},'2');
        assert.equal(filtered.total,1);assert.equal(filtered.rows[0].ozon_sku,'unmapped-a');
        assert.equal(filtered.filtered_quantity,7);assert.equal(filtered.summary.categories.fbp.item_count,2);
        assert.equal((await financeInventoryCapitalDetailsMysql({kind:'fbp',review,query:'STOCK-30'},'2')).total,0);
      }
      const historical=await financeInventoryCapitalDetailsMysql({kind:'local',review:'location'},'2');
      assert.equal(historical.total,1);assert.equal(historical.rows[0].product_id,20);
      assert.equal((await financeInventoryCapitalDetailsMysql({kind:'local',review:'cost'},'2')).total,0);
      assert.equal((await financeInventoryCapitalDetailsMysql({kind:'local',review:'location',page:2,pageSize:1},'2')).rows.length,0);
      await assert.rejects(financeInventoryCapitalDetailsMysql({kind:'local',review:'x OR 1=1'},'2'),{statusCode:400});
      await assert.rejects(financeInventoryCapitalDetailsMysql({kind:'fbp',review:'availability'},'2'),{statusCode:400});
      assert.equal(fbp.summary.categories.fbp.unmapped_count,1);assert.equal(fbp.summary.categories.fbp.quantity,27);
      await q("DELETE FROM purchase_cost_versions WHERE source_key IN ('capital-test','foreign-cost')");
      await q("DELETE FROM inventory_movements WHERE source_type='legacy-test'");
      await q("DELETE FROM ozon_stock_snapshots WHERE ozon_sku='unmapped-a'");
      await q("DELETE FROM online_products WHERE id IN(920,930)");
    });
    await t.test('local capital exactly follows free inventory after orders, FBP locks and safety',async()=>{
      await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(220,20,'capital-pending','awaiting_packaging','awaiting_packaging',UTC_TIMESTAMP())");
      await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(220,220,20,'same-sku',4,20)");
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status,related_order_item_id) VALUES(2,20,'order_outbound',-4,'LOCAL','posted',220)");
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,movement_type,quantity_delta,stock_location,status) VALUES(2,20,'capital-lock','ORDER_RESERVED',-3,'LOCAL','posted')");
      await q("INSERT INTO inventory_flow_settings(tenant_id,product_id,settings_json) VALUES(2,20,JSON_OBJECT('local_safety_override',2)) ON DUPLICATE KEY UPDATE settings_json=VALUES(settings_json)");
      const detail=await financeInventoryCapitalDetailsMysql({kind:'local'},'2'),row=detail.rows[0];
      assert.equal(row.physical_quantity,20);assert.equal(row.ledger_quantity,13);
      assert.equal(row.order_quantity,4);assert.equal(row.locked_quantity,3);assert.equal(row.safety_quantity,2);
      assert.equal(row.quantity,11);assert.equal(row.inventory_value,22);
      assert.equal(detail.summary.local_inventory_quantity,11);assert.equal(detail.summary.local_inventory_value,22);
      assert.equal(detail.summary.fbp_inventory_quantity,20);assert.equal(detail.summary.in_transit_quantity,20);
      const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
      const [expected]=await createInventoryWorkflowService().batch([20],2,{localOnly:true,fresh:true,cache:false});
      assert.equal(row.quantity,expected.free);
      await q("UPDATE inventory_flow_settings SET settings_json=JSON_OBJECT('local_safety_override',30) WHERE tenant_id=2 AND product_id=20");
      const occupied=await financeInventoryCapitalDetailsMysql({kind:'local'},'2');
      assert.equal(occupied.rows[0].quantity,0);assert.equal(occupied.rows[0].physical_quantity,20);assert.equal(occupied.summary.local_inventory_value,0);
      await q("DELETE FROM inventory_flow_settings WHERE tenant_id=2 AND product_id=20");
      await q("DELETE FROM inventory_movements WHERE related_order_item_id=220 OR source_type='capital-lock'");
      await q("DELETE FROM order_items WHERE id=220");await q("DELETE FROM orders WHERE id=220");
    });
    await t.test('local review filters apply before pagination, intersect search and do not change stock',async()=>{
      await q("INSERT INTO products(id,tenant_id,name,code,purchase_cost,inventory_number) VALUES(23,2,'Missing cost A','REVIEW-A',0,'STOCK-23'),(24,2,'Missing cost B','REVIEW-B',0,'STOCK-24')");
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status) VALUES(2,23,'review-fixture',5,'UNKNOWN','posted'),(2,24,'review-fixture',6,'LOCAL','posted')");
      const before=await q("SELECT id,product_id,quantity_delta,status FROM inventory_movements ORDER BY id");
      const first=await financeInventoryCapitalDetailsMysql({kind:'local',review:'cost',pageSize:1},'2');
      const second=await financeInventoryCapitalDetailsMysql({kind:'local',review:'cost',pageSize:1,page:2},'2');
      assert.equal(first.total,2);assert.equal(second.total,2);assert.notEqual(first.rows[0].product_id,second.rows[0].product_id);
      assert.equal(first.filtered_quantity,11);assert.equal(first.filtered_value,0);
      assert.equal(first.summary.categories.local.item_count,3);
      const search=await financeInventoryCapitalDetailsMysql({kind:'local',review:'cost',query:'STOCK-24'},'2');
      assert.equal(search.total,1);assert.equal(search.rows[0].product_id,24);
      const overlap=await financeInventoryCapitalDetailsMysql({kind:'local',review:'location'},'2');
      assert.ok(overlap.rows.some(r=>r.product_id===23));
      assert.equal((await financeInventoryCapitalDetailsMysql({kind:'local',review:'cost'},'3')).total,0);
      assert.deepEqual(await q("SELECT id,product_id,quantity_delta,status FROM inventory_movements ORDER BY id"),before);
      await q("DELETE FROM inventory_movements WHERE source_type='review-fixture'");await q("DELETE FROM products WHERE id IN(23,24)");
    });
    await t.test('local capital excludes virtual parents and nested parents but retains real multipacks and child deficits',async()=>{
      await q("INSERT INTO products(id,tenant_id,name,code,purchase_cost,inventory_number) VALUES(240,2,'Virtual set','V240',100,'VIRTUAL-240'),(241,2,'Virtual sub-set','V241',50,'VIRTUAL-241'),(242,2,'Physical child pack','P242',3,'PHYSICAL-242'),(243,2,'Physical deficit','P243',4,'PHYSICAL-243'),(244,2,'Real four-piece set','P244',5,'PHYSICAL-244'),(340,3,'Foreign parent','V340',999,'FOREIGN-340')");
      await q("INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,240,241,2),(2,241,242,2),(2,240,243,1),(3,244,340,1)");
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status) VALUES(2,240,'virtual-capital-fixture',-70,'UNKNOWN','posted'),(2,241,'virtual-capital-fixture',10,'LOCAL','posted'),(2,242,'virtual-capital-fixture',8,'LOCAL','posted'),(2,243,'virtual-capital-fixture',-2,'LOCAL','posted'),(2,244,'virtual-capital-fixture',4,'LOCAL','posted')");
      const before=await q("SELECT id,product_id,quantity_delta FROM inventory_movements ORDER BY id");
      const all=await financeInventoryCapitalDetailsMysql({kind:'local',pageSize:100},'2');
      const ids=all.rows.map(r=>r.product_id);
      assert.ok(!ids.includes(240));assert.ok(!ids.includes(241));
      assert.ok(ids.includes(242));assert.ok(ids.includes(243));assert.ok(ids.includes(244));
      assert.equal(all.rows.find(r=>r.product_id===242).quantity,8);
      assert.equal(all.rows.find(r=>r.product_id===242).inventory_value,24);
      assert.equal(all.rows.find(r=>r.product_id===244).inventory_value,20);
      assert.equal(all.summary.categories.local.availability_unknown_count,1);
      const unknown=await financeInventoryCapitalDetailsMysql({kind:'local',review:'availability'},'2');
      assert.deepEqual(unknown.rows.map(r=>r.product_id),[243]);
      assert.equal((await financeInventoryCapitalDetailsMysql({kind:'local',query:'VIRTUAL-240'},'2')).total,0);
      await q("UPDATE inventory_movements SET quantity_delta=2 WHERE product_id=243 AND source_type='virtual-capital-fixture'");
      const known=await financeInventoryCapitalDetailsMysql({kind:'local'},'2');
      assert.equal(known.summary.categories.local.value,40+24+8+20);
      assert.equal(known.summary.categories.local.quantity,20+8+2+4);
      await q("UPDATE inventory_movements SET quantity_delta=-2 WHERE product_id=243 AND source_type='virtual-capital-fixture'");
      assert.deepEqual(await q("SELECT id,product_id,quantity_delta FROM inventory_movements ORDER BY id"),before);
      await q("DELETE FROM inventory_movements WHERE source_type='virtual-capital-fixture'");
      await q("DELETE FROM product_components WHERE product_id IN(240,241,244)");
      await q("DELETE FROM products WHERE id IN(240,241,242,243,244,340)");
    });
    await t.test('deleted local products do not block capital review while historical records remain',async()=>{
      await q("INSERT INTO products(id,tenant_id,name,code,purchase_cost,active) VALUES(250,2,'Deleted deficit','DELETED-250',2,0),(251,2,'Deleted positive','DELETED-251',3,0),(252,2,'Active deficit','ACTIVE-252',4,1)");
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status) VALUES(2,250,'deleted-capital-fixture',-1,'UNKNOWN','posted'),(2,251,'deleted-capital-fixture',10,'LOCAL','posted'),(2,252,'deleted-capital-fixture',-2,'LOCAL','posted')");
      const before=await q("SELECT * FROM inventory_movements WHERE source_type='deleted-capital-fixture' ORDER BY id");
      const all=await financeInventoryCapitalDetailsMysql({kind:'local',pageSize:100},'2');
      assert.ok(!all.rows.some(r=>[250,251].includes(r.product_id)));
      assert.ok(all.rows.some(r=>r.product_id===252));
      assert.equal(all.summary.categories.local.unclassified_count,0);
      assert.equal(all.summary.categories.local.availability_unknown_count,1);
      assert.deepEqual((await financeInventoryCapitalDetailsMysql({kind:'local',review:'availability'},'2')).rows.map(r=>r.product_id),[252]);
      assert.equal((await financeInventoryCapitalDetailsMysql({kind:'local',query:'DELETED-250'},'2')).total,0);
      await q("UPDATE products SET active=0 WHERE id=252");
      const summary=await financeInventoryCapitalMysql({},'2');
      assert.equal(summary.categories.local.value,40);
      assert.equal(summary.categories.local.quantity,20);
      assert.equal(summary.categories.local.availability_unknown_count,0);
      assert.deepEqual(await q("SELECT * FROM inventory_movements WHERE source_type='deleted-capital-fixture' ORDER BY id"),before);
      await q("DELETE FROM inventory_movements WHERE source_type='deleted-capital-fixture'");
      await q("DELETE FROM products WHERE id IN(250,251,252)");
    });
    await t.test('purchase gap filter includes shipped products even with zero remaining stock',async()=>{
      await q("INSERT INTO products(id,tenant_id,name,code,purchase_cost,inventory_number) VALUES(253,2,'Missing purchase child','GAP253',2,'GAP253')");
      await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku) VALUES(253,2,20,253,'gap253')");
      await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at,delivered_at) VALUES(253,20,'gap-posting','delivered','delivered','2026-10-03','2026-10-04')");
      await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(253,253,253,'gap253',3,20)");
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,related_order_item_id,quantity_delta,stock_location,status) VALUES(2,253,'order_outbound',253,-3,'LOCAL','posted'),(2,253,'manual_adjustment',NULL,3,'LOCAL','posted')");
      const gaps=await financeInventoryCapitalDetailsMysql({kind:'local',review:'purchase'},'2');
      const gap=gaps.rows.find(r=>r.product_id===253);assert.ok(gap);assert.equal(gap.missing_purchase_quantity,3);assert.equal(gap.shipped_quantity,3);assert.equal(gap.missing_receipt_quantity,0);assert.ok(gaps.summary.categories.local.missing_purchase_count>0);
      assert.equal((await financeInventoryCapitalDetailsMysql({kind:'local',review:'purchase',query:'GAP253'},'3')).total,0);
      await q("DELETE FROM inventory_movements WHERE product_id=253");await q("DELETE FROM order_items WHERE id=253");await q("DELETE FROM orders WHERE id=253");await q("DELETE FROM sku_mappings WHERE id=253");await q("DELETE FROM products WHERE id=253");
    });
    await t.test('unknown available quantity is not capitalized as zero',async()=>{
      await q("INSERT INTO products(id,tenant_id,name,code,purchase_cost,inventory_number) VALUES(25,2,'Unverified negative stock','P-25',2,'STOCK-25')");
      await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status) VALUES(2,25,'capital-unknown',-5,'LOCAL','posted')");
      const summary=await financeInventoryCapitalMysql({},'2');
      assert.equal(summary.local_inventory_value,null);assert.equal(summary.inventory_total_value,null);
      assert.equal(summary.categories.local.availability_unknown_count,1);
      const detail=await financeInventoryCapitalDetailsMysql({kind:'local',query:'STOCK-25'},'2');
      const todo=await financeInventoryCapitalDetailsMysql({kind:'local',review:'availability'},'2');
      assert.equal(todo.total,1);assert.equal(todo.rows[0].product_id,25);assert.equal(todo.filtered_value,null);
      assert.equal((await financeInventoryCapitalDetailsMysql({kind:'local',review:'availability',query:'STOCK-20'},'2')).total,0);
      assert.equal(detail.rows[0].quantity,null);assert.equal(detail.rows[0].inventory_value,null);assert.equal(detail.filtered_value,null);
      assert.equal(detail.rows[0].physical_quantity,-5);
      await q("DELETE FROM inventory_movements WHERE source_type='capital-unknown'");await q("DELETE FROM products WHERE id=25");
    });
    await t.test('capital list filters and pages share a scoped snapshot; writes and manual refresh invalidate it',async()=>{
      const {getMysqlPoolMetrics}=await import('../src/mysql-pool.js');
      const {invalidateInventoryWorkflow}=await import('../src/services/inventory-workflow-cache.js');
      const {invalidateMasterDataCachePrefix}=await import('../src/services/mysql-master-data-cache.js');
      invalidateMasterDataCachePrefix('inventory-capital:list:');
      let before=getMysqlPoolMetrics().acquisitions;
      const cold=await financeInventoryCapitalDetailsMysql({kind:'local',reuse_snapshot:'1'},'2');
      const coldReads=getMysqlPoolMetrics().acquisitions-before;
      before=getMysqlPoolMetrics().acquisitions;
      const warm=await financeInventoryCapitalDetailsMysql({kind:'local',reuse_snapshot:'1',pageSize:100},'2');
      const warmReads=getMysqlPoolMetrics().acquisitions-before;
      assert.deepEqual(warm.summary,cold.summary);assert.equal(warm.snapshot_at,cold.snapshot_at);
      assert.ok(warmReads<coldReads/2,`cold ${coldReads}, reused ${warmReads}`);
      for(const review of ['cost','availability','purchase']){
        const filtered=await financeInventoryCapitalDetailsMysql({kind:'local',reuse_snapshot:'1',review},'2');
        assert.equal(filtered.snapshot_at,cold.snapshot_at);
      }
      const foreign=await financeInventoryCapitalDetailsMysql({kind:'local',reuse_snapshot:'1'},'3');assert.ok(foreign.rows.every(r=>r.product_id===30));
      await q('UPDATE products SET purchase_cost=3 WHERE id=20');invalidateInventoryWorkflow({tenantId:2,productIds:[20]});
      const changed=await financeInventoryCapitalDetailsMysql({kind:'local',reuse_snapshot:'1'},'2');assert.equal(changed.rows.find(r=>r.product_id===20).unit_cost,3);
      await q('UPDATE products SET purchase_cost=4 WHERE id=20');
      const forced=await financeInventoryCapitalDetailsMysql({kind:'local',reuse_snapshot:'1',refresh:'1'},'2');assert.equal(forced.rows.find(r=>r.product_id===20).unit_cost,4);
      await q('UPDATE products SET purchase_cost=2 WHERE id=20');invalidateInventoryWorkflow();
      t.diagnostic(`capital SQL acquisitions: cold=${coldReads}, reused filters/pages=${warmReads}`);
    });
    await t.test('annual grouping matches each month including Beijing boundaries, ads and company expenses',async()=>{
      await q("INSERT INTO finance_shop_company_assignments(tenant_id,shop_id,company_id,effective_from) VALUES(2,20,2,'2026-01-01')");
      for(const [id,date] of [[201,'2026-08-31 15:59:59'],[202,'2026-08-31 16:00:00'],[203,'2026-09-30 16:00:00']]){
        await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at,delivered_at) VALUES(?,20,?,'delivered','delivered',?,?)",[id,`boundary-${id}`,date,date]);
        await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(?,?,20,'same-sku',1,100,25)",[id,id]);
      }
      await q("INSERT INTO ozon_ad_sku_daily(shop_id,ozon_sku,date_key,spend_cny,revenue_cny) VALUES(20,'same-sku','2026-08-31',2,0),(20,'same-sku','2026-09-01',3,0),(20,'same-sku','2026-10-01',5,0)");
      const annual=await monthlyBillingDetailsMysql({year:2026,fromMonth:8,toMonth:10,overviewOnly:'1'},'2');
      for(const month of [8,9,10]){
        const ordinary=(await monthlyBillingDetailsMysql({year:2026,fromMonth:month,toMonth:month},'2')).selected;
        const grouped=annual.months.find(row=>row.month_key===`2026-${String(month).padStart(2,'0')}`);
        for(const key of ['revenue','order_count','advertising_cost','operating_profit','net_profit','manual_expense','salary_expense'])assert.equal(grouped.summary[key],ordinary.summary[key],`${month}/${key}`);
      }
      const company=await monthlyBillingDetailsMysql({year:2026,fromMonth:10,toMonth:10,companyId:2,overviewOnly:'1'},'2');
      const bill=await monthlyBillingDetailsMysql({from:'2026-10-01',to:'2026-10-31',companyId:2},'2');
      assert.equal(company.selected.summary.net_profit,bill.selected.summary.net_profit);
      assert.deepEqual((await monthlyBillingOrderDetailsMysql({from:'2026-10-01',to:'2026-10-31',companyId:2},'2')).rows.map(row=>row.order_id).sort((a,b)=>a-b),[20,203]);
      await assert.rejects(monthlyBillingDetailsMysql({year:2026,companyId:3,overviewOnly:'1'},'2'),{statusCode:404});
      await assert.rejects(monthlyBillingOrderDetailsMysql({...range,companyId:3},'2'),{statusCode:404});
    });
    await t.test('annual expense categories and grouped AI match monthly statements without extra deductions',async()=>{
      const query={year:2026,fromMonth:8,toMonth:10,overviewOnly:'1',includeOverviewAi:'1'};
      const annual=await monthlyBillingDetailsMysql(query,'2');
      for(const m of annual.months){const bill=(await monthlyBillingDetailsMysql({from:m.from,to:m.to},'2')).selected;
        for(const key of ['revenue','order_profit','net_profit','purchase_cost','international_shipping_cost','commission_fee','return_loss'])assert.equal(m.summary[key],bill.summary[key],m.month_key+'/'+key);
        assert.equal(m.ai_usage.available,true);assert.equal(m.ai_usage.cost,bill.ai_usage.cost);
        const a=new Map(m.expense_totals.map(e=>[e.category,Math.round(e.amount_cny*100)])),b=new Map();for(const e of bill.expenses)b.set(e.category,(b.get(e.category)||0)+Math.round(e.amount_cny*100));assert.deepEqual(a,b);
      }
      const company=await monthlyBillingDetailsMysql({...query,companyId:2},'2');assert.equal(company.selected.ai_usage.scope,'enterprise');
      await q("INSERT INTO ai_image_usage_events(tenant_id,person_id,requested_count,status,job_no,item_no,operation,started_at) VALUES('2',2,3,'failed','boundary-ai','boundary-ai','submit','2026-08-31 16:00:00')");
      const boundary=await monthlyBillingDetailsMysql(query,'2');assert.equal(boundary.months[0].ai_usage.request_count,0);assert.equal(boundary.months[1].ai_usage.request_count,3);assert.equal(boundary.months[1].ai_usage.cost,.114);
      await q("DELETE FROM ai_image_usage_events WHERE job_no='boundary-ai'");
    });
    await t.test('annual overview query count stays bounded instead of growing per month',async()=>{
      const {getMysqlPoolMetrics}=await import('../src/mysql-pool.js');
      let before=getMysqlPoolMetrics().acquisitions;
      await monthlyBillingDetailsMysql({year:2026,fromMonth:10,toMonth:10,overviewOnly:'1',includeOverviewAi:'1'},'2');
      const single=getMysqlPoolMetrics().acquisitions-before;
      before=getMysqlPoolMetrics().acquisitions;
      const start=performance.now();await monthlyBillingDetailsMysql({year:2026,fromMonth:1,toMonth:12,overviewOnly:'1',includeOverviewAi:'1'},'2');
      const annual=getMysqlPoolMetrics().acquisitions-before;
      assert.ok(annual<=single+2,`one month ${single}, full year ${annual}`);
      t.diagnostic(`overview SQL acquisitions: one month=${single}, full year=${annual}; fixture full year=${Math.round(performance.now()-start)}ms`);
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
    await t.test('fixed AI, rent, utilities and subsidies deduct once and preserve shared expense scope',async()=>{
      const before=(await monthlyBillingDetailsMysql(range,'2')).selected;
      for(const [category,amount] of [['ai_subscription',700],['rent',2000],['utilities',80],['subsidy',120]]) {
        await q("INSERT INTO finance_expenses(tenant_id,company_id,expense_date,category,amount_cny) VALUES(2,2,'2026-10-03',?,?)",[category,amount]);
      }
      const after=(await monthlyBillingDetailsMysql(range,'2')).selected;
      assert.equal(after.summary.manual_expense-before.summary.manual_expense,2900);
      assert.equal(Math.round((before.summary.net_profit-after.summary.net_profit)*100),290000);
      assert.equal(after.summary.salary_expense,before.summary.salary_expense);
      assert.equal(after.ai_usage.cost,before.ai_usage.cost);
      const shop=(await monthlyBillingDetailsMysql({...range,shopId:20},'2')).selected;
      assert.ok(!shop.expenses.some(row=>row.category==='ai_subscription'));
      const foreign=(await monthlyBillingDetailsMysql(range,'3')).selected;
      assert.ok(!foreign.expenses.some(row=>row.category==='ai_subscription'));
    });
    await t.test('source ledgers paginate exact fee records without tenant, company or date leakage',async()=>{
      for(const [shop,op,name,amount,currency,rate] of [[20,'A-1','LastMile',-5,'CNY',1],[20,'A-2','LastMile',-7,'CNY',1],[30,'B-1','B secret',-99,'CNY',1],[20,'A-3','PendingFx',8,'JPY',0],[10,'Default-1','LegacyLedger',-3,'CNY',1],[11,'Default-2','DefaultLedger',-4,'CNY',1]]) {
        await q("INSERT INTO ozon_finance_items(shop_id,operation_id,service_type,service_name,operation_date,amount,currency_code,exchange_rate) VALUES(?,?,'fixture',?,'2026-11-10',?,?,?)",[shop,op,name,amount,currency,rate]);
      }
      const range={from:'2026-11-01',to:'2026-11-30',companyId:2,pageSize:1};
      const data=await monthlyBillingSourceRecordsMysql(range,'2');
      assert.equal(data.total,3);assert.equal(data.rows.length,1);
      const defaultLedger=await monthlyBillingSourceRecordsMysql({from:range.from,to:range.to},'admin');
      assert.equal(defaultLedger.total,2);assert.deepEqual(defaultLedger.rows.map(row=>Number(row.shop_id)).sort((a,b)=>a-b),[10,11]);
      assert.equal(data.groups.find(g=>g.item_name==='LastMile').amount_cny,-12);
      assert.equal(data.groups.find(g=>g.item_name==='PendingFx').amount_cny,null);
      assert.ok(!JSON.stringify(data).includes('B secret'));
      const filtered=await monthlyBillingSourceRecordsMysql({...range,itemName:'LastMile',page:2},'2');
      assert.equal(filtered.total,2);assert.equal(filtered.rows.length,1);assert.equal(filtered.rows[0].item_name,'LastMile');
      assert.equal((await monthlyBillingSourceRecordsMysql({...range,shopId:30},'2')).total,0);
      assert.equal((await monthlyBillingSourceRecordsMysql({...range,from:'2026-11-11'},'2')).total,0);
      await assert.rejects(monthlyBillingSourceRecordsMysql({...range,companyId:3},'2'),{statusCode:404});
      await q("INSERT INTO ozon_ad_sku_daily(shop_id,ozon_sku,date_key,campaign_name,spend_cny) VALUES(20,'A','2026-11-10','A广告',9),(30,'B','2026-11-10','B secret',99)");
      const ad=await monthlyBillingSourceRecordsMysql({...range,source:'advertising'},'2');
      assert.equal(ad.total,1);assert.equal(ad.groups[0].amount_cny,9);assert.equal(ad.rows[0].original_amount,null);assert.ok(!JSON.stringify(ad).includes('B secret'));
      await assert.rejects(monthlyBillingSourceRecordsMysql({...range,source:'other'},'2'),{statusCode:400});
    });
    await t.test('assigned AI lowers company net profit once and is identical across annual, monthly and lightweight reads',async()=>{
      const args={from:'2026-10-01',to:'2026-10-31',companyId:2};const before=(await monthlyBillingDetailsMysql(args,'2')).selected;
      await q("INSERT INTO finance_ai_cost_policies(tenant_id,company_id,effective_month,updated_by) VALUES(2,2,'2026-01',2)");
      try{const month=(await monthlyBillingDetailsMysql(args,'2')).selected,light=(await monthlyBillingDetailsMysql({...args,includeAppendices:'0'},'2')).selected,annual=(await monthlyBillingDetailsMysql({year:2026,fromMonth:10,toMonth:10,companyId:2,overviewOnly:'1'},'2')).selected;
        assert.equal(month.summary.ai_cost_applied,true);assert.equal(month.summary.ai_usage_cost,.95);assert.equal(month.summary.order_profit,before.summary.order_profit);assert.equal(month.summary.net_profit,Math.round((before.summary.net_profit-.95)*100)/100);
        assert.equal(light.summary.net_profit,month.summary.net_profit);assert.equal(annual.summary.net_profit,month.summary.net_profit);
        const shop=(await monthlyBillingDetailsMysql({...args,shopId:20},'2')).selected;assert.equal(shop.summary.ai_cost_applied,false);
      }finally{await q('DELETE FROM finance_ai_cost_policies WHERE tenant_id=2');}
    });
    await t.test('unavailable annual AI remains unknown rather than a recorded zero',async()=>{
      await q('RENAME TABLE ai_image_usage_events TO ai_image_usage_events_unavailable');
      try{const r=await monthlyBillingDetailsMysql({year:2026,fromMonth:10,toMonth:10,overviewOnly:'1',includeOverviewAi:'1',refresh:'1'},'2');assert.equal(r.selected.ai_usage.available,false);assert.equal(r.selected.ai_usage.cost,null);}
      finally{await q('RENAME TABLE ai_image_usage_events_unavailable TO ai_image_usage_events');}
    });
    await t.test('request tenant selectors cannot replace authenticated enterprise',async()=>{
      const seen=[];const routes=createProfitRoutes({services:{monthlyBillingDetails:async(...args)=>seen.push(args),monthlyBillingOrders:async(...args)=>seen.push(args),monthlyBillingSourceRecords:async(...args)=>seen.push(args)}});
      const req={_session:{personId:2,tenant:{id:2,slug:'a'}}};const url=new URL('http://localhost:8788/api/monthly-billing-details?tenant_id=3');
      await routes['GET /api/monthly-billing-details'](req,url);await routes['GET /api/monthly-billing-orders'](req,url);await routes['GET /api/monthly-billing-source-records'](req,url);
      assert.deepEqual(seen.map(args=>args[1]),['2','2','2']);assert.throws(()=>routes['GET /api/monthly-billing-details']({},url),/企业上下文/);
    });
    await t.test('cost-only records preserve exact values and tenant scope without loading product identities',async()=>{
      const base=await monthlyBillingOrderDetailsMysql({...range,pageSize:200},'2');
      for(const field of ['purchase_cost','domestic_shipping_cost','international_shipping_cost','packaging_cost','commission_fee','ozon_service_fee','other_fee']){
        const lite=await monthlyBillingOrderDetailsMysql({...range,pageSize:200,field},'2');
        assert.equal(lite.total,base.total);assert.equal(lite.cost_field,field);
        for(const row of lite.rows){const original=base.rows.find(x=>x.order_id===row.order_id);if(original)assert.equal(row[field],original[field]);assert.notEqual(row.shop_id,30);assert.equal('product_name' in row,false);}
      }
      await assert.rejects(monthlyBillingOrderDetailsMysql({...range,field:'__proto__'},'2'),{statusCode:400});
      await assert.rejects(monthlyBillingOrderDetailsMysql({...range,field:'other_fee',companyId:3},'2'),{statusCode:404});
    });
    await t.test('FBP stocking freight CRUD updates monthly and annual net profit without changing order profit or foreign reports',async()=>{
      const {saveFinanceExpense,deleteFinanceExpense}=await import('../src/services/finance-center.js');
      const filters={from:'2026-05-01',to:'2026-05-31',companyId:2,includeAppendices:'0'},read=()=>monthlyBillingDetailsMysql(filters,'2');
      const baseline=(await read()).selected.summary;
      const body={company_id:2,expense_date:'2026-05-10',category:'fbp_stocking_shipping',description:'FBP备货快递费',original_amount:18.2,amount_cny:18.2};
      const created=await saveFinanceExpense(body,2,'2');
      let selected=(await read()).selected;assert.equal(selected.summary.order_profit,baseline.order_profit);assert.equal(selected.summary.net_profit,baseline.net_profit-18.2);
      assert.equal(selected.expenses.filter(r=>r.category==='fbp_stocking_shipping').length,1);
      const annual=await monthlyBillingDetailsMysql({year:2026,fromMonth:5,toMonth:5,companyId:2,overviewOnly:'1'},'2');assert.equal(annual.selected.summary.net_profit,selected.summary.net_profit);assert.equal(annual.selected.expense_totals.find(r=>r.category==='fbp_stocking_shipping').amount_cny,18.2);
      assert.equal((await monthlyBillingDetailsMysql({...filters,shopId:20},'2')).selected.summary.net_profit,baseline.net_profit);
      assert.equal((await monthlyBillingDetailsMysql({...filters,companyId:3},'3')).selected.expenses.some(r=>r.category==='fbp_stocking_shipping'),false);
      await saveFinanceExpense({...body,id:created.id,original_amount:20.3,amount_cny:20.3},2,'2');assert.equal((await read()).selected.summary.net_profit,baseline.net_profit-20.3);
      await deleteFinanceExpense(created.id,'2');assert.equal((await read()).selected.summary.net_profit,baseline.net_profit);
    });
    await t.test('actual procurement groups stock once and does not pretend company or SKU allocation exists',async()=>{
      const filters={from:'2026-10-01',to:'2026-10-31',recordSource:'procurement',groupBy:'inventory'};
      // Restore an owned product binding only for this independent purchasing projection.
      const result=await monthlyBillingOrderDetailsMysql(filters,'2');assert.equal(result.record_source,'procurement');assert.equal(result.summary.quantity,20);assert.equal(result.summary.amount,40);assert.ok(!JSON.stringify(result).includes('B secret'));
      await assert.rejects(monthlyBillingOrderDetailsMysql({...filters,companyId:2},'2'),{statusCode:400});
      await assert.rejects(monthlyBillingOrderDetailsMysql({...filters,shopId:20},'2'),{statusCode:400});
    });
    await t.test('official refund and cancellation reversals replace estimates across finance dates without changing saved profits',async()=>{
      await q('UPDATE sku_mappings SET product_id=20 WHERE id=20');
      await q("INSERT INTO orders(id,shop_id,posting_number,order_number,status,tracking_stage,ordered_at) VALUES(900,20,'RETURN-1','RETURN','cancelled','returned','2026-04-10'),(901,20,'CANCEL-1','CANCEL','cancelled','cancelled','2026-04-10')");
      await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(900,900,20,'same-sku',1,100),(901,901,20,'same-sku',1,100)");
      await q("INSERT INTO order_profit_items(order_item_id,purchase_cost_cny,domestic_shipping_cny,international_shipping_cny,commission_fee_cny,other_fee_cny,net_profit_cny,profit_status) VALUES(900,20,3,30,12,3,-68,'estimated'),(901,0,0,0,0,3,-3,'estimated')");
      let i=0;
      for(const [posting,type,amount,date] of [['RETURN-1','MarketplaceRedistributionOfAcquiringOperation',-5,'2026-04-11'],['RETURN-1','MarketplaceRedistributionOfAcquiringOperation',5,'2026-05-01'],['RETURN-1','delivery_charge',-10,'2026-04-11'],['RETURN-1','delivery_charge',2,'2026-05-01'],['RETURN-1','agencyfeeaggregator3plglobal',0,'2026-05-01'],['RETURN-1','sale_commission',-12,'2026-04-11'],['RETURN-1','sale_commission',12,'2026-05-01'],['RETURN-1','return_delivery_charge',-4,'2026-05-01'],['CANCEL-1','MarketplaceRedistributionOfAcquiringOperation',-5,'2026-04-11'],['CANCEL-1','MarketplaceRedistributionOfAcquiringOperation',5,'2026-05-01']]){
        await q("INSERT INTO ozon_finance_items(shop_id,posting_number,operation_id,operation_date,service_type,service_name,amount,amount_cny,currency_code,exchange_rate,accruals_for_sale,accruals_for_sale_cny,sale_commission,sale_commission_cny,delivery_charge,delivery_charge_cny,return_delivery_charge,return_delivery_charge_cny,raw_json) VALUES(20,?,?,?,?,'官方费用',?,?,'CNY',1,0,0,0,0,0,0,0,0,'{}')",[posting,'refund-proof-'+(++i),date,type,amount,amount]);
      }
      const filters={from:'2026-04-01',to:'2026-04-30',companyId:2,includeAppendices:'0'};
      const r=(await monthlyBillingDetailsMysql(filters,'2')).selected.summary;assert.equal(r.purchase_cost,20);assert.equal(r.international_shipping_cost,8);assert.equal(r.commission_fee,0);assert.equal(r.other_fee,0);assert.equal(r.aftersale_fee,4);assert.equal(r.net_profit,-35);assert.equal(r.withdrawal_fee,0);
      const annual=await monthlyBillingDetailsMysql({year:2026,fromMonth:4,toMonth:4,companyId:2,overviewOnly:'1'},'2');assert.equal(annual.selected.summary.net_profit,r.net_profit);
      const detail=await monthlyBillingOrderDetailsMysql({...filters,outcomeType:'returns',groupBy:'inventory'},'2');assert.equal(detail.rows.length,1);assert.equal(detail.summary.net_profit,-35);assert.equal(detail.rows[0].inventory_name,'Product 20');assert.equal(detail.rows[0].rate,.5);
      const proof=await monthlyBillingOrderDetailsMysql({...filters,outcomeType:'returns',groupBy:'order'},'2');assert.equal(proof.rows[0].fee_evidence.length,8);assert.equal(proof.rows[0].billing_costs.other_fee,0);
      assert.equal((await monthlyBillingOrderDetailsMysql({...filters,shopId:30,outcomeType:'returns',groupBy:'inventory'},'2')).total,0);
      assert.equal(Number((await q('SELECT net_profit_cny FROM order_profit_items WHERE order_item_id=900'))[0].net_profit_cny),-68);
      await q('DELETE FROM ozon_finance_items WHERE operation_id LIKE ?',['refund-proof-%']);await q('DELETE FROM order_profit_items WHERE order_item_id IN (900,901)');await q('DELETE FROM order_items WHERE id IN (900,901)');await q('DELETE FROM orders WHERE id IN (900,901)');await q('UPDATE sku_mappings SET product_id=30 WHERE id=20');
    });
    await t.test('zero monthly advertising report replaces estimated ads and withdrawal uses the same month totals',async()=>{
      await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(910,20,'AD-ZERO','delivered','delivered','2026-03-10')");
      await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES(910,910,'AD-ZERO',1,100)");
      await q("INSERT INTO order_profit_items(order_item_id,sale_amount_cny,advertising_cost_cny,profit_status) VALUES(910,100,9,'estimated')");
      await q("INSERT INTO ozon_ad_sku_daily(shop_id,ozon_sku,date_key,spend_cny) VALUES(20,'AD-ZERO','2026-03-10',0)");
      const filters={from:'2026-03-01',to:'2026-03-31',companyId:2,includeAppendices:'0'};const result=(await monthlyBillingDetailsMysql(filters,'2')).selected.summary;
      assert.equal(result.advertising_cost,0);assert.equal(result.withdrawal_base,100);assert.equal(result.withdrawal_fee,1.2);assert.equal(result.net_profit,98.8);
      const annual=await monthlyBillingDetailsMysql({year:2026,fromMonth:3,toMonth:3,companyId:2,overviewOnly:'1'},'2');assert.equal(annual.selected.summary.net_profit,98.8);
      await q("DELETE FROM ozon_ad_sku_daily WHERE ozon_sku='AD-ZERO'");await q('DELETE FROM order_profit_items WHERE order_item_id=910');await q('DELETE FROM order_items WHERE id=910');await q('DELETE FROM orders WHERE id=910');
    });
    await t.test('advertising amount and count sorting happen before row pagination',async()=>{
      for(const [shop,campaign,sku,amount,day] of [[20,'小额多笔','SORT1',1,'2026-07-01'],[20,'小额多笔','SORT1',1,'2026-07-02'],[20,'小额多笔','SORT1',1,'2026-07-03'],[20,'大额少笔','SORT2',9,'2026-07-01'],[30,'B secret','SORT3',99,'2026-07-01']])await q('INSERT INTO ozon_ad_sku_daily(shop_id,campaign_name,ozon_sku,spend_cny,date_key) VALUES(?,?,?,?,?)',[shop,campaign,sku,amount,day]);
      const query={from:'2026-07-01',to:'2026-07-31',source:'advertising',companyId:2,pageSize:1};
      const byAmount=await monthlyBillingSourceRecordsMysql({...query,sortBy:'amount',sortOrder:'desc'},'2');assert.equal(byAmount.groups[0].amount_cny,9);assert.equal(byAmount.rows[0].amount_cny,9);assert.equal(byAmount.total,4);assert.ok(!JSON.stringify(byAmount).includes('B secret'));
      const byCount=await monthlyBillingSourceRecordsMysql({...query,sortBy:'count',sortOrder:'desc'},'2');assert.equal(byCount.groups[0].record_count,3);
      await q("DELETE FROM ozon_ad_sku_daily WHERE date_key>='2026-07-01' AND date_key<='2026-07-31'");
    });
    await t.test('independent official SKU returns drive inventory piece rates without returning unrelated items or fabricating refund income',async()=>{
      await q('UPDATE sku_mappings SET product_id=20 WHERE id=20');
      await q("INSERT INTO products(id,tenant_id,name,code) VALUES(921,2,'未退商品','P-921')");await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku) VALUES(921,2,20,921,'NOT-RETURN')");
      await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(920,20,'PARTIAL-RETURN','delivered','delivered','2026-02-10')");
      await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(920,920,20,'same-sku',2,100),(921,920,921,'NOT-RETURN',1,50)");
      await q("INSERT INTO order_profit_items(order_item_id,sale_amount_cny,purchase_cost_cny,profit_status) VALUES(920,200,40,'estimated'),(921,50,10,'estimated')");
      const record={return_id:'9201',posting_number:'PARTIAL-RETURN',state:{state:'MoneyReturned'},product:{sku:'same-sku',quantity:1}};
      for(const endpoint of ['/v2/returns/rfbs/list','/v1/returns/list'])await q("INSERT INTO ozon_return_observations(tenant_id,shop_id,order_id,source_endpoint,return_id,posting_number,official_state,state_json,observed_at) VALUES(2,20,920,?,'9201','PARTIAL-RETURN','MoneyReturned',?,NOW())",[endpoint,JSON.stringify({...record,source_endpoint:endpoint})]);
      const filters={from:'2026-02-01',to:'2026-02-28',companyId:2,includeAppendices:'0'};
      const detail=await monthlyBillingOrderDetailsMysql({...filters,outcomeType:'returns',groupBy:'inventory',sortBy:'quantity'},'2');assert.equal(detail.total,1);assert.equal(detail.rows[0].quantity,1);assert.equal(detail.rows[0].base_quantity,2);assert.equal(detail.rows[0].rate,.5);assert.equal(detail.rows[0].order_count,1);assert.equal(detail.rows[0].inventory_name,'Product 20');
      const statement=(await monthlyBillingDetailsMysql(filters,'2')).selected.summary;assert.equal(statement.income_pending_count,1);assert.equal(statement.net_profit,null);assert.equal(typeof statement.estimated_net_profit,'number');
      const overview=await monthlyBillingDetailsMysql({year:2026,fromMonth:2,toMonth:2,companyId:2,overviewOnly:'1'},'2');
      assert.equal(overview.selected.summary.estimated_net_profit,statement.estimated_net_profit);assert.equal(overview.selected.completion_status,'pending');
      const cached=await monthlyBillingDetailsMysql({year:2026,fromMonth:2,toMonth:2,companyId:2,overviewOnly:'1'},'2');assert.equal(cached.overview_cache.hit,true);
      const {mysqlExecute,withMysqlTransaction}=await import('../src/mysql-pool.js');
      const expense=await mysqlExecute("INSERT INTO finance_expenses(tenant_id,company_id,expense_date,category,description,amount_cny) VALUES(2,2,'2026-02-15','rent','cache invalidation test',7)");
      const args={year:2026,fromMonth:2,toMonth:2,companyId:2,overviewOnly:'1'};
      const changed=await monthlyBillingDetailsMysql(args,'2');assert.equal(changed.overview_cache.hit,false);assert.equal(changed.selected.summary.estimated_net_profit,Math.round((statement.estimated_net_profit-7)*100)/100);
      await withMysqlTransaction(async connection=>{await connection.execute('UPDATE finance_expenses SET amount_cny=9 WHERE id=?',[expense.insertId]);});
      const committed=await monthlyBillingDetailsMysql(args,'2');assert.equal(committed.overview_cache.hit,false);assert.equal(committed.selected.summary.estimated_net_profit,Math.round((statement.estimated_net_profit-9)*100)/100);
      await assert.rejects(withMysqlTransaction(async connection=>{await connection.execute('UPDATE finance_expenses SET amount_cny=11 WHERE id=?',[expense.insertId]);throw Error('rollback cache test');}));
      const rolledBack=await monthlyBillingDetailsMysql(args,'2');assert.equal(rolledBack.overview_cache.hit,true);assert.equal(rolledBack.selected.summary.estimated_net_profit,committed.selected.summary.estimated_net_profit);
      await mysqlExecute('DELETE FROM finance_expenses WHERE id=?',[expense.insertId]);
      await q('DELETE FROM ozon_return_observations WHERE order_id=920');await q('DELETE FROM order_profit_items WHERE order_item_id IN (920,921)');await q('DELETE FROM order_items WHERE order_id=920');await q('DELETE FROM orders WHERE id=920');await q('DELETE FROM sku_mappings WHERE id=921');await q('DELETE FROM products WHERE id=921');await q('UPDATE sku_mappings SET product_id=30 WHERE id=20');
    });
    await t.test('disposed returns zero revenue in monthly, annual and inventory views without dropping goods costs',async()=>{
      const filters={from:'2026-02-01',to:'2026-02-28',companyId:2,includeAppendices:'0'};
      await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(930,20,'DISPOSED-RETURN','delivered','delivered','2026-02-10')");
      await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(930,930,20,'same-sku',1,100)");
      await q("INSERT INTO order_profit_items(order_item_id,sale_amount_cny,purchase_cost_cny,profit_status) VALUES(930,100,20,'estimated')");
      const before=(await monthlyBillingDetailsMysql(filters,'2')).selected.summary;
      const record={return_id:'9301',posting_number:'DISPOSED-RETURN',state:{state:'Utilizing'},product:{sku:'same-sku'}};
      await q("INSERT INTO ozon_return_observations(tenant_id,shop_id,order_id,source_endpoint,return_id,posting_number,official_state,state_json,observed_at) VALUES(2,20,930,'/v2/returns/rfbs/list','9301','DISPOSED-RETURN','Utilizing',?,NOW())",[JSON.stringify(record)]);
      const after=(await monthlyBillingDetailsMysql(filters,'2')).selected.summary;
      assert.equal(after.revenue,before.revenue-100);assert.equal(after.purchase_cost,before.purchase_cost);assert.equal(after.income_pending_count,0);assert.equal(after.disposed_return_count,1);assert.equal(after.disposed_revenue_removed,100);assert.equal(typeof after.net_profit,'number');
      const annual=(await monthlyBillingDetailsMysql({year:2026,fromMonth:2,toMonth:2,companyId:2,overviewOnly:'1'},'2')).selected.summary;
      assert.equal(annual.net_profit,after.net_profit);assert.equal(annual.revenue,after.revenue);assert.equal(annual.disposed_return_count,1);
      const details=await monthlyBillingOrderDetailsMysql({...filters,outcomeType:'returns',groupBy:'order'},'2');const row=details.rows.find(r=>r.order_id===930);assert.equal(row.billing_revenue,0);assert.equal(row.billing_costs.purchase_cost,20);assert.equal(row.disposed_return,true);
      const unchanged=await q('SELECT sale_amount_cny FROM order_profit_items WHERE order_item_id=930');assert.equal(Number(unchanged[0].sale_amount_cny),100);
      await q('DELETE FROM ozon_return_observations WHERE order_id=930');await q('DELETE FROM order_profit_items WHERE order_item_id=930');await q('DELETE FROM order_items WHERE order_id=930');await q('DELETE FROM orders WHERE id=930');
    });
    await t.test('paid pending payroll is recognized once per company and month, including concurrent approval',async()=>{
      const {createFinanceSubmissions}=await import('../src/services/finance-submissions.js');
      const {paidPayrollAccruals}=await import('../src/services/finance-payroll-accruals.js');
      const {withMysqlReadSnapshot}=await import('../src/mysql-pool.js');
      const service=createFinanceSubmissions();const actor={personId:2,name:'A owner',tenant:{id:2,slug:'a',role:'owner'}};
      const added=await service.savePayrollItem({company_id:2,month:'2026-06',person_name:'工资计提测试',base:1000,employer:300,employee:100,tax:0,employer_items:null,employee_items:null},actor);
      const filters={from:'2026-06-01',to:'2026-06-30',companyId:2,includeAppendices:'0'},read=()=>monthlyBillingDetailsMysql(filters,'2');
      assert.equal((await read()).selected.summary.salary_expense,0);
      await service.recordPayrollPaid({item_id:added.id,paid_amount:300,expected_paid_amount:0},actor);
      let report=await read();assert.equal(report.selected.summary.salary_expense,1300);assert.equal(report.selected.summary.net_profit,-1300);assert.equal(report.selected.expenses.filter(e=>e.salary_recognition==='paid_pending').length,1);
      assert.equal((await monthlyBillingDetailsMysql({...filters,shopId:20},'2')).selected.summary.salary_expense,0);
      assert.equal((await monthlyBillingDetailsMysql({...filters,from:'2026-06-01',to:'2026-06-20'},'2')).selected.summary.salary_expense,0);
      const annual=await monthlyBillingDetailsMysql({year:2026,fromMonth:6,toMonth:6,companyId:2,overviewOnly:'1'},'2');assert.equal(annual.selected.summary.net_profit,-1300);
      assert.equal((await paidPayrollAccruals({tenantId:3,from:filters.from,to:filters.to})).length,0);
      await service.recordPayrollPaid({item_id:added.id,paid_amount:0,expected_paid_amount:300},actor);
      assert.equal((await service.payrollLedger({year:2026,company_id:2},actor)).rows.find(x=>Number(x.id)===added.id).cost_confirmed,true);
      assert.equal((await read()).selected.summary.salary_expense,1300);
      const {createCompanyFinanceDocuments}=await import('../src/services/company-finance-documents.js');
      const companyReport=createCompanyFinanceDocuments({query:q,execute:q,authorize:async value=>value});
      assert.equal((await companyReport.report({company_id:2,month:'2026-06'},actor)).lines.reduce((n,line)=>n+line.amount,0),1300);
      const [item]=await q('SELECT submission_id FROM finance_submission_items WHERE id=?',[added.id]);
      await withMysqlReadSnapshot(async read=>{
        const posted=await read("SELECT amount_cny FROM finance_expenses WHERE source_type='finance_submission' AND source_id=?",[added.id]);assert.equal(posted.length,0);
        await service.review({id:item.submission_id,status:'approved'},actor);
        const accrual=await paidPayrollAccruals({tenantId:2,companyId:2,from:filters.from,to:filters.to},read);assert.equal(accrual.reduce((n,e)=>n+e.amount_cny,0),1300);
      });
      report=await read();assert.equal(report.selected.summary.salary_expense,1300);assert.equal(report.selected.expenses.filter(e=>e.salary_recognition==='paid_pending').length,0);
      assert.equal((await companyReport.report({company_id:2,month:'2026-06'},actor)).lines.reduce((n,line)=>n+line.amount,0),1300);
    });
  } finally { globalThis.fetch=originalFetch;await closeMysqlPool?.();await fixture.cleanup(); }
});
