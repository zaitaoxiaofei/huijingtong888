$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$distDir = Join-Path $root "dist"
$deployDir = Join-Path $distDir "deploy"
$backupDir = Join-Path $distDir "deploy-prev"
$lockPath = Join-Path $distDir "deploy.lock"
$skipPreflight = @("1", "true", "yes", "on") -contains [string]$env:SKIP_DEPLOY_PREFLIGHT
$skipDbBackup = @("1", "true", "yes", "on") -contains [string]$env:SKIP_DEPLOY_DB_BACKUP
$skipPublicHealthCheck = @("1", "true", "yes", "on") -contains [string]$env:SKIP_DEPLOY_PUBLIC_HEALTH_CHECK
$stopScript = Join-Path $PSScriptRoot "stop-host-stack.ps1"
$startScript = Join-Path $PSScriptRoot "start-host-stack.ps1"
$backupMysqlScript = Join-Path $PSScriptRoot "backup-mysql.ps1"
$healthCheckScript = Join-Path $root "scripts\health-check.mjs"

if (-not (Test-Path $stopScript)) {
  throw "Stop script not found: $stopScript"
}

if (-not (Test-Path $startScript)) {
  throw "Start script not found: $startScript"
}

if (-not (Test-Path $healthCheckScript)) {
  throw "Health check script not found: $healthCheckScript"
}

function New-DeployLock {
  if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
  }

  try {
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $lockWriter = New-Object System.IO.StreamWriter($lockStream)
    $lockWriter.WriteLine("pid=$PID")
    $lockWriter.WriteLine("started_at=$((Get-Date).ToString('s'))")
    $lockWriter.Flush()
    return @{ Stream = $lockStream; Writer = $lockWriter }
  } catch [System.IO.IOException] {
    throw "Another deployment appears to be running because the lock file exists: $lockPath. If no publish is running, delete this file and retry."
  }
}

function Remove-DeployLock {
  param($Lock)

  if ($Lock) {
    if ($Lock.Writer) {
      $Lock.Writer.Dispose()
    } elseif ($Lock.Stream) {
      $Lock.Stream.Dispose()
    }
  }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}

function Get-EnvFileValue {
  param(
    [Parameter(Mandatory = $true)][string]$EnvPath,
    [Parameter(Mandatory = $true)][string]$Key
  )

  if (-not (Test-Path $EnvPath)) {
    return ""
  }

  foreach ($line in Get-Content -LiteralPath $EnvPath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
      continue
    }
    $parts = $trimmed -split "=", 2
    if ($parts[0].Trim() -ne $Key) {
      continue
    }
    $value = $parts[1].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
  }
  return ""
}

function Copy-DeployEnvIfPresent {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$TargetDir
  )

  $sourceEnv = Join-Path $SourceDir ".env"
  $targetEnv = Join-Path $TargetDir ".env"
  if ((Test-Path $sourceEnv) -and (Test-Path $TargetDir)) {
    Copy-Item -LiteralPath $sourceEnv -Destination $targetEnv -Force
    Write-Host "Preserved deployment .env from $SourceDir"
  }
}

