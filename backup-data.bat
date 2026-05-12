@echo off
setlocal
cd /d "%~dp0"
echo Ozon Profit Hub data backup
echo.
powershell -NoProfile -Command "$PSVersionTable.PSVersion" >nul 2>&1
if errorlevel 1 (
  echo PowerShell was not found. Please run this script on Windows with PowerShell enabled.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\backup-data.ps1"
if errorlevel 1 (
  echo.
  echo Backup failed. Please check the error message above.
  pause
  exit /b 1
)
echo.
echo Backup finished.
pause
