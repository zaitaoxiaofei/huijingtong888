import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOglDispatchService } from '../src/services/ogl-dispatch.js';
import { oglPhysicalDispatchSql } from '../src/services/ogl-dispatch-state.js';

test('mixed OGL bags keep original-shop official evidence, local membership and confirmation authority separate', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('ogl_mixed');
  const query = fixture.query;
  const pool = mysql.createPool({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: 'root', database: fixture.database, connectionLimit: 5, timezone: 'Z' });
  const transaction = async operation => {
    const connection = await pool.getConnection();
    try { await connection.beginTransaction(); const result = await operation(connection); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  };
  const session = tenant => ({ personId: tenant, tenant: { id: tenant, slug: tenant === 1 ? 'default' : `mixed-${tenant}` } });
  const calls = [];
  const state = { remoteStatus: 'new', count: 0, method: 77, numbers: ['OWN'], mode: 'PICK_UP', actions: ['get_label_containers'], hook: null, discover: false, entrusted: true, sellerErrors: {}, postingStatuses: {} };
  const api = {
    async deliveryMethods(shop, filter) {
      calls.push({ shop: Number(shop.id), path: 'delivery', filter });
      return [{ delivery_method_id: 77, departure_date: '2026-10-22T16:00:00Z', has_entrusted_acceptance: state.entrusted,
        first_mile_type: state.mode, integration_type: 'ozon_outsourced',
        carriages: state.discover ? [{ id: 901, status: state.remoteStatus, containers_count: state.count, available_actions: state.actions }] : [{ id: 0, available_actions: ['create'] }] }];
    },
    async request(shop, path, body, options) {
      const call = { shop: Number(shop.id), path, body, options }; calls.push(call);
      await state.hook?.(call);
      if (path === '/v1/carriage/create') return { carriage_id: 901 };
      if (path === '/v1/carriage/get') return { carriage_id: 901, status: state.remoteStatus, containers_count: state.count, delivery_method_id: state.method,
        first_mile_type: state.mode, integration_type: 'ozon_outsourced', available_actions: [...state.actions], created_at: '2026-10-22T16:10:00Z' };
      if (path === '/v2/posting/fbs/act/get-postings') return { result: state.numbers.map(posting_number => ({ posting_number,
        ...(state.sellerErrors[posting_number] ? { seller_error: state.sellerErrors[posting_number] } : {}),
        ...(state.postingStatuses[posting_number] ? { status: state.postingStatuses[posting_number] } : {}),
        private_fixture_field: 'must-not-return-official-row' })) };
      if (path === '/v1/carriage/set-postings') { state.numbers = [...body.posting_numbers]; return { result: state.numbers.map(posting_number => ({ posting_number, result: true })) }; }
      if (path === '/v1/carriage/courier-contact/set') return {};
      if (path === '/v1/carriage/approve') { state.remoteStatus = 'formed'; state.count = body.containers_count; return {}; }
      if (path === '/v2/posting/fbs/act/get-container-labels') return { buffer: Buffer.from('%PDF-isolated-mixed'), contentType: 'application/pdf' };
      assert.fail(`Unexpected isolated Ozon fixture request ${path}`);
    }
  };
  const service = createOglDispatchService({ transaction, api, now: () => new Date('2026-10-23T01:00:00Z') });
  let requestNumber = 0;
  const begin = async () => {
    state.remoteStatus = 'new'; state.count = 0; state.method = 77; state.numbers = ['OWN']; state.mode = 'PICK_UP'; state.actions = ['get_label_containers']; state.hook = null; state.discover = false; state.entrusted = true; state.sellerErrors = {}; state.postingStatuses = {};
    await query("UPDATE tenants SET subscription_status='active',subscription_expires_at=NULL WHERE id=2");
    await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2");
    await query("UPDATE shops SET status='active' WHERE tenant_id=2");
    for (const table of ['ogl_dispatch_events', 'ogl_dispatch_official_locks', 'ogl_dispatch_members', 'ogl_dispatch_batches']) await query(`DELETE FROM ${table} WHERE tenant_id=2`);
    calls.length = 0;
    return service.createBatch(session(2), { order_ids: [1, 2], container_count: 3, client_request_id: `isolated-mixed-${++requestNumber}` });
  };
  const createOfficial = batch => service.action(session(2), { batch_id: batch.batch.id, action: 'official-create', delivery_method_id: 77, departure_date: '2026-10-23', handover_type: 'courier' });
  const confirm = (batch, extra = {}) => service.action(session(2), { batch_id: batch.batch.id, action: 'official-confirm', handover_type: 'courier', courier_contact: { phone: '+8613812345678' }, ...extra });
  const memberEvidence = async batchId => query('SELECT order_id,shop_id,posting_number,official_member,container_no,dispatched_at,dispatched_by FROM ogl_dispatch_members WHERE tenant_id=2 AND batch_id=? ORDER BY order_id', [batchId]);
  const foreignEvidence = async () => {
    const result = {};
    for (const table of ['ogl_dispatch_settings', 'ogl_dispatch_batches', 'ogl_dispatch_members', 'ogl_dispatch_events', 'ogl_dispatch_official_locks']) result[table] = await query(`SELECT * FROM ${table} WHERE tenant_id<>2 ORDER BY tenant_id,id`.replace(',id', table === 'ogl_dispatch_settings' || table === 'ogl_dispatch_official_locks' ? '' : ',id'));
    return result;
  };
  const expectLocalMixed = result => {
    assert.ok(Array.isArray(result.local_members), 'Official detail must include the distinct authorized ERP local_members collection');
    assert.deepEqual(result.local_members.map(row => [Number(row.order_id), Number(row.shop_id)]).sort((a, b) => a[0] - b[0]), [[1, 20], [2, 21]]);
    assert.equal(result.local_members.find(row => Number(row.shop_id) === 21).official_member, 0);
    assert.match(result.local_members.find(row => Number(row.shop_id) === 21).order_path, /orderId=2.*shopId=21/);
    assert.equal(result.summary.local_members_count, 2); assert.equal(result.summary.local_only_count, 1);
  };
  try {
    for (const tenant of [1, 2, 3]) {
      await query('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)', [tenant, tenant === 1 ? 'default' : `mixed-${tenant}`, `Mixed enterprise ${tenant}`]);
      await query("INSERT INTO people(id,name,role) VALUES(?,?,'packing')", [tenant, `Mixed packer ${tenant}`]);
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'admin',JSON_ARRAY('packing'))", [tenant, tenant]);
    }
    for (const [shop, tenant] of [[10, null], [20, 2], [21, 2], [30, 3]]) await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,'isolated-client','isolated-secret')", [shop, tenant, `Mixed shop ${shop}`]);
    for (const [order, shop, posting] of [[1, 20, 'OWN'], [2, 21, 'LOCAL-OTHER'], [3, 30, 'FOREIGN']]) {
      await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,'awaiting_deliver','2026-10-22 12:00:00')", [order, shop, posting]);
      await query('INSERT INTO order_label_prints(order_id) VALUES(?)', [order]);
      await query("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(?,?,'awaiting_deliver',?)", [shop, posting, JSON.stringify({ posting_number: posting, status: 'awaiting_deliver', delivery_method: { id: 77, name: 'OGL pickup' } })]);
    }
    for (const [tenant, shop] of [[2, 20], [3, 30]]) await query('INSERT INTO ogl_dispatch_settings(tenant_id,default_shop_id,updated_by) VALUES(?,?,?)', [tenant, shop, tenant]);
    await service.createBatch(session(3), { order_ids: [3], container_count: 1, client_request_id: 'foreign-existing' });
    const foreignBefore = await foreignEvidence();

    await t.test('mixed local bag submits only the creation-shop order and never creates physical handover', async () => {
      const batch = await begin(); const created = await createOfficial(batch);
      assert.deepEqual(created.members.map(row => [Number(row.order_id), Number(row.shop_id)]), [[1, 20], [2, 21]]);
      assert.deepEqual(calls.find(row => row.path === '/v1/carriage/set-postings').body.posting_numbers, ['OWN']);
      assert.ok(calls.every(row => row.shop === 20));
      assert.deepEqual((await memberEvidence(batch.batch.id)).map(row => [row.order_id, row.official_member]), [[1, 1], [2, 0]]);
      assert.ok((await memberEvidence(batch.batch.id)).every(row => row.dispatched_at === null && row.dispatched_by === null));
      assert.deepEqual(created.batch.official_result.cross_shop_local_only, ['LOCAL-OTHER']);
    });

    await t.test('foreign order IDs, batch IDs and official-shop selectors are refused without requests or mutations', async () => {
      await begin(); const before = calls.length;
      const preview = await service.preview(session(2), { order_ids: [3] }); assert.equal(preview.counts.eligible, 0);
      await assert.rejects(service.createBatch(session(2), { order_ids: [1, 3], container_count: 1, client_request_id: 'poison-foreign' }), { statusCode: 409 });
      const foreignBatch = (await query('SELECT id FROM ogl_dispatch_batches WHERE tenant_id=3'))[0].id;
      await assert.rejects(service.detail(session(2), foreignBatch), { statusCode: 404 });
      await assert.rejects(service.file(session(2), foreignBatch, 'container-labels'), { statusCode: 404 });
      await assert.rejects(service.officialDetail(session(2), { id: 901, date: '2026-10-23', shop_id: 30 }), { statusCode: 409 });
      assert.equal(calls.length, before); assert.deepEqual(await foreignEvidence(), foreignBefore);
    });

    await t.test('formed with an exact original-shop manifest, matching positive count and label capability can confirm a mixed local bag', async () => {
      const batch = await begin(); await createOfficial(batch);
      const approved = await confirm(batch, { container_count: 2 });
      assert.equal(approved.batch.official_status, 'approved'); assert.equal(approved.batch.containers_count, 2);
      assert.equal(calls.find(row => row.path === '/v1/carriage/approve').body.containers_count, 2);
      assert.ok(calls.some(row => row.path === '/v1/carriage/courier-contact/set'));
      assert.deepEqual((await memberEvidence(batch.batch.id)).map(row => row.official_member), [1, 0]);
      const pdf = await service.file(session(2), batch.batch.id, 'container-labels'); assert.equal(pdf.buffer.toString(), '%PDF-isolated-mixed');
      assert.ok((await memberEvidence(batch.batch.id)).every(row => row.dispatched_at === null));
    });

    await t.test('formed alone, zero or mismatched count, wrong method and changed manifest never authorize a label', async () => {
      for (const change of [
        () => { state.actions = []; state.count = 3; },
        () => { state.count = 0; },
        () => { state.count = 4; },
        () => { state.count = 3; state.method = 78; },
        () => { state.count = 3; state.numbers = ['OWN', 'LOCAL-OTHER']; }
      ]) {
        const batch = await begin(); await createOfficial(batch); state.remoteStatus = 'formed'; change();
        const read = await service.action(session(2), { action: 'official-sync', batch_id: batch.batch.id });
        assert.notEqual(read.batch.official_status, 'approved');
        const offset = calls.length; await assert.rejects(service.file(session(2), batch.batch.id, 'container-labels'), { statusCode: 409 });
        assert.ok(!calls.slice(offset).some(row => row.path.endsWith('get-container-labels')));
        assert.ok((await memberEvidence(batch.batch.id)).every(row => row.dispatched_at === null));
      }
    });

    await t.test('an approved mixed bag fresh-checks manifest before each download and never promotes another local shop', async () => {
      const batch = await begin(); await createOfficial(batch); await confirm(batch);
      state.numbers = ['OWN', 'LOCAL-OTHER']; const offset = calls.length;
      await assert.rejects(service.file(session(2), batch.batch.id, 'container-labels'), { code: 'OGL_FILE_CONFIRMATION_CHANGED' });
      assert.ok(!calls.slice(offset).some(row => row.path.endsWith('get-container-labels')));
      assert.equal((await memberEvidence(batch.batch.id)).find(row => row.shop_id === 21).official_member, 0);
    });

    await t.test('count reduction cannot erase assigned bags or contact Ozon', async () => {
      const batch = await begin(); await service.action(session(2), { action: 'assign', batch_id: batch.batch.id, order_ids: [2], container_no: 3 });
      await createOfficial(batch); const before = await memberEvidence(batch.batch.id); const offset = calls.length;
      await assert.rejects(confirm(batch, { container_count: 2 }), { code: 'OGL_CONTAINER_ASSIGNMENT_CONFLICT' });
      assert.deepEqual(await memberEvidence(batch.batch.id), before); assert.equal(calls.length, offset);
      assert.equal((await service.detail(session(2), batch.batch.id)).batch.containers_count, 3);
    });

    await t.test('count validation is repeated after manifest network reads before a contact or approval write', async () => {
      const batch = await begin(); await createOfficial(batch);
      state.hook = async call => {
        if (call.path === '/v2/posting/fbs/act/get-postings') {
          state.hook = null;
          await query('UPDATE ogl_dispatch_members SET container_no=3 WHERE tenant_id=2 AND batch_id=? AND order_id=2', [batch.batch.id]);
        }
      };
      const offset = calls.length;
      await assert.rejects(confirm(batch, { container_count: 2 }), { code: 'OGL_CONTAINER_ASSIGNMENT_CONFLICT' });
      assert.ok(!calls.slice(offset).some(row => ['/v1/carriage/approve', '/v1/carriage/courier-contact/set'].includes(row.path)));
      assert.equal((await service.detail(session(2), batch.batch.id)).batch.containers_count, 3);
      assert.equal((await memberEvidence(batch.batch.id)).find(row => row.order_id === 2).container_no, 3);
    });

    await t.test('pickup requires a phone while self-delivery never submits a hidden pickup contact', async () => {
      let batch = await begin(); await createOfficial(batch); let offset = calls.length;
      await assert.rejects(confirm(batch, { courier_contact: {} }), { code: 'OGL_COURIER_CONTACT_REQUIRED' });
      assert.ok(!calls.slice(offset).some(row => ['/v1/carriage/approve', '/v1/carriage/courier-contact/set'].includes(row.path)));
      batch = await begin(); state.mode = 'DROP_OFF';
      await service.action(session(2), { action: 'official-create', batch_id: batch.batch.id, delivery_method_id: 77, departure_date: '2026-10-23', handover_type: 'self' }); offset = calls.length;
      const approved = await confirm(batch, { handover_type: 'self', courier_contact: { phone: 'invalid-stale-value', wechat_nickname: 'old-hidden' } });
      assert.equal(approved.batch.official_status, 'approved');
      assert.ok(!calls.slice(offset).some(row => row.path === '/v1/carriage/courier-contact/set'));
      assert.ok(calls.filter(row => ['/v1/carriage/create', '/v1/carriage/approve'].includes(row.path)).every(row => !Object.hasOwn(row.body, 'handover_type')), 'ERP handover selection is never invented as an official API field');
    });

    await t.test('revocation after contact submission prevents approval and leaves every foreign enterprise unchanged', async () => {
      const batch = await begin(); await createOfficial(batch);
      state.hook = async call => { if (call.path === '/v1/carriage/courier-contact/set') { state.hook = null; await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2'); } };
      const offset = calls.length; await assert.rejects(confirm(batch, { container_count: 2 }), error => Number(error.statusCode || error.status) === 403);
      assert.ok(!calls.slice(offset).some(row => row.path === '/v1/carriage/approve'));
      assert.equal(state.remoteStatus, 'new'); assert.equal(state.count, 0);
      assert.ok((await memberEvidence(batch.batch.id)).every(row => row.dispatched_at === null));
      assert.deepEqual(await foreignEvidence(), foreignBefore);
    });

    await t.test('discovery and saved official snapshots never upgrade local-only or foreign orders to official membership', async () => {
      const batch = await begin(); await createOfficial(batch); await confirm(batch);
      state.discover = true; state.numbers = ['OWN', 'LOCAL-OTHER', 'FOREIGN', 'NOT-SYNCED'];
      const discovered = await service.discover(session(2), { date: '2026-10-23', shop_id: 20 }); assert.equal(discovered.rows[0].batch_id, batch.batch.id);
      const after = await memberEvidence(batch.batch.id); assert.deepEqual(after.map(row => [row.order_id, row.official_member]), [[1, 1], [2, 0]]);
      const offset = calls.length;
      const snapshot = await service.officialDetail(session(2), { source: 'snapshot', id: 901, date: '2026-10-23', shop_id: 20 });
      assert.equal(snapshot.members.find(row => row.posting_number === 'OWN').order_id, 1);
      for (const number of ['LOCAL-OTHER', 'FOREIGN', 'NOT-SYNCED']) assert.equal(snapshot.members.find(row => row.posting_number === number).order_id, null);
      assert.equal(calls.length, offset); assert.deepEqual(await memberEvidence(batch.batch.id), after);
      expectLocalMixed(snapshot);
      assert.ok(!JSON.stringify(snapshot).includes('isolated-secret'));
      assert.deepEqual(await foreignEvidence(), foreignBefore);
    });

    await t.test('live official details return the same authorized mixed local list without asserting official cross-shop support', async () => {
      const batch = await begin(); await createOfficial(batch); state.discover = true;
      const result = await service.officialDetail(session(2), { id: 901, date: '2026-10-23', shop_id: 20 });
      expectLocalMixed(result);
      assert.deepEqual(result.members.map(row => [row.posting_number, row.order_id]), [['OWN', 1]]);
      assert.equal(result.summary.matched_local, 1);
    });

    await t.test('seller_error remains a failed official row with its raw status and never becomes official membership', async () => {
      const batch = await begin(); await createOfficial(batch); state.discover = true; state.remoteStatus = 'formed'; state.count = 3;
      state.numbers = ['OWN', 'LOCAL-OTHER', 'FOREIGN']; state.sellerErrors.OWN = 'OWN_REJECTED'; state.postingStatuses.OWN = 'future_unknown_ozon_status';
      const result = await service.officialDetail(session(2), { id: 901, date: '2026-10-23', shop_id: 20 });
      const failed = result.members.find(row => row.posting_number === 'OWN');
      assert.equal(failed.matched_local, true); assert.equal(failed.official_member, 0);
      assert.equal(failed.seller_error, 'OWN_REJECTED'); assert.equal(failed.official_status, 'future_unknown_ozon_status');
      assert.ok(result.summary.failed_postings.some(row => row.posting_number === 'OWN' && row.seller_error === 'OWN_REJECTED'));
      assert.equal(result.local_members.find(row => row.order_id === 1).official_member, 0);
      assert.ok(!JSON.stringify(result).includes('must-not-return-official-row'));
      const read = await service.action(session(2), { batch_id: batch.batch.id, action: 'official-sync' });
      assert.notEqual(read.batch.official_status, 'approved');
      assert.deepEqual((await memberEvidence(batch.batch.id)).map(row => row.official_member), [0, 0]);
      const offset = calls.length; await assert.rejects(service.file(session(2), batch.batch.id, 'container-labels'), { statusCode: 409 });
      assert.ok(!calls.slice(offset).some(row => row.path.endsWith('get-container-labels')));
    });

    await t.test('failed discovery rows retain their status in saved snapshots and are never imported as official members', async () => {
      const unused = await begin();
      await query('DELETE FROM ogl_dispatch_events WHERE tenant_id=2 AND batch_id=?', [unused.batch.id]);
      await query('DELETE FROM ogl_dispatch_members WHERE tenant_id=2 AND batch_id=?', [unused.batch.id]);
      await query('DELETE FROM ogl_dispatch_batches WHERE tenant_id=2 AND id=?', [unused.batch.id]);
      state.discover = true; state.numbers = ['OWN', 'LOCAL-OTHER', 'FOREIGN']; state.sellerErrors.OWN = 'REJECTED_IMPORT'; state.postingStatuses.OWN = 'future_saved_failure';
      const discovered = await service.discover(session(2), { date: '2026-10-23', shop_id: 20 }); const batchId = discovered.rows[0].batch_id;
      assert.deepEqual(await memberEvidence(batchId), []);
      const offset = calls.length;
      const snapshot = await service.officialDetail(session(2), { source: 'snapshot', id: 901, date: '2026-10-23', shop_id: 20 });
      const failed = snapshot.members.find(row => row.posting_number === 'OWN');
      assert.equal(failed.official_member, 0); assert.equal(failed.seller_error, 'REJECTED_IMPORT'); assert.equal(failed.official_status, 'future_saved_failure');
      assert.ok(snapshot.summary.failed_postings.some(row => row.posting_number === 'OWN' && row.status === 'future_saved_failure'));
      assert.ok(!JSON.stringify(snapshot).includes('must-not-return-official-row')); assert.equal(calls.length, offset);
      await assert.rejects(confirm({ batch: { id: batchId } }, { container_count: 1 }), { statusCode: 409 });
      assert.ok(!calls.slice(offset).some(row => ['/v1/carriage/approve', '/v1/carriage/create', '/v1/carriage/courier-contact/set'].includes(row.path)));
    });

    await t.test('discovery removes stale official proof from failed or removed own postings in an existing local mixed batch', async () => {
      for (const failedPosting of [true, false]) {
        const batch = await begin(); await createOfficial(batch); await confirm(batch); state.discover = true;
        const before = await memberEvidence(batch.batch.id); assert.deepEqual(before.map(row => row.official_member), [1, 0]);
        state.numbers = failedPosting ? ['OWN'] : [];
        if (failedPosting) { state.sellerErrors.OWN = 'LATER_REJECTED'; state.postingStatuses.OWN = 'saved_rejection_status'; }
        const offset = calls.length;
        await service.discover(session(2), { date: '2026-10-23', shop_id: 20 });
        const after = await memberEvidence(batch.batch.id);
        assert.deepEqual(after.map(row => row.official_member), [0, 0], 'Persistent proof must follow current successful official membership, including existing ERP-created batches');
        assert.deepEqual(after.map(row => row.dispatched_at), before.map(row => row.dispatched_at));
        assert.deepEqual(after.map(row => row.dispatched_by), before.map(row => row.dispatched_by));
        assert.equal((await service.detail(session(2), batch.batch.id)).batch.official_status, 'approved', 'Discovery cannot invent or repeat an approval transition');
        const snapshot = await service.officialDetail(session(2), { source: 'snapshot', id: 901, date: '2026-10-23', shop_id: 20 });
        assert.equal(snapshot.summary.local_members_count, 2); assert.equal(snapshot.summary.local_only_count, 2);
        assert.equal(snapshot.local_members.find(row => row.order_id === 1).association_type, 'local_missing_official');
        assert.equal(snapshot.local_members.find(row => row.order_id === 2).association_type, 'local_other_shop');
        if (failedPosting) assert.equal(snapshot.members.find(row => row.posting_number === 'OWN').official_status, 'saved_rejection_status');
        assert.ok(!calls.slice(offset).some(row => ['/v1/carriage/create', '/v1/carriage/approve', '/v1/carriage/courier-contact/set'].includes(row.path)));
        await assert.rejects(service.file(session(2), batch.batch.id, 'container-labels'), { code: 'OGL_FILE_CONFIRMATION_CHANGED' });
      }
    });

    await t.test('poisoned foreign member references are excluded from both live and saved local_members', async () => {
      const batch = await begin(); await createOfficial(batch); await confirm(batch); state.discover = true;
      await service.discover(session(2), { date: '2026-10-23', shop_id: 20 });
      await query("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,shop_id,posting_number,official_member) VALUES(2,?,3,30,'FOREIGN',1)", [batch.batch.id]);
      for (const source of [undefined, 'snapshot']) {
        const result = await service.officialDetail(session(2), { source, id: 901, date: '2026-10-23', shop_id: 20 });
        expectLocalMixed(result);
        assert.ok(!result.local_members.some(row => Number(row.order_id) === 3 || Number(row.shop_id) === 30));
        assert.ok(!result.members.some(row => Number(row.order_id) === 3));
      }
      assert.deepEqual(await foreignEvidence(), foreignBefore);
    });

    await t.test('a discovered pending application can be explicitly confirmed without creating another carriage or recording physical dispatch', async () => {
      const unused = await begin();
      await query('DELETE FROM ogl_dispatch_events WHERE tenant_id=2 AND batch_id=?', [unused.batch.id]);
      await query('DELETE FROM ogl_dispatch_members WHERE tenant_id=2 AND batch_id=?', [unused.batch.id]);
      await query('DELETE FROM ogl_dispatch_batches WHERE tenant_id=2 AND id=?', [unused.batch.id]);
      state.discover = true;
      const imported = await service.discover(session(2), { date: '2026-10-23', shop_id: 20 });
      const batchId = imported.rows[0].batch_id; assert.ok(batchId);
      assert.equal((await service.detail(session(2), batchId)).batch.official_status, 'observed');
      const offset = calls.length;
      const approved = await confirm({ batch: { id: batchId } }, { container_count: 2 });
      assert.equal(approved.batch.official_status, 'approved'); assert.equal(approved.batch.containers_count, 2);
      assert.ok(!calls.slice(offset).some(row => ['/v1/carriage/create', '/v1/carriage/set-postings'].includes(row.path)));
      assert.equal(calls.slice(offset).filter(row => row.path === '/v1/carriage/approve').length, 1);
      assert.ok((await memberEvidence(batchId)).every(row => row.dispatched_at === null));
      assert.equal((await service.file(session(2), batchId, 'container-labels')).buffer.toString(), '%PDF-isolated-mixed');
    });

    await t.test('a discovered pending application cannot use old or client-asserted entrusted capability', async () => {
      const unused = await begin();
      await query('DELETE FROM ogl_dispatch_events WHERE tenant_id=2 AND batch_id=?', [unused.batch.id]);
      await query('DELETE FROM ogl_dispatch_members WHERE tenant_id=2 AND batch_id=?', [unused.batch.id]);
      await query('DELETE FROM ogl_dispatch_batches WHERE tenant_id=2 AND id=?', [unused.batch.id]);
      state.discover = true; state.entrusted = true;
      const imported = await service.discover(session(2), { date: '2026-10-23', shop_id: 20 }); const batchId = imported.rows[0].batch_id;
      state.entrusted = false; const offset = calls.length;
      await assert.rejects(confirm({ batch: { id: batchId } }, { container_count: 2, has_entrusted_acceptance: true }), { statusCode: 409 });
      assert.ok(!calls.slice(offset).some(row => ['/v1/carriage/create', '/v1/carriage/approve', '/v1/carriage/courier-contact/set'].includes(row.path)));
      assert.equal((await service.detail(session(2), batchId)).batch.official_status, 'observed');
      assert.ok((await memberEvidence(batchId)).every(row => row.dispatched_at === null));
      assert.deepEqual(await foreignEvidence(), foreignBefore);
    });
    const observed = async () => {
      await query('DELETE FROM order_marks WHERE order_id IN (1,2)');
      await begin();
      for(const table of ['ogl_dispatch_events','ogl_dispatch_official_locks','ogl_dispatch_members','ogl_dispatch_batches'])await query(`DELETE FROM ${table} WHERE tenant_id=2`);
      await query('DELETE FROM order_marks WHERE order_id IN (1,2)');
      state.discover=true;state.remoteStatus='formed';state.count=2;
      await service.discover(session(2),{date:'2026-10-23',shop_id:20});
      const [batch]=await query('SELECT id FROM ogl_dispatch_batches WHERE tenant_id=2 AND official_carriage_id=901');
      return Number(batch.id);
    };
    await t.test('existing official application accepts same-enterprise system members, survives synchronization and only explicit handover supplies stock evidence',async()=>{
      const batchId=await observed();
      const payload={batch_id:batchId,action:'bind-orders',order_ids:[1,2],client_request_id:'manual-bind-two-orders'};
      const beforeCalls=calls.length;
      await Promise.all([service.action(session(2),payload),service.action(session(2),payload)]);
      const common=await service.action(session(2),{batch_id:batchId,action:'assign-tracking',order_ids:[1,2],tracking_number:'COMMON-001',cargo_type:'normal'});
      assert.ok(common.members.every(row=>row.tracking_assignment.tracking_number==='COMMON-001'));
      await service.action(session(2),{batch_id:batchId,action:'assign-tracking',order_ids:[2],tracking_number:'SPECIAL-002',cargo_type:'special'});
      const assigned=await service.detail(session(2),batchId);
      assert.deepEqual(assigned.members.map(row=>[row.tracking_assignment.tracking_number,row.tracking_assignment.cargo_type]),[['COMMON-001','normal'],['SPECIAL-002','special']]);
      let members=await memberEvidence(batchId);
      assert.deepEqual(members.map(row=>[row.order_id,row.official_member]),[[1,1],[2,0]]);
      assert.ok(members.every(row=>row.dispatched_at===null));
      assert.equal((await query("SELECT COUNT(*) AS n FROM ogl_dispatch_events WHERE tenant_id=2 AND batch_id=? AND action='bind-orders'",[batchId]))[0].n,1);
      assert.ok(calls.slice(beforeCalls).every(row=>!['/v1/carriage/create','/v1/carriage/set-postings','/v1/carriage/approve'].includes(row.path)));
      let proof=await query(`SELECT o.id,${oglPhysicalDispatchSql()} AS consumed FROM orders o WHERE o.id IN (1,2)`);
      assert.ok(proof.every(row=>Number(row.consumed)===0),'binding does not release local physical stock');
      await service.discover(session(2),{date:'2026-10-23',shop_id:20});
      members=await memberEvidence(batchId);assert.equal(members.length,2);assert.ok(members.every(row=>row.active_order_id===undefined&&row.dispatched_at===null));
      const [system]=await query('SELECT active_order_id,withdrawn_at FROM ogl_dispatch_members WHERE tenant_id=2 AND order_id=2');assert.equal(system.active_order_id,2);assert.equal(system.withdrawn_at,null);
      await assert.rejects(service.action(session(2),{batch_id:batchId,action:'dispatch',order_ids:[1,2]}),/接管/);
      await service.action(session(2),{batch_id:batchId,action:'official-adopt',container_count:2});
      await service.action(session(2),{batch_id:batchId,action:'dispatch',order_ids:[1,2]});
      members=await memberEvidence(batchId);assert.ok(members.every(row=>row.dispatched_at));
      await service.action(session(2),{batch_id:batchId,action:'dispatch',order_ids:[1,2]});
      assert.deepEqual(await memberEvidence(batchId),members,'repeated confirmation cannot dispatch twice');
      await assert.rejects(service.action(session(2),{batch_id:batchId,action:'assign-tracking',order_ids:[2],tracking_number:'LATE-003',cargo_type:'normal'}),/不能重新分配/);
      assert.equal((await service.detail(session(2),batchId)).members.find(row=>row.order_id===2).tracking_assignment.tracking_number,'SPECIAL-002');
      proof=await query(`SELECT o.id,${oglPhysicalDispatchSql()} AS consumed FROM orders o WHERE o.id IN (1,2)`);assert.ok(proof.every(row=>Number(row.consumed)===1));
      assert.deepEqual(await foreignEvidence(),foreignBefore);
    });
    await t.test('manual notes require exact current review proof and a later changed note blocks physical handover',async()=>{
      const batchId=await observed();
      await query("INSERT INTO order_marks(order_id,mark_type,note) VALUES(2,'manual_check','warehouse inspected')");
      const payload={batch_id:batchId,action:'bind-orders',order_ids:[2],client_request_id:'review-first-operation'};
      await assert.rejects(service.action(session(2),payload),/复核/);
      let preview=await service.preview(session(2),{order_ids:[2],batch_id:batchId});let signature=preview.eligible[0].review_signature;
      await service.action(session(2),{...payload,reviewed_order_ids:[2],review_signatures:{2:signature},review_note:'人工确认可以发运'});
      await query("UPDATE order_marks SET note='changed: hold delivery' WHERE order_id=2");
      await service.action(session(2),{batch_id:batchId,action:'official-adopt',container_count:2});
      await assert.rejects(service.action(session(2),{batch_id:batchId,action:'dispatch',order_ids:[2]}),/复核/);
      await assert.rejects(service.action(session(2),{...payload,client_request_id:'review-second-operation',reviewed_order_ids:[2],review_signatures:{2:signature},review_note:'old proof'}),/复核/);
      preview=await service.preview(session(2),{order_ids:[2],batch_id:batchId});signature=preview.eligible[0].review_signature;
      await service.action(session(2),{...payload,client_request_id:'review-second-operation',reviewed_order_ids:[2],review_signatures:{2:signature},review_note:'已重新核对'});
      await service.action(session(2),{batch_id:batchId,action:'official-adopt',container_count:2});
      await service.action(session(2),{batch_id:batchId,action:'dispatch',order_ids:[2]});
      assert.equal((await query('SELECT note FROM order_marks WHERE order_id=2'))[0].note,'changed: hold delivery','dispatch does not erase notes');
      assert.ok((await memberEvidence(batchId)).find(row=>row.order_id===2).dispatched_at);
    });
    await t.test('printed-date candidates use Beijing boundaries and owned scopes; binding refuses foreign orders and an unlisted own posting',async()=>{
      const batchId=await observed();
      await query("UPDATE order_label_prints SET printed_at=CASE WHEN order_id=1 THEN '2026-10-22 16:00:00' ELSE '2026-10-23 15:59:59' END WHERE order_id IN (1,2,3)");
      const result=await service.candidates(session(2),{printed_from:'2026-10-23',printed_to:'2026-10-23',batch_id:batchId});
      assert.equal(result.total,2);assert.deepEqual(result.eligible.map(row=>Number(row.id)).sort(),[1,2]);
      assert.equal((await service.candidates(session(2),{printed_from:'2026-10-22',printed_to:'2026-10-22',batch_id:batchId})).total,0);
      await assert.rejects(service.candidates(session(2),{shop_id:30}),/不属于/);
      await assert.rejects(service.action(session(2),{batch_id:batchId,action:'bind-orders',order_ids:[3],client_request_id:'foreign-bind-attempt'}),/不能绑定/);
      await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(4,20,'NOT-IN-OZON','awaiting_deliver','2026-10-23 01:00:00')");
      await query('INSERT INTO order_label_prints(order_id) VALUES(4)');
      await query("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(20,'NOT-IN-OZON','awaiting_deliver',?)",[JSON.stringify({delivery_method:{id:77,name:'OGL pickup'}})]);
      await assert.rejects(service.action(session(2),{batch_id:batchId,action:'bind-orders',order_ids:[4],client_request_id:'unlisted-own-posting'}),/未被 Ozon/);
      assert.equal((await memberEvidence(batchId)).length,1);
      assert.deepEqual(await foreignEvidence(),foreignBefore);
    });
  } finally { await pool.end(); await fixture.cleanup(); }
});
