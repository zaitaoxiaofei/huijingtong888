$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$deployDir = Join-Path $root "dist\deploy"
$defaultBackupRoot = Join-Path $env:ProgramData "OzonERP\backups\mysql"
$backupDir = if ($env:MYSQL_BACKUP_DIR) {
  [System.IO.Path]::GetFullPath($env:MYSQL_BACKUP_DIR)
} else {
  $defaultBackupRoot
}
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
$compressedPath = "$dumpPath.gz"

$env:MYSQL_PWD = $dbPassword
try {
  & $mysqldump "--host=$dbHost" "--port=$dbPort" "--user=$dbUser" "--default-character-set=utf8mb4" "--single-transaction" "--routines" "--events" "--triggers" "--no-tablespaces" "--result-file=$dumpPath" $dbName
  if ($LASTEXITCODE -ne 0) {
    throw "mysqldump failed with code $LASTEXITCODE."
  }
} finally {
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
}

if (-not (Test-Path $dumpPath) -or (Get-Item $dumpPath).Length -le 0) {
  throw "MySQL backup is empty: $dumpPath"
}

$inputStream = [System.IO.File]::OpenRead($dumpPath)
$outputStream = [System.IO.File]::Create($compressedPath)
$gzipStream = New-Object System.IO.Compression.GZipStream(
  $outputStream,
  [System.IO.Compression.CompressionMode]::Compress
)
try {
  $inputStream.CopyTo($gzipStream)
} finally {
  $gzipStream.Dispose()
  $outputStream.Dispose()
  $inputStream.Dispose()
}

if (-not (Test-Path $compressedPath) -or (Get-Item $compressedPath).Length -le 0) {
  throw "Compressed MySQL backup is empty: $compressedPath"
}

Remove-Item -LiteralPath $dumpPath -Force

Get-ChildItem $backupDir -File |
  Where-Object { $_.Name -match '\.sql(\.gz)?$' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 1 |
  Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "MySQL backup created: $compressedPath"
