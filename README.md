# Ozon ERP

本项目是一个本地部署的 Ozon ERP 单体系统，当前使用 Node.js + SQLite + 原生前端 JavaScript。

## 当前真实入口

- 后端入口：[src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- 前端页面：[public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
- 前端运行入口：[public/app.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.js)

说明：

- `public/app.js` 现在是当前运行入口。
- `public/app.repair.js` 只是修复阶段遗留文件，不再作为正式入口。
- 文档以当前代码为准，不以旧方案稿、旧审查记录为准。

## 技术栈

- Node.js 22.5+
- 原生 `node:http`
- SQLite
- 原生 HTML / CSS / JavaScript
- `pdf-lib`

## 启动方式

```powershell
npm start
```

开发模式：

```powershell
npm run dev
```

默认配置来自 [.env](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/.env) 或 [.env.example](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/.env.example)：

- `HOST`
- `PORT`
- `DATABASE_PATH`
- `APP_BASE_URL`
- `APP_SESSION_TTL_HOURS`
- `SITE_ACCESS_PASSWORD`

## 当前系统范围

当前代码已经覆盖这些业务域：

- 选品计价
- 在线商品同步与 SKU 绑定
- 订单同步、订单处理、面单与发货
- 采购请求、采购单、入库、出库
- 库存预警、异常任务台
- 店铺、人员、供应商、物流规则、汇率配置
- 数据备份与恢复

## 代码结构

### 后端

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
  - HTTP 服务入口
  - 鉴权
  - 路由分发
  - 静态资源服务

- [src/http](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http)
  - 请求读取
  - 响应封装
  - 静态文件处理

- [src/server](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server)
  - 会话
  - 站点访问门禁
  - 备份/恢复
  - 通知检查

- [src/services.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
  - 仍然是主要业务实现文件

- [src/services](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services)
  - 当前是服务导出分组层
  - 还不是完整迁移后的独立业务实现

- [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)
  - SQLite 初始化
  - 表结构
  - 密码哈希

### 前端

- [public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
  - 页面结构
  - 各业务视图与弹窗容器

- [public/app.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.js)
  - 当前前端运行逻辑
  - 状态管理
  - API 调用
  - 页面渲染与交互

- [public/ui.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/ui.js)
  - 复用 UI 帮助函数

- [public/design-system.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/design-system.css)
  - 设计系统令牌与组件样式

## 数据文件

默认数据库：

- `data/ozon-profit-hub.sqlite`
- `data/ozon-profit-hub.sqlite-wal`
- `data/ozon-profit-hub.sqlite-shm`

不要只迁移 `src/` 或 `public/`，否则业务数据不会跟过去。

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

- [backup-data.bat](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/backup-data.bat)
- [restore-data.bat](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/restore-data.bat)

## 外网访问

当前推荐方案是：

- 本机运行 Node
- 只监听 `127.0.0.1`
- 通过 Cloudflare Tunnel 对外暴露
- 应用内再加一层站点访问口令

部署说明看：

- [docs/remote-access-deployment.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/remote-access-deployment.md)

## 文档入口

优先阅读这些文档：

- [docs/PROJECT_GUIDE.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/PROJECT_GUIDE.md)
- [docs/ARCHITECTURE.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/ARCHITECTURE.md)
- [docs/UI_DESIGN_SYSTEM.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/UI_DESIGN_SYSTEM.md)
- [docs/README.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/README.md)

## 维护原则

- 当前行为以代码为准。
- 先改代码，再同步文档。
- 不再把历史审查稿、规划稿当成“当前实现说明”。
- 清理旧文件时，优先删除未引用的备份和临时脚本，避免继续污染入口判断。
