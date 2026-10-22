import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('purchase item status follows the persisted receipt quantity once across approvals, edits, reversals and deletes', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('receipt_status');
  const previousFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error('Live external calls forbidden in receipt tests'); };
    const service = await import('../src/services/mysql-cutover.js');
    ({ closeMysqlPool } = await import('../src/mysql-pool.js'));
    const q = fixture.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'receipt-a','A'),(3,'receipt-b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(7,'Receipt operator','procurement'),(8,'B operator','procurement')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,7,'member',JSON_ARRAY('procurement')),(2,7,'member',JSON_ARRAY('procurement')),(3,8,'member',JSON_ARRAY('procurement'))");
    await service.warmCoreInventoryRuntimeMysql('admin');
    async function purchase(productId, tenant, actor = 7) {
      await q('INSERT INTO products(id,tenant_id,name,code) VALUES(?,?,?,?)', [productId, tenant === 'admin' ? null : tenant, 'Receipt fixture', `RECEIPT-${productId}`]);
      await service.recordProcurementPurchaseMysql({ items: [{ product_id: productId, quantity: 10, amount: 100 }] }, actor, tenant);
      return (await q("SELECT id FROM inbound_records WHERE product_id=? AND status='pending_arrival' ORDER BY id", [productId]))[0].id;
    }
    async function check(productId, quantity, status) {
      const [item] = await q('SELECT inbound_quantity,status,purchase_order_id FROM purchase_order_items WHERE product_id=?', [productId]);
      assert.equal(Number(item.inbound_quantity), quantity);
      assert.equal(item.status, status);
      assert.equal((await q('SELECT status FROM purchase_orders WHERE id=?', [item.purchase_order_id]))[0].status, status);
      const [stock] = await q("SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM inventory_movements WHERE product_id=? AND status='posted'", [productId]);
      assert.equal(Number(stock.quantity), quantity, 'The status correction must not duplicate or lose posted stock');
    }
    await purchase(300, 3, 8);
    const foreignBefore = await q('SELECT * FROM purchase_order_items WHERE product_id=300');
    for (const [tenant, base] of [['admin', 100], [2, 200]]) {
      await t.test(`${tenant}: partial, complete, reverse and delete agree with the parent and stock`, async () => {
        const first = await purchase(base, tenant);
        await service.updateInboundRecordMysql(first, { receive_quantity: 5, expected_remaining_quantity: 10, status: 'approved' }, 7, tenant);
        await check(base, 5, 'partial_inbound');
        const [remaining] = await q("SELECT id FROM inbound_records WHERE product_id=? AND status='pending_arrival'", [base]);
        await service.updateInboundRecordMysql(remaining.id, { receive_quantity: 5, expected_remaining_quantity: 5, status: 'approved' }, 7, tenant);
        await check(base, 10, 'inbound_done');
        await service.updateInboundRecordMysql(first, { status: 'pending_arrival' }, 7, tenant);
        await check(base, 5, 'partial_inbound');
        await service.deleteInboundRecordMysql(remaining.id, tenant);
        await check(base, 0, 'purchased');
      });
      await t.test(`${tenant}: deleting a larger receipt cannot hide a smaller received remainder`, async () => {
        const first = await purchase(base + 1, tenant);
        await service.updateInboundRecordMysql(first, { receive_quantity: 6, expected_remaining_quantity: 10 }, 7, tenant);
        await check(base + 1, 6, 'partial_inbound');
        const [remaining] = await q("SELECT id FROM inbound_records WHERE product_id=? AND status='pending_arrival'", [base + 1]);
        await service.updateInboundRecordMysql(remaining.id, { status: 'approved' }, 7, tenant);
        await check(base + 1, 10, 'inbound_done');
        await service.deleteInboundRecordMysql(first, tenant);
        await check(base + 1, 4, 'partial_inbound');
      });
      await t.test(`${tenant}: correcting a receipt preserves the approved-edit guard and recomputes status after reversal`, async () => {
        const first = await purchase(base + 2, tenant);
        await service.updateInboundRecordMysql(first, { receive_quantity: 2, expected_remaining_quantity: 10 }, 7, tenant);
        await check(base + 2, 2, 'partial_inbound');
        await assert.rejects(service.updateInboundRecordMysql(first, { receive_quantity: 6, receipt_difference_reason: 'Correct received quantity' }, 7, tenant), /已入库或已取消/);
        await check(base + 2, 2, 'partial_inbound');
        await service.updateInboundRecordMysql(first, { status: 'pending_arrival' }, 7, tenant);
        await check(base + 2, 0, 'purchased');
        await service.updateInboundRecordMysql(first, { receive_quantity: 6, expected_remaining_quantity: 2, receipt_difference_reason: 'Correct received quantity' }, 7, tenant);
        await check(base + 2, 6, 'partial_inbound');
      });
    }
    await t.test('foreign receipts are rejected without touching either enterprise', async () => {
      const [foreign] = await q('SELECT id FROM inbound_records WHERE product_id=300');
      await assert.rejects(service.updateInboundRecordMysql(foreign.id, { status: 'approved' }, 7, 2), { statusCode: 404 });
      await assert.rejects(service.deleteInboundRecordMysql(foreign.id, 'admin'), { statusCode: 404 });
      assert.deepEqual(await q('SELECT * FROM purchase_order_items WHERE product_id=300'), foreignBefore);
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
