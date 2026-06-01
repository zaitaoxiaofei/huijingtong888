$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$projectRoot = Split-Path -Parent $PSScriptRoot
$desktopDist = Join-Path $projectRoot "dist\desktop"
$appSource = Join-Path $desktopDist "win-unpacked"
$sevenZip = Join-Path $projectRoot "node_modules\7zip-bin\win\x64\7za.exe"
$workDir = Join-Path $desktopDist "installer-build"
$payloadDir = Join-Path $workDir "payload"
$archivePath = Join-Path $payloadDir "app.7z"
$sevenZipPayloadPath = Join-Path $payloadDir "7za.exe"
$installScriptPath = Join-Path $payloadDir "install.ps1"
$sedPath = Join-Path $workDir "installer.sed"
$outputExe = Join-Path $desktopDist "Ozon-ERP-Setup-0.1.0.exe"

if (-not (Test-Path $appSource)) {
  throw "Desktop build folder not found: $appSource"
}

if (-not (Test-Path $sevenZip)) {
  throw "7za not found: $sevenZip"
}

if (Test-Path $workDir) {
  Remove-Item -LiteralPath $workDir -Recurse -Force
}

New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null

& $sevenZip a -t7z $archivePath (Join-Path $appSource "*") | Out-Null
Copy-Item -LiteralPath $sevenZip -Destination $sevenZipPayloadPath -Force

$installScriptLines = @(
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms',
  '',
  'function New-Shortcut {',
  '  param(',
  '    [Parameter(Mandatory = $true)][string]$ShortcutPath,',
  '    [Parameter(Mandatory = $true)][string]$TargetPath,',
  '    [string]$Arguments = "",',
  '    [string]$WorkingDirectory = "",',
  '    [string]$IconLocation = ""',
  '  )',
  '  $shell = New-Object -ComObject WScript.Shell',
  '  $shortcut = $shell.CreateShortcut($ShortcutPath)',
  '  $shortcut.TargetPath = $TargetPath',
  '  if ($Arguments) { $shortcut.Arguments = $Arguments }',
  '  if ($WorkingDirectory) { $shortcut.WorkingDirectory = $WorkingDirectory }',
  '  if ($IconLocation) { $shortcut.IconLocation = $IconLocation }',
  '  $shortcut.Save()',
  '}',
  '',
  '$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path',
  '$archivePath = Join-Path $sourceRoot "app.7z"',
  '$sevenZipPath = Join-Path $sourceRoot "7za.exe"',
  '$installRoot = Join-Path $env:LOCALAPPDATA "Programs\\Ozon ERP"',
  '$appRoot = Join-Path $installRoot "app"',
  '$exePath = Join-Path $appRoot "Ozon ERP.exe"',
  '$uninstallPath = Join-Path $installRoot "Uninstall Ozon ERP.ps1"',
  '$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Ozon ERP.lnk"',
  '$startMenuDir = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Ozon ERP"',
  '$startMenuShortcut = Join-Path $startMenuDir "Ozon ERP.lnk"',
  '$uninstallShortcut = Join-Path $startMenuDir "Uninstall Ozon ERP.lnk"',
  '',
  'Get-Process | Where-Object { $_.ProcessName -eq "Ozon ERP" -or $_.MainWindowTitle -like "*Ozon ERP*" } | Stop-Process -Force -ErrorAction SilentlyContinue',
  'Start-Sleep -Milliseconds 800',
  '',
  'if (Test-Path $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }',
  'New-Item -ItemType Directory -Path $appRoot -Force | Out-Null',
  '& $sevenZipPath x $archivePath "-o$appRoot" -y | Out-Null',
  '',
  '$uninstallScriptLines = @(',
  '  ''$ErrorActionPreference = "Stop"'',',
  '  ''Add-Type -AssemblyName System.Windows.Forms'',',
  '  ''$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Ozon ERP.lnk"'',',
  '  ''$startMenuDir = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Ozon ERP"'',',
  '  ''$installRoot = Join-Path $env:LOCALAPPDATA "Programs\\Ozon ERP"'',',
  '  ''Get-Process | Where-Object { $_.ProcessName -eq "Ozon ERP" -or $_.MainWindowTitle -like "*Ozon ERP*" } | Stop-Process -Force -ErrorAction SilentlyContinue'',',
  '  ''if (Test-Path $desktopShortcut) { Remove-Item -LiteralPath $desktopShortcut -Force }'',',
  '  ''if (Test-Path $startMenuDir) { Remove-Item -LiteralPath $startMenuDir -Recurse -Force }'',',
  '  ''if (Test-Path $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }'',',
  '  ''[System.Windows.Forms.MessageBox]::Show("Ozon ERP has been uninstalled.", "Ozon ERP")''',
  ')',
  'Set-Content -LiteralPath $uninstallPath -Value $uninstallScriptLines -Encoding UTF8',
  'New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null',
  'New-Shortcut -ShortcutPath $desktopShortcut -TargetPath $exePath -WorkingDirectory $appRoot -IconLocation $exePath',
  'New-Shortcut -ShortcutPath $startMenuShortcut -TargetPath $exePath -WorkingDirectory $appRoot -IconLocation $exePath',
  'New-Shortcut -ShortcutPath $uninstallShortcut -TargetPath "powershell.exe" -Arguments "-ExecutionPolicy Bypass -File `"$uninstallPath`"" -WorkingDirectory $installRoot',
  '[System.Windows.Forms.MessageBox]::Show("Ozon ERP has been installed.", "Ozon ERP")'
)

Set-Content -LiteralPath $installScriptPath -Value $installScriptLines -Encoding UTF8

$sedLines = @(
  '[Version]',
  'Class=IEXPRESS',
  'SEDVersion=3',
  '[Options]',
  'PackagePurpose=InstallApp',
  'ShowInstallProgramWindow=1',
  'HideExtractAnimation=0',
  'UseLongFileName=1',
  'InsideCompressed=0',
  'CAB_FixedSize=0',
  'CAB_ResvCodeSigning=0',
  'RebootMode=N',
  'InstallPrompt=',
  'DisplayLicense=',
  'FinishMessage=',
  "TargetName=$outputExe",
  'FriendlyName=Ozon ERP Installer',
  'AppLaunched=powershell.exe -ExecutionPolicy Bypass -File install.ps1',
  'PostInstallCmd=<None>',
  'AdminQuietInstCmd=powershell.exe -ExecutionPolicy Bypass -File install.ps1',
  'UserQuietInstCmd=powershell.exe -ExecutionPolicy Bypass -File install.ps1',
  'SourceFiles=SourceFiles',
  '[Strings]',
  'FILE0=app.7z',
  'FILE1=7za.exe',
  'FILE2=install.ps1',
  '[SourceFiles]',
  "SourceFiles0=$payloadDir",
  '[SourceFiles0]',
  '%FILE0%=',
  '%FILE1%=',
  '%FILE2%='
)

Set-Content -LiteralPath $sedPath -Value $sedLines -Encoding ASCII

$iexpressPath = (Get-Command iexpress.exe).Source
& $iexpressPath /N $sedPath | Out-Null

if (-not (Test-Path $outputExe)) {
  throw "Installer was not created: $outputExe"
}

Write-Output "Installer created: $outputExe"
