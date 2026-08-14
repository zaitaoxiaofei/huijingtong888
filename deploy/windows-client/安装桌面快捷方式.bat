@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装桌面快捷方式.ps1"
if errorlevel 1 pause
