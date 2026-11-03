import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { loadTenantOrderService } from './helpers/tenant-order-service.js';

const socket = process.env.TENANT_TEST_MYSQL_SOCKET;
test('46-label cached and mixed batches preserve PDF pages and print sequences', { skip: !socket && 'Requires isolated socket-only MySQL', timeout: 180000 }, async t => {
  const fixture = await createTenantMysqlFixture('label_batch');
  const q = fixture.query;
  const pdf = async id => { const doc = await PDFDocument.create(); doc.addPage([100 + id, 150]); return Buffer.from(await doc.save()); };
  const pages = async buffer => (await PDFDocument.load(buffer)).getPages().map(page => page.getWidth() - 100);
  const ids = Array.from({length:46}, (_,i) => 100 + i).reverse();
  const methods = ['activeShopForTenantMysql', 'loadCachedOrderPackageLabelsMysql', 'fetchAndCacheOrderPackageLabelMysql', 'cacheOrderPackageLabelMysql', 'mergePdfBuffersMysql', 'prefetchOrderPackageLabelsMysql'];
  let fetched = [], active = 0, maxActive = 0;
  const {service, calls} = loadTenantOrderService(fixture.connection, {
    extraMethods: methods, PDFDocument,
    isOrderInTransportMysql: () => false, clearOrderPackageLabelPrefetchTimerMysql() {},
    fetchOzonPackageLabel: async (_shop, postings) => {
      const id = Number(postings[0].slice(1)); fetched.push(id); active++; maxActive = Math.max(maxActive, active);
      try { await new Promise(resolve => setTimeout(resolve, id % 3 === 0 ? 50 : 5)); return await pdf(id); }
      finally { active--; }
    }
  });
  try {
    await q('ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL');
    await q("INSERT INTO tenants(id,slug,name) VALUES(2,'labels-a','A'),(3,'labels-b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(2,'Packer','packing')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,2,'member',JSON_ARRAY('packing'),1)");
    await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A','active'),(30,3,'B','active')");
    for (const id of ids) {
      await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,20,?,'awaiting_deliver','2026-11-01')", [id, 'P'+id]);
      const buffer = await pdf(id);
      await q('INSERT INTO order_package_label_cache(order_id,shop_id,posting_number,label_pdf,label_size) VALUES(?,20,?,?,?)', [id,'P'+id,buffer,buffer.length]);
    }
    const options = {session:{personId:2,tenant:{id:2,slug:'labels-a',role:'member'}}};
    await t.test('background prefetch persists PDFs before printing and later reads skip Ozon', async () => {
      await q('DELETE FROM order_package_label_cache WHERE order_id IN (144,143)');
      const result = await service.prefetchOrderPackageLabelsMysql([144,143].map(id => ({id, shop_id:20, posting_number:'P'+id, tenant_id:2, task_session:options.session})));
      assert.equal(result.fetched,2); assert.equal(result.failures.length,0);
      assert.equal((await q('SELECT COUNT(*) n FROM order_package_label_cache'))[0].n,46);
      fetched=[];
    });
    await t.test('all cached PDFs use one bulk cache read and zero Ozon calls', async () => {
      calls.length = 0;
      const result = await service.orderPackageLabelMysql({order_ids:ids},2,'2',options);
      assert.deepEqual(await pages(result.buffer),ids); assert.deepEqual(Array.from(result.printed_ids),ids);
      assert.equal(result.stats.cache_hits,46); assert.equal(result.stats.ozon_requests,0); assert.equal(fetched.length,0);
      assert.equal(calls.filter(x => /SELECT order_id, shop_id, posting_number, label_pdf/.test(x.sql)).length,1);
      assert.ok(calls.length < 50, `cached batch unexpectedly performed ${calls.length} queries`);
      console.log('46 cached labels: '+result.stats.duration_ms+'ms, '+calls.length+' SQL calls, 0 Ozon calls');
    });
    await t.test('mixed hits and out-of-order downloads keep exact PDF order and persist missing labels', async () => {
      await q('DELETE FROM order_package_label_cache WHERE order_id IN (144,143,142,141,140)');
      const result = await service.orderPackageLabelMysql({order_ids:ids},2,'2',options);
      assert.deepEqual(await pages(result.buffer),ids); assert.equal(result.stats.cache_hits,41); assert.equal(fetched.length,5);
      assert.ok(maxActive > 1); assert.ok(maxActive <= 3);
      const cached = await service.orderPackageLabelMysql({order_ids:ids},2,'2',options);
      assert.equal(cached.stats.cache_hits,46); assert.equal(fetched.length,5);
    });
    await t.test('printing saves all sequences in a single statement and reprints update the entire batch', async () => {
      calls.length=0;
      const result = await service.markOrderLabelsPrintedMysql({order_ids:ids},2,'2',options);
      assert.equal(result.count,46);
      assert.equal(calls.filter(x=>/INSERT INTO order_label_prints/.test(x.sql)).length,1);
      const records=await q('SELECT order_id,print_sequence,print_batch_id FROM order_label_prints ORDER BY print_sequence');
      assert.deepEqual(records.map(x=>Number(x.order_id)),ids);
      assert.deepEqual(records.map(x=>Number(x.print_sequence)),ids.map((_,i)=>i+1));
      assert.ok(records.every(x=>x.print_batch_id===result.print_batch_id));
      const retry = await service.markOrderLabelsPrintedMysql({order_ids:[...ids].reverse()},2,'2',options);
      assert.deepEqual((await q('SELECT order_id FROM order_label_prints WHERE print_batch_id=? ORDER BY print_sequence',[retry.print_batch_id])).map(x=>Number(x.order_id)),[...ids].reverse());
    });
    await t.test('download failure blocks the whole batch and never records printing', async () => {
      await q('DELETE FROM order_package_label_cache WHERE order_id IN (144,143)');
      service.fetchOzonPackageLabel=async (_shop, postings) => { if(postings[0]==='P144') throw Error('fixture failure'); return pdf(143); };
      const before=await q('SELECT * FROM order_label_prints ORDER BY order_id');
      await assert.rejects(service.orderPackageLabelMysql({order_ids:ids},2,'2',options),/部分面单生成失败/);
      assert.deepEqual(await q('SELECT * FROM order_label_prints ORDER BY order_id'),before);
    });
    await t.test('explicit partial output keeps successful PDF pages in the requested positions', async () => {
      const result = await service.orderPackageLabelMysql({order_ids:ids,allow_partial:true},2,'2',options);
      const expected=ids.filter(id=>id!==144);
      assert.deepEqual(await pages(result.buffer),expected);
      assert.deepEqual(Array.from(result.printed_ids),expected);
      assert.deepEqual(Array.from(result.failures,item=>item.id),[144]);
    });
    await t.test('revoked permission during a download prevents caching and returning the batch', async () => {
      service.fetchOzonPackageLabel=async () => { await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2'); return pdf(144); };
      try {
        await assert.rejects(service.orderPackageLabelMysql({order_ids:ids},2,'2',options));
        assert.equal((await q('SELECT COUNT(*) n FROM order_package_label_cache WHERE order_id=144'))[0].n,0);
      } finally { await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2'); }
    });
    await t.test('foreign cache, deleted shop and revoked membership cannot use the fast path', async () => {
      await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(300,30,'foreign','awaiting_deliver','2026-11-01')");
      await assert.rejects(service.orderPackageLabelMysql({order_ids:[ids[0],300]},2,'2',options),/不属于/);
      await q("UPDATE shops SET status='deleted' WHERE id=20");
      await assert.rejects(service.orderPackageLabelMysql({order_ids:[145]},2,'2',options),/店铺不存在/);
      await q("UPDATE shops SET status='active' WHERE id=20");
      await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      await assert.rejects(service.orderPackageLabelMysql({order_ids:[145]},2,'2',options));
    });
  } finally { await fixture.cleanup(); }
});
