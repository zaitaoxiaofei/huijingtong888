import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const source = (await fs.readFile(new URL("../deploy/linux/remote-release.sh", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe") : "bash";
const skip = process.platform === "win32" && !fsSync.existsSync(bash);
const functionSource = name => {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "m"));
  assert.ok(match, `execute the actual ${name} release function`);
  return match[0];
};

async function fixture(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-release-availability-"));
  try {
    await fs.mkdir(path.join(directory, "previous"));
    await fs.writeFile(path.join(directory, "env"), "DB_NAME=isolated_release_fixture\n");
    const run = script => execute(bash, ["--noprofile", "--norc", "-c", `
set -Eeuo pipefail
release_dir="$PWD"
previous_target="$PWD/previous"
previous_version=old-release
current_link="$PWD/current"
env_file="$PWD/env"
candidate_log="$PWD/candidate.log"
candidate_pid_file="$PWD/candidate.pid"
candidate_pid=""
candidate_port=8788
release_version=new-release
candidate_ready=0
primary_changed=0
candidate_warmup_seconds=360
rollback_warmup_seconds=360
trace() { printf '%s\\n' "$*" >> "$PWD/trace"; }
kill() { if [[ "$1" != -0 ]]; then trace "kill $*"; fi; }
systemctl() { trace "$*"; }
stop_existing_candidate() { trace stop-existing-candidate; }
runuser() { printf '424242' > "$candidate_pid_file"; trace candidate-start; }
sleep() { SECONDS=$((SECONDS + $1)); }
${functionSource("wait_for_release")}
${functionSource("rollback")}
${functionSource("assert_release_interruption_policy")}
${functionSource("start_candidate")}
${script}
`], { cwd: directory, env: { ...process.env, BASH_ENV: "" } });
    const trace = async () => (await fs.readFile(path.join(directory, "trace"), "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error))).trim().split(/\r?\n/).filter(Boolean);
    await operation({ directory, run, trace });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("cold candidates may warm beyond 45 seconds without touching the serving primary", { skip }, async () => {
  await fixture(async ({ run, trace }) => {
    await run(`
SECONDS=0
curl() { if [[ "$*" == *release.json* ]]; then printf '{"version":"new-release"}'; elif ((SECONDS >= 60)); then printf 200; else printf 503; fi; }
start_candidate
[[ "$candidate_ready" == 1 && "$SECONDS" -ge 60 ]]
`);
    assert.deepEqual(await trace(), ["stop-existing-candidate", "candidate-start"]);
  });
});

test("a failed candidate leaves the current link and healthy primary alone", { skip }, async () => {
  await fixture(async ({ run, trace }) => {
    await assert.rejects(run(`
ln -s "$previous_target" "$current_link"
candidate_warmup_seconds=1
curl() { printf 503; }
trap rollback ERR
start_candidate
`), error => /Primary was not changed/.test(error.stderr));
    const steps = await trace();
    assert.deepEqual(steps, ["stop-existing-candidate", "candidate-start", "kill 424242"]);
  });
});

test("an install or preflight failure does not restart the untouched primary", { skip }, async () => {
  await fixture(async ({ run, trace }) => {
    await assert.rejects(run("trap rollback ERR\nfalse"), error => /Primary was not changed/.test(error.stderr));
    assert.deepEqual(await trace(), []);
  });
});

test("rollback warms the previous release and preserves validated failover through Nginx recovery", { skip }, async () => {
  await fixture(async ({ run, trace }) => {
    await assert.rejects(run(`
primary_changed=1
candidate_ready=1
candidate_pid=424242
SECONDS=0
curl() { if [[ "$*" == *release.json* ]]; then trace old-version-read; printf '{"version":"old-release"}'; elif ((SECONDS >= 60)); then trace old-ready; printf 200; else trace old-warming; printf 503; fi; }
trap rollback ERR
false
`), error => /Rollback restored and ready/.test(error.stderr));
    const steps = await trace();
    assert.equal(steps[0], "restart ozon-erp");
    assert.ok(steps.indexOf("old-ready") > 0);
    assert.ok(steps.indexOf("old-version-read") > steps.indexOf("old-ready"));
    assert.equal(steps.at(-1), "old-version-read");
    assert.equal(steps.some(step => step.startsWith("kill ")), false);
  });
});

test("failed rollback keeps the validated candidate available for failover", { skip }, async () => {
  await fixture(async ({ run, trace }) => {
    await assert.rejects(run(`
primary_changed=1
candidate_ready=1
candidate_pid=424242
rollback_warmup_seconds=1
curl() { printf 503; }
trap rollback ERR
false
`), error => /retaining the candidate/.test(error.stderr));
    assert.deepEqual(await trace(), ["restart ozon-erp"]);
  });
});

test("readiness accepts only the expected release and checks candidate liveness", { skip }, async () => {
  await fixture(async ({ run }) => {
    await run(`
curl() { if [[ "$*" == *release.json* ]]; then printf '{"version":"wrong-release"}'; else printf 200; fi; }
if wait_for_release 8788 expected-release 1; then exit 91; fi
kill() { return 1; }
if wait_for_release 8788 expected-release 1 424242; then exit 92; fi
`);
  });
});

for (const change of ["material", "identity"]) test(`ordinary release refuses ${change} writer interruption before backup or stop`, { skip }, async () => {
  await fixture(async ({ run, trace }) => {
    await assert.rejects(run(`
allow_service_interruption=0
material_change_required=${change === "material" ? "change" : "ready"}
reviewed_identity_manifest=${change === "identity" ? "reviewed.json" : '""'}
trap rollback ERR
assert_release_interruption_policy
trace backup
trace stop-primary
`), error => /Schedule explicit maintenance/.test(error.stderr));
    assert.deepEqual(await trace(), []);
    await run(`
allow_service_interruption=1
material_change_required=change
reviewed_identity_manifest=reviewed.json
assert_release_interruption_policy
`);
  });
});

test("writer interruption policy is checked before backup, DDL and all service stops", () => {
  const policy = source.indexOf("\nassert_release_interruption_policy\n");
  assert.ok(policy > source.indexOf('material_change_required="$(material_optimization_preflight)"'));
  for (const action of ["\n  backup_database\n", "npm run db:init:mysql", "\n  systemctl stop ozon-erp\n"]) assert.ok(policy < source.indexOf(action));
  assert.doesNotMatch(source, /material_candidate_warmup_seconds|warmup_seconds=45/);
});

test("additive pilot schemas require a verified backup and execute before readiness even with maintenance skipped", () => {
  const migrations = ["migrate-order-search-indexes.mjs", "migrate-listing-draft-list-indexes.mjs", "migrate-listing-frozen-content.mjs", "migrate-ai-credits.mjs"];
  const loop = source.indexOf("for additive_migration in ");
  assert.ok(loop > source.indexOf("\n  backup_database\n"));
  assert.ok(loop < source.indexOf("\nstart_candidate\n"));
  for (const script of migrations) {
    assert.ok(source.slice(loop, source.indexOf("\ndone", loop)).includes(script));
  }
  assert.ok(loop < source.indexOf('if [[ "$run_db_maintenance" == "1" ]]; then'));
  const body = source.slice(loop, source.indexOf("\ndone", loop));
  assert.match(body, /if ! migration_pending "\$additive_migration"; then continue; fi/);
  assert.ok(source.indexOf("\nplan_database_changes\n") < source.indexOf("\n  backup_database\n"));
  assert.ok(body.indexOf('--database="$DB_NAME"') < body.indexOf('--apply --database="$DB_NAME"'));
  assert.match(body, /--mysql-admin-socket=\/var\/run\/mysqld\/mysqld\.sock/);
  assert.doesNotMatch(body, /recharge|configureAccount|LISTING_FROZEN_DRAFT_TENANTS|DELETE FROM/i);
});

test("AI private metadata is backed up with SQL and remains outside versioned release directories", () => {
  const backup = functionSource("backup_database");
  assert.ok(backup.indexOf('gzip -t "$backup_path.partial"') < backup.indexOf("node scripts/backup-private-ai-results.mjs"));
  assert.match(backup, /AI_CREDIT_RESULT_ROOT:-\$shared_root\/private-ai-results/);
  assert.match(source, /install -d -m 700 -o ozon-erp -g ozon-erp "\$shared_root\/private-ai-results"/);
  const rejectArchive = source.indexOf("Deploy archives must not contain private AI result data.");
  const privateLink = source.indexOf('ln -s "$shared_root/private-ai-results" "$staging_dir/data/ai-credit-results"');
  assert.ok(rejectArchive > 0 && rejectArchive < privateLink && privateLink < source.indexOf("\nstart_candidate\n"));
});

test("a missing configured private result directory refuses the release before DDL without stopping the primary", { skip }, async () => {
  await fixture(async ({ run, trace }) => {
    await assert.rejects(run(`
shared_root="$PWD/shared"
staging_dir="$PWD/staging"
mkdir -p "$staging_dir/scripts"
touch "$staging_dir/scripts/backup-private-ai-results.mjs"
printf '\\nAI_CREDIT_RESULT_ROOT=%s/missing-private-results\\n' "$PWD" >> "$env_file"
mysqldump() { printf 'isolated SQL snapshot\\n'; }
install() { shift 3; mkdir -p "$1"; }
chmod() { :; }
${functionSource("backup_database")}
trap rollback ERR
backup_database
trace ddl-must-not-run
`), error => /refusing an unpaired database backup/.test(error.stderr) && /Primary was not changed/.test(error.stderr));
    assert.deepEqual(await trace(), []);
  });
});

test("private-result backup failure after the SQL snapshot leaves the serving primary alone", { skip }, async () => {
  await fixture(async ({ run, trace }) => {
    let observedFailure;
    await assert.rejects(run(`
shared_root="$PWD/shared"
staging_dir="$PWD/staging"
mkdir -p "$shared_root/private-ai-results" "$staging_dir/scripts"
touch "$staging_dir/scripts/backup-private-ai-results.mjs"
mysqldump() { printf 'isolated SQL snapshot\\n'; }
install() { shift 3; mkdir -p "$1"; }
chmod() { :; }
node() { printf '%s\\n' private-backup-attempt >> "$release_dir/trace"; return 19; }
${functionSource("backup_database")}
trap rollback ERR
backup_database
trace ddl-must-not-run
`), error => { observedFailure = error; return /Primary was not changed/.test(error.stderr); });
    assert.deepEqual(await trace(), ["private-backup-attempt"], observedFailure?.stderr);
  });
});
