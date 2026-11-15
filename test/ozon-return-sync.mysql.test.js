import {createOrderFixtureSchema} from './helpers/tenant-order-service.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ozonReturnFilterSql} from '../src/services/ozon-return-state.js';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('return writes are scoped, idempotent and retain history without changing posting or ledger',async t=>{
  const fixture=await createTenantMysqlFixture('returns');if(!fixture){t.skip('isolated test socket required');return;}
  fixture.useEnvironment();
  try{
    await createOrderFixtureSchema(fixture.connection);
    const {storeOzonReturnObservations,enrichOrdersWithOzonReturns}=await import('../src/services/ozon-return-sync.js');
    const q=async(s,p=[])=>(await fixture.connection.query(s,p))[0];
    await q("INSERT INTO tenants(id,slug,name,status) VALUES(901,'return-a','A','active'),(902,'return-b','B','active')");
    await q("INSERT INTO shops(id,tenant_id,name,platform,status) VALUES(901,901,'A','ozon','active'),(902,902,'B','ozon','active')");
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(901,901,'same-posting','delivered','2026-01-01'),(902,902,'same-posting','delivered','2026-01-01')");
    await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,actual_profit,estimated_profit,settlement_state) VALUES(901,901,'1',1,100,25,30,'accrued')");
    await q("INSERT INTO order_profit_items(order_item_id,sale_amount_cny,purchase_cost_cny,net_profit_cny,profit_status) VALUES(901,100,20,25,'accrued')");
    const ledgerBefore=JSON.stringify(await q('SELECT * FROM order_profit_items'));
    const scope={id:901,isDefault:false};const row={return_id:'77',posting_number:'same-posting',source_endpoint:'/v2/returns/rfbs/list',state:{state:'MoneyReturned'},product:{sku:1},created_at:'2026-01-01T00:00:00Z'};
    assert.equal((await storeOzonReturnObservations(fixture.connection,scope,901,[row])).changed,1);
    assert.equal((await storeOzonReturnObservations(fixture.connection,scope,901,[row])).changed,0);
    await assert.rejects(storeOzonReturnObservations(fixture.connection,scope,902,[row]),/店铺/);
    const enriched=await enrichOrdersWithOzonReturns([{id:901},{id:902}],scope,q);
    assert.equal(enriched[0].aftersale.refund_confirmed,true);assert.equal(enriched[1].aftersale,undefined);
    assert.equal((await q(`SELECT COUNT(*) n FROM orders o WHERE ${ozonReturnFilterSql(scope)}`))[0].n,1);
    assert.equal((await q(`SELECT COUNT(*) n FROM orders o WHERE ${ozonReturnFilterSql({id:902,isDefault:false})}`))[0].n,0);
    assert.equal((await q(`SELECT COUNT(*) n FROM orders o WHERE ${ozonReturnFilterSql(scope,'possible_return')}`))[0].n,0);
    assert.equal((await q('SELECT status FROM orders WHERE id=901'))[0].status,'delivered');
    assert.equal((await q('SELECT COUNT(*) n FROM ozon_return_history'))[0].n,1);
    const {profitAftersalesMysql,profitAftersalesDetailsMysql}=await import('../src/services/mysql-cutover.js');
    const report=await profitAftersalesMysql({from:'2026-01-01',to:'2026-12-31'},'901');
    assert.equal(report.operational_totals.return_orders,1);
    assert.equal(report.totals.actual_loss_cny,null,'a prior positive actual is not proof that the new refund was booked');
    const details=await profitAftersalesDetailsMysql({from:'2026-01-01',to:'2026-12-31'},'901');
    assert.equal(details.rows[0].bucket,'official_after_delivery_return');
    assert.equal(details.rows[0].actual_loss_cny,null);
    await storeOzonReturnObservations(fixture.connection,scope,901,[{...row,state:{state:'UtilizedByOzon'}}]);
    assert.equal((await q('SELECT COUNT(*) n FROM ozon_return_history'))[0].n,2);
    assert.equal(JSON.stringify(await q('SELECT * FROM order_profit_items')),ledgerBefore);
    assert.equal((await q('SELECT actual_profit FROM order_items WHERE id=901'))[0].actual_profit,'25.0000');
    const {ordersPagedMysql}=await import('../src/services/mysql-cutover.js');
    const filters={status:'aftersale',includeCounts:'0',includeLogisticsOptions:'0',includeInventoryAvailability:'0',searchQuery:'same-posting',searchType:'order',searchMatch:'exact',pageSize:10};
    const own=await ordersPagedMysql(filters,'901');
    assert.equal(own.total,1);assert.equal(own.rows[0].id,901);assert.equal(own.rows[0].aftersale.status,'disposed');
    const foreign=await ordersPagedMysql(filters,'902');assert.equal(foreign.total,0);assert.equal(foreign.rows.length,0);
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(903,901,'maybe-posting','delivered','2026-01-02')");
    await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES(903,903,'2',1,20)");
    await storeOzonReturnObservations(fixture.connection,scope,901,[{...row,return_id:'78',posting_number:'maybe-posting',state:{state:'OnSellerClarification'},product:{sku:2}}]);
    const possible=await ordersPagedMysql({...filters,status:'possible_return',searchQuery:'maybe-posting'},'901');
    assert.equal(possible.total,1);assert.equal(possible.rows[0].id,903);assert.equal(possible.rows[0].aftersale.needs_review,true);
    await assert.rejects(ordersPagedMysql({...filters,status:'unreviewed_status'},'901'),e=>e.statusCode===503);

  }finally{const {closeMysqlPool}=await import('../src/mysql-pool.js');await closeMysqlPool();await fixture.cleanup();}
});
