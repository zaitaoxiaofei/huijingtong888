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
  assert.match(remote, /run_db_maintenance="\$\{4:-0\}"/);
  assert.match(remote, /if \[\[ "\$run_db_maintenance" == "1" \]\]; then\s+if migration_pending migrate-tenant-sku-order-trackers\.mjs; then/);
  assert.match(remote, /if migration_pending migrate-tenant-sku-order-trackers\.mjs; then[\s\S]*?\nfi\s+for tenant_migration/);
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
    const materialManifestPath = path.join(fixtureDir, "reviewed material with spaces.json");
    await fsPromises.mkdir(scriptDir, { recursive: true });
    await fsPromises.mkdir(scriptsDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    await fsPromises.writeFile(scriptPath, client, "utf8");
    await fsPromises.writeFile(path.join(outputDir, "deploy-manifest.json"), "{}", "utf8");
    await fsPromises.writeFile(manifestPath, "{}", "utf8");
    await fsPromises.writeFile(materialManifestPath, JSON.stringify({ reason: "MATERIAL_CONTENT_MUST_NOT_BE_PRINTED", batches: [] }), "utf8");
    await fsPromises.writeFile(path.join(scriptsDir, "verify-release-worktree.mjs"), `
      import fs from "node:fs";
      fs.appendFileSync(process.env.OZON_DEPLOY_TEST_TRACE, JSON.stringify({ step: "guard", cwd: process.cwd() }) + "\\n");
      process.exit(Number(process.env.OZON_DEPLOY_TEST_GUARD_EXIT || 0));
    `, "utf8");
    const execute = async ({ skipInit = false, skipMaintenance = false, runMaintenance = false, skipBuild = true, manifest = false, material = false, retention = false, materialUploadExit = 0, activationExit = 0, guardExit = 0, dryRun = false, allowInterruption = false } = {}) => {
      await fsPromises.writeFile(tracePath, "", "utf8");
      return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
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
          $global:LASTEXITCODE = if ($args[-1] -like '*ozon-erp-ai-material-*') { [int]$env:OZON_DEPLOY_TEST_MATERIAL_UPLOAD_EXIT } else { 0 }
        }
        function global:ssh {
          Record-DeployStep @{ step = 'ssh'; arguments = @($args) }
          [System.IO.File]::WriteAllText($env:OZON_DEPLOY_TEST_CAPTURE, (ConvertTo-Json -InputObject @($args) -Compress), [System.Text.UTF8Encoding]::new($false))
          $global:LASTEXITCODE = if ($args[-1] -like '*bash*remote-release.sh*') { [int]$env:OZON_DEPLOY_TEST_ACTIVATION_EXIT } else { 0 }
        }
        $options = @{ EcsHost = 'deployment.test.invalid'; SshUser = 'test'; SshPort = 22; IdentityFile = ''; Version = 'test-release' }
        if ($env:OZON_DEPLOY_TEST_SKIP_BUILD -eq '1') { $options.SkipBuild = $true }
        if ($env:OZON_DEPLOY_TEST_SKIP_INIT -eq '1') { $options.SkipDatabaseInit = $true }
        if ($env:OZON_DEPLOY_TEST_SKIP_MAINTENANCE -eq '1') { $options.SkipDatabaseMaintenance = $true }
        if ($env:OZON_DEPLOY_TEST_RUN_MAINTENANCE -eq '1') { $options.RunDatabaseMaintenance = $true }
        if ($env:OZON_DEPLOY_TEST_ALLOW_INTERRUPTION -eq '1') { $options.AllowServiceInterruption = $true }
        if ($env:OZON_DEPLOY_TEST_MANIFEST) { $options.ReviewedIdentityManifest = $env:OZON_DEPLOY_TEST_MANIFEST }
        if ($env:OZON_DEPLOY_TEST_MATERIAL) { $options.ReviewedAiMaterialManifest = $env:OZON_DEPLOY_TEST_MATERIAL }
        if ($env:OZON_DEPLOY_TEST_RETENTION) { $options.ReviewedAiMediaRetentionManifest = $env:OZON_DEPLOY_TEST_RETENTION }
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
          OZON_DEPLOY_TEST_RUN_MAINTENANCE: runMaintenance ? "1" : "0",
          OZON_DEPLOY_TEST_ALLOW_INTERRUPTION: allowInterruption ? "1" : "0",
          OZON_DEPLOY_TEST_MANIFEST: manifest ? manifestPath : "",
          OZON_DEPLOY_TEST_MATERIAL: material ? materialManifestPath : "",
          OZON_DEPLOY_TEST_RETENTION: retention ? materialManifestPath : "",
          OZON_DEPLOY_TEST_MATERIAL_UPLOAD_EXIT: String(materialUploadExit),
          OZON_DEPLOY_TEST_ACTIVATION_EXIT: String(activationExit),
          OZON_DEPLOY_TEST_GUARD_EXIT: String(guardExit),
          OZON_DEPLOY_TEST_DRY_RUN: dryRun ? "1" : "0"
        }
      });
    };
    const trace = async () => (await fsPromises.readFile(tracePath, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    await run({ fixtureDir, capturePath, manifestPath, materialManifestPath, execute, trace });
  } finally {
    await fsPromises.rm(fixtureDir, { recursive: true, force: true });
  }
}

