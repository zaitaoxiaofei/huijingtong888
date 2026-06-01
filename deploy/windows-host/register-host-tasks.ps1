$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$hostStackScript = Join-Path $PSScriptRoot "start-host-stack.ps1"
$backupScript = Join-Path $PSScriptRoot "backup-mysql.ps1"

if (-not (Test-Path $hostStackScript)) {
  throw "Host stack script not found: $hostStackScript"
}

if (-not (Test-Path $backupScript)) {
  throw "Backup script not found: $backupScript"
}

$hostTaskName = "Ozon ERP Host Stack"
$backupTaskName = "Ozon ERP MySQL Backup"

$hostAction = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$hostStackScript`""
$backupAction = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$backupScript`""

schtasks /Create /F /TN $hostTaskName /SC ONSTART /DELAY 0000:45 /RL HIGHEST /TR $hostAction | Out-Null
schtasks /Create /F /TN $backupTaskName /SC DAILY /ST 03:15 /RL HIGHEST /TR $backupAction | Out-Null

Write-Host "Scheduled tasks registered:"
Write-Host "  $hostTaskName"
Write-Host "  $backupTaskName"
