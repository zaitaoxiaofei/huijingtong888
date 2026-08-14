$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$launcher = Join-Path $PSScriptRoot '连接Ozon ERP.bat'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "找不到连接程序：$launcher"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '连接 Ozon ERP.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = '通过 SSH 安全连接阿里云 Ozon ERP'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$shortcut.Save()

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
  "桌面快捷方式已创建：`n$shortcutPath`n`n首次连接时请选择管理员提供的 SSH 私钥。",
  'Ozon ERP',
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::Information
) | Out-Null
