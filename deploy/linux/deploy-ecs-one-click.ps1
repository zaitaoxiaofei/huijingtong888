[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$logRoot = Join-Path $projectRoot ".deploy-artifacts"
$logPath = Join-Path $logRoot "one-click-deploy.log"
$deployScript = Join-Path $PSScriptRoot "deploy-ecs.ps1"
$ecsHost = if ($env:OZON_ECS_HOST) { $env:OZON_ECS_HOST } else { "47.113.195.4" }
$sshUser = if ($env:OZON_ECS_USER) { $env:OZON_ECS_USER } else { "root" }
$sshPort = if ($env:OZON_ECS_PORT) { [int]$env:OZON_ECS_PORT } else { 22 }
$identityFile = $env:OZON_ECS_IDENTITY_FILE
$configPath = Join-Path $logRoot "ecs-deploy.json"

Add-Type -AssemblyName PresentationFramework
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Get-Utf8Text([string]$value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}

$title = Get-Utf8Text "T3pvbiBFUlAg5LiA6ZSu6YOo572y"
$failedTitle = Get-Utf8Text "T3pvbiBFUlAg6YOo572y5aSx6LSl"

[System.Windows.MessageBox]::Show(
  (Get-Utf8Text "6YOo572y5bel5YW35bey5ZCv5Yqo44CC54K55Ye74oCc56Gu5a6a4oCd5ZCO5qOA5p+l6Zi/6YeM5LqR5pyN5Yqh5Zmo6L+e5o6l77yM6YCa5bi45LiN6LaF6L+HIDEwIOenkuOAgg=="),
  $title,
  [System.Windows.MessageBoxButton]::OK,
  [System.Windows.MessageBoxImage]::Information
) | Out-Null

try {
  if (Test-Path -LiteralPath $configPath) {
    $savedConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $env:OZON_ECS_HOST -and $savedConfig.host) { $ecsHost = [string]$savedConfig.host }
    if (-not $env:OZON_ECS_USER -and $savedConfig.user) { $sshUser = [string]$savedConfig.user }
    if (-not $env:OZON_ECS_PORT -and $savedConfig.port) { $sshPort = [int]$savedConfig.port }
    if (-not $identityFile -and $savedConfig.identityFile) { $identityFile = [string]$savedConfig.identityFile }
  }

  $sshCheckOptions = @("-p", "$sshPort", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8")
  if ($identityFile) {
    $sshCheckOptions += @("-i", (Resolve-Path -LiteralPath $identityFile).Path)
  }
  & ssh @sshCheckOptions "$sshUser@$ecsHost" "true" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw ((Get-Utf8Text "U1NIIOi/nuaOpeajgOafpeWksei0pe+8iOmAgOWHuuS7o+eggSB7MH3vvInjgII=") -f $LASTEXITCODE)
  }

  $answer = [System.Windows.MessageBox]::Show(
    (Get-Utf8Text "5piv5ZCm5bCG5b2T5YmN5pys5Zyw54mI5pys6YOo572y5Yiw6Zi/6YeM5LqRIEVDU++8n+mDqOe9sui/h+eoi+S4reS8mumHjeWQr+acjeWKoeWZqOS4iueahCBPem9uIEVSUCDmnI3liqHvvJvlpoLmnpzlpLHotKXkvJroh6rliqjlsJ3or5Xlm57mu5rjgII="),
    $title,
    [System.Windows.MessageBoxButton]::YesNo,
    [System.Windows.MessageBoxImage]::Question
  )
  if ($answer -ne [System.Windows.MessageBoxResult]::Yes) { exit 0 }

  Start-Transcript -LiteralPath $logPath -Force | Out-Null
  & $deployScript
  if ($LASTEXITCODE -ne 0) {
    throw ((Get-Utf8Text "6YOo572y6ISa5pys6YCA5Ye65Luj56CB77yaezB9") -f $LASTEXITCODE)
  }
  Stop-Transcript | Out-Null

  [System.Windows.MessageBox]::Show(
    ((Get-Utf8Text "6Zi/6YeM5LqRIEVDUyDpg6jnvbLmiJDlip/jgII=") + "`n`n" + (Get-Utf8Text "5pel5b+X77ya") + $logPath),
    "Ozon ERP",
    [System.Windows.MessageBoxButton]::OK,
    [System.Windows.MessageBoxImage]::Information
  ) | Out-Null
} catch {
  try { Stop-Transcript | Out-Null } catch {}
  [System.Windows.MessageBox]::Show(
    ((Get-Utf8Text "6YOo572y5aSx6LSl44CC") + "`n`n$($_.Exception.Message)`n`n" + (Get-Utf8Text "5pel5b+X77ya") + $logPath),
    $failedTitle,
    [System.Windows.MessageBoxButton]::OK,
    [System.Windows.MessageBoxImage]::Error
  ) | Out-Null
  exit 1
}
