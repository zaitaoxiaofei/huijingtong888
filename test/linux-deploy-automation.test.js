import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const execFileAsync = promisify(execFile);

const client = fs.readFileSync(new URL("../deploy/linux/deploy-ecs.ps1", import.meta.url), "utf8");
const unixClient = fs.readFileSync(new URL("../deploy/linux/deploy-ecs.sh", import.meta.url), "utf8");
const remote = fs.readFileSync(new URL("../deploy/linux/remote-release.sh", import.meta.url), "utf8");
const oneClick = fs.readFileSync(new URL("../deploy/linux/deploy-ecs-one-click.ps1", import.meta.url), "utf8");
const launcher = fs.readFileSync(new URL("../一键部署到阿里云.vbs", import.meta.url), "utf8");
const keySetup = fs.readFileSync(new URL("../deploy/linux/configure-ecs-key.ps1", import.meta.url), "utf8");
const windowsClient = fs.readFileSync(new URL("../deploy/windows-client/连接Ozon ERP.ps1", import.meta.url), "utf8");
const deploymentDocs = fs.readFileSync(new URL("../docs/ECS_ONE_COMMAND_DEPLOYMENT.md", import.meta.url), "utf8");

test("ECS deployment defaults use the verified production host everywhere", () => {
  const defaults = [client, unixClient, oneClick, keySetup, windowsClient, deploymentDocs];
  for (const source of defaults) {
    assert.match(source, /47\.120\.47\.194/);
    assert.doesNotMatch(source, /47\.113\.195\.4/);
  }
});

