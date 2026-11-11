import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('shared receiving exposes purchases immediately, keeps reminders separate and reserves stock receipts for warehouse staff', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('shared_receiving'); fixture.useEnvironment(); const q = fixture.query;
  const api = await import('../src/services/mysql-cutover.js');
  const { createProcurementArrivals } = await import('../src/services/procurement-arrivals.js');
  const { createInventoryWorkflowService } = await import('../src/services/inventory-workflow.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const arrivals = createProcurementArrivals();
  const workflow = createInventoryWorkflowService({ ledger: api.inventoryLedgerMysql, receiveRecords: api.batchUpdateInboundRecordsMysql, previewReceipts: api.previewInboundReceiptImpactMysql });
  const buyer = { personId: 7, tenant: { id: 2, slug: 'a', role: 'member' } }, warehouse = { ...buyer, personId: 8 }, foreign = { personId: 9, tenant: { id: 3, slug: 'b', role: 'member' } };
  const stock = async id => Number((await q("SELECT COALESCE(SUM(quantity_delta),0) AS n FROM inventory_movements WHERE product_id=? AND status='posted'", [id]))[0].n);
  const batches = id => q('SELECT * FROM inbound_records WHERE product_id=? ORDER BY id', [id]);
  const row = async id => (await arrivals.list({ status: 'pending', product_id: id }, warehouse)).rows[0];
  const reminder = batch => ({ id: batch.id, operation: 'remind', expected_quantity: Number(batch.quantity), expected_updated_at: batch.updated_at, request_key: randomUUID(), note: '物流显示签收，请仓库核实实物' });
  const receipt = async (productId, batch, quantity, reason = '') => {
    const input = { product_id: productId, receipt_mode: 'new_arrival', request_key: randomUUID(), records: [{ id: batch.id, quantity, expected_quantity: Number(batch.quantity), reason }] };
    return { ...input, expected_revision: (await workflow.previewReceive(input, warehouse)).revision };
  };
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(7,'Buyer','procurement'),(8,'Warehouse','packing'),(9,'Foreign buyer','procurement')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,7,'member',JSON_ARRAY('procurement'),1),(2,8,'member',JSON_ARRAY('packing'),1),(3,9,'member',JSON_ARRAY('procurement'),1)");
    await api.prepareInventoryFlowMysql();
    await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
    await api.procurementRequestsMysql({ grouped: '1', paged: '1', compact: '1' }, 2);
    for (const id of [200, 201, 202, 203]) {
      await q('INSERT INTO products(id,tenant_id,name,code) VALUES(?,2,?,?)', [id, `Shared stock ${id}`, `SHARED-${id}`]);
      await api.recordProcurementPurchaseMysql({ items: [{ product_id: id, quantity: 600, amount: 1200, shipping_amount: 30 }] }, 7, 2);
    }
    let initial, reminded;
    await t.test('warehouse sees newly purchased unmarked batches and no financial fields', async () => {
      initial = await row(200); assert.equal(initial.quantity, 600); assert.equal(initial.arrival_state, 'open'); assert.equal(initial.arrival_reminder, null);
      assert.equal('amount' in initial, false); assert.equal('shipping_amount' in initial, false); assert.equal('purchase_note' in initial, false);
      const queue = await arrivals.list({ status: 'pending', day_mode: 'pending', product_id: 200 }, warehouse);
      assert.equal(queue.summary.pending, 1); assert.equal(queue.summary.pending_quantity, 600); assert.equal(queue.day_summary.pending, 1);
      assert.equal((await arrivals.list({ status: 'arrived', product_id: 200 }, warehouse)).total, 0);
    });
    await t.test('reminding is audited, idempotent and never marks physical arrival or stock', async () => {
      const input = reminder(initial); await arrivals.confirm(input, buyer);
      assert.equal((await arrivals.confirm(input, buyer)).duplicate, true);
      await assert.rejects(arrivals.confirm({ ...input, note: 'changed' }, buyer), { statusCode: 409 });
      reminded = await row(200); assert.equal(reminded.arrival_state, 'reminded'); assert.equal(reminded.received_at, null);
      assert.equal(reminded.arrival_reminder.person_id, 7); assert.equal(reminded.arrival_reminder.person_name, 'Buyer'); assert.equal(reminded.arrival_reminder.note, input.note); assert.ok(reminded.arrival_reminder.created_at);
      const queue = await arrivals.list({ status: 'reminded', day_mode: 'pending', product_id: 200 }, warehouse);
      assert.equal(queue.total, 1); assert.equal(queue.summary.reminded, 1); assert.equal(queue.summary.open, 1); assert.equal(queue.day_summary.pending_quantity, 600);
      assert.equal((await arrivals.confirm(reminder(reminded), buyer)).duplicate, true);
      assert.equal((await q("SELECT COUNT(*) AS n FROM inventory_flow_events WHERE action='purchase_arrival_reminder' AND product_id=200"))[0].n, 1);
      assert.equal(await stock(200), 0); assert.equal((await batches(200)).length, 1);
      assert.equal((await q('SELECT actual_quantity FROM purchase_order_items WHERE product_id=200'))[0].actual_quantity, 600);
    });
    await t.test('warehouse may mark 80 physically arrived and accept 70 while the other 10 remain physically arrived', async () => {
      await arrivals.confirm({ id: reminded.id, quantity: 80, expected_quantity: 600, expected_updated_at: reminded.updated_at, request_key: randomUUID() }, warehouse);
      let records = await batches(200); assert.equal(records.length, 2); assert.equal(Number(records[1].quantity), 520); assert.equal(records[1].received_at, null);
      const arrived = (await arrivals.list({ status: 'arrived', product_id: 200 }, warehouse)).rows[0];
      assert.equal(arrived.quantity, 80); assert.ok(arrived.arrival_reminder); assert.equal(await stock(200), 0);
      await workflow.receive(await receipt(200, arrived, 70, '另外10件验货不合格，留待处理'), warehouse);
      records = await batches(200); assert.equal(records.length, 3); assert.equal(await stock(200), 70);
      const unaccepted = records.find(batch => batch.status === 'pending_arrival' && Number(batch.quantity) === 10);
      assert.ok(unaccepted.received_at, 'already-arrived rejected units must not become unarrived');
      const queue = await arrivals.list({ status: 'pending', day_mode: 'pending', product_id: 200 }, warehouse);
      assert.equal(queue.summary.pending_quantity, 530); assert.equal(queue.summary.open_quantity, 520); assert.equal(queue.summary.arrived_quantity, 10);
      assert.deepEqual(queue.rows.find(batch => Number(batch.quantity) === 520).purchase_progress, { ordered_quantity: 600, unarrived_quantity: 520, arrived_quantity: 10, received_quantity: 70 });
      assert.equal(queue.rows.find(batch => Number(batch.quantity) === 520).arrival_reminder, null, 'reminder does not migrate to a later delivery');
      assert.equal(records.reduce((sum, batch) => sum + Number(batch.amount), 0), 1200);
      await assert.rejects(arrivals.confirm(reminder(arrived), buyer), { statusCode: 409 });
    });
    await t.test('purchaser-only cannot bypass stock receipt through modern or legacy entry points', async () => {
      const pending = await row(201), input = await receipt(201, pending, 600);
      await assert.rejects(workflow.receiptContext(201, buyer), { statusCode: 403 });
      await assert.rejects(workflow.previewReceive(input, buyer), { statusCode: 403 });
      await assert.rejects(workflow.receive(input, buyer), { statusCode: 403 });
      await assert.rejects(api.createInboundRecordMysql({ product_id: 201, person_id: 7, quantity: 1, status: 'approved' }, 2, 7), { statusCode: 403 });
      await assert.rejects(api.updateInboundRecordMysql(pending.id, { status: 'approved' }, 7, 2), { statusCode: 403 });
      const legacy = { records: [{ id: pending.id, payload: { status: 'approved' } }] };
      await assert.rejects(api.batchUpdateInboundRecordsMysql(legacy, 7, 2), { statusCode: 403 });
      await assert.rejects(api.startBatchUpdateInboundRecordsMysql(legacy, 7, 2, buyer), { statusCode: 403 });
      await assert.rejects(api.directInboundProcurementRequestsMysql({ request_ids: [1] }, 2, 7), { statusCode: 403 });
      assert.equal(await stock(201), 0); assert.equal((await batches(201)).length, 1);
      const approved = (await batches(200)).find(batch => batch.status === 'approved'), approvedQuantity = Number(approved.quantity);
      const beforeMovements = await q('SELECT id,quantity_delta FROM inventory_movements WHERE product_id=200 ORDER BY id');
      await assert.rejects(api.updateInboundRecordMysql(approved.id, { status: 'approved', receive_quantity: approvedQuantity + 1, expected_remaining_quantity: approvedQuantity, receipt_difference_reason: '多收一件' }, 7, 2), { statusCode: 403 });
      await assert.rejects(api.updateInboundRecordMysql(approved.id, { status: 'approved', quantity: approvedQuantity + 1 }, 7, 2), { statusCode: 403 });
      const ledger = await api.procurementLedgerMysql({ product_id: 200, include_fbp: false }, 2);
      await assert.rejects(api.applyProcurementLedgerMysql({ action_type: 'record_purchase', product_id: 200, quantity: 1, amount: 2, shipping_amount: 0, purchased_at: '2026-11-01T12:00:00+08:00', inventory_effect: 'missing_inbound', reason: '补漏记采购', revision: ledger.revision, request_key: randomUUID() }, 7, 2), { statusCode: 403 });
      await assert.rejects(api.applyProcurementLedgerMysql({ action_type: 'receive', product_id: 200, quantity: 1, inbound_id: pending.id, inventory_effect: 'missing_inbound', reason: '补漏记到货', revision: ledger.revision, request_key: randomUUID() }, 7, 2), { statusCode: 403 });
      assert.equal(await stock(200), 70); assert.deepEqual(await q('SELECT id,quantity_delta FROM inventory_movements WHERE product_id=200 ORDER BY id'), beforeMovements);
    });
    await t.test('purchase-only backfill keeps in-transit and already-accounted paths while new stock requires both duties', async () => {
      await q("INSERT INTO products(id,tenant_id,name,code) VALUES(204,2,'Backfill stock','BACKFILL-204')");
      const backfill = async effect => {
        const snapshot = await api.procurementLedgerMysql({ product_id: 204, include_fbp: false }, 2);
        return api.applyProcurementLedgerMysql({ action_type: 'record_purchase', product_id: 204, quantity: 1, amount: 2, shipping_amount: 0, purchased_at: '2026-11-01T12:00:00+08:00', inventory_effect: effect, reason: '核对历史采购凭证', revision: snapshot.revision, request_key: randomUUID() }, 7, 2);
      };
      await backfill('in_transit'); await backfill('already_accounted'); assert.equal(await stock(204), 0);
      await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement','packing') WHERE tenant_id=2 AND person_id=7");
      await backfill('missing_inbound'); assert.equal(await stock(204), 1);
      await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=7");
    });
    await t.test('warehouse can directly accept unmarked partial deliveries and complete the date without purchaser actions', async () => {
      const initial201 = await row(201);
      await workflow.receive(await receipt(201, initial201, 80, '分批到货，其余520尚未到货'), warehouse);
      const pending = await row(201); assert.equal(pending.quantity, 520); assert.equal(pending.received_at, null); assert.equal(await stock(201), 80);
      await workflow.receive(await receipt(201, pending, 520), warehouse);
      const queue = await arrivals.list({ status: 'pending', day_mode: 'pending', product_id: 201, purchase_day: '2026-11-11' }, warehouse);
      assert.equal(queue.total, 0); assert.equal(queue.summary.pending, 0); assert.deepEqual(queue.days, []); assert.equal(await stock(201), 600);
    });
    await t.test('arrival marking and direct warehouse receipt racing on 600 cannot create duplicate remainders', async () => {
      const pending = await row(202), input = await receipt(202, pending, 80, '本次实收80，其余待到货');
      const results = await Promise.allSettled([
        arrivals.confirm({ id: pending.id, quantity: 80, expected_quantity: 600, expected_updated_at: pending.updated_at, request_key: randomUUID() }, buyer),
        workflow.receive(input, warehouse)
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409);
      const records = await batches(202); assert.equal(records.length, 2); assert.equal(records.reduce((sum, batch) => sum + Number(batch.quantity), 0), 600);
      assert.equal(records.filter(batch => Number(batch.quantity) === 520 && !batch.received_at).length, 1);
      assert.ok([0, 80].includes(await stock(202)));
    });
    await t.test('tenant ownership, stale data and freshly revoked warehouse rights remain enforced', async () => {
      const pending = await row(203), input = reminder(pending);
      await assert.rejects(arrivals.confirm(input, warehouse), { statusCode: 403 });
      await assert.rejects(arrivals.confirm(input, foreign), { statusCode: 404 });
      await assert.rejects(arrivals.confirm({ ...input, expected_quantity: 599 }, buyer), { statusCode: 409 });
      const receive = await receipt(203, pending, 600);
      await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=8");
      await assert.rejects(workflow.receive(receive, warehouse), { statusCode: 403 });
      assert.equal(await stock(203), 0);
      await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=8");
    });
  } finally { await closeMysqlPool(); await fixture.cleanup(); }
});
