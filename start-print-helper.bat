@echo off
cd /d "%~dp0"
echo Starting Ozon local print helper...
node scripts\local-print-helper.mjs
pause
