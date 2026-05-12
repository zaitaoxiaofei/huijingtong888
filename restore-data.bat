@echo off
setlocal
cd /d "%~dp0"
echo Ozon Profit Hub data restore
echo.
echo Close the running Ozon Profit Hub server before restoring data.
echo.
powershell -NoProfile -Command "$PSVersionTable.PSVersion" >nul 2>&1
if errorlevel 1 (
  echo PowerShell was not found. Please run this script on Windows with PowerShell enabled.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\restore-data.ps1" %*
if errorlevel 1 (
  echo.
  echo Restore failed. Please check the error message above.
  pause
  exit /b 1
)
echo.
echo Restore finished.
pause
