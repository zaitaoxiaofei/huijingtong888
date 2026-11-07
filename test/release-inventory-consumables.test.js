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

const backupGate = () => {
  const found = source.match(/^if \[\[ "\$run_db_maintenance" == "1"[^\n]*\n  backup_database\nfi/m);
  assert(found, 'execute the actual full-backup decision');
  return found[0];
};
const additiveLoop = () => {
  const start = source.indexOf('for additive_migration in ');
  const end = source.indexOf('\ndone', start);
  assert(start >= 0 && end > start, 'execute the actual additive migration loop');
  return source.slice(start, end + '\ndone'.length);
};

async function fixture(t, { manifest = true, missingSchema = false, stale = false, sqlBackupFailure = false, privateBackupFailure = false, missingBackupHelper = '' } = {}) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'inventory-consumables-release-'));
  assert.equal(path.dirname(root), temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'staging', 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'shared', 'private-ai-results'), { recursive: true });
  for (const name of ['migrate-inventory-consumables.mjs', 'backup-private-ai-results.mjs', 'prune-release-backups.mjs']) {
    if (name !== missingBackupHelper) await fs.writeFile(path.join(root, 'staging', 'scripts', name), 'fixture only; intercepted by the fake node command\n');
  }
  await fs.writeFile(path.join(root, 'env'), 'DB_NAME=isolated_consumables_release_fixture\n');
  await fs.writeFile(path.join(root, 'reviewed.json'), JSON.stringify({ reason: 'PRIVATE_CONSUMABLE_CONTENT_NOT_FOR_LOGS', products: [{ product_id: 335 }] }));
  const run = async extra => {
    const script = `
set -Eeuo pipefail
fixture_root="$PWD"
staging_dir="$PWD/staging"
release_dir="$PWD/staging"
shared_root="$PWD/shared"
release_version=consumables-fixture
env_file="$PWD/env"
reviewed_inventory_consumables_manifest=${manifest ? '"$PWD/reviewed.json"' : '""'}
reviewed_identity_manifest=""
reviewed_ai_material_manifest=""
reviewed_ai_media_retention_manifest=""
material_change_required=ready
run_db_maintenance=0
run_db_init=1
release_backup_path=""
primary_changed=0
candidate_ready=0
candidate_pid=""
candidate_pid_file="$PWD/candidate.pid"
previous_target=""
pending_schema_migrations=${missingSchema ? 'migrate-inventory-consumables.mjs' : '""'}
trace() { printf '%s\\n' "$*" >> "$fixture_root/trace"; }
install() { if [[ "$1" == -d ]]; then mkdir -p "$4"; else cp "$3" "$4"; fi; }
chmod() { :; }
systemctl() { trace "FORBIDDEN-SERVICE $*"; return 95; }
stop_existing_candidate() { trace FORBIDDEN-STOP-CANDIDATE; return 96; }
migration_pending() { [[ "$pending_schema_migrations" == "$1" ]]; }
mysqldump() { trace full-sql-backup; ${sqlBackupFailure ? 'return 31;' : "printf '%s\\n' 'isolated fixture SQL';"} }
node() {
  case "$*" in
    *backup-private-ai-results.mjs*)
      trace private-ai-backup
      ${privateBackupFailure ? 'return 32' : ':'}
      for arg in "$@"; do if [[ "$arg" == --output=* ]]; then printf '%s\\n' 'isolated private results' > "\${arg#--output=}"; fi; done
      ;;
    *prune-release-backups.mjs*) trace pin-backup ;;
    *migrate-inventory-consumables.mjs*)
      local is_apply=0 manifest_path="" before_path=""
      for arg in "$@"; do
        [[ "$arg" != --apply ]] || is_apply=1
        [[ "$arg" != --manifest=* ]] || manifest_path="\${arg#--manifest=}"
        [[ "$arg" != --backup=* ]] || before_path="\${arg#--backup=}"
      done
      if [[ -z "$manifest_path" ]]; then
        if ((is_apply)); then trace schema-apply; : > "$PWD/schema-ready"; else trace schema-read; fi
      elif ((!is_apply)); then
        trace reviewed-preflight
        ${stale ? 'return 33' : ':'}
      else
        [[ -s "$release_backup_path" && -s "\${release_backup_path%.sql.gz}.ai-results.jsonl.gz" ]] || return 34
        ${missingSchema ? '[[ -f "$PWD/schema-ready" ]] || return 35' : ':'}
        [[ -f "$manifest_path" && -n "$before_path" ]] || return 36
        trace row-before-image
        printf '%s\\n' '{"fixture":"private before image"}' > "$before_path"
        printf '%s\\n' fixture-sha256 > "$before_path.sha256"
        trace reviewed-flags-apply
      fi
      printf '%s\\n' '{"ok":true,"mode":"fixture"}'
      ;;
    *) command node "$@" ;;
  esac
}
${functionSource('rollback')}
${functionSource('inventory_consumables_preflight')}
${functionSource('backup_database')}
${functionSource('apply_reviewed_inventory_consumables')}
trap rollback ERR
${extra}
`;
    const scriptFile = path.join(root, 'fixture.sh');
    await fs.writeFile(scriptFile, script, 'utf8');
    return execute(bash, ['--noprofile', '--norc', scriptFile.replaceAll('\\', '/')], { cwd: root, env: { ...process.env, BASH_ENV: '' }, timeout: 15000 }).catch(error => {
    // Keep failed-fixture output bounded instead of echoing the whole Bash body.
    throw Object.assign(new Error(`Isolated release fixture failed: ${error.stderr || error.code}`), { code: error.code, stdout: error.stdout, stderr: error.stderr });
    });
  };
  const trace = async () => (await fs.readFile(path.join(root, 'trace'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split(/\r?\n/).filter(Boolean);
  const normal = () => run(`
inventory_consumables_preflight
${backupGate()}
${additiveLoop()}
apply_reviewed_inventory_consumables
trace candidate-may-start
`);
  return { root, run, normal, trace };
}

test('consumables preserve the ninth baseline guard and add an independent private tenth manifest', () => {
  assert.match(source, /expected_production_commit="\$\{9:-\}"/);
  assert.match(source, /reviewed_inventory_consumables_manifest="\$\{10:-\}"/);
  assert.match(source, /! -s "\$reviewed_inventory_consumables_manifest"/);
  assert.match(source, /-L "\$reviewed_inventory_consumables_manifest"/);
  assert.match(source, /chmod 600 "\$reviewed_inventory_consumables_manifest"/);
  assert.match(functionSource('cleanup_material_manifest'), /reviewed_inventory_consumables_manifest/);
  const lock = source.indexOf('flock -n 9');
  const guard = source.indexOf('# Check after taking the shared lock:');
  const preflight = source.indexOf('\ninventory_consumables_preflight\n', source.indexOf('npm ci --omit=dev'));
  const plan = source.indexOf('\nplan_database_changes\n');
  const backup = source.indexOf('\n  backup_database\n');
  const apply = source.indexOf('\napply_reviewed_inventory_consumables\n');
  const candidate = source.indexOf('\nstart_candidate\n');
  assert(lock >= 0 && lock < guard && guard < preflight && preflight < plan && plan < backup && backup < apply && apply < candidate);
  assert.match(backupGate(), /reviewed_inventory_consumables_manifest/);
  assert.match(functionSource('backup_database'), /reviewed_inventory_consumables_manifest/);
  assert.match(functionSource('backup_database'), /--pin-backup="\$backup_path"[^\n]*--lock-fd=9/);
  assert.match(additiveLoop(), /migrate-inventory-consumables\.mjs/);
  assert.doesNotMatch(functionSource('apply_reviewed_inventory_consumables'), /systemctl|stop_existing_candidate|db:init|UPDATE products|DELETE FROM/);
});

test('a reviewed manifest forces full paired backup and pin even with an already-ready schema', { skip }, async t => {
  const f = await fixture(t);
  const { stdout } = await f.normal();
  assert.doesNotMatch(stdout, /PRIVATE_CONSUMABLE_CONTENT_NOT_FOR_LOGS/);
  const steps = await f.trace();
  assert.deepEqual(steps, ['reviewed-preflight', 'full-sql-backup', 'private-ai-backup', 'pin-backup', 'reviewed-preflight', 'row-before-image', 'reviewed-flags-apply', 'candidate-may-start']);
  const maintenance = path.join(f.root, 'shared', 'maintenance', 'inventory-consumables');
  const entries = await fs.readdir(maintenance);
  assert.equal(entries.length, 1);
  const directory = path.join(maintenance, entries[0]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'reviewed.manifest.json'), 'utf8')), { reason: 'PRIVATE_CONSUMABLE_CONTENT_NOT_FOR_LOGS', products: [{ product_id: 335 }] });
  await fs.access(path.join(directory, 'products.before.json'));
  await fs.access(path.join(directory, 'products.before.json.sha256'));
  await fs.access(path.join(directory, 'result.json'));
});

