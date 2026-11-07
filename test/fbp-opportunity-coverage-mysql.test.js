import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema } from './helpers/tenant-order-service.js';
import { loadOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';

function snapshot(value) {
  const canonical = item => item instanceof Date ? item.toISOString() : item instanceof Map
    ? [...item].sort(([a], [b]) => Number(a) - Number(b)).map(([key, row]) => [key, canonical(row)])
    : item instanceof Set ? [...item].sort()
      : Array.isArray(item) ? item.map(canonical)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return canonical({ rows: value, ...value });
}

test('FBP full-tenant coverage equals the previous complete owned-ID scope for large and small enterprises', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent TCP-disabled MySQL socket', timeout: 90000
}, async t => {
  const f = await createTenantMysqlFixture('fbp_scope');
  try {
    await createOrderFixtureSchema(f.connection);
    await f.query('CREATE TABLE fbp_replenishment_orders(id BIGINT PRIMARY KEY,shop_id BIGINT,status VARCHAR(32)) ENGINE=InnoDB');
    await f.query('CREATE TABLE fbp_replenishment_order_items(id BIGINT PRIMARY KEY,order_id BIGINT,shop_id BIGINT,product_id BIGINT,ozon_sku VARCHAR(80),mapping_id BIGINT,approved_qty DECIMAL(18,4)) ENGINE=InnoDB');
    await f.query('CREATE TABLE fbp_replenishment_item_adjustments(item_id BIGINT,adjustment_qty DECIMAL(18,4)) ENGINE=InnoDB');
    await f.query('CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
    await f.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'other','Other')");
    await f.query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(20,2,'Customer')");
    const products = [...Array.from({ length: 40 }, (_, i) => [i + 1, null, `Owned ${i + 1}`, `OWN-${i + 1}`]), ...[101, 102, 103].map(id => [id, 2, `Customer ${id}`, `OWN-${id}`])];
    await f.connection.query('INSERT INTO products(id,tenant_id,name,code) VALUES ?', [products]);
    await f.query('UPDATE products SET active=0 WHERE id=40');
    const mappings = [[1,null,10,'shared',1],[2,null,10,'combo',2],[3,null,10,'recipe',5],[4,null,10,'unbound',4],[5,null,10,'foreign',101],[6,null,10,'history',8],[7,2,20,'customer',101],[8,2,20,'cancel-history',102]];
    await f.connection.query('INSERT INTO sku_mappings(id,tenant_id,shop_id,ozon_sku,product_id) VALUES ?', [mappings.filter(row => row[0] !== 4)]);
    await f.query('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(NULL,2,3,2),(NULL,2,4,1),(NULL,2,101,1)');
    await f.query("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES(1,10,'recipe',1,'combo')");
    await f.query('INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(1,6,2),(1,7,1),(1,103,1)');
    const orders = [[1,10,'D1','awaiting_packaging'],[2,10,'D2','awaiting_packaging'],[3,10,'D3','awaiting_deliver'],[4,10,'D4','awaiting_deliver'],[5,10,'D5','awaiting_packaging'],[6,10,'D6','awaiting_packaging'],[7,10,'D7','delivered'],[8,10,'D8','cancelled'],[9,10,'D9','awaiting_deliver'],[10,10,'D10','awaiting_deliver'],[201,20,'C201','awaiting_deliver'],[202,20,'C202','awaiting_deliver'],[203,20,'C203','cancelled']];
    await f.connection.query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES ?", [orders.map(row => [...row,'2026-10-01'])]);
    const items = orders.map(([id], i) => { const mappingId = i < 2 ? 1 : i <= 5 ? i : i < 10 ? 6 : i === 12 ? 8 : 7; const mapping = mappings.find(row => row[0] === mappingId); return [id,id,mappingId === 4 ? null : mappingId,mapping[3],i % 3 + 1,100]; });
    await f.connection.query('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES ?', [items]);
    await f.connection.query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type) VALUES ?", [products.map(([id,tenant]) => [tenant,id,12,'opening_stock'])]);
    await f.query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type,related_order_item_id) VALUES(NULL,1,-1,'order_outbound',1),(NULL,9,-2,'order_outbound',7),(2,103,-2,'order_outbound',203)");
    await f.query("INSERT INTO order_status_history(order_id,shop_id,posting_number,status,observed_at,observed_hour,last_status_changed_at) VALUES(8,10,'D8','delivering','2026-10-02','2026-10-02','2026-10-02'),(203,20,'C203','delivering','2026-10-02','2026-10-02','2026-10-02')");
    await f.query("INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,created_by) VALUES(1,1,'default-batch','default-request',10,1,1),(2,2,'customer-batch','customer-request',20,1,1)");
    await f.query("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,dispatched_at,withdrawn_at) VALUES(1,1,9,9,10,'D9','2026-10-02',NULL),(1,1,10,NULL,10,'D10','2026-10-02','2026-10-03'),(2,2,201,201,20,'C201','2026-10-02',NULL),(2,2,202,NULL,20,'C202','2026-10-02','2026-10-03')");
    await f.query("INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at) VALUES(1,NULL,'purchase-default','purchased','2026-09-01'),(2,2,'purchase-customer','purchased','2026-09-01')");
    await f.query("INSERT INTO procurement_requests(id,tenant_id,product_id,source_order_item_id,quantity,amount,status,purchase_order_id) VALUES(1,NULL,3,3,5,50,'purchased',1),(2,2,102,203,3,30,'purchased',2)");
    await f.query("INSERT INTO inbound_records(id,tenant_id,product_id,quantity,amount,status,purchase_order_id,procurement_request_id,created_at,approved_at) VALUES(1,NULL,3,1,10,'approved',1,1,'2026-09-01','2026-09-02'),(2,NULL,3,4,40,'pending_arrival',1,1,'2026-09-01',NULL),(3,2,102,3,30,'pending_arrival',2,2,'2026-09-01',NULL)");
    await f.query('INSERT INTO procurement_order_allocations(procurement_request_id,order_item_id,order_id,product_id,allocated_quantity) VALUES(1,3,3,3,2),(2,203,203,102,2)');
    await f.query('INSERT INTO procurement_history_sources(action_id,order_item_id,product_id,quantity,inbound_record_id) VALUES(1,3,3,1,1)');
    await f.query("INSERT INTO fbp_replenishment_orders VALUES(1,10,'approved'),(2,20,'ozon_created')");
    await f.query("INSERT INTO fbp_replenishment_order_items VALUES(1,1,10,2,'combo',2,2),(2,2,20,101,'customer',7,2)");
    await f.query('INSERT INTO fbp_replenishment_item_adjustments VALUES(1,1),(2,-1)');
    const countBefore = (await f.query('SELECT COUNT(*) n FROM inventory_movements'))[0].n;
    for (const [tenantId, includeLegacyTenantNull, ids] of [[1,true,products.filter(row => row[1] === null).map(row => row[0])],[2,false,[101,102,103]]]) {
      const previousSql = [], currentSql = [];
      const capture = entries => async (sql, params = []) => { entries.push(sql); return f.query(sql,params); };
      const previous = await loadOrderProcurementCoverage(capture(previousSql), '', { productIds: ids, tenantId, includeLegacyTenantNull, fresh: true });
      const current = await loadOrderProcurementCoverage(capture(currentSql), '', { tenantId, includeLegacyTenantNull, fresh: true });
      assert.deepEqual(snapshot(current), snapshot(previous), `Complete coverage and attached properties differ for tenant ${tenantId}`);
      assert.ok(current.product_availability.size > 0);
      assert.ok(previousSql.some(sql => sql.includes('OR oi.id IN (SELECT related_order_item_id')));
      assert.ok(currentSql.every(sql => !sql.includes('OR oi.id IN (SELECT related_order_item_id')));
      assert.ok([...current.product_availability.keys()].every(id => ids.includes(id)));
      t.diagnostic(`tenant=${tenantId}, products=${ids.length}: previous loader ${previousSql.length} SQL, full-tenant loader ${currentSql.length} SQL; complete Map and attached properties equal; outer duplicate product-ID read removed by the FBP reader.`);
    }
    assert.equal((await f.query('SELECT COUNT(*) n FROM inventory_movements'))[0].n, countBefore);
  } finally { await f.cleanup(); }
});
