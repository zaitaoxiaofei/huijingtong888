import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { ensureProcurementQueryFacts, inspectProcurementQueryFacts, PROCUREMENT_LOCATION_INDEX } from '../src/services/order-procurement-query-facts.js';

test('indexed fulfillment classification preserves legacy fallback, follows transactional writes, and refuses incompatible schema', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 120000
}, async () => {
  const f = await createTenantMysqlFixture('procurement_facts');
  try {
    const vectors = [
      ['{}','LOCAL'],['null','LOCAL'],['{bad json','LOCAL'],
      ['{"fulfillment_schema":"FBP"}','FBP'],['{"fulfillment_schema":"fbo"}','FBP'],
      ['{"raw":{"fulfillment_schema":"OGR"}}','FBP'],
      ['{"fulfillment_schema":"FBS","raw":{"fulfillment_schema":"FBP"}}','LOCAL'],
      ['{"fulfillment_schema":null,"raw":{"fulfillment_schema":"FBP"}}','LOCAL'],
      ['{"fulfillment_schema":"","raw":{"fulfillment_schema":"FBP"}}','LOCAL'],
      ['{"\\u0066ulfillment_schema":"F\\u0042P"}','FBP'],
      ['{"delivery_method":{"warehouse":"Hch-pd 2"},"fulfillment_schema":"FBS"}','FBP'],
      [JSON.stringify({notes:'x'.repeat(100000),raw:{fulfillment_schema:'FBP'}}),'FBP']
    ];
    for (let index=0; index<vectors.length; index++) {
      await f.query('INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json) VALUES(1,?,?)',[`fact-${index}`,vectors[index][0]]);
    }
    const rows = await f.query('SELECT posting_number,query_procurement_location AS location FROM ozon_orders_raw ORDER BY id');
    assert.deepEqual(rows.map(row=>row.location),vectors.map(row=>row[1]));
    const read = async () => (await f.query("SELECT query_procurement_location AS value FROM ozon_orders_raw WHERE posting_number='fact-0'"))[0].value;
    await f.connection.beginTransaction();
    await f.connection.query("UPDATE ozon_orders_raw SET raw_json=? WHERE posting_number='fact-0'",['{"raw":{"fulfillment_schema":"FBP"}}']);
    assert.equal(await read(),'FBP');
    await f.connection.rollback();
    assert.equal(await read(),'LOCAL');
    const [explain] = await f.connection.query(`EXPLAIN FORMAT=JSON SELECT query_procurement_location FROM ozon_orders_raw FORCE INDEX (${PROCUREMENT_LOCATION_INDEX}) WHERE store_id=1 AND posting_number='fact-0'`);
    assert.match(explain[0].EXPLAIN,/"using_index": true/);
    assert.equal((await ensureProcurementQueryFacts(f.connection)).changed,false);
    await f.query(`ALTER TABLE ozon_orders_raw DROP INDEX ${PROCUREMENT_LOCATION_INDEX}`);
    const before = await inspectProcurementQueryFacts(f.connection);
    assert.equal(before.ready,false); assert.equal(before.column_present,true);
    assert.equal((await ensureProcurementQueryFacts(f.connection)).changed,true);
    assert.equal((await inspectProcurementQueryFacts(f.connection)).ready,true);
    await f.query(`ALTER TABLE ozon_orders_raw DROP INDEX ${PROCUREMENT_LOCATION_INDEX}`);
    await f.query(`ALTER TABLE ozon_orders_raw ADD INDEX ${PROCUREMENT_LOCATION_INDEX}(posting_number)`);
    await assert.rejects(ensureProcurementQueryFacts(f.connection),/incompatible definition/);
    assert.equal((await f.query('SELECT COUNT(*) AS n FROM ozon_orders_raw'))[0].n,vectors.length);
  } finally { await f.cleanup(); }
});
