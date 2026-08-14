# MySQL Binlog 清理手册

这份文档用于清理 Windows 本机 OzonERP MySQL 实例占用的磁盘空间。

## 是什么占用了空间

占用空间的大文件是 MySQL 二进制日志，位置在：

```text
C:\ProgramData\MySQL\OzonERP\data\binlog.000xxx
```

2026-07-15 清理前有 275 个 binlog 文件，合计约 274.37 GB。保留最近 3 天并清理后剩余 54 个文件，约 51.94 GB，共释放约 222.43 GB；同时已将 `binlog_expire_logs_seconds` 持久设置为 `259200`。

同日审计显示最近每天约产生 10-21 GB binlog。实例使用 `ROW` 格式，且业务库包含较大的分类模板、发布记录、AI 素材、商品和草稿 JSON/媒体字段；原来的 `binlog_row_image=FULL` 会在更新时记录完整行，进一步放大日志。当前实例没有 MySQL 副本，因此已将 `binlog_row_image` 持久设置为 `MINIMAL`，只记录定位行和实际变化所需的列，以降低后续更新产生的日志量。

```sql
SET PERSIST binlog_row_image = 'MINIMAL';
```

保留期仍为 3 天。由于当前没有发现 Ozon ERP MySQL 定时备份任务，不要为了省空间擅自缩短到 1 天或关闭 binlog；应先建立并验证每日备份，再重新评估恢复窗口。

不要在资源管理器里直接删除 `binlog.000xxx` 文件。MySQL 会在 `binlog.index` 里记录这些日志文件，手动删文件可能导致 MySQL 状态不一致。请使用 `PURGE BINARY LOGS` 命令清理。

## 账号和密码在哪里

这里有两类账号，要分清楚：

1. MySQL `root`
   - 这是 MySQL 服务器管理员账号。
   - 密码是在安装或配置 MySQL 时设置的。
   - 项目和文档里不会明文保存 MySQL `root` 密码。
   - 本机维护凭据使用 Windows DPAPI 加密，保存在 `%USERPROFILE%\.ozon-erp\mysql-root.credential.clixml`。该文件只能由创建它的 Windows 用户在本机解密，不应提交到仓库或发送给他人。
   - MySQL Configurator 界面里要求填写的 `Root password`，指的就是这个密码。

2. 项目应用账号
   - 项目从这个文件读取数据库连接信息：

```text
%USERPROFILE%\OneDrive\<Documents folder>\ozon-erp\ozon-system\.env
```

   - 相关字段：

```text
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=ozon_erp
DB_USER=ozon_app
DB_PASSWORD=...
```

这里的 `DB_PASSWORD` 是 `ozon_app` 应用账号密码，不一定是 MySQL `root` 密码。一般不要用应用账号做服务器维护操作。

## 如何手动登录

打开 PowerShell，执行：

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -h 127.0.0.1 -P 3306 -u root -p
```

出现密码提示后，输入 MySQL `root` 密码。

如果需要使用本机已加密保存的 root 凭据，可以在 PowerShell 当前会话中读取，不要把密码打印到屏幕：

```powershell
$mysqlRootCredential = Import-Clixml "$env:USERPROFILE\.ozon-erp\mysql-root.credential.clixml"
$mysqlRootPassword = $mysqlRootCredential.GetNetworkCredential().Password
```

维护脚本应通过临时 `--defaults-extra-file` 使用该密码，并在完成后立即删除临时文件。不要把密码拼进命令行参数、项目文档、Git 文件或聊天消息。

如果只是想测试项目应用账号，可以执行：

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -h 127.0.0.1 -P 3306 -u ozon_app -p ozon_erp
```

出现密码提示后，粘贴 `.env` 里的 `DB_PASSWORD` 值。这个账号可能没有清理 binlog 的权限。

## 安全清理命令

用 `root` 登录后，执行：

```sql
SHOW BINARY LOGS;
SELECT @@binlog_expire_logs_seconds;
PURGE BINARY LOGS BEFORE '2026-07-09 00:00:00';
SET PERSIST binlog_expire_logs_seconds = 259200;
SHOW BINARY LOGS;
```

这会保留较新的日志，并清理早于 `2026-07-09 00:00:00` 的日志。`259200` 秒表示以后 MySQL 自动保留最近 3 天的 binlog。

如果想保留更长时间，可以改成 7 天：

```sql
SET PERSIST binlog_expire_logs_seconds = 604800;
```

## 如果 root 登录失败

如果 `root` 登录失败，不要手动删除 binlog 文件。

可以选择下面任意一种方式处理：

1. 找到当初安装或配置 MySQL 的人，确认 `root` 密码。
2. 按 MySQL 官方流程重置 `root` 密码。
3. `root` 登录成功后，可以单独创建一个维护账号：

```sql
CREATE USER IF NOT EXISTS 'ozon_maint'@'localhost' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT BINLOG_ADMIN, SYSTEM_VARIABLES_ADMIN, REPLICATION CLIENT ON *.* TO 'ozon_maint'@'localhost';
FLUSH PRIVILEGES;
```

之后可以用这个维护账号登录：

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -h 127.0.0.1 -P 3306 -u ozon_maint -p
```

## 清理后如何确认空间

在 PowerShell 里执行：

```powershell
$binlogs = Get-ChildItem -LiteralPath "C:\ProgramData\MySQL\OzonERP\data" -Force -File -Filter "binlog.*" | Where-Object { $_.Name -match '^binlog\.\d+$' }
[pscustomobject]@{
  Count = $binlogs.Count
  TotalGB = [math]::Round(($binlogs | Measure-Object Length -Sum).Sum / 1GB, 2)
  Oldest = ($binlogs | Sort-Object LastWriteTime | Select-Object -First 1).LastWriteTime
  Newest = ($binlogs | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
}
```

## 备注

- 本机 MySQL 配置文件：

```text
C:\ProgramData\MySQL\OzonERP\my.ini
```

- 本机 MySQL 数据目录：

```text
C:\ProgramData\MySQL\OzonERP\data
```

- MySQL 端口是 `3306`。
- 这个清理不需要操作 ERP 的 `8788`、`8787` 或 `8087` 端口。
