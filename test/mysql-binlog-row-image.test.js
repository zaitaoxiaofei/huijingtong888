import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBinlogRowImage } from '../src/services/mysql-binlog-row-image.js';

function connection({ replicas = [], sources = [], format = 'ROW' } = {}) {
  const sql = [];
  return { sql,
    async query(statement) {
      sql.push(statement);
      assert.match(statement, /^SELECT|^SHOW/);
      if (statement.includes('@@server_uuid')) return [[{ server_uuid: 'synthetic-server', version: '8.0.46', log_bin: 1, binlog_format: format, row_image: 'FULL' }]];
      if (statement.includes('persisted_variables')) return [[]];
      if (statement === 'SHOW REPLICAS') return [replicas];
      if (statement === 'SHOW REPLICA STATUS') return [sources];
      throw new Error(statement);
    },
    async execute(statement, params) {
      sql.push(statement);
      assert.match(statement, /^SELECT/);
      assert.deepEqual(params, ['synthetic_db']);
      return [[{ name: 'orders', has_primary_key: 1 }, { name: 'old_backup', has_primary_key: 0 }]];
    }
  };
}
test('binlog audit is strictly read-only, binds its database and reports legacy tables without changing them', async () => {
  const c = connection();
  const result = await auditBinlogRowImage(c, 'synthetic_db');
  assert.equal(result.row_image, 'FULL'); assert.equal(result.target_image, 'NOBLOB');
  assert.deepEqual(result.tables_without_primary_key, ['old_backup']); assert.deepEqual(result.blocked, []);
  assert.equal(result.persisted_image, null);
  await assert.rejects(auditBinlogRowImage(c, 'db; SET GLOBAL x=1'), /database name/);
});
test('a replication topology or different binlog format blocks the proposed configuration review', async () => {
  for (const options of [{ replicas: [{}] }, { sources: [{}] }, { format: 'MIXED' }]) {
    assert.ok((await auditBinlogRowImage(connection(options), 'synthetic_db')).blocked.length);
  }
});