test("AI media retention requires maintenance before upload and passes a private eighth manifest argument", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ execute, trace }) => {
    await assert.rejects(execute({ retention:true }), /AI media retention requires an explicit offline maintenance window/);
    assert.deepEqual(await trace(), []);
    await execute({ retention:true, allowInterruption:true });
    const steps=await trace();
    const activation=steps.find(step=>step.step==='ssh' && step.arguments.at(-1).includes("bash '/tmp/ozon-erp-remote-release.sh'"));
    assert.match(activation.arguments.at(-1), /'test-release' '1' '0' '' '' '1' '\/tmp\/ozon-erp-ai-media-retention-test-release-[a-f0-9]+\.json'$/);
    assert.ok(steps.some(step=>step.step==='ssh' && step.arguments.at(-1).includes('umask 077') && step.arguments.at(-1).includes('ai-media-retention')));
    assert.ok(steps.some(step=>step.step==='ssh' && step.arguments.at(-1).startsWith('rm -f -- ') && step.arguments.at(-1).includes('ai-media-retention')));
  });
  const apply=remote.lastIndexOf('node scripts/cleanup-ai-media-retention.mjs');
  assert.ok(remote.indexOf('  backup_database')<apply);
  const freeze=remote.slice(remote.lastIndexOf('if [[ -n "${reviewed_ai_media_retention_manifest:-}" ]]'),remote.indexOf('\nstart_candidate\n'));
  assert.match(freeze,/stop_existing_candidate[\s\S]*systemctl stop ozon-erp[\s\S]*--apply --offline-maintenance/);
  assert.match(freeze,/install -m 600/);
});

test("Windows ordinary release skips broad maintenance and explicit maintenance remains available", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ capturePath, execute }) => {
    for (const [skipInit, skipMaintenance, runMaintenance] of [[false, false, false], [true, false, false], [false, true, false], [true, true, false], [false, false, true]]) {
      await execute({ skipInit, skipMaintenance, runMaintenance });
      const sshArguments = JSON.parse(await fsPromises.readFile(capturePath, "utf8"));
      assert.equal(sshArguments.at(-2), "test@deployment.test.invalid");
      assert.ok(sshArguments.at(-1).endsWith(
        `bash '/tmp/ozon-erp-remote-release.sh' '/tmp/ozon-erp-test-release.zip' 'test-release' '${skipInit ? "0" : "1"}' '${runMaintenance ? "1" : "0"}' '' '' '0'`
      ), `incorrect remote flags for SkipDatabaseInit=${skipInit}, SkipDatabaseMaintenance=${skipMaintenance}`);
    }
    await assert.rejects(execute({ runMaintenance: true, skipMaintenance: true }), /Choose either/);
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

test("Windows service interruption is opt-in and forwarded independently of database skip switches", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ execute, capturePath }) => {
    for (const allowInterruption of [false, true]) {
      await execute({ allowInterruption, skipInit: true, skipMaintenance: true });
      const argumentsList = JSON.parse(await fsPromises.readFile(capturePath, "utf8"));
      assert.ok(argumentsList.at(-1).endsWith(`'0' '0' '' '' '${allowInterruption ? "1" : "0"}'`));
    }
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
    assert.ok(command.endsWith("bash '/tmp/ozon-erp-remote-release.sh' '/tmp/ozon-erp-test-release.zip' 'test-release' '0' '0' '/tmp/ozon-erp-identity-test-release.json' '' '0'"));
  });
});

test("both deployment clients explicitly forward the optional reviewed identity manifest", () => {
  assert.match(client, /\[string\]\$ReviewedIdentityManifest/);
  assert.match(client, /Resolve-Path -LiteralPath \$ReviewedIdentityManifest/);
  assert.match(client, /\$activationCommand = .*'\$remoteIdentityManifest' '\$remoteAiMaterialManifest'/);
  assert.match(unixClient, /--reviewed-identity-manifest/);
  assert.match(unixClient, /scp "\$\{scp_options\[@\]\}" "\$reviewed_identity_manifest" "\$remote_target:\$remote_identity_manifest"/);
  assert.match(unixClient, /activation_command=.*'\$remote_identity_manifest' '\$remote_ai_material_manifest'/);
  assert.match(remote, /reviewed_identity_manifest="\$\{5:-\}"/);
});

