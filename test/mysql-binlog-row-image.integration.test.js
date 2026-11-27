import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { auditBinlogRowImage } from '../src/services/mysql-binlog-row-image.js';
import { saveOrderPostingLogistics } from '../src/services/mysql-order-posting-logistics.js';

function run(binary, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const stdout = [], stderr = [];
    child.stdout.on('data', value => stdout.push(value));
    child.stderr.on('data', value => stderr.push(value));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(stdout).toString('utf8'))
      : reject(new Error(`${path.basename(binary)} exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`)));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}

test('NOBLOB preserves observations and exact baseline/binlog recovery while reducing unchanged TEXT logging', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL and native client tools', timeout: 120000
}, async () => {
  const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
  const c = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: false });
  const suffix = randomBytes(6).toString('hex');
  const database = `ozon_binlog_test_${suffix}`, restored = `${database}_restore`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-binlog-replay-'));
  const toolDirectory = process.env.COST_TEST_MYSQL_BIN || '';
  const binary = name => path.join(toolDirectory, name + (process.platform === 'win32' ? '.exe' : ''));
  const cli = process.platform === 'win32' ? ['--no-defaults', '--protocol=PIPE', `--socket=${socketPath.replace(/^\\\\\.\\pipe\\/, '')}`, '-uroot']
    : ['--no-defaults', '--protocol=SOCKET', `--socket=${socketPath}`, '-uroot'];
  try {
    const [[safe]] = await c.query('SELECT @@skip_networking disabled');
    assert.equal(Number(safe.disabled), 1, 'never changes a network-enabled server');
    await c.query(`CREATE DATABASE \`${database}\``);
    await c.query(`CREATE DATABASE \`${restored}\``);
    await c.changeUser({ database });
    await c.query('CREATE TABLE ozon_orders_raw (store_id BIGINT NOT NULL, posting_number VARCHAR(128) NOT NULL, order_id VARCHAR(128), status VARCHAR(64), substatus VARCHAR(64), raw_json LONGTEXT, fetched_at DATETIME NOT NULL, PRIMARY KEY(store_id,posting_number))');
    await c.query('CREATE TABLE legacy_backup (label VARCHAR(32), body LONGTEXT)');
    await c.query("INSERT INTO legacy_backup VALUES('same','duplicate'),('same','duplicate'),('untouched',NULL)");
    const posting = { posting_number: 'P1', order_id: 'O1', status: 'delivering', raw: { text: 'x'.repeat(100000), nested: { keep: true } } };
    const transaction = async operation => {
      await c.beginTransaction();
      try { const value = await operation(c); await c.commit(); return value; }
      catch (error) { await c.rollback(); throw error; }
    };
    const save = value => saveOrderPostingLogistics({ transaction, shopId: 7, posting: value, serialize: JSON.stringify });
    await save(posting);
    const baseline = await run(binary('mysqldump'), [...cli, '--single-transaction', '--set-gtid-purged=OFF', '--no-tablespaces', '--skip-comments', database]);
    await run(binary('mysql'), [...cli, restored], baseline);
    const position = async () => (await c.query('SHOW BINARY LOG STATUS'))[0][0];
    const before = await position();
    const bytes = {};
    for (const image of ['FULL', 'NOBLOB']) {
      await c.query(`SET SESSION binlog_row_image = '${image}'`);
      await c.query("UPDATE ozon_orders_raw SET fetched_at='2000-01-01 00:00:00'");
      const start = await position();
      await save(posting);
      bytes[image] = (await position()).Position - start.Position;
      const [[row]] = await c.query('SELECT raw_json,fetched_at FROM ozon_orders_raw');
      assert.equal(JSON.parse(row.raw_json).raw.text, posting.raw.text);
      assert.ok(new Date(row.fetched_at).getUTCFullYear() >= 2026);
    }
    assert.ok(bytes.NOBLOB > 0 && bytes.NOBLOB < bytes.FULL / 100, JSON.stringify(bytes));
    await save({ ...posting, status: 'delivered', raw: { text: 'changed', nested: { keep: false } } });
    await c.query("UPDATE ozon_orders_raw SET posting_number='P2', raw_json=NULL WHERE posting_number='P1'");
    await c.query("INSERT INTO ozon_orders_raw VALUES(8,'P2','O2','new','',NULL,NOW())");
    await c.query("DELETE FROM ozon_orders_raw WHERE store_id=8");
    await c.query("UPDATE legacy_backup SET body='updated' WHERE label='same'");
    await c.query("DELETE FROM legacy_backup WHERE label='same' LIMIT 1");
    const end = await position();
    assert.equal(before.File, end.File, 'test slice must stay in one binlog');
    const [[server]] = await c.query('SELECT @@datadir data_directory,@@version version');
    await c.query('FLUSH BINARY LOGS');
    const replay = await run(binary('mysqlbinlog'), ['--no-defaults', `--start-position=${before.Position}`, `--stop-position=${end.Position}`,
      `--rewrite-db=${database}->${restored}`, path.join(server.data_directory, before.File)]);
    await fs.writeFile(path.join(directory, 'baseline.sql'), baseline, { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'replay.sql'), replay, { mode: 0o600 });
    await run(binary('mysql'), [...cli, restored], replay);
    const [expected] = await c.query(`SELECT * FROM \`${database}\`.ozon_orders_raw ORDER BY store_id,posting_number`);
    const [actual] = await c.query(`SELECT * FROM \`${restored}\`.ozon_orders_raw ORDER BY store_id,posting_number`);
    assert.deepEqual(actual, expected);
    const [backupExpected] = await c.query(`SELECT * FROM \`${database}\`.legacy_backup ORDER BY label,body`);
    const [backupActual] = await c.query(`SELECT * FROM \`${restored}\`.legacy_backup ORDER BY label,body`);
    assert.deepEqual(backupActual, backupExpected);
    const manifest = await auditBinlogRowImage(c, database);
    assert.equal(manifest.row_image, 'FULL');
    assert.deepEqual(manifest.blocked, []);
    assert.deepEqual(manifest.tables_without_primary_key, ['legacy_backup']);
    const report = { format: 'ozon-binlog-replay-v1', ok: true, row_image: 'NOBLOB', restored_identically: true,
      mysql_version: server.version, measured_binlog_bytes: bytes, cases: ['unchanged-observation', 'changed-TEXT', 'primary-key-change', 'NULL', 'insert', 'delete', 'duplicate-rows-without-primary-key'], artifacts: directory };
    if (process.env.COST_BINLOG_REPLAY_REPORT) await fs.writeFile(process.env.COST_BINLOG_REPLAY_REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  } finally {
    await c.query(`DROP DATABASE IF EXISTS \`${restored}\``);
    await c.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await c.end();
  }
});
