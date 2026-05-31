$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$deployDir = Join-Path $root "dist\deploy"
$backupDir = Join-Path $deployDir "backups\mysql"
$envPath = Join-Path $deployDir ".env"
$mysqldump = "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe"

if (-not (Test-Path $deployDir)) {
  throw "Deploy artifact not found: $deployDir"
}

if (-not (Test-Path $envPath)) {
  throw "Deploy .env not found: $envPath"
}

if (-not (Test-Path $mysqldump)) {
  throw "mysqldump.exe not found: $mysqldump"
}

$envMap = @{}
Get-Content $envPath | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -notmatch '=') { return }
  $parts = $_ -split '=', 2
  $envMap[$parts[0]] = $parts[1]
}

$dbHost = $envMap['DB_HOST']
$dbPort = $envMap['DB_PORT']
$dbName = $envMap['DB_NAME']
$dbUser = $envMap['DB_USER']
$dbPassword = $envMap['DB_PASSWORD']

if (-not $dbHost -or -not $dbPort -or -not $dbName -or -not $dbUser) {
  throw "DB settings are incomplete in $envPath"
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dumpPath = Join-Path $backupDir "$dbName-$timestamp.sql"

$env:MYSQL_PWD = $dbPassword
try {
  & $mysqldump "--host=$dbHost" "--port=$dbPort" "--user=$dbUser" "--default-character-set=utf8mb4" "--single-transaction" "--routines" "--events" "--triggers" "--no-tablespaces" $dbName | Out-File -FilePath $dumpPath -Encoding utf8
} finally {
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
}

Get-ChildItem $backupDir -Filter "*.sql" |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "MySQL backup created: $dumpPath"
