# 数据备份、迁移和恢复

这份文档只说明一件事：怎样把当前测试版里的店铺、采购、入库、出库、库存、订单和 SKU 绑定数据完整带到另一台电脑。

## 核心原则

项目数据不在页面文件里，而是在 SQLite 数据库中：

```text
data/ozon-profit-hub.sqlite
data/ozon-profit-hub.sqlite-wal
data/ozon-profit-hub.sqlite-shm
```

系统使用 SQLite WAL 模式，所以不要只复制 `.sqlite` 主文件。换电脑、压缩项目、发给别人测试之前，先运行备份脚本。

## 旧电脑备份

推荐双击：

```powershell
.\backup-data.bat
```

也可以运行：

```powershell
npm run backup:data
```

脚本会先执行数据库 checkpoint，再生成：

```text
backups/ozon-data-YYYYMMDD-HHMMSS.zip
```

这个 zip 就是迁移时要带走的数据包。

## 新电脑恢复

推荐使用脚本恢复，不要手动解压覆盖。

1. 在新电脑解压完整项目。
2. 把旧电脑生成的 `ozon-data-YYYYMMDD-HHMMSS.zip` 复制到新电脑项目的 `backups/` 文件夹。
3. 确认 Ozon Profit Hub 没有正在运行。
4. 双击 `restore-data.bat`。
5. 启动项目，访问 `http://localhost:8787`。

恢复脚本会自动选择 `backups/` 里最新的 `ozon-data-*.zip`。恢复前，它会把当前 `data/` 另存到：

```text
backups/before-restore-YYYYMMDD-HHMMSS/
```

这样即使恢复错了，也还有恢复前的数据副本。

## 迁移前后检查

- 迁移前：页面右上角会显示当前数据文件路径，确认它指向当前项目的 `data/ozon-profit-hub.sqlite`。
- 迁移后：先检查店铺配置、采购请求、入库表、出库表、产品库存表是否和旧电脑一致。
- 如果不一致，先不要继续录入新数据，重新用最新备份覆盖 `data/` 文件夹。

## 常见问题

### 复制整个项目文件夹，为什么数据还是可能丢？

如果系统正在运行，SQLite 的最新写入可能还在 WAL 文件里。直接复制项目文件夹容易漏掉 WAL 状态，或者复制到的不是正在使用的那个数据库。备份脚本会先做 checkpoint，再把数据库相关文件一起打包。

### 可以把 backups 目录提交到代码版本里吗？

不建议。`backups/` 里是业务数据备份，可能包含店铺、订单、成本、人员等敏感信息。项目已经在 `.gitignore` 中忽略了 `backups/` 和本地数据库文件。

### 恢复之前要不要关闭系统？

要。恢复会替换 `data/` 里的数据库文件，恢复前请关闭正在运行的 Ozon Profit Hub 服务窗口。
