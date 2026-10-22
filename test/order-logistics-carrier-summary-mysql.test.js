import assert from 'node:assert/strict';
import test from 'node:test';
import { orderLogisticsCarrierCandidateSql, orderLogisticsCarrierSummaryRows } from '../src/services/order-logistics-carrier-summary.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('carrier SQL candidates retain complete final classification for escaped paths and polluted raw', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 60000
}, async () => {
  const fixture = await createTenantMysqlFixture('carrier_guard');
  try {
    await fixture.query('CREATE TABLE carrier_raw(id INT PRIMARY KEY, raw_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin)');
    const paths = ['delivery_method.name', 'delivery_method.warehouse', 'delivery_method.tpl_provider',
      'analytics_data.warehouse', 'analytics_data.tpl_provider', 'warehouse_name', 'tpl_provider'];
    const payloads = [];
    for (const path of paths) for (const wrapped of [true, false]) for (const token of ['OGL', 'ogl', 'OgL', 'Google', 'xOGL', '_OGL_', 'GUOO']) {
      const raw = {}, fields = path.split('.');
      let current = raw;
      for (const part of fields.slice(0, -1)) current = current[part] = {};
      current[fields.at(-1)] = token;
      for (const escaped of [false, true]) {
        const json = JSON.stringify(wrapped ? { raw } : raw);
        payloads.push(escaped ? json.replace(/[a-zA-Z]/g, letter => `\\u${letter.charCodeAt(0).toString(16).padStart(4, '0')}`) : json);
      }
    }
    payloads.push(null, 'not JSON OGL', '{"delivery_method":{"name":"\\u004fG\\u004c"}}',
      '{"raw":{},"delivery_method":{"name":"OGL ignored outer"}}',
      '{"delivery_method":{"name":{"customer":"OGL"}}}',
      '{"delivery_method":{"name":"GUOO"},"products":[{"name":"OGL"}],"url":"https://example.test/ogl"}',
      JSON.stringify({ delivery_method: { name: 'GUOO' }, description: 'irrelevant words '.repeat(15000) }));
    for (const [index, json] of payloads.entries()) await fixture.query('INSERT INTO carrier_raw(id,raw_json) VALUES(?,?)', [index + 1, json]);
    const current = orderLogisticsCarrierCandidateSql('ogl');
    const after = await fixture.query(`SELECT raw.id,raw.raw_json FROM carrier_raw raw WHERE ${current} ORDER BY raw.id`);
    const all = await fixture.query('SELECT id,raw_json FROM carrier_raw ORDER BY id');
    assert.deepEqual(orderLogisticsCarrierSummaryRows(after, 'ogl'), orderLogisticsCarrierSummaryRows(all, 'ogl'));
    assert.ok(after.length < all.length);
    assert.equal(orderLogisticsCarrierSummaryRows(after, 'ogl').some(row => row.id === payloads.length - 1), false, 'product or URL text is not carrier evidence');
  } finally { await fixture.cleanup(); }
});
