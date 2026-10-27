import mysql from 'mysql2/promise';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { parseHistoryArguments, captureHistorySource, inspectHistory, prepareHistory, installHistory, inspectHistoryJournal, rollbackHistory } from './lib/reviewed-history-shadow-repair.mjs';

let db;
try {
  const args = parseHistoryArguments(process.argv.slice(2));
  if (args.output) {
    const exists = await access(args.output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) throw Error('Output already exists; use a fresh path before any database action');
    await access(dirname(args.output), constants.W_OK);
  }
  const plan = args.plan ? JSON.parse(await readFile(args.plan, 'utf8')) : null;
  if (plan && plan.source_database !== args.database) throw Error('Manifest and explicit CLI database differ');
  db = await mysql.createConnection({ socketPath: args['mysql-admin-socket'], user: 'root', database: args.database, dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  await db.query("SET time_zone='+00:00'");
  let result = args.capture ? await captureHistorySource(db, args.database, { sourceKind: args['source-kind'], maintenanceConfirmed: args['maintenance-confirmed'] === true })
    : args.rollback ? await rollbackHistory(db, args.rollback, args.database, args['maintenance-confirmed'] === true)
    : args.journal ? await inspectHistoryJournal(db, args.journal, args.database, args.stage === true)
    : args.install ? await installHistory(db, plan)
    : args.prepare ? await prepareHistory(db, plan)
    : await inspectHistory(db, plan);
  if (args.capture && plan) {
    result = { ...plan, ...result };
    for (const field of ['approved_by', 'approved_at', 'approval_metadata', 'production_approval']) delete result[field];
  }
  if (args.output) await writeFile(args.output, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ ok: true, repair_id: result.repair_id, phase: result.phase, production_approved: args.capture ? false : undefined, changes_source: Boolean(args.install || args.rollback) }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.code ? 'SQL/file error details withheld; keep maintenance and inspect the history journal' : error.message, code: error.code || undefined }));
  process.exitCode = 1;
} finally { await db?.end(); }
