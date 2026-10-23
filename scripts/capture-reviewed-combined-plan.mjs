import mysql from 'mysql2/promise';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureReviewedCombinedPlan, captureReviewedRowProof, parseCaptureArguments } from './lib/capture-reviewed-combined-plan.mjs';
let db, monitor;
try {
  const args = parseCaptureArguments(process.argv.slice(2));
  const paths = [args.plan, args.baseline, args.output, args.report].filter(Boolean).map(value => path.resolve(value));
  if (new Set(paths).size !== paths.length) throw Error('Input proof/plan and fresh output/report paths must be distinct');
  for (const output of [args.output, args.report].filter(Boolean)) {
    try { await access(output); throw Error('Capture output/report already exists; choose fresh paths'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const plan = JSON.parse(await readFile(args.plan, 'utf8'));
  db = await mysql.createConnection({ socketPath: args['mysql-admin-socket'], user: 'root', database: args.database, dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  await db.query("SET time_zone='+00:00'");
  if (args.mode === 'baseline') {
    const [[server]] = await db.query('SELECT @@skip_networking disabled');
    if (Number(server.disabled) !== 1) throw Error('Baseline must be captured from a reviewed isolated backup, never live data');
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try { const proof = await captureReviewedRowProof(db, plan); await writeFile(args.output, JSON.stringify(proof, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); console.log(JSON.stringify({ ok: true, changes_source: false, scope_sha256: proof.scope_sha256, proof_tables: proof.tables.length })); } finally { await db.rollback(); }
  } else {
    const started = Date.now(); let peakRss = process.memoryUsage().rss;
    monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100); monitor.unref();
    const baseline = JSON.parse(await readFile(args.baseline, 'utf8'));
    const result = await captureReviewedCombinedPlan(db, plan, baseline, { database: args.database, source_kind: args['source-kind'], maintenance_confirmed: args['maintenance-confirmed'] });
    result.report.capture_elapsed_seconds = Math.round((Date.now() - started) / 1000);
    result.report.peak_rss_bytes = Math.max(peakRss, process.memoryUsage().rss);
    await writeFile(args.report, JSON.stringify(result.report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    if (result.candidate) await writeFile(args.output, JSON.stringify(result.candidate, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ ok: result.report.ok, changes_source: false, production_approved: false, root_review_required: true, issue_count: result.report.issues.length }));
    if (!result.report.ok) process.exitCode = 1;
  }
} catch (error) { console.error(JSON.stringify({ ok: false, code: error.code, error: error.code ? 'Read-only capture SQL failure; protected source values withheld' : error.message, changes_source: false })); process.exitCode = 1; } finally { clearInterval(monitor); await db?.end(); }