function Invoke-DeployHealthCheck {
  param(
    [Parameter(Mandatory = $true)][string]$DeployPath,
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $normalizedBaseUrl = $BaseUrl.TrimEnd("/")
  Write-Host "Running $Label health check against $normalizedBaseUrl..."
  Push-Location $root
  try {
    $env:HEALTH_CHECK_BASE_URL = $normalizedBaseUrl
    $env:HEALTH_CHECK_ENV_FILE = Join-Path $DeployPath ".env"
    & node $healthCheckScript
    if ($LASTEXITCODE -ne 0) {
      throw "$Label health check failed with code $LASTEXITCODE."
    }
  } finally {
    Remove-Item Env:HEALTH_CHECK_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:HEALTH_CHECK_ENV_FILE -ErrorAction SilentlyContinue
    Pop-Location
  }
}

function Invoke-DeployPreflightChecks {
  Write-Host "Running deploy preflight checks..."
  Push-Location $root
  try {
    & npm test
    if ($LASTEXITCODE -ne 0) {
      throw "Preflight npm test failed with code $LASTEXITCODE."
    }

    & npm run check:deploy-preflight
    if ($LASTEXITCODE -ne 0) {
      throw "Preflight environment check failed with code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

function Invoke-DeployDatabaseBackup {
  if ($skipDbBackup) {
    Write-Warning "Skipping deployment MySQL backup because SKIP_DEPLOY_DB_BACKUP is enabled."
    return
  }

  if (-not (Test-Path $backupMysqlScript)) {
    throw "Backup script not found: $backupMysqlScript"
  }

  if (-not (Test-Path $deployDir)) {
    Write-Warning "Skipping deployment MySQL backup because no previous deploy folder exists yet."
    return
  }

  Write-Host "Creating MySQL backup before deployment..."
  & $backupMysqlScript
  if ($LASTEXITCODE -ne 0) {
    throw "MySQL backup failed with code $LASTEXITCODE."
  }
}

function Invoke-DeployPublicHealthCheck {
  param([Parameter(Mandatory = $true)][string]$DeployPath)

  if ($skipPublicHealthCheck) {
    Write-Warning "Skipping public deployment health check because SKIP_DEPLOY_PUBLIC_HEALTH_CHECK is enabled."
    return
  }

  $deployEnvPath = Join-Path $DeployPath ".env"
  $publicBaseUrl = $env:PUBLIC_HEALTH_CHECK_BASE_URL
  if (-not $publicBaseUrl) {
    $publicBaseUrl = Get-EnvFileValue -EnvPath $deployEnvPath -Key "APP_BASE_URL"
  }
  if (-not $publicBaseUrl) {
    $publicBaseUrl = "https://erp.hjt888.xyz"
  }

  if ($publicBaseUrl -match "^https?://(localhost|127\.0\.0\.1)(:\d+)?/?$") {
    Write-Warning "Skipping public deployment health check because APP_BASE_URL is local: $publicBaseUrl"
    return
  }

  Invoke-DeployHealthCheck -DeployPath $DeployPath -BaseUrl $publicBaseUrl -Label "public"
}

$deployLock = $null
try {
  $deployLock = New-DeployLock
  Write-Host "Updating Ozon ERP host stack..."

  if ($skipPreflight) {
    Write-Warning "Skipping deploy preflight checks because SKIP_DEPLOY_PREFLIGHT is enabled."
  } else {
    Invoke-DeployPreflightChecks
  }

  Invoke-DeployDatabaseBackup

  & $stopScript

  $hadPreviousDeploy = Test-Path $deployDir
  if (Test-Path $backupDir) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force
  }

  if ($hadPreviousDeploy) {
    Rename-Item -LiteralPath $deployDir -NewName (Split-Path $backupDir -Leaf)
    Write-Host "Backed up current deployment to $backupDir"
  }

  try {
    Push-Location $root
    try {
      npm run package:deploy
      if ($LASTEXITCODE -ne 0) {
        throw "package:deploy failed with code $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }

    if ($hadPreviousDeploy) {
      Copy-DeployEnvIfPresent -SourceDir $backupDir -TargetDir $deployDir
    }

    & $startScript -DeployDir $deployDir
    Invoke-DeployHealthCheck -DeployPath $deployDir -BaseUrl "http://127.0.0.1:8787" -Label "local"
    Invoke-DeployPublicHealthCheck -DeployPath $deployDir
    Write-Host "Ozon ERP host stack updated."
  } catch {
    $deployError = $_
    Write-Warning ("Host update failed: " + $deployError.Exception.Message)
    Write-Warning "Attempting rollback to previous deployment..."

    try {
      & $stopScript
    } catch {
      Write-Warning ("Failed to stop partially started host stack: " + $_.Exception.Message)
    }

    if (Test-Path $deployDir) {
      Remove-Item -LiteralPath $deployDir -Recurse -Force
    }

    if (Test-Path $backupDir) {
      Rename-Item -LiteralPath $backupDir -NewName (Split-Path $deployDir -Leaf)
      & $startScript -DeployDir $deployDir
      Write-Warning "Rollback completed. Previous deployment is running again."
    } else {
      Write-Warning "Rollback was not possible because no previous deployment backup was available."
    }

    throw
  }
} finally {
  Remove-DeployLock -Lock $deployLock
}
