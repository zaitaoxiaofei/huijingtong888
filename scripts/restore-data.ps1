param(
  [string]$BackupZip = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

if (-not $BackupZip) {
  $LatestBackup = Get-ChildItem ".\backups\ozon-data-*.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $LatestBackup) {
    throw "No backup zip was found in .\backups. Pass a backup zip path to restore-data.bat or scripts\restore-data.ps1."
  }

  $BackupZip = $LatestBackup.FullName
}

$BackupZipPath = Resolve-Path $BackupZip
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$TempDir = Join-Path $ProjectRoot ".restore-temp-$Stamp"
$CurrentDataBackup = Join-Path $ProjectRoot "backups\before-restore-$Stamp"

try {
  if (Test-Path $TempDir) {
    Remove-Item $TempDir -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
  Expand-Archive -Path $BackupZipPath -DestinationPath $TempDir -Force

  $SourceDataDir = Join-Path $TempDir "data"
  $SourceDatabase = Join-Path $SourceDataDir "ozon-profit-hub.sqlite"

  if (-not (Test-Path $SourceDatabase)) {
    throw "The selected zip does not contain data\ozon-profit-hub.sqlite."
  }

  if (Test-Path ".\data") {
    New-Item -ItemType Directory -Force -Path $CurrentDataBackup | Out-Null
    Copy-Item ".\data\*" $CurrentDataBackup -Recurse -Force
    Write-Host "Current data was backed up to:"
    Write-Host $CurrentDataBackup
  }

  New-Item -ItemType Directory -Force -Path ".\data" | Out-Null
  Remove-Item ".\data\ozon-profit-hub.sqlite*" -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $SourceDataDir "ozon-profit-hub.sqlite*") ".\data" -Force

  Write-Host ""
  Write-Host "Data restored from:"
  Write-Host $BackupZipPath
  Write-Host ""
  Write-Host "Start Ozon Profit Hub and check shops, inbound, outbound, and inventory tables."
} finally {
  if (Test-Path $TempDir) {
    Remove-Item $TempDir -Recurse -Force
  }
}
