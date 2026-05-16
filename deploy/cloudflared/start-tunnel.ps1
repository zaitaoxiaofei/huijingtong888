$ErrorActionPreference = "Stop"

$cloudflared = "C:\Users\DIZAI\AppData\Local\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"
$configPath = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
$logPath = Join-Path $env:USERPROFILE ".cloudflared\ozon-erp-run.log"

if (-not (Test-Path $cloudflared)) {
  throw "cloudflared.exe 不存在：$cloudflared"
}

if (-not (Test-Path $configPath)) {
  throw "cloudflared 配置不存在：$configPath"
}

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force

Start-Process `
  -FilePath $cloudflared `
  -ArgumentList "--config", $configPath, "--loglevel", "info", "--logfile", $logPath, "tunnel", "run", "ozon-erp" `
  -WindowStyle Hidden

Start-Sleep -Seconds 4
& $cloudflared tunnel info ozon-erp
