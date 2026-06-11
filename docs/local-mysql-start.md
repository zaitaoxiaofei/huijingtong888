# Local MySQL Startup

Use the MySQL-backed local stack for this workspace:

```powershell
npm run start:mysql
```

On Windows, `start-mysql.bat` does the same thing for a double-click start.

The startup script:

1. Reuses MySQL if `127.0.0.1:3306` is already listening.
2. Otherwise starts `mysqld.exe` with `C:\ProgramData\MySQL\OzonERP\my.ini`.
3. Waits for MySQL to accept TCP connections.
4. Builds the frontend and starts the ERP server on the local test port.

The app still reads database credentials from `.env`. The current local MySQL layout expects:

- MySQL server: `C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe`
- MySQL config: `C:\ProgramData\MySQL\OzonERP\my.ini`
- MySQL data directory: `C:\ProgramData\MySQL\OzonERP\data`
- ERP URL after startup: `http://localhost:8788`

Override the machine-specific MySQL paths before startup when needed:

```powershell
$env:OZON_MYSQLD_PATH = "D:\MySQL\bin\mysqld.exe"
$env:OZON_MYSQL_CONFIG = "D:\MySQL\my.ini"
npm run start:mysql
```

To start only MySQL without starting the tunnel or ERP server:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local-mysql.ps1
```

To start MySQL and the Cloudflare Tunnel explicitly:

```powershell
npm run start:mysql:tunnel
```
