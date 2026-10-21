import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

test("Windows database skip switches preserve defaults and forward all remote release arguments", { skip: process.platform !== "win32" }, async () => {
  const fixtureDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-deploy-flags-"));
  try {
    const scriptDir = path.join(fixtureDir, "deploy", "linux");
    const scriptPath = path.join(scriptDir, "deploy-ecs.ps1");
    const outputDir = path.join(fixtureDir, ".deploy-artifacts", "test-release-package");
    const capturePath = path.join(fixtureDir, "ssh-arguments.json");
    await fsPromises.mkdir(scriptDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    await fsPromises.writeFile(scriptPath, client, "utf8");
    await fsPromises.writeFile(path.join(outputDir, "deploy-manifest.json"), "{}", "utf8");
    for (const [skipInit, skipMaintenance] of [[false, false], [true, false], [false, true], [true, true]]) {
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
        $ErrorActionPreference = 'Stop'
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        function global:tar.exe {
          [System.IO.File]::WriteAllText($args[3], 'test archive')
          $global:LASTEXITCODE = 0
        }
        function global:scp { $global:LASTEXITCODE = 0 }
        function global:ssh {
          [System.IO.File]::WriteAllText($env:OZON_DEPLOY_TEST_CAPTURE, (ConvertTo-Json -InputObject @($args) -Compress), [System.Text.UTF8Encoding]::new($false))
          $global:LASTEXITCODE = 0
        }
        $options = @{ EcsHost = 'deployment.test.invalid'; SshUser = 'test'; SshPort = 22; IdentityFile = ''; Version = 'test-release'; SkipBuild = $true }
        if ($env:OZON_DEPLOY_TEST_SKIP_INIT -eq '1') { $options.SkipDatabaseInit = $true }
        if ($env:OZON_DEPLOY_TEST_SKIP_MAINTENANCE -eq '1') { $options.SkipDatabaseMaintenance = $true }
        & $env:OZON_DEPLOY_TEST_SCRIPT @options
      `], {
        env: {
          ...process.env,
          OZON_DEPLOY_TEST_SCRIPT: scriptPath,
          OZON_DEPLOY_TEST_CAPTURE: capturePath,
          OZON_DEPLOY_TEST_SKIP_INIT: skipInit ? "1" : "0",
          OZON_DEPLOY_TEST_SKIP_MAINTENANCE: skipMaintenance ? "1" : "0"
        }
      });
      const sshArguments = JSON.parse(await fsPromises.readFile(capturePath, "utf8"));
      assert.equal(sshArguments.at(-2), "test@deployment.test.invalid");
      assert.ok(sshArguments.at(-1).endsWith(
        `bash '/tmp/ozon-erp-remote-release.sh' '/tmp/ozon-erp-test-release.zip' 'test-release' '${skipInit ? "0" : "1"}' '${skipMaintenance ? "0" : "1"}'`
      ), `incorrect remote flags for SkipDatabaseInit=${skipInit}, SkipDatabaseMaintenance=${skipMaintenance}`);
    }
  } finally {
    await fsPromises.rm(fixtureDir, { recursive: true, force: true });
  }
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
  assert.match(remote, /node "scripts\/\$tenant_migration" --apply --mysql-admin-socket=\/var\/run\/mysqld\/mysqld\.sock/);
  assert.ok(remote.indexOf("migrate-tenant-products-ownership.mjs") < remote.indexOf("migrate-tenant-sku-mappings.mjs"));
  assert.ok(remote.indexOf("migrate-tenant-sku-mappings.mjs") < remote.indexOf("migrate-tenant-logistics-rules.mjs"));
  assert.ok(remote.indexOf("migrate-tenant-logistics-rules.mjs") < remote.indexOf("\nstart_candidate\n"));
});

test("ECS release applies versioned OGL rates before activating the candidate", () => {
  assert.match(remote, /node scripts\/apply-ogl-rates\.mjs --apply/);
  assert.ok(remote.indexOf("migrate-tenant-logistics-rules.mjs") < remote.indexOf("node scripts/apply-ogl-rates.mjs --apply"));
  assert.ok(remote.indexOf("node scripts/apply-ogl-rates.mjs --apply") < remote.indexOf("\nstart_candidate\n"));
});
