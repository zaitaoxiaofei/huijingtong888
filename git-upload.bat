@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0git-upload.ps1"
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo Git upload failed with code %EXIT_CODE%.
) else (
  echo Git upload finished.
)
pause
exit /b %EXIT_CODE%
