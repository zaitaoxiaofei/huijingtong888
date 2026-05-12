# Ozon ERP Project Guide

这份文档只说明当前代码仓库里“真实正在运行的项目结构”，不再混入历史修复稿和旧规划结论。

## 1. 项目定位

当前项目是一个本地部署的 Ozon ERP 单体系统，主要围绕这些业务域：

- 选品计价
- 在线商品与 SKU 绑定
- 订单同步与订单处理
- 采购请求、采购单、入库、出库
- 库存预警与异常任务
- 店铺、人员、供应商、物流规则、汇率配置

技术上，它不是前后端分离的多服务系统，而是一个 Node.js 单体应用。

## 2. 当前真实入口

### 后端入口

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)

职责：

- 启动 HTTP 服务
- 处理站点访问门禁
- 处理登录与会话校验
- 分发 API
- 提供静态资源

### 前端入口

- [public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
- [public/app.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.js)

说明：

- `public/index.html` 当前加载 `ui.js`、`app.js`、`supplier.js`
- `public/app.js` 是当前正式运行入口
- `public/app.repair.js` 已移除，不再作为正式入口

## 3. 当前后端结构

### 3.1 入口与基础层

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- [src/config.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js)
- [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)

### 3.2 HTTP 基础模块

- [src/http/request.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/request.js)
- [src/http/response.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/response.js)
- [src/http/static.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/static.js)

### 3.3 Server 子模块

- [src/server/session.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/session.js)
- [src/server/access.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/access.js)
- [src/server/maintenance.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/maintenance.js)
- [src/server/notifications.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/notifications.js)

### 3.4 业务实现层

- [src/services.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
  - 目前仍然是核心业务实现集中点

- [src/services/index.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/index.js)
  - 当前作为服务导出层

- [src/services/analytics.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/analytics.js)
- [src/services/catalog.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/catalog.js)
- [src/services/configuration.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/configuration.js)
- [src/services/inventory.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/inventory.js)
- [src/services/orders.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/orders.js)
- [src/services/procurement.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/procurement.js)
- [src/services/sync.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/sync.js)

说明：

- 这些 `src/services/*` 文件当前主要是分组导出和局部迁移承接层。
- 不是所有业务都已经完全从 `src/services.js` 迁出。
- 所以理解项目时，`src/services.js` 仍然必须看。

## 4. 当前前端结构

- [public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
  - 主页面结构
  - 各业务视图
  - 弹窗容器

- [public/app.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.js)
  - 当前前端运行逻辑
  - 页面状态
  - API 调用
  - 表格、筛选、弹窗交互

- [public/ui.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/ui.js)
  - UI 帮助函数

- [public/supplier.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/supplier.js)
  - 供应商页交互补充逻辑

- [public/styles.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/styles.css)
  - 历史页面样式

- [public/ui-shared.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/ui-shared.css)
  - 当前共享 UI 样式层

- [public/design-system.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/design-system.css)
  - 设计系统令牌和通用组件样式

## 5. 当前主要页面

从 [public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html) 可以确认当前页面范围：

- 异常任务中心
- 利润看板
- 选品计价表
- 订单系统
- 出库流水
- 库存系统
- 采购系统
- 在线商品
- 系统设置

系统设置内部包括：

- 计价公式
- 利润规则
- 店铺配置
- 人员配置
- 汇率设置

## 6. 当前主要 API 领域

从 [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js) 可确认当前 API 大致分为：

- 系统与认证
- 仪表盘与利润汇总
- 汇率与计价
- 产品、在线商品、SKU 绑定
- 订单、面单、发货、订单异常
- 采购请求、采购单、入库、出库
- 店铺、人员、供应商、物流规则、库存规则
- Ozon 订单/库存/在线商品/财务同步

## 7. 当前数据库核心表

数据库初始化在 [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)。

当前主要表包括：

- `shops`
- `people`
- `products`
- `online_products`
- `sku_mappings`
- `procurement_requests`
- `purchase_orders`
- `purchase_order_items`
- `inbound_records`
- `outbound_records`
- `inventory_movements`
- `orders`
- `order_items`
- `order_profit_items`
- `ozon_orders_raw`
- `ozon_finance_items`
- `inventory_current`
- `order_exceptions`
- `exception_task_states`
- `order_marks`
- `order_label_prints`
- `order_quality_rules`
- `sync_logs`
- `exchange_rates`
- `sessions`
- `suppliers`
- `logistics_fee_rules`
- `ozon_stock_snapshots`
- `stock_warehouse_rules`

## 8. 运行与部署

### 启动

```powershell
npm start
```

### 开发模式

```powershell
npm run dev
```

### 当前环境变量

来自 [src/config.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js)：

- `HOST`
- `PORT`
- `DATABASE_PATH`
- `APP_BASE_URL`
- `APP_SESSION_TTL_HOURS`
- `SITE_ACCESS_PASSWORD`
- `SITE_ACCESS_COOKIE_NAME`
- `SITE_ACCESS_SESSION_HOURS`
- `AUTH_RATE_LIMIT_WINDOW_MINUTES`
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`

### 当前推荐外网访问方案

- 本机运行 Node 服务
- 监听 `127.0.0.1`
- Cloudflare Tunnel 做公网入口
- 应用内站点访问口令 + 系统登录两层保护

参考文档：

- [remote-access-deployment.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/remote-access-deployment.md)

## 9. 当前代码现状判断

### 已经更清晰的部分

- `server.js` 已经拆出 HTTP、session、maintenance、access 等辅助模块
- 前端有 `design-system.css` 和 `ui.js` 作为可复用基础
- 服务导出已经开始按领域分组

### 仍然混乱的部分

- `src/services.js` 仍然过大
- `public/app.js` 仍然过大
- 文档历史稿很多，容易把“旧方案”误认为“当前实现”
- 仓库内历史备份文件曾经混入运行目录

## 10. 当前维护原则

- 先看代码，再写文档。
- 先确认真实入口，再讨论重构。
- 历史评审稿、优化稿、修复备份稿不再作为当前说明主入口。
- 如果以后继续拆分 `src/services.js` 或 `public/app.js`，必须同步更新本文件。
