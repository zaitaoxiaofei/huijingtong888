import mysql from 'mysql2/promise';
import { readFile, writeFile } from 'node:fs/promises';
import { parseCombinedArguments, inspectCombined, prepareCombined, installCombined, rollbackCombined, inspectCombinedJournal } from './lib/reviewed-combined-shadow-repair.mjs';
const run = async (db, sql, args = []) => (await db.query(sql, args))[0];
const args = parseCombinedArguments(process.argv.slice(2));
let db;
try {
  db = await mysql.createConnection({ socketPath: args['mysql-admin-socket'], user: 'root', database: args.database, dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  await run(db, "SET time_zone='+00:00'");
  const plan = args.plan ? JSON.parse(await readFile(args.plan, 'utf8')) : null;
  if (plan && plan.source_database !== args.database) throw Error('Manifest database differs from explicit CLI database');
  const result = args.rollback ? await rollbackCombined(db, args.rollback, args.database, args['maintenance-confirmed'] === true)
    : args.journal ? await inspectCombinedJournal(db, args.journal, args.database, args.stage === true)
    : args.install === true ? await installCombined(db, plan)
    : args.prepare === true ? await prepareCombined(db, plan)
    : await inspectCombined(db, plan);
  if (args.output) await writeFile(args.output, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: true, repair_id: result.repair_id, phase: result.phase, changes_source: args.install === true || Boolean(args.rollback) }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.code ? 'SQL error details withheld; keep maintenance and inspect journal' : error.message, code: error.code || undefined }));
  process.exitCode = 1;
} finally {
  await db?.end();
}
