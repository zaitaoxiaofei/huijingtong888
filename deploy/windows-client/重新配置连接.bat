@echo off
chcp 65001 >nul
title Ozon ERP 重新配置
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0连接Ozon ERP.ps1" -Reset
