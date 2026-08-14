import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const backupScript = fs.readFileSync("deploy/windows-host/backup-mysql.ps1", "utf8");
const registerTasksScript = fs.readFileSync("deploy/windows-host/register-host-tasks.ps1", "utf8");
const updateScript = fs.readFileSync("deploy/windows-host/update-host-stack.ps1", "utf8");

test("MySQL backups live outside deploy artifacts and retain only the newest compressed dump", () => {
  assert.match(backupScript, /ProgramData.*OzonERP\\backups\\mysql/);
  assert.match(backupScript, /MYSQL_BACKUP_DIR/);
  assert.match(backupScript, /GZipStream/);
  assert.match(backupScript, /Select-Object -Skip 1/);
  assert.doesNotMatch(backupScript, /dist\\deploy\\backups\\mysql/);
});

test("automatic and pre-deploy MySQL backups are disabled by default", () => {
  assert.doesNotMatch(registerTasksScript, /\/SC DAILY/);
  assert.match(registerTasksScript, /schtasks \/Delete .*Ozon ERP MySQL Backup|\$backupTaskName/);
  assert.match(updateScript, /ENABLE_DEPLOY_DB_BACKUP/);
  assert.match(updateScript, /if \(-not \$enableDbBackup\)/);
  assert.doesNotMatch(updateScript, /SKIP_DEPLOY_DB_BACKUP/);
});
