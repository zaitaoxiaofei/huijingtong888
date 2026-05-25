@echo off
setlocal
cd /d "%~dp0"
echo Starting Ozon ERP with local MySQL...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-local-mysql.ps1" -StartTunnel -StartApp
pause