test('a missing consumable column is backed up and applied before reviewed flags and candidate start', { skip }, async t => {
  const f = await fixture(t, { missingSchema: true });
  await f.normal();
  const steps = await f.trace();
  assert(steps.indexOf('private-ai-backup') < steps.indexOf('schema-apply'));
  assert(steps.indexOf('pin-backup') < steps.indexOf('schema-apply'));
  assert(steps.indexOf('schema-read') < steps.indexOf('schema-apply'));
  assert(steps.indexOf('schema-apply') < steps.indexOf('reviewed-flags-apply'));
  assert.equal(steps.at(-1), 'candidate-may-start');
  assert(!steps.some(step => step.startsWith('FORBIDDEN')));
});

test('stale reviewed data refuses before backup, schema, flags or service operations', { skip }, async t => {
  const f = await fixture(t, { missingSchema: true, stale: true });
  await assert.rejects(f.normal(), error => /Primary was not changed/.test(error.stderr));
  assert.deepEqual(await f.trace(), ['reviewed-preflight']);
});

for (const failure of ['sqlBackupFailure', 'privateBackupFailure']) test(`${failure} prevents every consumable database write and leaves the primary running`, { skip }, async t => {
  const f = await fixture(t, { missingSchema: true, [failure]: true });
  await assert.rejects(f.normal(), error => /Primary was not changed/.test(error.stderr));
  const steps = await f.trace();
  assert(steps.includes('full-sql-backup'));
  assert(!steps.some(step => ['pin-backup', 'schema-apply', 'row-before-image', 'reviewed-flags-apply', 'candidate-may-start'].includes(step) || step.startsWith('FORBIDDEN')));
});

