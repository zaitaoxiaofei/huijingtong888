param(
  [string]$DeployDir = "",
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($DeployDir)) {
  $liveDir = Join-Path $root "dist\live"
  $deployDir = if (Test-Path $liveDir) { $liveDir } else { Join-Path $root "dist\deploy" }
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

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($existing) {
  Write-Host "Stopping existing ERP listener on ${Port}: $($existing -join ', ')"
  foreach ($procId in $existing) {
    try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
  }
  Start-Sleep -Seconds 2
}

Write-Host "Starting ERP server from $deployDir on port $Port"
Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList "/d", "/s", "/c", "set PORT=$Port&& node src/server.js 1>> `"$outLog`" 2>> `"$errLog`"" `
  -WorkingDirectory $deployDir `
  -WindowStyle Hidden

Start-Sleep -Seconds 3
$started = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $started) {
  throw "ERP server did not start on port $Port. Check $outLog and $errLog"
}

Write-Host "ERP server is listening on 127.0.0.1:$Port"
Write-Host "Logs:"
Write-Host "  $outLog"
Write-Host "  $errLog"
