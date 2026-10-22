import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { migrateAiVariantDraftHistoryIndex } from '../scripts/lib/ai-variant-draft-history-index-migration.mjs';
import {
  AI_VARIANT_SOURCE_COLUMN_SQL,
  AI_VARIANT_SOURCE_EXPRESSION,
  AI_VARIANT_SOURCE_INDEX,
  inspectAiVariantDraftHistorySchema
} from '../src/services/ai-variant-draft-history-schema.js';

const runFile = promisify(execFile);
const script = 'scripts/migrate-ai-variant-draft-history-index.mjs';

test('source index CLI refuses apply without explicit database and administrator socket', async () => {
  for (const args of [['--apply'], ['--apply', '--database=fixture_only']]) {
    await assert.rejects(runFile(process.execPath, [script, ...args], { cwd: new URL('..', import.meta.url), windowsHide: true }), error => {
      assert.match(error.stderr, /Explicit --database|Apply requires explicit --mysql-admin-socket/);
      return true;
    });
  }
});

test('both ECS clients use the common pre-activation source index dry-run and apply migration', async () => {
  const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const remote = await read('deploy/linux/remote-release.sh');
  const required = remote.slice(remote.indexOf('# Case target history requires'), remote.indexOf('# This additive schema is required'));
  assert.match(required, /node scripts\/migrate-ai-variant-draft-history-index\.mjs --database="\$DB_NAME" --mysql-admin-socket=/);
  assert.match(required, /node scripts\/migrate-ai-variant-draft-history-index\.mjs --apply --database="\$DB_NAME" --mysql-admin-socket=/);
  assert.ok(remote.indexOf('# Case target history requires') > remote.indexOf('echo "Skipping database maintenance'));
  assert.match(remote, /if \[\[.*\|\| -f "\$staging_dir\/scripts\/migrate-ai-variant-draft-history-index\.mjs" \]\]; then\s+backup_database/);
  for (const client of ['deploy/linux/deploy-ecs.ps1', 'deploy/linux/deploy-ecs.sh']) {
    assert.match(await read(client), /remote-release\.sh/);
  }
  assert.ok(remote.indexOf('migrate-ai-variant-draft-history-index.mjs') < remote.indexOf('ln -sfn "$release_dir" "$current_link"'));
});

