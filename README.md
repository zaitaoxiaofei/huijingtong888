# Ozon ERP

## 当前说明

这是一个本地部署的 Ozon ERP 单体项目，当前覆盖以下业务：

- 选品与计价
- 在线商品同步与 SKU 绑定
- 采购申请与采购单
- 入库与出库流水
- 订单同步与履约处理
- 利润汇总与利润明细
- 库存预警、异常任务、物流规则、供应商配置

## 文档原则

后续所有文档统一遵循以下规则：

1. 实际运行行为以当前代码为准
2. 实际入口文件以当前代码引用关系为准
3. 实际接口、表结构、字段口径以当前代码和数据库初始化逻辑为准
4. 文档用于说明、交接、规划，不作为最终判定来源
5. 未来优化方案必须和“当前事实”分开写，不能混写成现状

当前建议优先阅读：

- [docs/PROJECT_GUIDE.md](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/PROJECT_GUIDE.md)
- [docs/README.md](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/README.md)

## 实际入口

后端入口：

- [src/server.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)

前端入口：

- [public/index.html](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
- [public/app.repair.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js)

说明：

- `public/index.html` 当前实际加载的是 `public/app.repair.js`
- `public/app.js` 是历史文件，不是当前浏览器运行入口
- 后续如果入口再次调整，文档必须同步按代码事实更新

## 启动方式

```powershell
npm start
```

开发模式：

```powershell
npm run dev
```

默认访问地址：

```text
http://localhost:8787
```

## 数据位置

默认 SQLite 文件：

- `data/ozon-profit-hub.sqlite`
- `data/ozon-profit-hub.sqlite-wal`
- `data/ozon-profit-hub.sqlite-shm`

迁移或备份项目时，不要只复制前端或源码目录，必须一起处理 `data/`。

## 备份与恢复

备份：

```powershell
npm run backup:data
```

恢复：

```powershell
npm run restore:data
```

也可以直接使用：

- [backup-data.bat](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/backup-data.bat)
- [restore-data.bat](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/restore-data.bat)

## 后续维护原则

后续会持续做功能优化和升级，因此文档维护也按下面执行：

- 先确认代码实际行为，再更新文档
- 先记录当前状态，再写优化目标
- 任何重构、入口切换、接口调整、表结构变化，都要同步更新 `docs/PROJECT_GUIDE.md`
- 规划类文档不得覆盖当前事实文档
