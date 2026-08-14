@echo off
chcp 65001 >nul
title Ozon ERP 安全连接
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0连接Ozon ERP.ps1"