test('real legacy JSON draft index migration is lossless, online, repeatable and rejects schema drift', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async t => {
  const database = `ozon_ai_source_test_${randomBytes(8).toString('hex')}`;
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: 'root' });
  let created = false;
  const q = async (sql, params = []) => (await connection.query(sql, params))[0];
  const migrate = options => migrateAiVariantDraftHistoryIndex(q, { database, ...options });
  const lockName = `ai_draft_source_v1:${createHash('sha256').update(database).digest('hex').slice(0, 32)}`;
  const runMigration = async apply => {
    const { stdout } = await runFile(process.execPath, [script, `--database=${database}`, `--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`, ...(apply ? ['--apply'] : [])], {
      cwd: new URL('..', import.meta.url), windowsHide: true
    });
    return JSON.parse(stdout.trim());
  };
  try {
    const [guard] = await q('SELECT @@skip_networking AS networking_disabled');
    assert.equal(Number(guard.networking_disabled), 1, 'Only the owned socket-only fixture server is permitted');
    await q(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await connection.changeUser({ database });
    await t.test('an absent table is left to the canonical initializer without creating unrelated business schema', async () => {
      assert.equal((await runMigration(false)).before.exists, false);
      const applied = await runMigration(true);
      assert.equal(applied.changes_database, false);
      assert.equal(applied.after.ready, true);
      assert.deepEqual(await q('SHOW TABLES'), []);
    });
    await q(`CREATE TABLE listing_drafts (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(80) NULL,
      product_name VARCHAR(255) NOT NULL, manual_facts_json LONGTEXT NULL,
      ai_payload_json LONGTEXT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const raw = [
      ['admin', 'nested wins', JSON.stringify({ user_facts: { source_product_id: 'P4' }, source_product_id: 'other' }), JSON.stringify({ manual_facts: { source_product_id: 'fallback' } })],
      ['2', 'root fallback', JSON.stringify({ user_facts: { source_product_id: '' }, source_product_id: 'P4' }), '{}'],
      ['3', 'AI fallback', '{}', JSON.stringify({ manual_facts: { source_product_id: 'P4' } })],
      [null, 'invalid historical JSON', 'not valid JSON', 'broken'],
      ['2', 'long source', JSON.stringify({ source_product_id: 'x'.repeat(129) }), '{}'],
      ['2', 'empty fields', null, null],
      ['2', 'unicode source', JSON.stringify({ source_product_id: '车型 / P4' }), '{}']
    ];
    await q('INSERT INTO listing_drafts(tenant_id,product_name,manual_facts_json,ai_payload_json) VALUES ?', [raw]);
    const oldFields = 'id,tenant_id,product_name,manual_facts_json,ai_payload_json,created_at,updated_at';
    const original = await q(`SELECT ${oldFields} FROM listing_drafts ORDER BY id`);
    await t.test('the real release CLI dry-run does not add fields or alter any historical value', async () => {
      const beforeDdl = await q('SHOW CREATE TABLE listing_drafts');
      const plan = await runMigration(false);
      assert.equal(plan.mode, 'dry-run');
      assert.equal(plan.changes_database, false);
      assert.equal(plan.before.ready, false);
      assert.equal(plan.before.missing_column, true);
      assert.equal(plan.before.missing_index, true);
      assert.deepEqual(await q('SHOW CREATE TABLE listing_drafts'), beforeDdl);
      assert.deepEqual(await q(`SELECT ${oldFields} FROM listing_drafts ORDER BY id`), original);
    });
    await t.test('noncopying online ALTERs build the virtual index without changing rows or timestamps', async () => {
      const applied = await runMigration(true);
      assert.equal(applied.changes_database, true);
      assert.equal(applied.data_rows_changed, 0);
      assert.equal(applied.after.ready, true);
      assert.deepEqual(await q(`SELECT ${oldFields} FROM listing_drafts ORDER BY id`), original);
      const values = await q('SELECT ai_variant_source_key FROM listing_drafts ORDER BY id');
      assert.deepEqual(values.map(row => row.ai_variant_source_key), ['P4', 'P4', 'P4', null, null, null, '车型 / P4']);
      const [column] = await q("SHOW COLUMNS FROM listing_drafts LIKE 'ai_variant_source_key'");
      assert.match(column.Extra, /VIRTUAL GENERATED/);
    });
    await t.test('repeat application is a no-op and legacy inserts and updates keep the indexed key in sync', async () => {
      const beforeDdl = await q('SHOW CREATE TABLE listing_drafts');
      assert.equal((await runMigration(true)).changes_database, false);
      assert.deepEqual(await q('SHOW CREATE TABLE listing_drafts'), beforeDdl);
      await q('INSERT INTO listing_drafts(tenant_id,product_name,manual_facts_json,ai_payload_json) VALUES(?,?,?,?)', ['2', 'old writer', '{"source_product_id":"OLD"}', '{}']);
      await q('UPDATE listing_drafts SET manual_facts_json=? WHERE product_name=?', ['{"source_product_id":"NEW"}', 'old writer']);
      assert.equal((await q('SELECT ai_variant_source_key FROM listing_drafts WHERE product_name=?', ['old writer']))[0].ai_variant_source_key, 'NEW');
    });
    await t.test('tenant plus source queries use the secondary index without scanning unrelated JSON', async () => {
      const filler = Array.from({ length: 1200 }, (_, id) => ['3', `other ${id}`, JSON.stringify({ source_product_id: `unrelated-${id}`, content: 'x'.repeat(300) }), '{}']);
      await q('INSERT INTO listing_drafts(tenant_id,product_name,manual_facts_json,ai_payload_json) VALUES ?', [filler]);
      const [plan] = await q('EXPLAIN SELECT id FROM listing_drafts WHERE tenant_id=? AND ai_variant_source_key IN (?)', ['2', 'P4']);
      assert.equal(plan.key, AI_VARIANT_SOURCE_INDEX);
      assert.ok(Number(plan.rows) < 10);
      assert.deepEqual((await q('SELECT id FROM listing_drafts WHERE tenant_id=? AND ai_variant_source_key IN (?)', ['2', 'P4'])).map(row => Number(row.id)), [2]);
    });
    await t.test('an already valid generated column can receive only its missing index', async () => {
      await q(`ALTER TABLE listing_drafts DROP INDEX ${AI_VARIANT_SOURCE_INDEX}`);
      const result = await migrate({ apply: true });
      assert.equal(result.before.missing_column, false);
      assert.equal(result.before.missing_index, true);
      assert.equal(result.after.ready, true);
    });
    await t.test('an interrupted second ALTER releases the lock and resumes without rewriting historical data', async () => {
      await q(`ALTER TABLE listing_drafts DROP INDEX ${AI_VARIANT_SOURCE_INDEX}, DROP COLUMN ai_variant_source_key`);
      const before = await q(`SELECT ${oldFields} FROM listing_drafts ORDER BY id`);
      const failIndex = async (sql, params = []) => {
        if (sql.startsWith(`ALTER TABLE listing_drafts ADD KEY ${AI_VARIANT_SOURCE_INDEX}`)) throw new Error('Fixture interrupted index build');
        return q(sql, params);
      };
      await assert.rejects(migrateAiVariantDraftHistoryIndex(failIndex, { database, apply: true }), /Fixture interrupted index build/);
      const partial = await inspectAiVariantDraftHistorySchema(q);
      assert.equal(partial.missing_column, false);
      assert.equal(partial.missing_index, true);
      assert.equal(Number((await q('SELECT IS_FREE_LOCK(?) AS free', [lockName]))[0].free), 1);
      assert.deepEqual(await q(`SELECT ${oldFields} FROM listing_drafts ORDER BY id`), before);
      assert.equal((await migrate({ apply: true })).after.ready, true);
      assert.deepEqual(await q(`SELECT ${oldFields} FROM listing_drafts ORDER BY id`), before);
    });
    await t.test('an invisible same-name index is rejected without schema or row changes', async () => {
      await q(`ALTER TABLE listing_drafts ALTER INDEX ${AI_VARIANT_SOURCE_INDEX} INVISIBLE`);
      try {
        const beforeDdl = await q('SHOW CREATE TABLE listing_drafts');
        const before = await q(`SELECT ${oldFields} FROM listing_drafts ORDER BY id`);
        await assert.rejects(migrate({ apply: true }), /Unexpected index definition/);
        assert.deepEqual(await q('SHOW CREATE TABLE listing_drafts'), beforeDdl);
        assert.deepEqual(await q(`SELECT ${oldFields} FROM listing_drafts ORDER BY id`), before);
        assert.equal(Number((await q('SELECT IS_FREE_LOCK(?) AS free', [lockName]))[0].free), 1);
      } finally { await q(`ALTER TABLE listing_drafts ALTER INDEX ${AI_VARIANT_SOURCE_INDEX} VISIBLE`); }
    });
    await t.test('index shape, uniqueness and prefixes must match exactly and refusal releases the advisory lock', async () => {
      for (const wrong of [
        `KEY ${AI_VARIANT_SOURCE_INDEX}(ai_variant_source_key,tenant_id)`,
        `UNIQUE KEY ${AI_VARIANT_SOURCE_INDEX}(tenant_id,ai_variant_source_key)`,
        `KEY ${AI_VARIANT_SOURCE_INDEX}(tenant_id,ai_variant_source_key(16))`
      ]) {
        await q(`ALTER TABLE listing_drafts DROP INDEX ${AI_VARIANT_SOURCE_INDEX}, ADD ${wrong}`);
        const beforeDdl = await q('SHOW CREATE TABLE listing_drafts');
        await assert.rejects(migrate({ apply: true }), /Unexpected index definition/);
        assert.deepEqual(await q('SHOW CREATE TABLE listing_drafts'), beforeDdl);
        assert.equal(Number((await q('SELECT IS_FREE_LOCK(?) AS free', [lockName]))[0].free), 1);
      }
      await q(`ALTER TABLE listing_drafts DROP INDEX ${AI_VARIANT_SOURCE_INDEX}`);
      await migrate({ apply: true });
    });
    await t.test('stored, changed-expression and wrong-type source columns are never silently overwritten', async () => {
      for (const definition of [
        `ai_variant_source_key VARCHAR(128) GENERATED ALWAYS AS (${AI_VARIANT_SOURCE_EXPRESSION}) STORED`,
        "ai_variant_source_key VARCHAR(128) GENERATED ALWAYS AS ('unreviewed') VIRTUAL",
        'ai_variant_source_key VARCHAR(64) NULL'
      ]) {
        await q(`ALTER TABLE listing_drafts DROP INDEX ${AI_VARIANT_SOURCE_INDEX}, DROP COLUMN ai_variant_source_key, ADD COLUMN ${definition}`);
        const beforeDdl = await q('SHOW CREATE TABLE listing_drafts');
        await assert.rejects(migrate({ apply: true }), /Unexpected generated column definition/);
        assert.deepEqual(await q('SHOW CREATE TABLE listing_drafts'), beforeDdl);
        await q(`ALTER TABLE listing_drafts DROP COLUMN ai_variant_source_key, ADD COLUMN ${AI_VARIANT_SOURCE_COLUMN_SQL}`);
        await migrate({ apply: true });
      }
    });
    await t.test('missing source inputs or wrong tenant type fail before any DDL and the explicit database cannot drift', async () => {
      await assert.rejects(migrateAiVariantDraftHistoryIndex(q, { database: `${database}_other`, apply: true }), /Selected database differs/);
      await q('ALTER TABLE listing_drafts MODIFY COLUMN tenant_id VARCHAR(64) NULL');
      const beforeDdl = await q('SHOW CREATE TABLE listing_drafts');
      await assert.rejects(migrate({ apply: true }), /ordinary VARCHAR\(80\)/);
      assert.deepEqual(await q('SHOW CREATE TABLE listing_drafts'), beforeDdl);
      await q('ALTER TABLE listing_drafts MODIFY COLUMN tenant_id VARCHAR(80) NULL');
      await q(`ALTER TABLE listing_drafts DROP INDEX ${AI_VARIANT_SOURCE_INDEX}, DROP COLUMN ai_variant_source_key, DROP COLUMN ai_payload_json`);
      await assert.rejects(migrate({ apply: true }), /Unexpected source column definition.*ai_payload_json/);
      assert.equal((await inspectAiVariantDraftHistorySchema(q)).missing_column, true);
    });
  } finally {
    try { if (created) await q(`DROP DATABASE IF EXISTS \`${database}\``); }
    finally { await connection.end(); }
  }
});
