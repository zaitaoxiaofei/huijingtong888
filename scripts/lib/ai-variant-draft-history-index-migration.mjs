import { createHash } from 'node:crypto';
import {
  AI_VARIANT_SOURCE_COLUMN_SQL,
  AI_VARIANT_SOURCE_INDEX_SQL,
  inspectAiVariantDraftHistorySchema
} from '../../src/services/ai-variant-draft-history-schema.js';

async function inspectMigrationSchema(query) {
  const status = await inspectAiVariantDraftHistorySchema(query);
  if (!status.exists) return status;
  const columns = await query(`SELECT column_name, column_type, extra
    FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'listing_drafts'`);
  const column = name => columns.find(row => (row.column_name || row.COLUMN_NAME) === name);
  for (const name of ['manual_facts_json', 'ai_payload_json']) {
    const definition = column(name);
    if (!definition || !/^(?:json|(?:tiny|medium|long)?text)$/i.test(String(definition.column_type || definition.COLUMN_TYPE))
      || /GENERATED/i.test(String(definition.extra || definition.EXTRA))) {
      throw new Error(`Unexpected source column definition: listing_drafts.${name}; no schema changes were applied`);
    }
  }
  const tenant = column('tenant_id');
  if (!tenant || String(tenant.column_type || tenant.COLUMN_TYPE).toLowerCase() !== 'varchar(80)'
    || /GENERATED/i.test(String(tenant.extra || tenant.EXTRA))) {
    throw new Error('listing_drafts.tenant_id must be an ordinary VARCHAR(80) column; run the listing ownership migration first');
  }
  const [table] = await query(`SELECT engine FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'listing_drafts'`);
  if (String(table?.engine || table?.ENGINE).toUpperCase() !== 'INNODB') {
    throw new Error('listing_drafts must use InnoDB for the online source index migration');
  }
  return status;
}

// Read-only by default. A VIRTUAL column avoids copying historical JSON into a
// new stored field; the secondary index evaluates it once during index creation.
export async function migrateAiVariantDraftHistoryIndex(query, { database, apply = false } = {}) {
  if (!database || !/^[A-Za-z0-9_]+$/.test(database)) throw new Error('An explicit valid database name is required');
  const [selected] = await query('SELECT DATABASE() AS database_name');
  if (selected?.database_name !== database) throw new Error('Selected database differs from the explicitly requested database');
  const lockName = `ai_draft_source_v1:${createHash('sha256').update(database).digest('hex').slice(0, 32)}`;
  let locked = false;
  try {
    if (apply) {
      const [lock] = await query('SELECT GET_LOCK(?, 60) AS acquired', [lockName]);
      if (Number(lock?.acquired) !== 1) throw new Error('AI variant draft history index migration lock unavailable');
      locked = true;
    }
    const before = await inspectMigrationSchema(query);
    if (!apply) return { ok: true, mode: 'dry-run', database, changes_database: false, before };
    const alterations = [];
    if (before.exists) {
      if (before.missing_column) alterations.push(`ADD COLUMN ${AI_VARIANT_SOURCE_COLUMN_SQL}`);
      if (before.missing_index) alterations.push(`ADD ${AI_VARIANT_SOURCE_INDEX_SQL}`);
    }
    // MySQL cannot combine ADD VIRTUAL and its new index with LOCK=NONE.
    // Separate online ALTERs also make an interrupted index build retryable.
    for (const alteration of alterations) {
      await query(`ALTER TABLE listing_drafts ${alteration}, ALGORITHM=INPLACE, LOCK=NONE`);
    }
    const after = await inspectMigrationSchema(query);
    if (!after.ready) throw new Error('AI variant draft history index verification failed');
    return {
      ok: true, mode: 'apply', database, changes_database: alterations.length > 0,
      before, after, data_rows_changed: 0, absent_table_policy: 'created by canonical listing initializer'
    };
  } finally {
    if (locked) await query('SELECT RELEASE_LOCK(?)', [lockName]);
  }
}
