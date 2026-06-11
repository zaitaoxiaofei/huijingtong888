param(
  [string]$DeployDir = "",
  [int]$Port = 8787,
  [string]$BindHost = "127.0.0.1",
  [string]$AppBaseUrl = ""
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

if ([string]::IsNullOrWhiteSpace($BindHost)) {
  $BindHost = "127.0.0.1"
}

if ([string]::IsNullOrWhiteSpace($AppBaseUrl)) {
  if ($BindHost -eq "0.0.0.0") {
    $lanAddress = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { -not $_.IPAddress.StartsWith("127.") -and $_.IPAddress -notlike "169.254.*" } |
      Sort-Object @{ Expression = { if ($_.IPAddress.StartsWith("192.168.")) { 0 } elseif ($_.IPAddress.StartsWith("10.")) { 1 } else { 2 } } }, InterfaceMetric |
      Select-Object -First 1 -ExpandProperty IPAddress
    if ($lanAddress) {
      $AppBaseUrl = "http://${lanAddress}:$Port"
    }
  } else {
    $AppBaseUrl = "http://${BindHost}:$Port"
  }
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($existing) {
  Write-Host "Stopping existing ERP listener on ${Port}: $($existing -join ', ')"
  foreach ($procId in $existing) {
    try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
  }
  Start-Sleep -Seconds 2
}

$startCommand = "set PORT=$Port&& set HOST=$BindHost"
if (-not [string]::IsNullOrWhiteSpace($AppBaseUrl)) {
  $startCommand = "$startCommand&& set APP_BASE_URL=$AppBaseUrl"
}
$startCommand = "$startCommand&& node src/server.js 1>> `"$outLog`" 2>> `"$errLog`""

Write-Host "Starting ERP server from $deployDir on ${BindHost}:$Port"
Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList "/d", "/s", "/c", $startCommand `
  -WorkingDirectory $deployDir `
  -WindowStyle Hidden

Start-Sleep -Seconds 3
$started = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $started) {
  throw "ERP server did not start on port $Port. Check $outLog and $errLog"
}

Write-Host "ERP server is listening on ${BindHost}:$Port"
if (-not [string]::IsNullOrWhiteSpace($AppBaseUrl)) {
  Write-Host "ERP base URL: $AppBaseUrl"
}
Write-Host "Logs:"
Write-Host "  $outLog"
Write-Host "  $errLog"
