import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('inventory and order dialogs use one nonfinancial scoped flow summary; deep links cannot cross enterprises', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 180000
}, async () => {
  const fixture = await createTenantMysqlFixture('flow_summary'); fixture.useEnvironment();
  const service = await import('../src/services/mysql-cutover.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const q = fixture.query;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('External calls forbidden'); };
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(1,'A operator','operations'),(2,'A warehouse','packing'),(3,'B private','operations')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,1,'member',JSON_ARRAY('operations')),(2,2,'member',JSON_ARRAY('packing')),(3,3,'member',JSON_ARRAY('operations'))");
    await service.prepareInventoryFlowMysql();
    await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'B private shop','active')");
    await q("INSERT INTO products(id,tenant_id,name,production_lead_days,warehouse_logistics_days) VALUES(200,2,'A part',7,3),(300,3,'B private product',7,3)");
    await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,offer_id,active) VALUES(200,2,200,20,'20001','A-1',1),(300,3,300,30,'30001','B-1',1)");
    await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,200,'purchase_inbound',200,'posted','LOCAL'),(3,300,'purchase_inbound',999,'posted','LOCAL')");
    await q("INSERT INTO ozon_stock_snapshots(shop_id,product_id,ozon_sku,stock_type,warehouse_id,present,available) VALUES(20,200,'20001','fbp_real','1',0,0)");
    await q("INSERT INTO fbp_replenishment_orders(id,order_no,shop_id,order_date,status,created_by,reviewed_by) VALUES(20,'A-FBP',20,'2026-10-29','approved',1,2),(30,'B-PRIVATE-FBP',30,'2026-10-29','approved',3,3)");
    await q("INSERT INTO fbp_replenishment_order_items(id,order_id,shop_id,product_id,mapping_id,ozon_sku,requested_qty,approved_qty,requested_by) VALUES(20,20,20,200,200,'20001',150,90,1),(30,30,30,300,300,'30001',900,900,3)");
    await q("INSERT INTO fbp_replenishment_orders(id,order_no,shop_id,order_date,status,created_by,reviewed_by,submitted_at,reviewed_at,closed_at) VALUES(21,'A-SENT',20,'2026-10-28','sent',1,2,UTC_TIMESTAMP(),UTC_TIMESTAMP(),NULL),(22,'A-COMPLETED',20,'2026-10-27','completed',1,2,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP()),(31,'B-PRIVATE-SENT',30,'2026-10-28','sent',3,3,NULL,NULL,NULL)");
    await q("INSERT INTO fbp_replenishment_order_items(id,order_id,shop_id,product_id,mapping_id,ozon_sku,requested_qty,approved_qty,requested_by) VALUES(21,21,20,200,200,'20001',45,40,1),(22,22,20,200,200,'20001',30,25,1),(31,31,30,300,300,'30001',999,999,3)");
    const before = await q('SELECT id,quantity_delta,status FROM inventory_movements ORDER BY id');
    const legacy = await service.procurementLedgerMysql({ product_id: 200 }, 2);
    assert.equal(legacy.flow_summary, undefined);
    const purchase = await service.procurementLedgerMysql({ product_id: 200, include_flow: '1' }, 2);
    const inventory = await service.inventoryLedgerMysql({ product_id: 200, include_flow: '1' }, 2);
    for (const result of [purchase, inventory]) {
      assert.equal(result.flow_summary.unavailable, undefined);
      assert.equal(result.flow_summary.physical, 200);
      assert.equal(result.flow_summary.locked, 90);
      assert.equal(result.flow_summary.applications.length, 3);
      assert.equal(result.flow_summary.applications[0].applicant_name, 'A operator');
      assert.equal(result.flow_summary.applications[0].reviewer_name, 'A warehouse');
      assert.equal(result.flow_summary.requested, 150);
      assert.doesNotMatch(JSON.stringify(result), /B-PRIVATE|B private/);
      assert.equal(result.revision, legacy.revision);
    }
    assert.doesNotMatch(JSON.stringify(inventory.flow_summary), /"amount"|purchase_cost|supplier_id|purchase_url/);
    const a = { ...purchase.flow_summary }; const b = { ...inventory.flow_summary }; delete a.calculated_at; delete b.calculated_at;
    assert.deepEqual(a, b);
    assert.deepEqual(await q('SELECT id,quantity_delta,status FROM inventory_movements ORDER BY id'), before);
    assert.equal((await service.fbpReplenishmentOrdersMysql({ orderId: 20, status: 'all' }, 2)).rows.length, 1);
    assert.equal((await service.fbpReplenishmentOrdersMysql({ orderId: 30, status: 'all' }, 2)).rows.length, 0);
    await assert.rejects(service.inventoryLedgerMysql({ product_id: 300, include_flow: '1' }, 2));
    await assert.rejects(service.fbpReplenishmentOrdersMysql({ orderId: '-1' }, 2), { statusCode: 400 });
    const local = await service.inventoryLedgerMysql({ product_id: 200, include_flow: 'local' }, 2);
    assert.equal(local.fbp_inventory, null);
    assert.equal(local.flow_summary.safety, 0);
    assert.equal(local.flow_summary.free, 110);
    assert.equal(local.flow_summary.requested, null);
    assert.equal(local.flow_summary.applications_pending, true);
    await q('DELETE FROM ozon_stock_snapshots WHERE shop_id=20');
    const withoutSnapshots = await service.inventoryLedgerMysql({ product_id: 200, include_flow: 'local' }, 2);
    assert.equal(withoutSnapshots.flow_summary.free, 110);
    const fbp = await service.inventoryLedgerMysql({ product_id: 200, view: 'fbp' }, 2);
    assert.equal(fbp.fbp_inventory.incomplete, true);
    assert.equal(fbp.applications.length, 3);
    assert.equal(fbp.physical_estimate, undefined);
    assert.equal(fbp.requested, 150);
    assert.equal(fbp.applications.find(row => row.status === 'sent').locked_quantity, 0);
    assert.equal(fbp.applications.find(row => row.status === 'completed').locked_quantity, 0);
    assert.ok(fbp.applications.find(row => row.status === 'completed').closed_at);
    await assert.rejects(service.inventoryLedgerMysql({ product_id: 300, view: 'fbp' }, 2));
    assert.deepEqual(await q('SELECT id,quantity_delta,status FROM inventory_movements ORDER BY id'), before);
    await q("INSERT INTO inventory_flow_settings(tenant_id,product_id,settings_json) VALUES(2,200,JSON_OBJECT('production_days',-1))");
    const unavailable = await service.inventoryLedgerMysql({ product_id: 200, include_flow: '1' }, 2);
    assert.equal(unavailable.flow_summary.unavailable, true);
    assert.equal(unavailable.physical_estimate, 200);
    assert.equal(unavailable.revision, legacy.revision);
  } finally { globalThis.fetch = oldFetch; await closeMysqlPool(); await fixture.cleanup(); }
});
