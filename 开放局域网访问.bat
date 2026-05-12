@echo off
chcp 65001 >nul 2>nul
echo ════════════════════════════════════════
echo   Ozon Profit Hub - 局域网开放工具
echo ════════════════════════════════════════
echo.

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 请右键此文件 → 以管理员身份运行！
    echo.
    pause
    exit /b 1
)

echo [1/2] 正在放行防火墙端口 8787 ...
netsh advfirewall firewall delete rule name="Ozon Profit Hub" >nul 2>&1
netsh advfirewall firewall add rule name="Ozon Profit Hub" dir=in action=allow protocol=TCP localport=8787 >nul 2>&1

if %errorlevel% equ 0 (
    echo       √ 防火墙规则添加成功
) else (
    echo       ✗ 防火墙规则添加失败，请手动操作
)

echo.
echo [2/2] 查询本机局域网 IP ...
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4"') do (
    set ip=%%a
)
set ip=%ip: =%

echo.
echo ════════════════════════════════════════
echo   搞定！把下面这个地址发给同事：
echo.
echo   http://%ip%:8787
echo.
echo   同事在浏览器打开就能用了（同一个WiFi下）
echo ════════════════════════════════════════
echo.
pause
