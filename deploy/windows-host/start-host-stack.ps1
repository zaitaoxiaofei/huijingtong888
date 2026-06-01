param(
  [string]$DeployDir = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverScript = Join-Path $PSScriptRoot "start-erp-server.ps1"
$tunnelScript = Join-Path $root "deploy\cloudflared\start-tunnel.ps1"

if (-not (Test-Path $serverScript)) {
  throw "Server start script not found: $serverScript"
}

if (-not (Test-Path $tunnelScript)) {
  throw "Tunnel start script not found: $tunnelScript"
}

Write-Host "Starting ERP host stack..."
if ([string]::IsNullOrWhiteSpace($DeployDir)) {
  & $serverScript
} else {
  & $serverScript -DeployDir $DeployDir
}
& $tunnelScript
Write-Host "ERP host stack started."
