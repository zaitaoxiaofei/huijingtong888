# Mac 开发指南

本文档用于在 macOS 上开发 `ozon-system`。当前正式部署、Windows 主机维护、桌面安装包和部分打印流程仍然以 Windows 为主，所以 Mac 先按“开发机”使用；真正发包前仍要按发布环境做验证。

## 适用范围

Mac 适合做：

- 修改前端、后端和共享 JavaScript 代码。
- 在本地 `8788` 端口运行 ERP Web 服务。
- 跑测试、前端构建和编码检查。
- 在打包发布前准备代码改动。

Mac 暂时不能直接替代：

- `deploy/windows-host/` 下的 Windows 主机部署脚本。
- `.bat` / `.ps1` 双击启动脚本。
- 当前 `npm run build:desktop` 的 Windows 桌面安装包构建。
- 依赖 SumatraPDF、PowerShell 或 Windows 打印机接口的服务端打印流程。

## 必装环境

Mac 上先安装：

- Node.js `>= 22.5.0`
- npm，随 Node.js 一起安装
- MySQL 8.x
- Git
- Chrome 或 Chromium 浏览器，用于人工检查页面

推荐用 Homebrew：

```bash
brew install node mysql git
brew services start mysql
```

检查版本：

```bash
node -v
npm -v
mysql --version
```

## 从 Windows 复制项目到 Mac

不要把 Windows 的 `node_modules` 复制到 Mac。`sharp`、Electron 和一些二进制依赖必须在 Mac 上重新安装。

建议：

- 复制项目源码。
- 不复制 `node_modules/`。
- 不依赖日志或旧文档里的 Windows 绝对路径。
- 所有文本文件保持 UTF-8。
- 如果用 zip/rar 传输，解压后确认中文文件名和中文内容没有乱码。

复制后执行：

```bash
cd ozon-system
rm -rf node_modules
npm install
```

## 配置 .env

从示例文件创建本地配置：

```bash
cd ozon-system
cp .env.example .env
```

本地开发最小配置：

```env
HOST=
PORT=8788
APP_BASE_URL=http://localhost:8788
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=ozon_erp
DB_USER=root
DB_PASSWORD=
DB_POOL_MIN=0
DB_POOL_MAX=10
```

如果 Mac 上 MySQL 的 `root` 有密码，填到 `DB_PASSWORD`。如果使用单独的开发账号，就同步修改 `DB_USER` 和 `DB_PASSWORD`。

不要把真实密钥、Token、客户数据、Ozon 凭证或数据库密码提交到仓库。

## MySQL 初始化

启动 MySQL：

```bash
brew services start mysql
```

创建数据库：

```bash
mysql -u root -p
```

进入 MySQL 后执行：

```sql
CREATE DATABASE IF NOT EXISTS ozon_erp
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
```

初始化或更新表结构：

```bash
npm run db:init:mysql
```

如果 MySQL 报 `utf8mb4_0900_ai_ci` 不支持，优先安装 MySQL 8.x，不要为了绕过错误随意改项目表结构。

## 本地启动

Mac 本地开发使用 `8788`：

```bash
npm start
```

该命令会：

1. 构建前端。
2. 打包浏览器插件。
3. 启动 ERP 服务。
4. 尽量自动打开本地页面。

访问：

```text
http://localhost:8788/admin.html
```

后端监听开发模式：

```bash
npm run dev
```

只验证前端构建：

```bash
npm run build:frontend
```

## 端口安全规则

Mac 本地开发只用 `8788`。

没有明确授权时，不要启动、停止、重启、绑定、部署或替换这些受保护端口上的服务：

- `8787`
- `8087`

如果命令意外使用受保护端口，先停下来检查 `.env`、shell 环境变量和启动参数。

检查 `8788` 是否被占用：

```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN
```

不要为了绕过端口占用而改用 `8787` 或 `8087`。

## Mac 上不要用的 Windows 命令

这些不是 Mac 启动入口：

```bash
npm run start:mysql
npm run start:mysql:tunnel
start.bat
start-mysql.bat
git-upload.bat
deploy/windows-host/*.ps1
```

Mac 上应先用 Homebrew 或 MySQL 官方工具启动 MySQL，再运行 `npm start`。

## Electron 和桌面打包

可以在本地 Web 服务启动后运行 Electron：

```bash
npm run electron:local
```

但当前桌面打包脚本是 Windows 目标：

```bash
npm run build:desktop
npm run build:desktop:portable
```

它们使用 `electron-builder --win`，不是 Mac `.app` 或 `.dmg` 打包命令。后续如果要做 Mac 安装包，需要单独补 `package.json` 的 `mac` 配置，并建立新的打包检查清单。

## 打包发出前检查

你准备“直接打包发出去”之前，至少先跑：

```bash
npm test
npm run build:frontend
npm run check:encoding
```

如果改动涉及上架流程、图片流程、Ozon 发布、后台任务、MySQL 表结构或核心业务逻辑，还要加跑对应模块的专项测试。

当前 Windows 发布包仍建议在 Windows 上最终验证，因为：

- 桌面安装包配置目标是 Windows。
- Windows 启动、部署脚本需要在 Windows 环境验证。
- 服务端打印依赖 Windows 工具。
- 生产等价端口 `8787` 和受保护端口 `8087` 是人工发布动作，不能在开发流程里误操作。

## 打印功能注意事项

部分本地打印 helper 对 Mac 有基础支持，但服务端打印流程目前明显偏 Windows。

Mac 开发时可以先验证 ERP 主流程；涉及面单、打印机选择、批量打印时，发包前要在目标 Windows 主机上测一遍，或者先补 Mac 专用打印实现和测试计划。

## 常见问题排查

启动失败时按顺序查：

- `node -v` 是否 `>= 22.5.0`。
- 是否误复制了 Windows 的 `node_modules`，必要时删除后重新 `npm install`。
- MySQL 是否在监听：`lsof -nP -iTCP:3306 -sTCP:LISTEN`。
- `.env` 是否是 `PORT=8788`，MySQL 账号密码是否正确。
- 是否已经执行 `npm run db:init:mysql`。
- `8788` 是否被其他进程占用。
- 不要切到 `8787` 或 `8087` 解决本地冲突。

## 推荐日常流程

```bash
cd ozon-system
brew services start mysql
npm install
npm run db:init:mysql
npm start
```

打开：

```text
http://localhost:8788/admin.html
```

普通代码改动完成后：

```bash
npm test
npm run build:frontend
```

如果改了中文文案、文档、Windows 脚本、用户可见文本或打包元数据，还要执行：

```bash
npm run check:encoding
```
