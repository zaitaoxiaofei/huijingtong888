@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Ozon Profit Hub...
echo.
set NODE_NO_WARNINGS=1
node --version >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 22 or newer.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -p "process.versions.node"') do set NODE_MAJOR=%%a
for /f "tokens=2 delims=." %%b in ('node -p "process.versions.node"') do set NODE_MINOR=%%b

if %NODE_MAJOR% LSS 22 (
  echo Current Node.js version is too old:
  node --version
  echo This project requires Node.js 22.5.0 or newer.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)

if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 5 (
  echo Current Node.js version is too old:
  node --version
  echo This project requires Node.js 22.5.0 or newer.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)
echo Node.js version:
node --version
echo.
echo Building frontend, starting server, print helper, and opening browser page...
echo.
npm run start:all
pause
