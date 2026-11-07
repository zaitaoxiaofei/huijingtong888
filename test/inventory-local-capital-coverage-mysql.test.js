import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema } from './helpers/tenant-order-service.js';
import { loadOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';
import { createInventoryWorkflowService } from '../src/services/inventory-workflow.js';
import { shanghaiDateKey } from '../src/shanghai-time.js';

const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const rowsKey = rows => [...new Set(rows.map(row => JSON.stringify(canonical(row))))].sort();

test('large local inventory reads equal the original small-scope path, including safety and free capital quantities', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent TCP-disabled MySQL socket', timeout: 90000
}, async t => {
  const f = await createTenantMysqlFixture('capital_local');
  try {
    await createOrderFixtureSchema(f.connection);
    await f.query('CREATE TABLE fbp_replenishment_orders(id BIGINT PRIMARY KEY,shop_id BIGINT,status VARCHAR(32)) ENGINE=InnoDB');
    await f.query('CREATE TABLE fbp_replenishment_order_items(id BIGINT PRIMARY KEY,order_id BIGINT,shop_id BIGINT,product_id BIGINT,ozon_sku VARCHAR(80),mapping_id BIGINT,approved_qty DECIMAL(18,4)) ENGINE=InnoDB');
    await f.query('CREATE TABLE fbp_replenishment_item_adjustments(item_id BIGINT,adjustment_qty DECIMAL(18,4)) ENGINE=InnoDB');
    await f.query('CREATE TABLE IF NOT EXISTS procurement_ledger_actions(id BIGINT PRIMARY KEY,product_id BIGINT,action_type VARCHAR(40),created_at DATETIME,result_json JSON) ENGINE=InnoDB');
    await f.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'other','Other')");
    await f.query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(20,2,'Customer')");
    const today = shanghaiDateKey(), end = Date.parse(today + 'T00:00:00+08:00');
    const utc = time => new Date(time).toISOString().slice(0, 19).replace('T', ' ');
    const recent = utc(end - 86400000), old = utc(end - 30 * 86400000), boundary = utc(end - 7 * 86400000);
    for (const [tenant, offset, shop] of [[null, 0, 10], [2, 100, 20]]) {
      const products = Array.from({ length: 40 }, (_, i) => [offset + i + 1, tenant, `Item ${offset + i + 1}`, `P-${offset + i + 1}`]);
      await f.connection.query('INSERT INTO products(id,tenant_id,name,code) VALUES ?', [products]);
      await f.query('UPDATE products SET active=0 WHERE id=?', [offset + 40]);
      await f.connection.query('INSERT INTO sku_mappings(id,tenant_id,shop_id,ozon_sku,product_id) VALUES ?', [[1,2,4,7].map(id => [offset + id, tenant, shop, `sku-${id}`, offset + id])]);
      await f.query('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(?,?,?,2)', [tenant, offset + 2, offset + 3]);
      await f.query("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES(?,?, 'sku-4',1,'combo')", [offset + 4, shop]);
      await f.query('INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(?,?,3),(?,?,1)', [offset + 4, offset + 5, offset + 4, offset + 6]);
      const statuses = ['awaiting_packaging','awaiting_deliver','cancelled','cancelled','delivered','awaiting_deliver','awaiting_deliver','delivered','delivered','awaiting_packaging','unknown','awaiting_packaging'];
      await f.connection.query('INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES ?', [statuses.map((status, i) => [offset + i + 1, shop, `order-${offset + i + 1}`, status, i === 3 ? recent : old])]);
      const mapping = [1,2,4,7,7,1,1,7,7,1,7,1];
      await f.connection.query('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES ?', [mapping.map((id, i) => [offset + i + 1, offset + i + 1, offset + id, `sku-${id}`, 2, 100])]);
      await f.query('UPDATE orders SET delivered_at=? WHERE id=?', [recent, offset + 5]);
      await f.query('UPDATE orders SET delivered_at=? WHERE id=?', [boundary, offset + 8]);
      await f.query('UPDATE orders SET delivered_at=? WHERE id=?', [utc(end), offset + 9]);
      await f.query('UPDATE orders SET cancelled_after_ship=1 WHERE id=?', [offset + 10]);
      const histories = [[2,recent],[3,old],[3,recent],[4,null],[11,recent]];
      for (const [id, at] of histories) await f.query('INSERT INTO order_status_history(order_id,shop_id,posting_number,status,observed_at,observed_hour,last_status_changed_at) VALUES(?,?,?,\'delivering\',?,?,?)', [offset + id, shop, `order-${offset + id}`, at || recent, at || recent, at]);
      await f.query('INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,created_by) VALUES(?,?,?,?,?,1,1)', [offset + 1, tenant || 1, `batch-${offset}`, `request-${offset}`, shop]);
      for (const [id, active, withdrawn] of [[2,2,null],[6,null,recent],[7,1,null]]) await f.query('INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,dispatched_at,withdrawn_at) VALUES(?,?,?,?,?,?,?,?)', [tenant || 1, offset + 1, offset + id, active == null ? null : offset + active, shop, `order-${offset + id}`, recent, withdrawn]);
      await f.connection.query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type) VALUES ?", [products.map(([id]) => [tenant, id, 100, 'opening_stock'])]);
      await f.query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type,related_order_item_id) VALUES(?,?,-1,'order_outbound',?),(?,?,-2,'order_outbound',?)", [tenant, offset + 1, offset + 1, tenant, offset + 9, offset + 5]);
      await f.query("INSERT INTO fbp_replenishment_orders VALUES(?,?,'approved')", [offset + 1, shop]);
      await f.query("INSERT INTO fbp_replenishment_order_items VALUES(?,?,?,?, 'sku-2',?,2)", [offset + 1, offset + 1, shop, offset + 2, offset + 2]);
      await f.query('INSERT INTO fbp_replenishment_item_adjustments VALUES(?,1)', [offset + 1]);
    }
    await f.query("INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json) VALUES(10,'order-12',JSON_OBJECT('fulfillment_schema','FBP')),(20,'order-112',JSON_OBJECT('fulfillment_schema','FBP'))");
    const before = (await f.query('SELECT COUNT(*) n FROM inventory_movements'))[0].n;
    for (const [tenantId, offset] of [[1,0],[2,100]]) await t.test(`tenant ${tenantId}: large and original chunked reads agree`, async () => {
      const ids = Array.from({ length: 40 }, (_, i) => offset + i + 1), largeDemands = [], originalDemands = [], statements = [];
      const capture = rows => async (sql, params = []) => {
        assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
        statements.push(sql);
        const result = await f.query(sql, params);
        if (/^(SELECT local_demands\.\*|WITH local_order_facts)/.test(sql)) rows.push(...result);
        return result;
      };
      await loadOrderProcurementCoverage(capture(largeDemands), '', { productIds: ids, tenantId, localStateOnly: true, fresh: true });
      for (let start = 0; start < ids.length; start += 20) await loadOrderProcurementCoverage(capture(originalDemands), '', { productIds: ids.slice(start,start + 20), tenantId, localStateOnly: true, fresh: true });
      assert.deepEqual(rowsKey(largeDemands), rowsKey(originalDemands));
      assert.ok(largeDemands.length > 0);
      assert.ok(largeDemands.every(row => ids.includes(Number(row.product_id))));
      assert.ok(!largeDemands.some(row => [offset + 3,offset + 9,offset + 11].includes(Number(row.order_id))));
      assert.ok(largeDemands.some(row => Number(row.order_id) === offset + 4), 'null transport timestamp retains ordered-at fallback');
      assert.ok(largeDemands.some(row => Number(row.order_id) === offset + 8), 'inclusive seven-day lower boundary');
      const workflow = createInventoryWorkflowService({ query: f.query });
      const current = await workflow.batch(ids, tenantId, { localOnly: true, fresh: true, cache: false });
      const previous = [];
      for (let start = 0; start < ids.length; start += 20) previous.push(...await workflow.batch(ids.slice(start,start + 20), tenantId, { localOnly: true, fresh: true, cache: false }));
      assert.deepEqual(canonical(current), canonical(previous));
      assert.ok(current.some(row => row.free < row.physical_recorded));
      assert.equal(statements.filter(sql => sql.startsWith('WITH local_order_facts')).length, 1);
      const largeSql = statements.find(sql => sql.startsWith('WITH local_order_facts'));
      assert.match(largeSql, new RegExp(`transport_shop\\.tenant_id = ${tenantId}`));
      assert.equal(largeSql.includes('transport_shop.tenant_id IS NULL'), tenantId === 1);
    });
    assert.equal((await f.query('SELECT COUNT(*) n FROM inventory_movements'))[0].n, before);
  } finally { await f.cleanup(); }
});
