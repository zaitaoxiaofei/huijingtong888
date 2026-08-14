[CmdletBinding()]
param(
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Host.UI.RawUI.WindowTitle = 'Ozon ERP 安全连接'

$configDirectory = Join-Path $env:LOCALAPPDATA 'OzonERP'
$configPath = Join-Path $configDirectory 'ecs-connection.json'
$bundledPrivateKey = Join-Path $PSScriptRoot 'ozon-erp-deploy.pem'
$defaultConfig = [ordered]@{
  server = '47.113.195.4'
  sshPort = 22
  sshUser = 'root'
  privateKey = if (Test-Path -LiteralPath $bundledPrivateKey -PathType Leaf) { $bundledPrivateKey } else { '' }
  localPort = 8790
  remoteHost = '127.0.0.1'
  remotePort = 3000
}

function Pause-BeforeExit {
  param([string]$Message = '按回车键关闭窗口。')
  Write-Host ''
  [void](Read-Host $Message)
}

function Select-PrivateKey {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = [System.Windows.Forms.OpenFileDialog]::new()
  $dialog.Title = '请选择管理员提供的 ERP SSH 私钥'
  $dialog.Filter = 'SSH 私钥 (*.pem;*.key;*.ppk;*.txt)|*.pem;*.key;*.ppk;*.txt|所有文件 (*.*)|*.*'
  $dialog.CheckFileExists = $true
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    throw '没有选择 SSH 私钥，配置已取消。'
  }
  return $dialog.FileName
}

function Initialize-Config {
  Write-Host '首次使用，需要完成一次连接配置。' -ForegroundColor Cyan
  Write-Host '私钥只保存在这台电脑上，不会上传到项目或服务器。'
  $config = [ordered]@{} + $defaultConfig
  if (-not $config.privateKey) {
    $config.privateKey = Select-PrivateKey
  } else {
    Write-Host '已检测到预设私钥，无需手动选择。' -ForegroundColor Green
  }
  New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
  $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
  return [pscustomobject]$config
}

function Test-LocalPort {
  param([int]$Port)
  try {
    $connection = [System.Net.Sockets.TcpClient]::new()
    $task = $connection.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait(600)) {
      $connection.Dispose()
      return $false
    }
    $connection.Dispose()
    return $true
  } catch {
    return $false
  }
}

function Protect-PrivateKey {
  param([string]$Path)
  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $currentIdentity.User.Value
  & icacls.exe $Path '/inheritance:r' '/grant:r' "*${sid}:(R)" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw '无法设置 SSH 私钥权限，请将工具解压到当前用户有权限的文件夹后重试。'
  }
}

try {
  if ($Reset -and (Test-Path -LiteralPath $configPath)) {
    Remove-Item -LiteralPath $configPath -Force
  }

  $sshCommand = Get-Command 'ssh.exe' -ErrorAction SilentlyContinue
  if (-not $sshCommand) {
    throw '未找到 Windows OpenSSH。请在“设置 → 系统 → 可选功能”中安装“OpenSSH 客户端”。'
  }

  $config = if (Test-Path -LiteralPath $configPath) {
    Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    Initialize-Config
  }

  if (-not (Test-Path -LiteralPath $config.privateKey -PathType Leaf)) {
    Write-Host '原私钥文件不存在，请重新选择。' -ForegroundColor Yellow
    $config.privateKey = Select-PrivateKey
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
  }
  Protect-PrivateKey -Path $config.privateKey

  $browserUrl = "http://127.0.0.1:$($config.localPort)/admin.html"
  if (Test-LocalPort -Port $config.localPort) {
    Write-Host "ERP 连接已经存在，正在打开：$browserUrl" -ForegroundColor Green
    Start-Process $browserUrl
    Pause-BeforeExit
    exit 0
  }

  Write-Host ''
  Write-Host "正在连接 ERP 服务器 $($config.server)……" -ForegroundColor Cyan
  Write-Host "连接成功后访问地址：$browserUrl"
  Write-Host '请保持此窗口打开；关闭窗口将断开 ERP 连接。' -ForegroundColor Yellow
  Write-Host ''

  $sshArguments = @(
    '-N', '-T',
    '-p', [string]$config.sshPort,
    '-i', [string]$config.privateKey,
    '-L', "127.0.0.1:$($config.localPort):$($config.remoteHost):$($config.remotePort)",
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    "$($config.sshUser)@$($config.server)"
  )

  # Start-Process is used instead of ProcessStartInfo.ArgumentList so this also
  # works on the Windows PowerShell 5.1 bundled with Windows 10/11.
  $sshArguments[5] = '"' + [string]$config.privateKey + '"'
  $sshProcess = Start-Process -FilePath $sshCommand.Source -ArgumentList $sshArguments -PassThru -NoNewWindow

  $connected = $false
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($sshProcess.HasExited) { break }
    if (Test-LocalPort -Port $config.localPort) {
      $connected = $true
      break
    }
  }

  if (-not $connected) {
    if (-not $sshProcess.HasExited) { $sshProcess.Kill() }
    throw '连接服务器失败。请确认网络正常、私钥正确，并联系管理员检查 SSH 权限。'
  }

  Write-Host 'ERP 安全连接已建立，浏览器即将打开。' -ForegroundColor Green
  Start-Process $browserUrl
  $sshProcess.WaitForExit()
  Write-Host "连接已断开（退出代码：$($sshProcess.ExitCode)）。" -ForegroundColor Yellow
  Pause-BeforeExit
} catch {
  Write-Host ''
  Write-Host "连接失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "如需重新选择私钥，请运行：PowerShell -File `"$PSCommandPath`" -Reset"
  Pause-BeforeExit
  exit 1
}
