[CmdletBinding()]
param(
  [string]$EcsHost = $(if ($env:OZON_ECS_HOST) { $env:OZON_ECS_HOST } else { "47.120.47.194" }),
  [string]$SshUser = $(if ($env:OZON_ECS_USER) { $env:OZON_ECS_USER } else { "root" }),
  [int]$SshPort = $(if ($env:OZON_ECS_PORT) { [int]$env:OZON_ECS_PORT } else { 22 }),
  [string]$IdentityFile = $env:OZON_ECS_IDENTITY_FILE,
  [string]$Version = (Get-Date -Format "yyyy.MM.dd-HHmmss"),
  [string]$ReviewedIdentityManifest,
  [string]$ReviewedAiMaterialManifest,
  [string]$ReviewedAiMediaRetentionManifest,
  [switch]$SkipBuild,
  [switch]$SkipDatabaseInit,
  [switch]$SkipDatabaseMaintenance,
  [switch]$AllowServiceInterruption,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$artifactRoot = Join-Path $projectRoot ".deploy-artifacts"
$configPath = Join-Path $artifactRoot "ecs-deploy.json"
if (Test-Path -LiteralPath $configPath) {
  $savedConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $env:OZON_ECS_HOST -and -not $PSBoundParameters.ContainsKey("EcsHost") -and $savedConfig.host) { $EcsHost = [string]$savedConfig.host }
  if (-not $env:OZON_ECS_USER -and -not $PSBoundParameters.ContainsKey("SshUser") -and $savedConfig.user) { $SshUser = [string]$savedConfig.user }
  if (-not $env:OZON_ECS_PORT -and -not $PSBoundParameters.ContainsKey("SshPort") -and $savedConfig.port) { $SshPort = [int]$savedConfig.port }
  if (-not $env:OZON_ECS_IDENTITY_FILE -and -not $PSBoundParameters.ContainsKey("IdentityFile") -and $savedConfig.identityFile) { $IdentityFile = [string]$savedConfig.identityFile }
}
$outputDir = Join-Path $artifactRoot "$Version-package"
$archivePath = Join-Path $artifactRoot "ozon-erp-$Version.zip"
$remoteArchive = "/tmp/ozon-erp-$Version.zip"
$remoteScript = "/tmp/ozon-erp-remote-release.sh"
$remoteTarget = "$SshUser@$EcsHost"
$remoteIdentityManifest = ""
$resolvedReviewedManifest = ""
$remoteAiMaterialManifest = ""
$resolvedAiMaterialManifest = ""
$remoteAiMediaRetentionManifest = ""
$resolvedAiMediaRetentionManifest = ""
if ($ReviewedIdentityManifest) {
  $resolvedReviewedManifest = (Resolve-Path -LiteralPath $ReviewedIdentityManifest).Path
  if (-not (Test-Path -LiteralPath $resolvedReviewedManifest -PathType Leaf)) { throw "Reviewed identity manifest must be a file." }
  $null = Get-Content -LiteralPath $resolvedReviewedManifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $remoteIdentityManifest = "/tmp/ozon-erp-identity-$Version.json"
}
if ($ReviewedAiMaterialManifest) {
  $resolvedAiMaterialManifest = (Resolve-Path -LiteralPath $ReviewedAiMaterialManifest).Path
  if (-not (Test-Path -LiteralPath $resolvedAiMaterialManifest -PathType Leaf)) { throw "Reviewed AI material manifest must be a file." }
  try { $null = Get-Content -LiteralPath $resolvedAiMaterialManifest -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "Reviewed AI material manifest is not valid JSON." }
  $remoteAiMaterialManifest = "/tmp/ozon-erp-ai-material-$Version-$([guid]::NewGuid().ToString('N')).json"
}
if ($ReviewedAiMediaRetentionManifest) {
  if (-not $AllowServiceInterruption) { throw "AI media retention requires an explicit offline maintenance window." }
  $resolvedAiMediaRetentionManifest = (Resolve-Path -LiteralPath $ReviewedAiMediaRetentionManifest).Path
  if (-not (Test-Path -LiteralPath $resolvedAiMediaRetentionManifest -PathType Leaf)) { throw "AI media retention manifest must be a file." }
  try { $null = Get-Content -LiteralPath $resolvedAiMediaRetentionManifest -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "AI media retention manifest is not valid JSON." }
  $remoteAiMediaRetentionManifest = "/tmp/ozon-erp-ai-media-retention-$Version-$([guid]::NewGuid().ToString('N')).json"
}

foreach ($command in @("ssh", "scp", "tar.exe")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required command is not available: $command"
  }
}
if (-not $EcsHost) { throw "ECS host is required." }
if ($Version -notmatch '^[0-9A-Za-z._-]+$') { throw "Version contains unsupported characters: $Version" }