test("ECS deployment uploads one artifact and delegates atomic release activation", () => {
  assert.match(client, /npm\.cmd run package:deploy/);
  assert.match(client, /scp @scpOptions/);
  assert.match(client, /bash '\$remoteScript'/);
  assert.match(remote, /previous_target="\$\(readlink -f/);
  assert.match(remote, /ln -sfn "\$release_dir" "\$current_link"/);
  assert.match(remote, /Release failed; attempting rollback/);
});

test("Mac/Linux deployment reuses the shared build and atomic release implementation", () => {
  assert.match(unixClient, /npm run package:deploy/);
  assert.match(unixClient, /remote-release\.sh/);
  assert.match(unixClient, /scp "\$\{scp_options\[@\]\}"/);
  assert.match(unixClient, /bash '\$remote_script'/);
  assert.match(unixClient, /--skip-database-init/);
});

test("Mac/Linux activation passes the archive before the version as required by the remote script", () => {
  assert.match(remote, /archive_path="\$\{1:-\}"/);
  assert.match(remote, /release_version="\$\{2:-\}"/);
  assert.ok(unixClient.includes("bash '$remote_script' '$remote_archive' '$version' '$db_init_flag' '$db_maintenance_flag'"));
});

test("Mac/Linux release can skip all database maintenance when no schema change is needed", () => {
  assert.match(unixClient, /--skip-database-maintenance/);
  assert.match(unixClient, /\(\(skip_database_maintenance\)\) && db_maintenance_flag=0/);
  assert.match(remote, /run_db_maintenance="\$\{4:-1\}"/);
  assert.match(remote, /if \[\[ "\$run_db_maintenance" == "1" \]\]; then\s+for tenant_migration/);
  assert.ok(remote.indexOf("init-order-query-facts.mjs") < remote.indexOf("\nfi\n\nrm -rf \"$staging_dir/public/uploads\""));
});

async function withWindowsDeployFixture(run) {
  const fixtureDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-deploy-flags-"));
  try {
    const scriptDir = path.join(fixtureDir, "deploy", "linux");
    const scriptPath = path.join(scriptDir, "deploy-ecs.ps1");
    const scriptsDir = path.join(fixtureDir, "scripts");
    const outputDir = path.join(fixtureDir, ".deploy-artifacts", "test-release-package");
    const capturePath = path.join(fixtureDir, "ssh-arguments.json");
    const tracePath = path.join(fixtureDir, "steps.jsonl");
    const manifestPath = path.join(fixtureDir, "reviewed identities with spaces.json");
    await fsPromises.mkdir(scriptDir, { recursive: true });
    await fsPromises.mkdir(scriptsDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    await fsPromises.writeFile(scriptPath, client, "utf8");
    await fsPromises.writeFile(path.join(outputDir, "deploy-manifest.json"), "{}", "utf8");
    await fsPromises.writeFile(manifestPath, "{}", "utf8");
    await fsPromises.writeFile(path.join(scriptsDir, "verify-release-worktree.mjs"), `
      import fs from "node:fs";
      fs.appendFileSync(process.env.OZON_DEPLOY_TEST_TRACE, JSON.stringify({ step: "guard", cwd: process.cwd() }) + "\\n");
      process.exit(Number(process.env.OZON_DEPLOY_TEST_GUARD_EXIT || 0));
    `, "utf8");
    const execute = async ({ skipInit = false, skipMaintenance = false, skipBuild = true, manifest = false, guardExit = 0, dryRun = false } = {}) => {
      await fsPromises.writeFile(tracePath, "", "utf8");
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
        $ErrorActionPreference = 'Stop'
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        function global:Record-DeployStep($entry) {
          [System.IO.File]::AppendAllText($env:OZON_DEPLOY_TEST_TRACE, (ConvertTo-Json -InputObject $entry -Compress) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
        }
        function global:git {
          if ($args -contains 'branch') { 'release/deploy-test' }
          elseif ($args -contains 'HEAD') { '0123456789abcdef0123456789abcdef01234567' }
          $global:LASTEXITCODE = 0
        }
        function global:npm.cmd {
          Record-DeployStep @{ step = 'build'; branch = $env:OZON_RELEASE_BRANCH; commit = $env:OZON_RELEASE_COMMIT; version = $env:OZON_RELEASE_VERSION }
          $global:LASTEXITCODE = 0
        }
        function global:tar.exe {
          Record-DeployStep @{ step = 'archive' }
          [System.IO.File]::WriteAllText($args[3], 'test archive')
          $global:LASTEXITCODE = 0
        }
        function global:scp {
          Record-DeployStep @{ step = 'upload'; arguments = @($args) }
          $global:LASTEXITCODE = 0
        }
        function global:ssh {
          Record-DeployStep @{ step = 'ssh' }
          [System.IO.File]::WriteAllText($env:OZON_DEPLOY_TEST_CAPTURE, (ConvertTo-Json -InputObject @($args) -Compress), [System.Text.UTF8Encoding]::new($false))
          $global:LASTEXITCODE = 0
        }
        $options = @{ EcsHost = 'deployment.test.invalid'; SshUser = 'test'; SshPort = 22; IdentityFile = ''; Version = 'test-release' }
        if ($env:OZON_DEPLOY_TEST_SKIP_BUILD -eq '1') { $options.SkipBuild = $true }
        if ($env:OZON_DEPLOY_TEST_SKIP_INIT -eq '1') { $options.SkipDatabaseInit = $true }
        if ($env:OZON_DEPLOY_TEST_SKIP_MAINTENANCE -eq '1') { $options.SkipDatabaseMaintenance = $true }
        if ($env:OZON_DEPLOY_TEST_MANIFEST) { $options.ReviewedIdentityManifest = $env:OZON_DEPLOY_TEST_MANIFEST }
        if ($env:OZON_DEPLOY_TEST_DRY_RUN -eq '1') { $options.DryRun = $true }
        & $env:OZON_DEPLOY_TEST_SCRIPT @options
      `], {
        env: {
          ...process.env,
          OZON_RELEASE_BRANCH: "",
          OZON_RELEASE_COMMIT: "",
          OZON_DEPLOY_TEST_SCRIPT: scriptPath,
          OZON_DEPLOY_TEST_CAPTURE: capturePath,
          OZON_DEPLOY_TEST_TRACE: tracePath,
          OZON_DEPLOY_TEST_SKIP_BUILD: skipBuild ? "1" : "0",
          OZON_DEPLOY_TEST_SKIP_INIT: skipInit ? "1" : "0",
          OZON_DEPLOY_TEST_SKIP_MAINTENANCE: skipMaintenance ? "1" : "0",
          OZON_DEPLOY_TEST_MANIFEST: manifest ? manifestPath : "",
          OZON_DEPLOY_TEST_GUARD_EXIT: String(guardExit),
          OZON_DEPLOY_TEST_DRY_RUN: dryRun ? "1" : "0"
        }
      });
    };
    const trace = async () => (await fsPromises.readFile(tracePath, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    await run({ fixtureDir, capturePath, manifestPath, execute, trace });
  } finally {
    await fsPromises.rm(fixtureDir, { recursive: true, force: true });
  }
}

test("Windows database skip switches preserve defaults and forward all remote release arguments", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ capturePath, execute }) => {
    for (const [skipInit, skipMaintenance] of [[false, false], [true, false], [false, true], [true, true]]) {
      await execute({ skipInit, skipMaintenance });
      const sshArguments = JSON.parse(await fsPromises.readFile(capturePath, "utf8"));
      assert.equal(sshArguments.at(-2), "test@deployment.test.invalid");
      assert.ok(sshArguments.at(-1).endsWith(
        `bash '/tmp/ozon-erp-remote-release.sh' '/tmp/ozon-erp-test-release.zip' 'test-release' '${skipInit ? "0" : "1"}' '${skipMaintenance ? "0" : "1"}'`
      ), `incorrect remote flags for SkipDatabaseInit=${skipInit}, SkipDatabaseMaintenance=${skipMaintenance}`);
    }
  });
});

test("Windows release validation runs before packaging and records branch and commit metadata", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ fixtureDir, execute, trace }) => {
    await execute({ skipBuild: false });
    const steps = await trace();
    assert.deepEqual(steps.map(entry => entry.step), ["guard", "build", "archive", "upload", "ssh"]);
    assert.equal(path.resolve(steps[0].cwd), path.resolve(fixtureDir));
    assert.equal(steps[1].branch, "release/deploy-test");
    assert.equal(steps[1].commit, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(steps[1].version, "test-release");
  });
});

test("Windows release validation failure prevents packaging, upload and SSH even with SkipBuild", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ execute, trace }) => {
    await assert.rejects(execute({ guardExit: 9 }));
    assert.deepEqual((await trace()).map(entry => entry.step), ["guard"]);
  });
});

test("Windows DryRun exits before release validation and all mutating or remote steps", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ execute, trace }) => {
    await execute({ dryRun: true, skipBuild: false, guardExit: 9 });
    assert.deepEqual(await trace(), []);
  });
});

test("Windows deployment uploads a reviewed manifest with spaces and forwards it as the fifth remote argument", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ capturePath, manifestPath, execute, trace }) => {
    await execute({ manifest: true, skipInit: true, skipMaintenance: true });
    const steps = await trace();
    assert.deepEqual(steps.map(entry => entry.step), ["guard", "archive", "upload", "upload", "ssh"]);
    const manifestUpload = steps.filter(entry => entry.step === "upload").at(-1).arguments;
    assert.equal(manifestUpload.at(-2), manifestPath);
    assert.equal(manifestUpload.at(-1), "test@deployment.test.invalid:/tmp/ozon-erp-identity-test-release.json");
    const sshArguments = JSON.parse(await fsPromises.readFile(capturePath, "utf8"));
    const command = sshArguments.at(-1);
    assert.match(command, /chmod 600 '\/tmp\/ozon-erp-identity-test-release\.json'/);
    assert.ok(command.endsWith("bash '/tmp/ozon-erp-remote-release.sh' '/tmp/ozon-erp-test-release.zip' 'test-release' '0' '0' '/tmp/ozon-erp-identity-test-release.json'"));
  });
});

test("both deployment clients explicitly forward the optional reviewed identity manifest", () => {
  assert.match(client, /\[string\]\$ReviewedIdentityManifest/);
  assert.match(client, /Resolve-Path -LiteralPath \$ReviewedIdentityManifest/);
  assert.match(client, /if \(\$remoteIdentityManifest\) \{[\s\S]*\$remoteCommand = .*'\$remoteIdentityManifest'/);
  assert.match(unixClient, /--reviewed-identity-manifest/);
  assert.match(unixClient, /scp "\$\{scp_options\[@\]\}" "\$reviewed_identity_manifest" "\$remote_target:\$remote_identity_manifest"/);
  assert.match(unixClient, /identity_argument=""/);
  assert.match(unixClient, /if \[\[ -n "\$remote_identity_manifest" \]\]; then[\s\S]*identity_argument=" '\$remote_identity_manifest'"/);
  assert.match(remote, /reviewed_identity_manifest="\$\{5:-\}"/);
});

test("Windows release guard runs after DryRun and before any build or upload", () => {
  const dryRunExit = client.indexOf("if ($DryRun)");
  const guard = client.indexOf("& node scripts/verify-release-worktree.mjs");
  assert.ok(dryRunExit >= 0 && guard > dryRunExit);
  for (const marker of ["New-Item -ItemType Directory", "& npm.cmd run package:deploy", "& tar.exe", "& scp", "& ssh"]) {
    assert.ok(client.indexOf(marker) > guard, `${marker} must remain after release validation`);
  }
  assert.match(client, /\$env:OZON_RELEASE_BRANCH = \$releaseBranch/);
  assert.match(client, /\$env:OZON_RELEASE_COMMIT = \$releaseCommit/);
  assert.match(client, /\$env:OZON_RELEASE_CHANNEL = "production"/);
});

test("ECS release verifies a private complete database backup before initialization or ownership migrations", () => {
  assert.match(remote, /if \[\[ "\$run_db_maintenance" == "1" \|\| -n "\$reviewed_identity_manifest" \|\| -f "\$staging_dir\/scripts\/migrate-order-profit-calculation-versions\.mjs" \|\| -f "\$staging_dir\/scripts\/migrate-ai-variant-draft-history-index\.mjs" \]\]; then\s+backup_database/);
  const backup = remote.indexOf("\n  backup_database\n");
  assert.ok(backup >= 0);
  assert.ok(backup < remote.indexOf("npm run db:init:mysql"));
  assert.ok(backup < remote.indexOf("for tenant_migration"));
  assert.ok(backup < remote.indexOf("node scripts/migrate-order-profit-calculation-versions.mjs"));
  assert.match(remote, /backup_dir="\$shared_root\/backups\/identity-releases"/);
  assert.match(remote, /install -d -m 700 "\$backup_dir"/);
  assert.match(remote, /umask 077/);
  assert.match(remote, /mysqldump --protocol=SOCKET --socket=\/var\/run\/mysqld\/mysqld\.sock --user=root/);
  for (const flag of ["--single-transaction", "--routines", "--triggers", "--events", "--hex-blob"]) assert.ok(remote.includes(flag));
  assert.match(remote, /--databases "\$DB_NAME" \| gzip > "\$backup_path\.partial"/);
  const verify = remote.indexOf('gzip -t "$backup_path.partial"');
  assert.ok(verify >= 0 && verify < remote.indexOf('mv "$backup_path.partial" "$backup_path"'));
  assert.match(remote, /chmod 600 "\$backup_path\.partial"/);
});

const bashExecutable = process.platform === "win32"
  ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")
  : "bash";
const missingGitBash = process.platform === "win32" && !fs.existsSync(bashExecutable);

test("profit schema preparation still requires a backup when ordinary maintenance is skipped", { skip: missingGitBash }, async () => {
  const fixtureDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-backup-gate-"));
  try {
    const gate = remote.match(/^if \[\[ "\$run_db_maintenance" == "1"[^\r\n]*\r?\n  backup_database\r?\nfi/m)?.[0];
    assert.ok(gate, "execute the release's actual backup gate");
    await fsPromises.mkdir(path.join(fixtureDir, "scripts"));
    for (const [maintenance, manifest, profitSchema, expected] of [["0", "", true, true], ["0", "", false, false], ["1", "", false, true], ["0", "reviewed.json", false, true]]) {
      const schema = path.join(fixtureDir, "scripts", "migrate-order-profit-calculation-versions.mjs");
      if (profitSchema) await fsPromises.writeFile(schema, "fixture", "utf8");
      else await fsPromises.rm(schema, { force: true });
      const { stdout } = await execFileAsync(bashExecutable, ["--noprofile", "--norc", "-c", `
        set -Eeuo pipefail
        staging_dir="$PWD"
        run_db_maintenance="${maintenance}"
        reviewed_identity_manifest="${manifest}"
        backup_database() { printf 'backup-required'; }
        ${gate}
      `], { cwd: fixtureDir, env: { ...process.env, BASH_ENV: "" } });
      assert.equal(stdout, expected ? "backup-required" : "");
    }
  } finally {
    await fsPromises.rm(fixtureDir, { recursive: true, force: true });
  }
});

for (const succeeds of [true, false]) {
  test(`real release backup ${succeeds ? "verifies compressed SQL before maintenance" : "failure prevents subsequent maintenance"}`, { skip: missingGitBash }, async () => {
    const fixtureDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-backup-fixture-"));
    try {
      await fsPromises.writeFile(path.join(fixtureDir, "mock.env"), "DB_NAME=deployment_fixture_only\n", "utf8");
      const backupFunction = remote.match(/^backup_database\(\) \{\r?\n[\s\S]*?^\}\r?\n(?=\r?\nstart_candidate)/m)?.[0];
      assert.ok(backupFunction, "test must execute the actual complete release backup function");
      const script = `
        set -Eeuo pipefail
        shared_root="$PWD/shared"
        env_file="$PWD/mock.env"
        release_version="test-release"
        ${process.platform === "win32" ? `
        # NTFS permissions are covered by source assertions; Git Bash cannot apply Unix modes here.
        install() { command mkdir -p -- "\${@: -1}"; }
        chmod() { return 0; }
        ` : ""}
        mysqldump() {
          printf '%s\\n' "$@" > "$PWD/dump-arguments.txt"
          printf '%s\\n' 'SELECT 12345;'
          return ${succeeds ? 0 : 42}
        }
        ${backupFunction.replace(/\r\n/g, "\n")}
        backup_database
        printf 'maintenance started\\n' > "$PWD/maintenance.marker"
      `;
      const execute = () => execFileAsync(bashExecutable, ["--noprofile", "--norc", "-c", script], {
        cwd: fixtureDir,
        env: { ...process.env, BASH_ENV: "" }
      });
      const backupDir = path.join(fixtureDir, "shared", "backups", "identity-releases");
      if (succeeds) {
        await execute();
        const names = await fsPromises.readdir(backupDir);
        assert.equal(names.length, 1);
        assert.match(names[0], /^pre-release-test-release-.*\.sql\.gz$/);
        const backupPath = path.join(backupDir, names[0]);
        assert.equal(gunzipSync(await fsPromises.readFile(backupPath)).toString("utf8"), "SELECT 12345;\n");
        assert.equal(await fsPromises.readFile(path.join(fixtureDir, "maintenance.marker"), "utf8"), "maintenance started\n");
        const argumentsText = await fsPromises.readFile(path.join(fixtureDir, "dump-arguments.txt"), "utf8");
        assert.match(argumentsText, /--databases\r?\ndeployment_fixture_only/);
        if (process.platform !== "win32") {
          assert.equal((await fsPromises.stat(backupPath)).mode & 0o777, 0o600);
          assert.equal((await fsPromises.stat(backupDir)).mode & 0o777, 0o700);
        }
      } else {
        await assert.rejects(execute(), error => error.code === 42);
        await assert.rejects(fsPromises.access(path.join(fixtureDir, "maintenance.marker")), error => error.code === "ENOENT");
        assert.equal((await fsPromises.readdir(backupDir)).filter(name => name.endsWith(".sql.gz")).length, 0);
      }
    } finally {
      await fsPromises.rm(fixtureDir, { recursive: true, force: true });
    }
  });
}

test("ECS identity migration stops both old writers before audit and apply then starts the new candidate", () => {
  const blockStart = remote.indexOf('if [[ -n "$reviewed_identity_manifest" ]]; then', remote.indexOf("\nconfigure_nginx_failover\n"));
  const candidate = remote.indexOf("\nstart_candidate\n", blockStart);
  const block = remote.slice(blockStart, candidate);
  const stopCandidate = block.indexOf("\n  stop_existing_candidate\n");
  const stopPrimary = block.indexOf("systemctl stop ozon-erp");
  const dryRun = block.indexOf('node scripts/migrate-platform-enterprise-identities.mjs --manifest="$reviewed_identity_manifest"');
  const apply = block.indexOf('node scripts/migrate-platform-enterprise-identities.mjs --apply --manifest="$reviewed_identity_manifest" --mysql-admin-socket=/var/run/mysqld/mysqld.sock');
  assert.ok(blockStart >= 0 && candidate > blockStart);
  assert.ok(stopCandidate >= 0 && stopPrimary > stopCandidate && dryRun > stopPrimary && apply > dryRun);
  assert.ok(candidate < remote.indexOf('ln -sfn "$release_dir" "$current_link"'));
  assert.match(block, /chmod 600 "\$reviewed_identity_manifest"/);
});

test("Mac/Linux DryRun exits before every mutating or remote deployment step", () => {
  const dryRunExit = unixClient.indexOf("if ((dry_run));");
  assert.ok(dryRunExit >= 0);
  for (const marker of ["mkdir -p", "npm run package:deploy", "zip -q -r", "scp ", "ssh "]) {
    assert.ok(unixClient.indexOf(marker) > dryRunExit, `${marker} must stay after DryRun`);
  }
  assert.match(unixClient, /no build, upload, SSH command, database change, release switch, restart, or rollback/);
  assert.doesNotMatch(unixClient, /StrictHostKeyChecking=no/);
});

test("ECS deployment preserves server secrets and shared uploads", () => {
  assert.match(remote, /env_file="\/etc\/ozon-erp\/ozon-erp\.env"/);
  assert.match(remote, /shared_root\/uploads\/public/);
  assert.match(remote, /shared_root\/uploads\/runtime/);
  assert.doesNotMatch(client, /ACCESS_KEY|DB_PASSWORD|OSS_ACCESS/);
});

test("ECS deployment validates the service before accepting the release", () => {
  assert.match(remote, /systemctl restart ozon-erp/);
  assert.match(remote, /http:\/\/127\.0\.0\.1:3000\//);
  assert.match(remote, /status" == "200"/);
});

test("ECS deployment warms a backup candidate before restarting the primary", () => {
  assert.match(remote, /candidate_port="3001"/);
  assert.match(remote, /DEPLOYMENT_CANDIDATE='1'/);
  assert.ok(remote.indexOf("\nstart_candidate\n") < remote.lastIndexOf("systemctl restart ozon-erp"));
  assert.match(remote, /server 127\.0\.0\.1:3001 backup/);
  assert.match(remote, /nginx -t/);
  assert.match(remote, /candidate_pid_file="\/tmp\/ozon-erp-candidate\.pid"/);
  assert.match(remote, /Keep the validated candidate alive as Nginx's hot backup/);
});

test("one-click launcher runs deployment hidden and keeps a durable log", () => {
  assert.match(launcher, /WindowStyle Hidden/);
  assert.match(launcher, /deploy-ecs-one-click\.ps1/);
  assert.match(oneClick, /deploy-ecs\.ps1/);
  assert.match(oneClick, /one-click-deploy\.log/);
  assert.match(oneClick, /MessageBox/);
});

test("first-time setup stores only a local key path and verifies passwordless SSH", () => {
  assert.match(keySetup, /OpenFileDialog/);
  assert.match(keySetup, /ozon-erp-deploy\.pem/);
  assert.match(keySetup, /ecs-deploy\.json/);
  assert.match(keySetup, /BatchMode=yes/);
  assert.doesNotMatch(keySetup, /AccessKey|DB_PASSWORD|OSS_ACCESS/);
});

test("ECS release installs inventory triggers as administrator and checks the served release version", () => {
  assert.ok(remote.indexOf("node scripts/init-inventory-numbering.mjs") < remote.indexOf("\nstart_candidate\n"));
  assert.match(remote, /candidate_version" == "\$release_version"/);
  assert.match(remote, /primary_version" == "\$release_version"/);
});

test("ECS release migrates tenant ownership dependencies before starting order sync", () => {
  assert.match(remote, /migration_args=\(--apply --mysql-admin-socket=\/var\/run\/mysqld\/mysqld\.sock\)/);
  assert.match(remote, /node "scripts\/\$tenant_migration" "\$\{migration_args\[@\]\}"/);
  assert.match(remote, /migration_args\+=\(--assign-legacy-platform-default\)/);
  assert.ok(remote.indexOf("migrate-tenant-products-ownership.mjs") < remote.indexOf("migrate-tenant-sku-mappings.mjs"));
  assert.ok(remote.indexOf("migrate-tenant-sku-mappings.mjs") < remote.indexOf("migrate-tenant-logistics-rules.mjs"));
  assert.ok(remote.indexOf("migrate-tenant-logistics-rules.mjs") < remote.indexOf("\nstart_candidate\n"));
  assert.ok(remote.indexOf("migrate-tenant-logistics-rules.mjs") < remote.indexOf("migrate-tenant-asset-variant-config.mjs"));
  assert.ok(remote.indexOf("migrate-tenant-asset-variant-config.mjs") < remote.indexOf("migrate-enterprise-messages.mjs"));
  assert.ok(remote.indexOf("migrate-enterprise-messages.mjs") < remote.indexOf("\nstart_candidate\n"));
  assert.ok(remote.indexOf("migrate-tenant-asset-variant-config.mjs") < remote.indexOf("\nstart_candidate\n"));
});

test("ECS release applies versioned OGL rates before activating the candidate", () => {
  assert.match(remote, /node scripts\/apply-ogl-rates\.mjs --apply/);
  assert.ok(remote.indexOf("migrate-tenant-logistics-rules.mjs") < remote.indexOf("node scripts/apply-ogl-rates.mjs --apply"));
  assert.ok(remote.indexOf("node scripts/apply-ogl-rates.mjs --apply") < remote.indexOf("\nstart_candidate\n"));
});
