# 历史图片视频迁移审计工具

`scripts/audit-oss-media-migration.mjs` 用于 OSS 迁移前的只读盘点。本阶段工具只扫描文件、执行 MySQL `SELECT` 查询并生成报告，不会上传、移动、改名或删除文件，也不会执行数据库写入。

## 审计范围

- 默认递归扫描 `uploads`、`public/uploads`。
- 按图片、视频、临时文件、其他文件分类，统计数量、字节数和扩展名。
- 对每个文件计算 SHA-256，并列出重复哈希组及重复占用空间。
- 从 `information_schema.COLUMNS` 找出当前数据库的字符、文本和 JSON 列，分批读取非空值。
- 识别 `data:image` Base64、`/uploads` 本地地址、已有 OSS 地址和其他外部地址。
- 对 `/uploads` 地址同时检查 `uploads/<路径>` 与 `public/uploads/<路径>`，报告两处都不存在的引用。

报告中的 Base64 内容会被替换为长度摘要，HTTP(S) 地址会移除查询参数和片段，避免把签名、令牌或 AccessKey 参数写入报告。数据库连接密码、OSS AccessKey 等环境变量不会进入报告。

## 使用方式

在 `ozon-system` 目录运行：

```powershell
node scripts/audit-oss-media-migration.mjs
```

工具读取项目现有的 `.env` 数据库配置（`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`），只发出 `SELECT`。建议数据库账号本身也配置为只读账号。

只扫描文件、不连接 MySQL：

```powershell
node scripts/audit-oss-media-migration.mjs --no-db
```

指定报告目录：

```powershell
node scripts/audit-oss-media-migration.mjs --output-dir tmp/media-audit
```

默认生成：

- `tmp/oss-media-migration-audit-<UTC时间>.json`
- `tmp/oss-media-migration-audit-<UTC时间>.md`

报告内的展示时间使用北京时间（`Asia/Shanghai`）。JSON 保留机器可读的 UTC 生成时间。

## 性能与边界

文件 SHA-256 会完整读取每个文件，首次扫描大目录可能耗时较长。MySQL 审计会遍历全部文本/JSON 列的非空值，因此应在低峰期运行，并优先使用只读副本或只读账号。

本工具没有迁移、清理或修复模式，也没有上传、`UPDATE`、`DELETE`、`INSERT`、`ALTER` 或文件删除代码。报告中的“可重复占用”只是统计值，不代表文件可以安全删除。

## 验证

```powershell
node --test --test-concurrency=1 test/oss-media-migration-audit.test.js
npm run check:encoding
```
