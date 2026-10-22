import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { inspectReviewedUniqueRepair, applyReviewedUniqueRepair, inspectUniqueRepairJournal, rollbackReviewedUniqueRepair } from './lib/reviewed-unique-index-repair.mjs';

// No application configuration/default credentials are imported. Default audit
// performs SELECT/SHOW only in a READ ONLY transaction. Plans contain IDs/hashes,
// never SKU, customer, PDF or full business-row content.
const args = process.argv.slice(2);
const value = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const database = value('database'), socketPath = value('mysql-admin-socket');
const apply = args.includes('--apply'), rollback = value('rollback'), journal = value('journal');
let db;
try {
  if (!database || !socketPath) throw Object.assign(new Error('Explicit --database and --mysql-admin-socket are required'), { safe: true });
  if ([apply, Boolean(rollback), Boolean(journal)].filter(Boolean).length > 1) throw Object.assign(new Error('Choose only audit, apply, journal or rollback'), { safe: true });
  db = await mysql.createConnection({ socketPath, user: 'root', database, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true });
  await db.query('SET SESSION max_execution_time=10000');
  await db.query("SET SESSION time_zone='+00:00'");
  const [[selected]] = await db.query('SELECT DATABASE() AS db');
  if (selected.db !== database) throw Object.assign(new Error('Explicit selected database mismatch'), { safe: true });
  let result;
  if (rollback) result = await rollbackReviewedUniqueRepair(db, rollback, database, args.includes('--maintenance-confirmed'));
  else if (journal) {
    const state = await inspectUniqueRepairJournal(db, journal);
    result = { repair_id: state.repair_id, phase: state.phase, targets: state.targets.map(({ table, archive, shadow, undone, before, after }) => ({ table, archive, shadow, undone, before, after })), references: state.references.map(({ table, before_digest, after_digest }) => ({ table, before_digest, after_digest })) };
  } else {
    if (!value('plan')) throw Object.assign(new Error('An explicit --plan=/absolute/reviewed-plan.json is required; production duplicates are never discovered by a full-table audit'), { safe: true });
    const plan = JSON.parse(await readFile(value('plan'), 'utf8'));
    if (apply) result = await applyReviewedUniqueRepair(db, plan, database);
    else {
      await db.query('START TRANSACTION READ ONLY');
      try { result = await inspectReviewedUniqueRepair(db, plan); } finally { await db.rollback(); }
    }
  }
  console.log(JSON.stringify({ ok: true, mode: rollback ? 'rollback' : journal ? 'journal' : apply ? 'apply' : 'dry-run', ...result }));
} catch (error) {
  // MySQL duplicate errors can contain private natural-key values. Do not echo
  // SQL/sqlMessage, parameters, row data or untrusted filesystem/JSON contents.
  console.error(JSON.stringify({ ok: false, code: error.code || 'REPAIR_REFUSED', error: error.safe ? error.message : 'Repair failed; keep maintenance mode and inspect the repair journal using its repair_id' }));
  process.exitCode = 1;
} finally { if (db) await db.end(); }
