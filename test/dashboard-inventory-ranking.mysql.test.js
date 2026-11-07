import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrderOutcomeSql } from '../src/services/order-outcome.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema, loadTenantOrderService } from './helpers/tenant-order-service.js';

// Real SQL against an isolated database; no application or production data.
test('inventory leaderboard aggregates before paging and keeps SKU details/date/tenant boundaries consistent', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async () => {
  const f = await createTenantMysqlFixture('inventory_rank');
  const q = f.query;
  try {
    await createOrderFixtureSchema(f.connection);
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'A one'),(21,2,'A two'),(30,3,'B private')");
    for (let id = 1; id <= 13; id++) {
      await q('INSERT INTO products(id,tenant_id,name,code,inventory_number,stock_unit,active) VALUES(?,2,?,?,?,\'件\',1)', [id,`Inventory ${id}`,`P${id}`,`1-${id}`]);
      await q('INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(?,2,20,?,?,1)', [id,id,`sku${id}`]);
    }
    await q("INSERT INTO products(id,tenant_id,name,code,active) VALUES(30,3,'B private','B',1)");
    await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(20,2,21,1,'sku1',1),(22,2,20,1,'sku1b',1),(30,3,30,30,'sku1',1)");
    // A kit remains a single sold inventory product: never replicate its revenue to components.
    await q('INSERT INTO product_components(product_id,component_product_id,quantity,tenant_id) VALUES(1,13,2,2)');
    let orderId = 100, itemId = 1000;
    async function order(shop, items, status = 'awaiting_packaging', date = '2026-10-29 18:00:00') {
      const id = ++orderId;
      await q('INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,?,?)', [id,shop,`posting-${id}`,status,date]);
      for (const [mapping,sku,qty,price] of items) await q('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,ozon_name,quantity,sale_price) VALUES(?,?,?,?,?,?,?)',[++itemId,id,mapping,sku,`Name ${sku}`,qty,price]);
    }
    for (let id = 2; id <= 12; id++) await order(20,[[id,`sku${id}`,1,100]]);
    await order(20,[[22,'sku1b',2,60],[null,'sku1',1,60]]); // one order, fallback mapping; 180 revenue
    await order(21,[[20,'sku1',1,60]]); // second shop makes aggregate top 1 (240)
    await order(30,[[30,'sku1',99,999]]);
    await order(20,[[30,'unmapped',99,999]]); // poisoned foreign mapping must not leak
    await order(20,[[1,'sku1',99,999]],'cancelled');
    await order(20,[[1,'sku1',99,999]],'returned');
    await q("UPDATE orders SET tracking_stage='delivered',delivered_at='2026-10-30 01:00:00' WHERE id=?",[orderId]);
    await order(20,[[1,'sku1',99,999]],'awaiting_packaging','2026-10-29 15:59:59');
    await order(20,[[1,'sku1',99,999]],'awaiting_packaging','2026-10-30 16:00:00');
    const { service, calls } = loadTenantOrderService(f.connection,{extraMethods:['profitRankingMysql','profitOrderedAtUtcRangeMysql','profitTimestampUtcRangeMysql','terminalOrderLossSqlMysql','returnLossTotalSqlMysql','roundMoneyMysql'],buildOrderOutcomeSql});
    const base = {inventory:'1',dimension:'product',from:'2026-10-30',to:'2026-10-30',sortBy:'revenue',sortOrder:'desc',pageSize:10};
    const first = await service.profitRankingMysql({...base,fast:'1'},'2');
    assert.equal(first.rows.length,10);
    const rankingSql=calls.find(c=>c.sql.includes('AS revenue')&&c.sql.includes('GROUP BY p.id'))?.sql||'';
    assert.ok(rankingSql);assert.doesNotMatch(rankingSql,/order_outcomes|opi\.net_profit_cny|commission_fee/,'inventory paging must not recalculate unrelated finance fields');
    assert.equal(first.rows[0].product_id,1);
    assert.equal(first.rows[0].revenue,240);
    assert.equal(first.rows[0].profit,undefined,'inventory sales responses must not claim zero profit');
    assert.equal(Number(first.rows[0].item_quantity),4);
    assert.equal(Number(first.rows[0].order_count),2);
    assert.equal(Number(first.rows[0].shop_count),2);
    assert.equal(Number(first.rows[0].sku_count),3);
    assert.deepEqual(Array.from(first.rows,r=>r.product_id),[1,2,3,4,5,6,7,8,9,10]);
    const second = await service.profitRankingMysql({...base,page:2,fast:'1'},'2');
    assert.deepEqual(Array.from(second.rows,r=>r.product_id),[11,12]);
    assert.equal(second.total,12);
    const exact = await service.profitRankingMysql(base,'2');
    assert.equal(exact.total,12);
    const details = await service.profitRankingMysql({...base,dimension:'sku',productId:1},'2');
    assert.equal(details.total,3);
    assert.equal(details.rows.reduce((sum,r)=>sum+r.revenue,0),240);
    assert.equal(details.rows.reduce((sum,r)=>sum+Number(r.item_quantity),0),4);
    assert.equal((await service.profitRankingMysql({...base,dimension:'sku',productId:30},'2')).total,0);
    const other = await service.profitRankingMysql(base,'3');
    assert.equal(other.total,1);
    assert.equal(other.rows[0].product_id,30);
    assert.ok(!JSON.stringify(first).includes('B private'));
  } finally { await f.cleanup(); }
});
