import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const source = (await fs.readFile(new URL('../deploy/linux/remote-release.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const skip = process.platform === 'win32' && !fsSync.existsSync(bash);
const functionSource = name => {
  const found = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'));
  assert(found, `execute actual ${name} release function`);
  return found[0];
};
const backupGate = source.match(/^if \[\[ "\$run_db_maintenance" == "1"[^\n]*\n  backup_database\nfi/m)?.[0];
const loopStart = source.indexOf('for additive_migration in ');
const loopEnd = source.indexOf('\ndone', loopStart);
const additiveLoop = source.slice(loopStart, loopEnd + 5);
assert(backupGate && loopStart >= 0 && loopEnd > loopStart);

async function fixture(t, options = {}) {
  const { manifest = true, missingSchema = false, stale = '', backupFailure = '', missingHelper = '', applyFailure = false, recoveryFailure = false, malformedRecovery = false, candidateFailure = false, malformedPreflight = false } = options;
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'inventory-numbering-release-'));
  assert.equal(path.dirname(root), temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'staging', 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'shared', 'private-ai-results'), { recursive: true });
  await fs.mkdir(path.join(root, 'previous'), { recursive: true });
  for (const name of ['migrate-inventory-numbering-v2.mjs', 'backup-private-ai-results.mjs', 'prune-release-backups.mjs']) {
    if (name !== missingHelper) await fs.writeFile(path.join(root, 'staging', 'scripts', name), 'isolated fixture; fake node intercepts this command\n');
  }
  await fs.writeFile(path.join(root, 'env'), 'DB_NAME=isolated_inventory_numbering_fixture\n');
  await fs.writeFile(path.join(root, 'reviewed.json'), JSON.stringify({ private_marker: 'PRIVATE_NUMBERING_CONTENT_NOT_FOR_LOGS' }));
  const run = async extra => {
    const script = `
set -Eeuo pipefail
fixture_root="$PWD"
staging_dir="$PWD/staging"
release_dir="$PWD/staging"
shared_root="$PWD/shared"
current_link="$PWD/current"
release_version=numbering-fixture
env_file="$PWD/env"
reviewed_inventory_numbering_manifest=${manifest ? '"$PWD/reviewed.json"' : '""'}
reviewed_inventory_consumables_manifest=""
reviewed_identity_manifest=""
reviewed_ai_material_manifest=""
reviewed_ai_media_retention_manifest=""
material_change_required=ready
run_db_maintenance=0
run_db_init=1
allow_service_interruption=1
release_backup_path=""
primary_changed=0
inventory_numbering_recovery_failed=0
candidate_ready=0
candidate_pid=""
candidate_pid_file="$PWD/candidate.pid"
previous_target="$PWD/previous"
previous_version=old-fixture
rollback_warmup_seconds=1
pending_schema_migrations=${missingSchema ? 'migrate-inventory-numbering-v2.mjs' : '""'}
trace() { printf '%s\\n' "$*" >> "$fixture_root/trace"; }
install() { if [[ "$1" == -d ]]; then mkdir -p "$4"; else cp "$3" "$4"; fi; }
chmod() { :; }
systemctl() { trace "service $*"; }
stop_existing_candidate() { trace stop-candidate; }
wait_for_release() { trace old-ready; }
migration_pending() { [[ "$pending_schema_migrations" == "$1" ]]; }
mysqldump() { trace full-sql-backup; ${backupFailure === 'sql' ? 'return 31;' : "printf '%s\\n' 'isolated fixture SQL';"} }
node() {
  case "$*" in
    *backup-private-ai-results.mjs*)
      trace private-ai-backup
      ${backupFailure === 'private' ? 'return 32' : ':'}
      for arg in "$@"; do if [[ "$arg" == --output=* ]]; then printf fixture > "\${arg#--output=}"; fi; done
      ;;
    *prune-release-backups.mjs*) trace pin-backup ;;
    *migrate-inventory-numbering-v2.mjs*)
      local is_apply=0 manifest_path="" before_path="" recover_path=""
      for arg in "$@"; do
        [[ "$arg" != --apply ]] || is_apply=1
        [[ "$arg" != --manifest=* ]] || manifest_path="\${arg#--manifest=}"
        [[ "$arg" != --backup=* ]] || before_path="\${arg#--backup=}"
        [[ "$arg" != --recover=* ]] || recover_path="\${arg#--recover=}"
      done
      if [[ -n "$recover_path" ]]; then
        [[ -s "$recover_path" ]] || return 36
        trace recover-matching-triggers
        ${recoveryFailure ? 'return 37' : ':'}
        printf '%s\\n' '${malformedRecovery ? '{"ok":false}' : '{"ok":true,"mode":"cutover-recovered","numbering_version":1,"product_numbers_changed":0}'}'
      elif [[ -z "$manifest_path" ]]; then
        if ((is_apply)); then trace schema-apply; : > "$PWD/schema-ready"; else trace schema-read; fi
      elif ((!is_apply)); then
        local phase=online
        [[ ! -f "$fixture_root/preflight-seen" ]] || phase=offline
        : > "$fixture_root/preflight-seen"
        trace "preflight-$phase"
        ${stale ? `[[ "$phase" != '${stale}' ]] || return 33` : ':'}
        printf '%s\\n' '${malformedPreflight ? '{"ok":true,"changes_database":true}' : `{"ok":true,"mode":"dry-run","schema_ready":${missingSchema ? 'false' : 'true'},"numbering_version":1,"changes_database":false,"reviewed_product_count":851,"source_sha256":"${'a'.repeat(64)}"}`}' | ${missingSchema ? 'sed "s/\\\"schema_ready\\\":false/\\\"schema_ready\\\":$( [[ -f \"$PWD/schema-ready\" ]] && echo true || echo false )/"' : 'cat'}
      else
        [[ -s "$release_backup_path" && -s "\${release_backup_path%.sql.gz}.ai-results.jsonl.gz" ]] || return 34
        ${missingSchema ? '[[ -f "$PWD/schema-ready" ]] || return 35' : ':'}
        trace before-image
        printf '%s\\n' '{"fixture":"private before image"}' > "$before_path"
        trace cutover
        ${applyFailure ? 'return 38' : ':'}
        printf '%s\\n' '{"ok":true,"mode":"reviewed-manifest-applied","numbering_version":2}'
      fi
      ;;
    *) command node "$@" ;;
  esac
}
${functionSource('rollback')}
${functionSource('inventory_numbering_preflight')}
${functionSource('backup_database')}
${functionSource('apply_reviewed_inventory_numbering')}
trap rollback ERR
${extra}
`;
    const file = path.join(root, 'fixture.sh');
    await fs.writeFile(file, script, 'utf8');
    return execute(bash, ['--noprofile', '--norc', file.replaceAll('\\', '/')], { cwd: root, env: { ...process.env, BASH_ENV: '' }, timeout: 15000 }).catch(error => {
      throw Object.assign(new Error(`Isolated numbering release fixture failed: ${error.stderr || error.code}`), { code: error.code, stdout: error.stdout, stderr: error.stderr });
    });
  };
  const trace = async () => (await fs.readFile(path.join(root, 'trace'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split(/\r?\n/).filter(Boolean);
  const normal = () => run(`
inventory_numbering_preflight
${backupGate}
${additiveLoop}
apply_reviewed_inventory_numbering
trace candidate-start
${candidateFailure ? 'false' : ':'}
`);
  return { root, run, normal, trace };
}

test('numbering preserves argument nine and ten, requires private maintenance, and cuts over near candidate start', () => {
  assert.match(source, /expected_production_commit="\$\{9:-\}"/);
  assert.match(source, /reviewed_inventory_consumables_manifest="\$\{10:-\}"/);
  assert.match(source, /reviewed_inventory_numbering_manifest="\$\{11:-\}"/);
  assert.match(source, /-L "\$reviewed_inventory_numbering_manifest"/);
  assert.match(source, /chmod 600 "\$reviewed_inventory_numbering_manifest"/);
  assert.match(functionSource('cleanup_material_manifest'), /reviewed_inventory_numbering_manifest/);
  assert.match(backupGate, /reviewed_inventory_numbering_manifest/);
  assert.match(additiveLoop, /migrate-inventory-numbering-v2\.mjs/);
  assert.doesNotMatch(additiveLoop, /--manifest|--writers-stopped/);
  const online = source.indexOf('\ninventory_numbering_preflight\n');
  const backup = source.indexOf('\n  backup_database\n');
  const cutover = source.indexOf('\napply_reviewed_inventory_numbering\n');
  const candidate = source.indexOf('\nstart_candidate\n');
  assert(online > 0 && online < backup && backup < cutover && cutover < candidate);
  assert.equal(source.slice(cutover, candidate).trim(), 'apply_reviewed_inventory_numbering');
});

test('ready schema still forces paired backup/pin before stopping writers and preserves private evidence', { skip }, async t => {
  const f = await fixture(t);
  const { stdout } = await f.normal();
  assert.doesNotMatch(stdout, /PRIVATE_NUMBERING_CONTENT_NOT_FOR_LOGS/);
  assert.deepEqual(await f.trace(), ['preflight-online', 'full-sql-backup', 'private-ai-backup', 'pin-backup', 'stop-candidate', 'service stop ozon-erp', 'preflight-offline', 'before-image', 'cutover', 'candidate-start']);
  const parent = path.join(f.root, 'shared', 'maintenance', 'inventory-numbering');
  const entries = await fs.readdir(parent);
  assert.equal(entries.length, 1);
  for (const name of ['reviewed.manifest.json', 'reviewed.manifest.json.sha256', 'before.json', 'result.json']) await fs.access(path.join(parent, entries[0], name));
});

test('missing numbering schema is installed only after backup and before stopping writers', { skip }, async t => {
  const f = await fixture(t, { missingSchema: true });
  await f.normal();
  const steps = await f.trace();
  assert(steps.indexOf('pin-backup') < steps.indexOf('schema-apply'));
  assert(steps.indexOf('schema-apply') < steps.indexOf('stop-candidate'));
  assert(steps.indexOf('preflight-offline') < steps.indexOf('cutover'));
});

for (const options of [{ stale: 'online' }, { malformedPreflight: true }, { backupFailure: 'sql' }, { backupFailure: 'private' }, { missingHelper: 'backup-private-ai-results.mjs' }, { missingHelper: 'prune-release-backups.mjs' }]) test(`pre-stop refusal preserves running writers: ${JSON.stringify(options)}`, { skip }, async t => {
  const f = await fixture(t, options);
  await assert.rejects(f.normal(), error => /Primary was not changed/.test(error.stderr));
  assert(!(await f.trace()).some(step => step.startsWith('service ') || ['stop-candidate', 'cutover', 'candidate-start'].includes(step)));
});

test('offline stale manifest restores the old service before any trigger/data cutover', { skip }, async t => {
  const f = await fixture(t, { stale: 'offline' });
  await assert.rejects(f.normal(), error => /Rollback restored and ready/.test(error.stderr));
  const steps = await f.trace();
  assert(steps.indexOf('preflight-offline') < steps.indexOf('service restart ozon-erp'));
  assert(!steps.includes('cutover'));
});

test('failed cutover recovers matching triggers before restarting the old writer', { skip }, async t => {
  const f = await fixture(t, { applyFailure: true });
  await assert.rejects(f.normal(), error => /Rollback restored and ready/.test(error.stderr));
  const steps = await f.trace();
  assert(steps.indexOf('cutover') < steps.indexOf('recover-matching-triggers'));
  assert(steps.indexOf('recover-matching-triggers') < steps.indexOf('service restart ozon-erp'));
  assert(!steps.includes('candidate-start'));
});

for (const options of [{ recoveryFailure: true }, { malformedRecovery: true }]) test(`unverified recovery leaves every old writer stopped: ${JSON.stringify(options)}`, { skip }, async t => {
  const f = await fixture(t, { applyFailure: true, ...options });
  await assert.rejects(f.normal(), error => /old writers remain stopped/.test(error.stderr));
  const steps = await f.trace();
  assert(steps.includes('recover-matching-triggers'));
  assert(!steps.includes('service restart ozon-erp'));
  assert(!steps.includes('candidate-start'));
});

test('candidate failure after committed V2 restores code without undoing committed numbers or triggers', { skip }, async t => {
  const f = await fixture(t, { candidateFailure: true });
  await assert.rejects(f.normal(), error => /Rollback restored and ready/.test(error.stderr));
  const steps = await f.trace();
  assert(steps.includes('cutover') && steps.includes('service restart ozon-erp'));
  assert(!steps.includes('recover-matching-triggers'));
});

test('normal no-manifest deployment never stops writers or cuts over numbers', { skip }, async t => {
  const f = await fixture(t, { manifest: false });
  await f.normal();
  assert.deepEqual(await f.trace(), ['candidate-start']);
});

test('normal no-manifest deployment may install additive schema without a number cutover', { skip }, async t => {
  const f = await fixture(t, { manifest: false, missingSchema: true });
  await f.normal();
  assert.deepEqual(await f.trace(), ['full-sql-backup', 'private-ai-backup', 'schema-read', 'schema-apply', 'candidate-start']);
});

test('missing paired backup companion refuses before stopping any writer', { skip }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('release_backup_path="$PWD/sql-only.sql.gz"\nprintf fixture > "$release_backup_path"\napply_reviewed_inventory_numbering'));
  assert.deepEqual(await f.trace(), []);
});

test('maintenance numbering inspection checks script existence and passes the explicit database without apply', { skip }, async t => {
  const hook = source.match(/^if \[\[ -f "\$staging_dir\/scripts\/init-inventory-numbering\.mjs" \]\]; then\n[\s\S]*?^fi\n/m)?.[0];
  assert(hook, 'execute the actual guarded maintenance inspection');
  const f = await fixture(t, { manifest: false });
  const runHook = () => f.run(`node() { trace "$*"; }\n${hook}`);
  await runHook();
  assert.deepEqual(await f.trace(), [], 'older artifacts without this optional script do not invoke it');
  await fs.writeFile(path.join(f.root, 'staging', 'scripts', 'init-inventory-numbering.mjs'), 'isolated fixture; fake node intercepts this command\n');
  await runHook();
  assert.deepEqual(await f.trace(), ['scripts/init-inventory-numbering.mjs --database=isolated_inventory_numbering_fixture --mysql-admin-socket=/var/run/mysqld/mysqld.sock']);
  assert.doesNotMatch(hook, /--apply|--manifest|--writers-stopped/);
});
