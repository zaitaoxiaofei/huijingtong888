param(
  [string]$BackupDir = ".\backups"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

$NodeCandidates = @(
  "C:\Users\Nice\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe",
  "node"
)

$Node = $null
foreach ($Candidate in $NodeCandidates) {
  try {
    $Command = Get-Command $Candidate -ErrorAction Stop
    $Node = $Command.Source
    break
  } catch {
  }
}

if (-not $Node) {
  throw "Node.js was not found. Install Node.js 22+ or update scripts\backup-data.ps1 with the Node path."
}

Write-Host "Preparing SQLite database..."
& $Node ".\scripts\checkpoint-db.mjs"

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupRoot = Join-Path $ProjectRoot $BackupDir
$WorkDir = Join-Path $BackupRoot "ozon-data-$Stamp"
$ZipPath = Join-Path $BackupRoot "ozon-data-$Stamp.zip"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkDir "data") | Out-Null

Copy-Item -Path ".\data\ozon-profit-hub.sqlite*" -Destination (Join-Path $WorkDir "data") -Force
if (Test-Path ".\.env") {
  Copy-Item ".\.env" $WorkDir -Force
}
Copy-Item ".\.env.example" $WorkDir -Force

@"
Ozon Profit Hub data backup
CreatedAt=$((Get-Date).ToString("s"))
DatabasePath=.\data\ozon-profit-hub.sqlite

Restore:
1. Close the Ozon Profit Hub server/browser tab.
2. Extract this zip into the project root on the target computer.
3. Make sure data\ozon-profit-hub.sqlite exists.
4. Start the project.
"@ | Set-Content -Path (Join-Path $WorkDir "RESTORE-INSTRUCTIONS.txt") -Encoding utf8

if (Test-Path $ZipPath) {
  Remove-Item $ZipPath -Force
}
Compress-Archive -Path (Join-Path $WorkDir "*") -DestinationPath $ZipPath -Force

Write-Host ""
Write-Host "Backup created:"
Write-Host $ZipPath
