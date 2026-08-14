$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$hostStackScript = Join-Path $PSScriptRoot "start-host-stack.ps1"

if (-not (Test-Path $hostStackScript)) {
  throw "Host stack script not found: $hostStackScript"
}

$hostTaskName = "Ozon ERP Host Stack"
$backupTaskName = "Ozon ERP MySQL Backup"

$hostAction = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$hostStackScript`""

schtasks /Create /F /TN $hostTaskName /SC ONSTART /DELAY 0000:45 /RL HIGHEST /TR $hostAction | Out-Null
schtasks /Delete /F /TN $backupTaskName 2>$null | Out-Null

Write-Host "Scheduled tasks registered:"
Write-Host "  $hostTaskName"
Write-Host "Automatic MySQL backup task is disabled. Run backup-mysql.ps1 manually when needed."
