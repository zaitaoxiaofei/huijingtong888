param(
  [switch]$StartTunnel,
  [switch]$StartApp
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$rootDir = Split-Path -Parent $PSScriptRoot
$mysqlHost = "127.0.0.1"
$mysqlPort = 3306
$mysqldPath = if ($env:OZON_MYSQLD_PATH) {
  $env:OZON_MYSQLD_PATH
} else {
  "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe"
}
$mysqlConfigPath = if ($env:OZON_MYSQL_CONFIG) {
  $env:OZON_MYSQL_CONFIG
} else {
  "C:\ProgramData\MySQL\OzonERP\my.ini"
}
$mysqlErrorLog = "C:\ProgramData\MySQL\OzonERP\logs\error.log"
$tunnelScript = Join-Path $rootDir "deploy\cloudflared\start-tunnel.ps1"

function Test-LocalMysqlPort {
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $async = $client.BeginConnect($mysqlHost, $mysqlPort, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(400)) {
      $client.Dispose()
      return $false
    }
    $client.EndConnect($async)
    $client.Dispose()
    return $true
  } catch {
    return $false
  }
}

function Wait-LocalMysqlPort {
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    if (Test-LocalMysqlPort) {
      return
    }
    Start-Sleep -Milliseconds 500
  }

  Write-Host "MySQL did not listen on $mysqlHost`:$mysqlPort within 15 seconds."
  if (Test-Path -LiteralPath $mysqlErrorLog) {
    Write-Host ""
    Write-Host "Recent MySQL error log lines:"
    Get-Content -LiteralPath $mysqlErrorLog -Tail 40
  }
  throw "Local MySQL startup failed."
}

if (-not (Test-LocalMysqlPort)) {
  if (-not (Test-Path -LiteralPath $mysqldPath)) {
    throw "mysqld.exe was not found at $mysqldPath. Set OZON_MYSQLD_PATH to override it."
  }
  if (-not (Test-Path -LiteralPath $mysqlConfigPath)) {
    throw "MySQL config was not found at $mysqlConfigPath. Set OZON_MYSQL_CONFIG to override it."
  }

  Write-Host "Starting local OzonERP MySQL..."
  Start-Process -WindowStyle Hidden -FilePath $mysqldPath -ArgumentList "--defaults-file=$mysqlConfigPath" | Out-Null
  Wait-LocalMysqlPort
} else {
  Write-Host "Local MySQL is already listening on $mysqlHost`:$mysqlPort."
}

Write-Host "Local MySQL is ready on $mysqlHost`:$mysqlPort."

if ($StartTunnel) {
  if (-not (Test-Path -LiteralPath $tunnelScript)) {
    throw "Cloudflare tunnel startup script was not found at $tunnelScript."
  }

  Write-Host "Starting Cloudflare tunnel for erp.hjt888.xyz..."
  & $tunnelScript
}

if ($StartApp) {
  Set-Location -LiteralPath $rootDir
  if (-not $env:PORT) {
    $env:PORT = if ($StartTunnel) { "8787" } else { "8788" }
  }
  if (-not $env:APP_BASE_URL) {
    $env:APP_BASE_URL = "http://localhost:$($env:PORT)"
  }
  Write-Host "Building frontend and starting ERP server..."
  & node scripts/start-with-build.mjs
  exit $LASTEXITCODE
}
