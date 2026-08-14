[CmdletBinding()]
param(
  [string]$EcsHost = $(if ($env:OZON_ECS_HOST) { $env:OZON_ECS_HOST } else { "47.113.195.4" }),
  [string]$SshUser = $(if ($env:OZON_ECS_USER) { $env:OZON_ECS_USER } else { "root" }),
  [int]$SshPort = $(if ($env:OZON_ECS_PORT) { [int]$env:OZON_ECS_PORT } else { 22 }),
  [string]$IdentityFile = $env:OZON_ECS_IDENTITY_FILE,
  [string]$Version = (Get-Date -Format "yyyy.MM.dd-HHmmss"),
  [switch]$SkipBuild,
  [switch]$SkipDatabaseInit,
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

if ($DryRun) {
  Write-Host "Dry run only."
  Write-Host "Host: $remoteTarget`:$SshPort"
  Write-Host "Version: $Version"
  Write-Host "Artifact: $archivePath"
  exit 0
}

New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
if (-not $SkipBuild) {
  $env:DEPLOY_OUTPUT_DIR = $outputDir
  $env:OZON_DEPLOY_WORK_DIR = Join-Path $env:TEMP "ozon-erp-deploy-$Version"
  $env:OZON_RELEASE_VERSION = $Version
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
& scp @scpOptions $archivePath $remoteReleaseScript "${remoteTarget}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Upload failed with exit code $LASTEXITCODE." }

$dbInitFlag = if ($SkipDatabaseInit) { "0" } else { "1" }
$remoteCommand = "mv /tmp/remote-release.sh '$remoteScript' && chmod 700 '$remoteScript' && bash '$remoteScript' '$remoteArchive' '$Version' '$dbInitFlag'"
& ssh @sshOptions $remoteTarget $remoteCommand
if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed with exit code $LASTEXITCODE." }

$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
Write-Host "Deployment completed."
Write-Host "Release: $Version"
Write-Host "Archive: $archivePath"
Write-Host "SHA256: $hash"