$sshOptions = @("-p", "$SshPort", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4")
$scpOptions = @("-P", "$SshPort", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4")
if ($IdentityFile) {
  $resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path
  $sshOptions += @("-i", $resolvedIdentity)
  $scpOptions += @("-i", $resolvedIdentity)
}
$dbInitFlag = if ($SkipDatabaseInit) { "0" } else { "1" }
$dbMaintenanceFlag = if ($SkipDatabaseMaintenance) { "0" } else { "1" }
$interruptionFlag = if ($AllowServiceInterruption) { "1" } else { "0" }
$activationCommand = "bash '$remoteScript' '$remoteArchive' '$Version' '$dbInitFlag' '$dbMaintenanceFlag' '$remoteIdentityManifest' '$remoteAiMaterialManifest' '$interruptionFlag'"
if ($remoteAiMediaRetentionManifest) { $activationCommand += " '$remoteAiMediaRetentionManifest'" }

if ($DryRun) {
  Write-Host "Dry run only."
  Write-Host "Host: $remoteTarget`:$SshPort"
  Write-Host "Version: $Version"
  Write-Host "Artifact: $archivePath"
  Write-Host "Activation arguments: $activationCommand"
  exit 0
}

Push-Location $projectRoot
try {
  & node scripts/verify-release-worktree.mjs
  if ($LASTEXITCODE -ne 0) { throw "Release worktree validation failed." }
  $releaseBranch = (& git branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Cannot resolve release branch." }
  $releaseCommit = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Cannot resolve release commit." }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
if (-not $SkipBuild) {
  $env:DEPLOY_OUTPUT_DIR = $outputDir
  $env:OZON_DEPLOY_WORK_DIR = Join-Path $env:TEMP "ozon-erp-deploy-$Version"
  $env:OZON_RELEASE_VERSION = $Version
  $env:OZON_RELEASE_BRANCH = $releaseBranch
  $env:OZON_RELEASE_COMMIT = $releaseCommit
  $env:OZON_RELEASE_CHANNEL = "production"
  Push-Location $projectRoot
  try {
    & npm.cmd run package:deploy
    if ($LASTEXITCODE -ne 0) { throw "Deployment package build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path (Join-Path $outputDir "deploy-manifest.json"))) {
  throw "Deployment artifact is incomplete: $outputDir"
}

if (Test-Path $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
& tar.exe -a -c -f $archivePath -C $outputDir .
if ($LASTEXITCODE -ne 0) { throw "Archive creation failed with exit code $LASTEXITCODE." }

$remoteReleaseScript = Join-Path $projectRoot "deploy\linux\remote-release.sh"
Write-Host "Uploading release $Version to $remoteTarget..."
try {
& scp @scpOptions $archivePath $remoteReleaseScript "${remoteTarget}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Upload failed with exit code $LASTEXITCODE." }
if ($resolvedReviewedManifest) {
  & scp @scpOptions $resolvedReviewedManifest "${remoteTarget}:$remoteIdentityManifest"
  if ($LASTEXITCODE -ne 0) { throw "Reviewed identity manifest upload failed with exit code $LASTEXITCODE." }
}
if ($resolvedAiMaterialManifest) {
  # Create the destination privately before SCP; never leave a world-readable
  # manifest between upload and chmod. A unique filename also isolates releases.
  & ssh @sshOptions $remoteTarget "set -Ce; umask 077; : > '$remoteAiMaterialManifest'; chmod 600 '$remoteAiMaterialManifest'"
  if ($LASTEXITCODE -ne 0) { throw "Private AI material manifest preparation failed with exit code $LASTEXITCODE." }
  & scp @scpOptions $resolvedAiMaterialManifest "${remoteTarget}:$remoteAiMaterialManifest"
  if ($LASTEXITCODE -ne 0) { throw "Reviewed AI material manifest upload failed with exit code $LASTEXITCODE." }
}
if ($resolvedAiMediaRetentionManifest) {
  & ssh @sshOptions $remoteTarget "set -Ce; umask 077; : > '$remoteAiMediaRetentionManifest'; chmod 600 '$remoteAiMediaRetentionManifest'"
  if ($LASTEXITCODE -ne 0) { throw "Private AI media retention manifest preparation failed." }
  & scp @scpOptions $resolvedAiMediaRetentionManifest "${remoteTarget}:$remoteAiMediaRetentionManifest"
  if ($LASTEXITCODE -ne 0) { throw "AI media retention manifest upload failed." }
}

$remoteCommand = "mv /tmp/remote-release.sh '$remoteScript' && chmod 700 '$remoteScript' && $activationCommand"
if ($remoteIdentityManifest) {
  $remoteCommand = "chmod 600 '$remoteIdentityManifest' && $remoteCommand"
}
& ssh @sshOptions $remoteTarget $remoteCommand
if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed with exit code $LASTEXITCODE." }
} finally {
  if ($remoteAiMediaRetentionManifest) {
    try { & ssh @sshOptions $remoteTarget "rm -f -- '$remoteAiMediaRetentionManifest'" 2>$null | Out-Null }
    catch { Write-Warning "AI media retention manifest cleanup could not be confirmed." }
  }
  if ($remoteAiMaterialManifest) {
    try {
      & ssh @sshOptions $remoteTarget "rm -f -- '$remoteAiMaterialManifest'" 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Warning "Private AI material manifest cleanup could not be confirmed." }
    } catch { Write-Warning "Private AI material manifest cleanup could not be confirmed." }
  }
}

if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
} else {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $archiveStream = [System.IO.File]::OpenRead($archivePath)
  try {
    $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($archiveStream))).Replace("-", "")
  } finally {
    $archiveStream.Dispose()
    $sha256.Dispose()
  }
}
Write-Host "Deployment completed."
Write-Host "Release: $Version"
Write-Host "Archive: $archivePath"
Write-Host "SHA256: $hash"