test("Windows material manifest is private before upload, stays sixth, and is cleaned on success or failure", { skip: process.platform !== "win32" }, async () => {
  await withWindowsDeployFixture(async ({ execute, trace, materialManifestPath }) => {
    for (const identity of [false, true]) {
      const { stdout } = await execute({ material: true, manifest: identity, skipInit: true, skipMaintenance: true });
      assert.doesNotMatch(stdout, /MATERIAL_CONTENT_MUST_NOT_BE_PRINTED/);
      const steps = await trace();
      const preparation = steps.findIndex(step => step.step === "ssh" && step.arguments.at(-1).includes("umask 077"));
      const upload = steps.findIndex(step => step.step === "upload" && step.arguments.at(-2) === materialManifestPath);
      const activation = steps.find(step => step.step === "ssh" && step.arguments.at(-1).includes("&& bash "));
      assert.ok(preparation >= 0 && upload > preparation);
      assert.match(steps[preparation].arguments.at(-1), /set -Ce; umask 077; : > '.*'; chmod 600/);
      assert.match(activation.arguments.at(-1), new RegExp(`'0' '0' '${identity ? "/tmp/ozon-erp-identity-test-release.json" : ""}' '/tmp/ozon-erp-ai-material-test-release-[a-f0-9]{32}\\.json' '0'$`));
      assert.match(steps.at(-1).arguments.at(-1), /^rm -f -- '\/tmp\/ozon-erp-ai-material-/);
    }
    for (const failure of [{ materialUploadExit: 41 }, { activationExit: 42 }]) {
      await assert.rejects(execute({ material: true, ...failure }));
      const steps = await trace();
      assert.match(steps.at(-1).arguments.at(-1), /^rm -f -- '\/tmp\/ozon-erp-ai-material-/);
      if (failure.materialUploadExit) assert.equal(steps.some(step => step.step === "ssh" && step.arguments.at(-1).includes("&& bash ")), false);
    }
    const { stdout } = await execute({ dryRun: true, material: true });
    assert.deepEqual(await trace(), []);
    assert.match(stdout, /'1' '0' '' '\/tmp\/ozon-erp-ai-material-test-release-[a-f0-9]{32}\.json'/);
    assert.doesNotMatch(stdout, /MATERIAL_CONTENT_MUST_NOT_BE_PRINTED/);
    await fsPromises.writeFile(materialManifestPath,"MATERIAL_CONTENT_MUST_NOT_BE_PRINTED invalid JSON");
    await assert.rejects(execute({dryRun:true,material:true}),error => /not valid JSON/.test(error.stderr) && !/MATERIAL_CONTENT_MUST_NOT_BE_PRINTED/.test(error.stderr));
    assert.deepEqual(await trace(),[]);
  });
});

test("material deployment does not mix identity and material review contracts", () => {
  assert.match(remote, /reviewed_identity_manifest="\$\{5:-\}"/);
  assert.match(remote, /reviewed_ai_material_manifest="\$\{6:-\}"/);
  assert.match(remote, /material_migration_args\+=\(--review-manifest="\$reviewed_ai_material_manifest"\)/);
  assert.doesNotMatch(remote, /migrate-platform-enterprise-identities[^\n]*reviewed_ai_material/);
  assert.doesNotMatch(remote, /migrate-tenant-ai-material-optimization[^\n]*reviewed_identity/);
  assert.match(remote, /trap cleanup_material_manifest EXIT/);
  assert.match(unixClient, /--reviewed-ai-material-manifest/);
  assert.match(unixClient, /set -Ce; umask 077; : > '\$remote_ai_material_manifest'; chmod 600/);
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
  const backupCondition = remote.match(/if \[\[ "\$run_db_maintenance" == "1" \|\|[^\n]+\]\]; then\s+backup_database/);
  assert.ok(backupCondition, "maintenance and mandatory schemas gate the backup");
  assert.ok(backupCondition[0].includes('-n "'+ '$' +'reviewed_identity_manifest"'));
  assert.ok(backupCondition[0].includes('$pending_schema_migrations'));
  assert.ok(backupCondition[0].includes('$material_change_required'));
  assert.doesNotMatch(backupCondition[0], /-f /, "packaging migration scripts is not a database change");
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

const bashPath = value => process.platform === "win32" ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;

test("real Git Bash client forwards material as argument six with an empty identity placeholder and cleans private uploads", { skip: missingGitBash }, async () => {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-material-client-"));
  try {
    const scripts = path.join(fixture, "deploy", "linux"), artifacts = path.join(fixture, ".deploy-artifacts", "fixture-package");
    await fsPromises.mkdir(scripts, { recursive: true }); await fsPromises.mkdir(artifacts, { recursive: true });
    const script = path.join(scripts, "deploy-ecs.sh"), mock = path.join(fixture, "mock.sh"), trace = path.join(fixture, "trace.jsonl");
    const material = path.join(fixture, "material review with spaces.json"), identity = path.join(fixture, "identity review.json"), key = path.join(fixture, "key");
    await fsPromises.writeFile(script, unixClient.replaceAll("\r\n", "\n"));
    await fsPromises.writeFile(path.join(scripts, "remote-release.sh"), "fixture");
    await fsPromises.writeFile(path.join(artifacts, "deploy-manifest.json"), "{}");
    await fsPromises.writeFile(material, JSON.stringify({ reason: "MATERIAL_CONTENT_MUST_NOT_BE_PRINTED" }));
    await fsPromises.writeFile(identity, "{}"); await fsPromises.writeFile(key, "fixture");
    await fsPromises.writeFile(mock, `
record() { node -e 'require("node:fs").appendFileSync(process.env.OZON_DEPLOY_BASH_TRACE, JSON.stringify(process.argv.slice(1))+"\\n")' "$@"; }
ssh() { record ssh "$@"; return 0; }
scp() { record scp "$@"; if [[ "$*" == *ozon-erp-ai-material-* ]]; then return "\${OZON_DEPLOY_BASH_UPLOAD_EXIT:-0}"; fi; }
zip() { record zip "$@"; printf 'fixture archive' > "$3"; }
`, "utf8");
    const execute = async (options = [], env = {}) => execFileAsync(bashExecutable, ["--noprofile", "--norc", bashPath(script), "--host", "deployment.test.invalid", "--version", "fixture", "--identity-file", bashPath(key), "--reviewed-ai-material-manifest", bashPath(material), "--skip-build", "--allow-dirty", ...options], {
      cwd: fixture, env: { ...process.env, BASH_ENV: bashPath(mock), OZON_DEPLOY_BASH_TRACE: trace, ...env }
    });
    for (const withIdentity of [false, true]) {
      await fsPromises.writeFile(trace, "");
      const { stdout } = await execute(withIdentity ? ["--reviewed-identity-manifest", bashPath(identity)] : []);
      assert.doesNotMatch(stdout, /MATERIAL_CONTENT_MUST_NOT_BE_PRINTED/);
      const calls = (await fsPromises.readFile(trace, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
      const activation = calls.find(call => call[0] === "ssh" && call.at(-1).startsWith("bash "));
      assert.match(activation.at(-1), new RegExp(`'1' '0' '${withIdentity ? "/tmp/ozon-erp-identity-fixture.json" : ""}' '/tmp/ozon-erp-ai-material-fixture-[a-f0-9]{32}\\.json' '0'$`));
      const prepare = calls.findIndex(call => call[0] === "ssh" && call.at(-1).includes("umask 077"));
      const upload = calls.findIndex(call => call[0] === "scp" && call.at(-1).includes("ozon-erp-ai-material-"));
      assert.ok(prepare >= 0 && upload > prepare);
      assert.match(calls.at(-1).at(-1), /^rm -f -- '\/tmp\/ozon-erp-ai-material-/);
    }
    await fsPromises.writeFile(trace, "");
    await execute(["--allow-service-interruption", "--skip-database-maintenance"]);
    const maintenanceCalls = (await fsPromises.readFile(trace, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.match(maintenanceCalls.find(call => call[0] === "ssh" && call.at(-1).startsWith("bash ")).at(-1), /'1' '0' '' '[^']+\.json' '1'$/);
    await fsPromises.writeFile(trace, "");
    await assert.rejects(execute([], { OZON_DEPLOY_BASH_UPLOAD_EXIT: "41" }));
    const failedCalls = (await fsPromises.readFile(trace, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.match(failedCalls.at(-1).at(-1), /^rm -f -- '\/tmp\/ozon-erp-ai-material-/);
    assert.equal(failedCalls.some(call => call[0] === "ssh" && call.at(-1).startsWith("bash ")), false);
    await fsPromises.writeFile(trace, "");
    const { stdout } = await execute(["--dry-run"]);
    assert.equal(await fsPromises.readFile(trace, "utf8"), "");
    assert.match(stdout, /'1' '0' '' '\/tmp\/ozon-erp-ai-material-fixture-[a-f0-9]{32}\.json'/);
    assert.doesNotMatch(stdout, /MATERIAL_CONTENT_MUST_NOT_BE_PRINTED/);
    await fsPromises.writeFile(material,"MATERIAL_CONTENT_MUST_NOT_BE_PRINTED invalid JSON");
    await assert.rejects(execute(["--dry-run"]),error => /not valid JSON/.test(error.stderr) && !/MATERIAL_CONTENT_MUST_NOT_BE_PRINTED/.test(error.stderr));
  } finally { await fsPromises.rm(fixture, { recursive: true, force: true }); }
});

test("remote private material manifests are removed on both success and failure exits", { skip: missingGitBash }, async () => {
  const cleanup = remote.match(/^cleanup_material_manifest\(\) \{\r?\n[\s\S]*?^\}\r?\n/m)?.[0];
  assert.ok(cleanup);
  for (const status of [0, 42]) {
    const { stdout } = await execFileAsync(bashExecutable, ["--noprofile", "--norc", "-c", `
set -Eeuo pipefail
manifest="$(mktemp /tmp/ozon-erp-ai-material-fixture.XXXXXX.json)"
printf '{}' > "$manifest"
${cleanup.replaceAll("\r\n", "\n")}
if (reviewed_ai_material_manifest="$manifest"; trap cleanup_material_manifest EXIT; exit ${status}); then actual=0; else actual=$?; fi
[[ "$actual" == '${status}' ]]
[[ ! -e "$manifest" ]]
printf 'removed'
`], { env: { ...process.env, BASH_ENV: "" } });
    assert.equal(stdout, "removed");
  }
});

test("candidate uses a bounded cold-start deadline and a rejected release leaves the primary running", { skip: missingGitBash }, async () => {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-material-warmup-"));
  try {
    const start = remote.match(/^start_candidate\(\) \{\r?\n[\s\S]*?^\}\r?\n(?=\r?\ninstall -d)/m)?.[0];
    const rollback = remote.match(/^rollback\(\) \{\r?\n[\s\S]*?^\}\r?\n(?=trap rollback ERR)/m)?.[0];
    const wait = remote.match(/^wait_for_release\(\) \{\r?\n[\s\S]*?^\}\r?\n/m)?.[0];
    assert.ok(start && rollback && wait);
    assert.match(remote, /candidate_warmup_seconds=360/);
    assert.match(start, /wait_for_release "\$candidate_port" "\$release_version" "\$candidate_warmup_seconds"/);
    await fsPromises.mkdir(path.join(fixture,"previous")); await fsPromises.writeFile(path.join(fixture,"env"),"DB_NAME=fixture_only\n");
    const beginning = Date.now();
    await assert.rejects(execFileAsync(bashExecutable,["--noprofile","--norc","-c",`
set -Eeuo pipefail
release_dir="$PWD"
previous_target="$PWD/previous"
current_link="$PWD/current"
env_file="$PWD/env"
candidate_log="$PWD/candidate.log"
candidate_pid_file="$PWD/candidate.pid"
candidate_pid=""
candidate_ready=0
primary_changed=0
candidate_port=8788
release_version=fixture
candidate_warmup_seconds=1
stop_existing_candidate() { :; }
runuser() { printf '424242' > "$candidate_pid_file"; }
kill() { if [[ "$1" != -0 ]]; then printf 'candidate-stop\\n' >> "$PWD/trace"; fi; }
curl() { printf '503'; }
systemctl() { printf '%s\\n' "$*" >> "$PWD/trace"; }
${rollback.replaceAll("\r\n","\n")}
${wait.replaceAll("\r\n","\n")}
${start.replaceAll("\r\n","\n")}
trap rollback ERR
start_candidate
printf 'unexpected acceptance' > "$PWD/accepted"
`],{cwd:fixture,env:{...process.env,BASH_ENV:""}}),error=> /Candidate process did not become ready/.test(error.stderr));
    assert.ok(Date.now()-beginning < 7000,"candidate deadline must bound the complete warmup");
    assert.doesNotMatch(await fsPromises.readFile(path.join(fixture,"trace"),"utf8"),/restart ozon-erp/);
    await assert.rejects(fsPromises.access(path.join(fixture,"accepted")),{code:"ENOENT"});
  } finally {await fsPromises.rm(fixture,{recursive:true,force:true});}
});

test("material preflight is read only, requires complete review and refuses active work before stopping writers", { skip: missingGitBash }, async () => {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-material-plan-"));
  try {
    const helper = remote.match(/^material_optimization_preflight\(\) \{\r?\n[\s\S]*?^\}\r?\n(?=\r?\nbackup_database)/m)?.[0];
    assert.ok(helper);
    await fsPromises.mkdir(path.join(fixture, "scripts")); await fsPromises.mkdir(path.join(fixture, "node_modules", "mysql2"), { recursive: true });
    await fsPromises.writeFile(path.join(fixture, "env"), "DB_NAME=fixture_only\n");
    await fsPromises.writeFile(path.join(fixture, "manifest.json"), JSON.stringify({ reason: "MATERIAL_CONTENT_MUST_NOT_BE_PRINTED" }));
    await fsPromises.writeFile(path.join(fixture, "node_modules", "mysql2", "package.json"), JSON.stringify({ type: "module", exports: { "./promise": "./promise.js" } }));
    await fsPromises.writeFile(path.join(fixture, "node_modules", "mysql2", "promise.js"), `export default {createConnection:async()=>({execute:async()=>[[{}]],query:async()=>[[{n:Number(process.env.MATERIAL_ACTIVE||0)}]],end:async()=>{}})};`);
    await fsPromises.writeFile(path.join(fixture, "scripts", "migrate-tenant-ai-material-optimization.mjs"), `export async function migrateTenantAiMaterialOptimization(_connection, options) { if (options.apply) throw Error("Unexpected apply in preflight"); if (process.env.MATERIAL_EXPECT_REVIEW && options.reviewManifest?.reason !== "MATERIAL_CONTENT_MUST_NOT_BE_PRINTED") throw Error("Manifest not forwarded"); return JSON.parse(process.env.MATERIAL_PLAN); }`);
    const execute = (plan, active = 0, manifest = "") => execFileAsync(bashExecutable, ["--noprofile", "--norc", "-c", `
set -Eeuo pipefail
staging_dir="$PWD"
env_file="$PWD/env"
reviewed_ai_material_manifest="${manifest ? "$PWD/manifest.json" : ""}"
${helper.replaceAll("\r\n", "\n")}
material_optimization_preflight
`], { cwd: fixture, env: { ...process.env, BASH_ENV: "", MATERIAL_PLAN: JSON.stringify(plan), MATERIAL_ACTIVE: String(active), MATERIAL_EXPECT_REVIEW: manifest } });
    const ready = { review: [], reviewed_batches: [], tables: [] };
    assert.equal((await execute(ready, 3)).stdout, "ready", "no schema change must not interrupt compatible running jobs");
    assert.equal((await execute({ ...ready, tables: [{ create: true }] })).stdout, "change");
    assert.equal((await execute({ ...ready, reviewed_batches: [{ batch_id: 1 }] }, 0, "yes")).stdout, "change");
    await assert.rejects(execute({ ...ready, review: [{ id: 1 }] }), error => /explicit complete reviewed manifest/.test(error.stderr));
    await assert.rejects(execute({ ...ready, tables: [{ create: true }] }, 1), error => /queued or running/.test(error.stderr));
  } finally { await fsPromises.rm(fixture, { recursive: true, force: true }); }
});

test("material migration is backed up, rechecks after a short stop, skips no-op changes and restores primary on failure", { skip: missingGitBash }, async () => {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-material-hook-"));
  try {
    const gate = remote.match(/^if \[\[ "\$run_db_maintenance" == "1"[^\r\n]*\r?\n  backup_database\r?\nfi/m)?.[0];
    const earlyStart = remote.indexOf('if [[ -f "$staging_dir/scripts/migrate-tenant-ai-material-optimization.mjs" ]]; then', remote.indexOf("npm ci --omit=dev"));
    const early = remote.slice(earlyStart, remote.indexOf('\n\nif [[ "$run_db_maintenance"', earlyStart));
    const hookStart = remote.indexOf('# Material jobs must have reviewed ownership');
    const hook = remote.slice(hookStart, remote.indexOf('\n# This additive schema', hookStart));
    const rollback = remote.match(/^rollback\(\) \{\r?\n[\s\S]*?^\}\r?\n(?=trap rollback ERR)/m)?.[0];
    const policy = remote.match(/^assert_release_interruption_policy\(\) \{\r?\n[\s\S]*?^\}\r?\n/m)?.[0];
    assert.ok(gate && early && hook && rollback && policy);
    assert.ok(remote.indexOf("\n  backup_database\n") < hookStart && hookStart < remote.indexOf("\nstart_candidate\n"));
    await fsPromises.mkdir(path.join(fixture, "scripts")); await fsPromises.mkdir(path.join(fixture, "previous"));
    await fsPromises.writeFile(path.join(fixture, "scripts", "migrate-tenant-ai-material-optimization.mjs"), "fixture");
    await fsPromises.writeFile(path.join(fixture, "env"), "DB_NAME=fixture_only\n");
    for (const scenario of ["change", "ready", "early-refusal", "second-refusal", "apply-failure"]) {
      const trace = path.join(fixture, "trace"); await fsPromises.writeFile(trace, "");
      const execute = () => execFileAsync(bashExecutable, ["--noprofile", "--norc", "-c", `
set -Eeuo pipefail
staging_dir="$PWD"
env_file="$PWD/env"
current_link="$PWD/current"
previous_target="$PWD/previous"
candidate_pid=""
candidate_ready=0
candidate_pid_file="$PWD/candidate.pid"
primary_changed=0
previous_version=fixture
rollback_warmup_seconds=1
allow_service_interruption=1
run_db_maintenance=0
reviewed_identity_manifest=""
reviewed_ai_material_manifest="/tmp/ozon-erp-ai-material-fixture.json"
material_change_required=ready
pending_schema_migrations=""
plan_database_changes() { :; }
install_storage_collector() { :; }
material_optimization_preflight() {
  printf 'preflight\\n' >> "$PWD/trace"
  local count; count="$(wc -l < "$PWD/trace")"
  if [[ "${scenario}" == early-refusal || ("${scenario}" == second-refusal && "$count" -gt 1) ]]; then return 41; fi
  printf '%s' '${scenario === "ready" ? "ready" : "change"}'
}
backup_database() { printf 'backup\\n' >> "$PWD/trace"; }
stop_existing_candidate() { printf 'stop-candidate\\n' >> "$PWD/trace"; }
systemctl() { printf 'service %s\\n' "$*" >> "$PWD/trace"; }
node() { printf 'apply %s\\n' "$*" >> "$PWD/trace"; return ${scenario === "apply-failure" ? 42 : 0}; }
wait_for_release() { return 0; }
${rollback.replaceAll("\r\n", "\n")}
${policy.replaceAll("\r\n", "\n")}
trap rollback ERR
${early}
${gate}
${hook}
printf 'candidate\\n' >> "$PWD/trace"
`], { cwd: fixture, env: { ...process.env, BASH_ENV: "" } });
      if (scenario.includes("refusal") || scenario === "apply-failure") await assert.rejects(execute()); else await execute();
      const lines = (await fsPromises.readFile(trace, "utf8")).trim().split(/\r?\n/);
      if (scenario === "early-refusal") assert.deepEqual(lines, ["preflight"]);
      else if (scenario === "ready") assert.deepEqual(lines, ["preflight", "backup", "candidate"]);
      else {
        assert.deepEqual(lines.slice(0, 5), ["preflight", "backup", "stop-candidate", "service stop ozon-erp", "preflight"]);
        if (scenario !== "second-refusal") assert.match(lines[5], /^apply scripts\/migrate-tenant-ai-material-optimization\.mjs --apply .*--review-manifest=\/tmp\/ozon-erp-ai-material-fixture\.json$/);
        if (scenario === "change") assert.equal(lines.at(-1), "candidate");
        else { assert.equal(lines.at(-1), "service restart ozon-erp"); assert.ok(!lines.includes("candidate")); }
      }
    }
  } finally { await fsPromises.rm(fixture, { recursive: true, force: true }); }
});

test("membership schemas require a verified backup and run before the candidate even with maintenance skipped", { skip: missingGitBash }, async () => {
  const fixtureDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-membership-deploy-"));
  try {
    const gate = remote.match(/^if \[\[ "\$run_db_maintenance" == "1"[^\r\n]*\r?\n  backup_database\r?\nfi/m)?.[0];
    const hookStart = remote.indexOf("for membership_schema in ");
    const hookEnd = remote.indexOf("\n# Tenant-aware order sync", hookStart);
    assert.ok(gate && hookStart > remote.indexOf("\n  backup_database\n") && hookEnd > hookStart);
    assert.ok(hookStart < remote.indexOf("\nstart_candidate\n"));
    const hook = remote.slice(hookStart, hookEnd);
    assert.doesNotMatch(hook, /review-people-account-kinds|assign-legacy|migrate-platform-enterprise-identities/);
    await fsPromises.mkdir(path.join(fixtureDir, "scripts"));
    await fsPromises.writeFile(path.join(fixtureDir, "env"), "DB_NAME=isolated_schema_fixture\n", "utf8");
    for (const schema of ["migrate-enterprise-messages.mjs", "migrate-subscription-vouchers.mjs"]) {
      const file = path.join(fixtureDir, "scripts", schema);
      await fsPromises.writeFile(file, "fixture", "utf8");
      const { stdout } = await execFileAsync(bashExecutable, ["--noprofile", "--norc", "-c", `
        set -Eeuo pipefail
        staging_dir="$PWD"
        env_file="$PWD/env"
        run_db_maintenance=0
        reviewed_identity_manifest=""
        reviewed_ai_material_manifest=""
        pending_schema_migrations="${schema}"
        material_change_required=ready
        migration_pending() { [[ "$1" == "${schema}" ]]; }
        backup_database() { printf 'backup-required\\n'; }
        node() { printf '%s\\n' "$*"; }
        ${gate}
        ${hook}
      `], { cwd: fixtureDir, env: { ...process.env, BASH_ENV: "" } });
      const lines = stdout.trim().split(/\r?\n/);
      assert.deepEqual(lines, ["backup-required", `scripts/${schema} --database=isolated_schema_fixture --mysql-admin-socket=/var/run/mysqld/mysqld.sock`, `scripts/${schema} --apply --database=isolated_schema_fixture --mysql-admin-socket=/var/run/mysqld/mysqld.sock`]);
      await fsPromises.rm(file);
    }
  } finally {
    await fsPromises.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("actual pending schemas and explicit maintenance require backup; packaged no-op schemas do not", { skip: missingGitBash }, async () => {
  const fixtureDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-backup-gate-"));
  try {
    const gate = remote.match(/^if \[\[ "\$run_db_maintenance" == "1"[^\r\n]*\r?\n  backup_database\r?\nfi/m)?.[0];
    assert.ok(gate, "execute the release's actual backup gate");
    await fsPromises.mkdir(path.join(fixtureDir, "scripts"));
    for (const [maintenance, manifest, profitSchema, pending, expected] of [["0", "", true, true, true], ["0", "", true, false, false], ["0", "", false, false, false], ["1", "", false, false, true], ["0", "reviewed.json", false, false, true]]) {
      const schema = path.join(fixtureDir, "scripts", "migrate-order-profit-calculation-versions.mjs");
      if (profitSchema) await fsPromises.writeFile(schema, "fixture", "utf8");
      else await fsPromises.rm(schema, { force: true });
      const { stdout } = await execFileAsync(bashExecutable, ["--noprofile", "--norc", "-c", `
        set -Eeuo pipefail
        staging_dir="$PWD"
        run_db_maintenance="${maintenance}"
        reviewed_identity_manifest="${manifest}"
        reviewed_ai_material_manifest=""
        pending_schema_migrations="${pending ? "migrate-order-profit-calculation-versions.mjs" : ""}"
        material_change_required=ready
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
        staging_dir="$PWD/staging"
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
  assert.match(remote, /wait_for_release 3000 "\$release_version"/);
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
  assert.match(remote, /wait_for_release "\$candidate_port" "\$release_version"/);
  assert.match(remote, /wait_for_release 3000 "\$release_version"/);
});

test("ECS release migrates tenant ownership dependencies before starting order sync", () => {
  assert.match(remote, /migration_args=\(--apply --mysql-admin-socket=\/var\/run\/mysqld\/mysqld\.sock\)/);
  assert.match(remote, /node "scripts\/\$tenant_migration" "\$\{migration_args\[@\]\}"/);
  assert.match(remote, /migration_args\+=\(--assign-legacy-platform-default\)/);
  assert.ok(remote.indexOf("migrate-tenant-products-ownership.mjs") < remote.indexOf("migrate-tenant-sku-mappings.mjs"));
  assert.ok(remote.indexOf("migrate-tenant-sku-mappings.mjs") < remote.indexOf("migrate-tenant-logistics-rules.mjs"));
  assert.ok(remote.indexOf("migrate-tenant-logistics-rules.mjs") < remote.indexOf("\nstart_candidate\n"));
  assert.ok(remote.indexOf("migrate-tenant-logistics-rules.mjs") < remote.indexOf("migrate-tenant-asset-variant-config.mjs"));
  assert.ok(remote.indexOf("for membership_schema") < remote.indexOf("for tenant_migration"));
  assert.ok(remote.indexOf("migrate-enterprise-messages.mjs") < remote.indexOf("\nstart_candidate\n"));
  assert.ok(remote.indexOf("migrate-tenant-asset-variant-config.mjs") < remote.indexOf("\nstart_candidate\n"));
});

test("ECS release applies versioned OGL rates before activating the candidate", () => {
  assert.match(remote, /node scripts\/apply-ogl-rates\.mjs --apply/);
  assert.ok(remote.indexOf("migrate-tenant-logistics-rules.mjs") < remote.indexOf("node scripts/apply-ogl-rates.mjs --apply"));
  assert.ok(remote.indexOf("node scripts/apply-ogl-rates.mjs --apply") < remote.indexOf("\nstart_candidate\n"));
});
