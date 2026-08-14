[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName System.Windows.Forms

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$configRoot = Join-Path $projectRoot ".deploy-artifacts"
$configPath = Join-Path $configRoot "ecs-deploy.json"
$sshRoot = Join-Path $env:USERPROFILE ".ssh"
$managedKeyPath = Join-Path $sshRoot "ozon-erp-deploy.pem"

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "选择阿里云下载的 SSH 私钥文件"
$dialog.Filter = "SSH 私钥 (*.pem;*.key)|*.pem;*.key|所有文件 (*.*)|*.*"
$dialog.InitialDirectory = [Environment]::GetFolderPath("UserProfile")
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }

try {
  New-Item -ItemType Directory -Path $sshRoot -Force | Out-Null
  Copy-Item -LiteralPath $dialog.FileName -Destination $managedKeyPath -Force
  & icacls.exe $managedKeyPath /inheritance:r /grant:r "${env:USERNAME}:(R)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "无法设置私钥文件权限。" }

  New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
  @{
    host = "47.113.195.4"
    user = "root"
    port = 22
    identityFile = $managedKeyPath
  } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

  & ssh -p 22 -i $managedKeyPath -o BatchMode=yes -o ConnectTimeout=10 "root@47.113.195.4" "true" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "私钥已保存，但连接测试失败。请确认密钥已绑定到华南2（河源）的 ECS，并且绑定后已重启实例。"
  }

  [System.Windows.MessageBox]::Show(
    "配置成功。以后直接双击「一键部署到阿里云.vbs」即可。",
    "Ozon ERP",
    [System.Windows.MessageBoxButton]::OK,
    [System.Windows.MessageBoxImage]::Information
  ) | Out-Null
} catch {
  [System.Windows.MessageBox]::Show(
    $_.Exception.Message,
    "配置失败",
    [System.Windows.MessageBoxButton]::OK,
    [System.Windows.MessageBoxImage]::Error
  ) | Out-Null
  exit 1
}
