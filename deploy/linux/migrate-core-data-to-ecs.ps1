[CmdletBinding()]
param(
  [switch]$Write,
  [string]$ExistingDump
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$envPath = Join-Path $projectRoot '.env'
$configPath = Join-Path $projectRoot '.deploy-artifacts\ecs-deploy.json'
$artifactRoot = Join-Path $projectRoot '.deploy-artifacts\core-data-migration'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpPath = if ($ExistingDump) { (Resolve-Path -LiteralPath $ExistingDump).Path } else { Join-Path $artifactRoot "core-data-$timestamp.sql" }

# The four large business tables are migrated from the slim staging copies built by
# scripts/build-slim-core-migration-db.mjs. Keeping them out of this operational
# dump prevents accidental multi-gigabyte raw imports on a 40 GB ECS disk.
$tables = @(
  'people', 'shops', 'settings', 'system_settings', 'shop_variant_rules',
  'logistics_fee_rules', 'exchange_rates', 'order_cancellation_rules', 'order_quality_rules',
  'suppliers', 'product_components', 'online_products', 'sku_mappings',
  'sku_inventory_recipes', 'sku_inventory_recipe_items',
  'orders', 'order_items', 'ozon_orders_raw', 'order_marks', 'order_label_prints',
  'order_item_procurement_marks', 'order_profit_items', 'outbound_records',
  'inventory_movements', 'inventory_current', 'stock_warehouse_rules',
  'procurement_requests', 'purchase_orders', 'purchase_order_items', 'inbound_records',
  'listing_variant_workbench_drafts', 'listing_shop_copies',
  'asset_tail_templates', 'asset_vehicle_models', 'asset_variant_jobs', 'asset_variants',
  'material_assets', 'media_migration_map'
)

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
  $arguments = @($options) + @("$($config.user)@$($config.host)", "echo $encoded | base64 -d | bash")
  $output = & ssh @arguments
  if ($LASTEXITCODE -ne 0) { throw "ECS remote command failed with exit code $LASTEXITCODE." }
  return $output
}

if (-not (Test-Path -LiteralPath $envPath)) { throw "Local configuration not found: $envPath" }
if (-not (Test-Path -LiteralPath $configPath)) { throw "ECS deployment configuration not found: $configPath" }
$envMap = Read-EnvFile $envPath
foreach ($key in @('DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER')) {
  if (-not $envMap[$key]) { throw "Local .env is missing $key." }
}

$mysql = Resolve-MySqlTool 'mysql'
$mysqldump = Resolve-MySqlTool 'mysqldump'
$ecsConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$tableSqlList = ($tables | ForEach-Object { "'$_'" }) -join ','
$signatureSql = @"
SELECT CONCAT(table_name, '.', column_name)
FROM information_schema.columns
WHERE table_schema=DATABASE() AND table_name IN ($tableSqlList)
ORDER BY table_name, ordinal_position;
"@

$env:MYSQL_PWD = [string]$envMap['DB_PASSWORD']
try {
  $localSignature = & $mysql '--batch' '--skip-column-names' "--host=$($envMap['DB_HOST'])" "--port=$($envMap['DB_PORT'])" "--user=$($envMap['DB_USER'])" "--database=$($envMap['DB_NAME'])" "--execute=$signatureSql"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to read the local database schema.' }
} finally { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }

$signatureBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($signatureSql))
$remoteSignatureScript = @'
set -e
set -a
. /etc/ozon-erp/ozon-erp.env
set +a
printf '%s' '__SIGNATURE_SQL__' | base64 -d | MYSQL_PWD="$DB_PASSWORD" mysql -N -B -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME"
'@
$remoteSignature = Invoke-RemoteScript ($remoteSignatureScript.Replace('__SIGNATURE_SQL__', $signatureBase64)) $ecsConfig
$localColumns = @($localSignature | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
$remoteColumns = @($remoteSignature | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
$localOnlyColumns = @(Compare-Object $localColumns $remoteColumns | Where-Object { $_.SideIndicator -eq '<=' })
if ($localOnlyColumns.Count -gt 0) {
  Write-Host 'Columns required by local data but missing on ECS:'
  $localOnlyColumns | Format-Table -AutoSize | Out-Host
  throw 'ECS is missing columns required by the local core data export.'
}

Write-Host "Schema validation passed: $($tables.Count) core tables."
if (-not $Write) {
  Write-Host 'Read-only preflight completed. Use -Write to back up and migrate.'
  exit 0
}

New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
if (-not $ExistingDump) {
  $env:MYSQL_PWD = [string]$envMap['DB_PASSWORD']
  try {
    & $mysqldump '--default-character-set=utf8mb4' '--single-transaction' '--quick' '--hex-blob' '--complete-insert' '--no-create-info' '--skip-triggers' '--no-tablespaces' "--host=$($envMap['DB_HOST'])" "--port=$($envMap['DB_PORT'])" "--user=$($envMap['DB_USER'])" "--result-file=$dumpPath" $envMap['DB_NAME'] @tables
    if ($LASTEXITCODE -ne 0) { throw "Local core data export failed with exit code $LASTEXITCODE." }
  } finally { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
}
if (-not (Test-Path -LiteralPath $dumpPath) -or (Get-Item -LiteralPath $dumpPath).Length -le 0) { throw 'The local core data export is empty.' }
$dumpTail = (Get-Content -LiteralPath $dumpPath -Tail 8 -Encoding UTF8) -join "`n"
if ($dumpTail -notmatch 'Dump completed') { throw 'The selected core data export is incomplete.' }

$compressedDumpPath = "$dumpPath.gz"
if (-not (Test-Path -LiteralPath $compressedDumpPath)) {
  Write-Host "Compressing core data export: $dumpPath"
  $inputStream = [IO.File]::OpenRead($dumpPath)
  $outputStream = [IO.File]::Create($compressedDumpPath)
  try {
    $gzipStream = [IO.Compression.GZipStream]::new($outputStream, [IO.Compression.CompressionLevel]::Optimal, $true)
    try { $inputStream.CopyTo($gzipStream, 1048576) } finally { $gzipStream.Dispose() }
  } finally {
    $inputStream.Dispose()
    $outputStream.Dispose()
  }
}
if ((Get-Item -LiteralPath $compressedDumpPath).Length -le 0) { throw 'The compressed core data export is empty.' }

$remoteDump = "/tmp/ozon-erp-core-data-$timestamp.sql.gz"
$scpOptions = @('-P', [string]$ecsConfig.port, '-o', 'BatchMode=yes')
if ($ecsConfig.identityFile) { $scpOptions += @('-i', [string]$ecsConfig.identityFile) }
$scpArguments = @($scpOptions) + @($compressedDumpPath, "$($ecsConfig.user)@$($ecsConfig.host):$remoteDump")
& scp @scpArguments
if ($LASTEXITCODE -ne 0) { throw "Core data upload failed with exit code $LASTEXITCODE." }

$remoteTables = $tables -join ' '
$truncateSql = 'SET FOREIGN_KEY_CHECKS=0;' + (($tables | ForEach-Object { "TRUNCATE TABLE ``$_``;" }) -join '') + 'SET FOREIGN_KEY_CHECKS=1;'
$truncateBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($truncateSql))
$remoteMigrationScript = @'
set -euo pipefail
set -a
. /etc/ozon-erp/ozon-erp.env
set +a
STAMP="__STAMP__"
REMOTE_DUMP="__REMOTE_DUMP__"
BACKUP_DIR="/opt/ozon-erp/shared/backups/core-data"
BACKUP_FILE="$BACKUP_DIR/target-before-core-$STAMP.sql.gz"
TABLES="__TABLES__"
TRUNCATE_B64="__TRUNCATE_SQL__"
mkdir -p "$BACKUP_DIR"
MYSQL=(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME")
DUMP=(mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --single-transaction --quick --hex-blob --complete-insert --no-create-info --skip-triggers --no-tablespaces "$DB_NAME")
export MYSQL_PWD="$DB_PASSWORD"
"${DUMP[@]}" $TABLES | gzip -9 > "$BACKUP_FILE"
systemctl stop ozon-erp
restore_target() {
  printf '%s' "$TRUNCATE_B64" | base64 -d | "${MYSQL[@]}" || true
  if [ -s "$BACKUP_FILE" ]; then { printf '%s\n' 'SET FOREIGN_KEY_CHECKS=0;'; gzip -dc "$BACKUP_FILE"; printf '%s\n' 'SET FOREIGN_KEY_CHECKS=1;'; } | "${MYSQL[@]}" || true; fi
  systemctl start ozon-erp || true
}
trap restore_target ERR
printf '%s' "$TRUNCATE_B64" | base64 -d | "${MYSQL[@]}"
{ printf '%s\n' 'SET FOREIGN_KEY_CHECKS=0;'; gzip -dc "$REMOTE_DUMP"; printf '%s\n' 'SET FOREIGN_KEY_CHECKS=1; DELETE FROM sessions;'; } | "${MYSQL[@]}"
systemctl start ozon-erp
sleep 5
systemctl is-active --quiet ozon-erp
trap - ERR
rm -f "$REMOTE_DUMP"
echo "CORE_MIGRATION_OK backup=$BACKUP_FILE"
'@
$remoteMigrationScript = $remoteMigrationScript.Replace('__STAMP__', $timestamp).Replace('__REMOTE_DUMP__', $remoteDump).Replace('__TABLES__', $remoteTables).Replace('__TRUNCATE_SQL__', $truncateBase64)
Invoke-RemoteScript $remoteMigrationScript $ecsConfig
Write-Host "Core data migration completed: $dumpPath"