for (const helper of ['backup-private-ai-results.mjs', 'prune-release-backups.mjs']) test(`a missing ${helper} refuses before SQL backup or schema/flag writes`, { skip }, async t => {
  const f = await fixture(t, { missingSchema: true, missingBackupHelper: helper });
  await assert.rejects(f.normal(), error => /Primary was not changed/.test(error.stderr));
  assert.deepEqual(await f.trace(), ['reviewed-preflight']);
});

test('a missing private AI backup companion refuses reviewed apply before its first flag write', { skip }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('release_backup_path="$PWD/sql-only.sql.gz"\nprintf fixture > "$release_backup_path"\napply_reviewed_inventory_consumables'));
  assert(!(await f.trace()).includes('reviewed-flags-apply'));
});

test('normal no-manifest release performs no classification or needless full backup', { skip }, async t => {
  const f = await fixture(t, { manifest: false });
  await f.normal();
  assert.deepEqual(await f.trace(), ['candidate-may-start']);
});

test('normal no-manifest release can install only the additive column without classifying any product', { skip }, async t => {
  const f = await fixture(t, { manifest: false, missingSchema: true });
  await f.normal();
  assert.deepEqual(await f.trace(), ['full-sql-backup', 'private-ai-backup', 'schema-read', 'schema-apply', 'candidate-may-start']);
});
