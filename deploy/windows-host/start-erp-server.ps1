param(
  [string]$DeployDir = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($DeployDir)) {
  $deployDir = Join-Path $root "dist\deploy"
} else {
  $deployDir = [System.IO.Path]::GetFullPath($DeployDir)
}
$logDir = Join-Path $deployDir "logs"
$outLog = Join-Path $logDir "erp-server.out.log"
$errLog = Join-Path $logDir "erp-server.err.log"

if (-not (Test-Path $deployDir)) {
  throw "Deploy artifact not found: $deployDir. Run 'npm run package:deploy' first."
}

if (-not (Test-Path (Join-Path $deployDir "package.json"))) {
  throw "Deploy package.json not found under $deployDir"
}

if (-not (Test-Path (Join-Path $deployDir ".env"))) {
  throw "Deploy .env not found under $deployDir. Create it before starting the hosted ERP server."
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$existing = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($existing) {
  Write-Host "Stopping existing ERP listener on 8787: $($existing -join ', ')"
  foreach ($procId in $existing) {
    try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
  }
  Start-Sleep -Seconds 2
}

Write-Host "Starting ERP server from $deployDir"
Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList "/d", "/s", "/c", "node src/server.js 1>> `"$outLog`" 2>> `"$errLog`"" `
  -WorkingDirectory $deployDir `
  -WindowStyle Hidden

Start-Sleep -Seconds 3
$started = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $started) {
  throw "ERP server did not start on port 8787. Check $outLog and $errLog"
}

Write-Host "ERP server is listening on 127.0.0.1:8787"
Write-Host "Logs:"
Write-Host "  $outLog"
Write-Host "  $errLog"
