[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{4}-\d{2}$')]
  [string]$Month,
  [switch]$Write
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$envPath = Join-Path $projectRoot '.env'
$configPath = Join-Path $projectRoot '.deploy-artifacts\ecs-deploy.json'
$artifactRoot = Join-Path $projectRoot '.deploy-artifacts\advertising-month-sync'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$monthStart = "$Month-01"
$monthStartDate = [DateTime]::ParseExact($monthStart, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$monthEndExclusive = $monthStartDate.AddMonths(1).ToString('yyyy-MM-dd')
$dumpPath = Join-Path $artifactRoot "ozon-ad-$Month-$timestamp.sql"

function Read-EnvFile([string]$path) {
  $map = @{}
  Get-Content -LiteralPath $path -Encoding UTF8 | ForEach-Object {
    $line = [string]$_
    if ($line -match '^\s*#' -or $line -notmatch '=') { return }
    $parts = $line -split '=', 2
    $map[$parts[0].Trim()] = $parts[1]
  }
  return $map
}

function Resolve-MySqlTool([string]$name) {
  $known = "C:\Program Files\MySQL\MySQL Server 8.4\bin\$name.exe"
  if (Test-Path -LiteralPath $known) { return $known }
  $command = Get-Command "$name.exe" -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "Cannot find $name.exe."
}

function Get-SshOptions([object]$config) {
  $options = @('-p', [string]$config.port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')
  if ($config.identityFile) { $options += @('-i', [string]$config.identityFile) }
  return $options
}

function Invoke-RemoteScript([string]$script, [object]$config) {
  $options = Get-SshOptions $config
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
  $output = & ssh @options "$($config.user)@$($config.host)" "echo $encoded | base64 -d | bash"
  if ($LASTEXITCODE -ne 0) { throw "ECS remote command failed with exit code $LASTEXITCODE." }
  return $output
}

if (-not (Test-Path -LiteralPath $envPath)) { throw "Local configuration not found: $envPath" }
if (-not (Test-Path -LiteralPath $configPath)) { throw "ECS deployment configuration not found: $configPath" }

$envMap = Read-EnvFile $envPath
foreach ($key in @('DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD')) {
  if (-not $envMap[$key]) { throw "Local .env is missing $key." }
}

$mysql = Resolve-MySqlTool 'mysql'
$mysqldump = Resolve-MySqlTool 'mysqldump'
$ecsConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$summarySql = "SELECT COUNT(*), ROUND(COALESCE(SUM(spend_cny),0),2) FROM ozon_ad_sku_daily WHERE date_key >= '$monthStart' AND date_key < '$monthEndExclusive';"

$env:MYSQL_PWD = [string]$envMap['DB_PASSWORD']
try {
  $localSummary = & $mysql '--batch' '--skip-column-names' "--host=$($envMap['DB_HOST'])" "--port=$($envMap['DB_PORT'])" "--user=$($envMap['DB_USER'])" "--database=$($envMap['DB_NAME'])" "--execute=$summarySql"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to read local advertising data.' }
} finally { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }

$remoteSummaryScript = @'
set -euo pipefail
set -a
. /etc/ozon-erp/ozon-erp.env
set +a
MYSQL_PWD="$DB_PASSWORD" mysql -N -B -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" -e "__SUMMARY_SQL__"
'@
$remoteSummaryScript = $remoteSummaryScript.Replace('__SUMMARY_SQL__', $summarySql)
$remoteSummary = Invoke-RemoteScript $remoteSummaryScript $ecsConfig

Write-Host "Month: $Month"
Write-Host "Local (rows / spend CNY): $localSummary"
Write-Host "ECS   (rows / spend CNY): $remoteSummary"
if (-not $Write) {
  Write-Host 'Read-only preflight completed. Use -Write to synchronize.'
  exit 0
}

New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$where = "date_key >= '$monthStart' AND date_key < '$monthEndExclusive'"
$env:MYSQL_PWD = [string]$envMap['DB_PASSWORD']
try {
  & $mysqldump '--default-character-set=utf8mb4' '--single-transaction' '--quick' '--hex-blob' '--complete-insert' '--replace' '--no-create-info' '--skip-triggers' '--no-tablespaces' "--where=$where" "--host=$($envMap['DB_HOST'])" "--port=$($envMap['DB_PORT'])" "--user=$($envMap['DB_USER'])" "--result-file=$dumpPath" $envMap['DB_NAME'] 'ozon_ad_sku_daily'
  if ($LASTEXITCODE -ne 0) { throw "Local advertising export failed with exit code $LASTEXITCODE." }
} finally { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }

if (-not (Test-Path -LiteralPath $dumpPath) -or (Get-Item -LiteralPath $dumpPath).Length -le 0) {
  throw 'Local advertising export is empty.'
}

$remoteDump = "/tmp/ozon-ad-$Month-$timestamp.sql"
$scpOptions = @('-P', [string]$ecsConfig.port, '-o', 'BatchMode=yes')
if ($ecsConfig.identityFile) { $scpOptions += @('-i', [string]$ecsConfig.identityFile) }
& scp @scpOptions $dumpPath "$($ecsConfig.user)@$($ecsConfig.host):$remoteDump"
if ($LASTEXITCODE -ne 0) { throw "Advertising data upload failed with exit code $LASTEXITCODE." }

$remoteWriteScript = @'
set -euo pipefail
set -a
. /etc/ozon-erp/ozon-erp.env
set +a
backup="/root/ozon-ad-__MONTH__-before-__TIMESTAMP__.sql"
where_clause="date_key >= '__MONTH_START__' AND date_key < '__MONTH_END__'"
MYSQL_PWD="$DB_PASSWORD" mysqldump --default-character-set=utf8mb4 --single-transaction --quick --hex-blob --complete-insert --replace --no-create-info --skip-triggers --no-tablespaces --where="$where_clause" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" ozon_ad_sku_daily > "$backup"
restore() {
  MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" -e "DELETE FROM ozon_ad_sku_daily WHERE $where_clause;"
  MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" < "$backup"
}
trap 'restore; rm -f "__REMOTE_DUMP__"' ERR
MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" -e "DELETE FROM ozon_ad_sku_daily WHERE $where_clause;"
MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" < "__REMOTE_DUMP__"
actual=$(MYSQL_PWD="$DB_PASSWORD" mysql -N -B -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" -e "__SUMMARY_SQL__")
printf 'ECS after synchronization (rows / spend CNY): %s\n' "$actual"
rm -f "__REMOTE_DUMP__"
trap - ERR
'@
$remoteWriteScript = $remoteWriteScript.Replace('__MONTH__', $Month).Replace('__TIMESTAMP__', $timestamp).Replace('__MONTH_START__', $monthStart).Replace('__MONTH_END__', $monthEndExclusive).Replace('__REMOTE_DUMP__', $remoteDump).Replace('__SUMMARY_SQL__', $summarySql)

$result = Invoke-RemoteScript $remoteWriteScript $ecsConfig
$result | ForEach-Object { Write-Host $_ }
Write-Host "ECS backup: /root/ozon-ad-$Month-before-$timestamp.sql"
