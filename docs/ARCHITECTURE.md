# Architecture

## 1. 运行形态

当前项目是一个本地部署的单体应用：

```text
Browser
  -> public/index.html
  -> public/app.js
  -> src/server.js
  -> src/services.js / src/services/*
  -> SQLite
  -> Ozon API / PDF / PowerShell backup-restore
```

不是前后端分离，不是微服务，也没有构建工具链。

## 2. 分层

### 前端层

- [public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
- [public/app.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.js)
- [public/ui.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/ui.js)
- [public/styles.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/styles.css)
- [public/design-system.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/design-system.css)

职责：

- 视图切换
- 表格渲染
- 弹窗与表单
- 请求 `/api/*`

### HTTP 基础层

- [src/http/request.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/request.js)
- [src/http/response.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/response.js)
- [src/http/static.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/static.js)

职责：

- 读取 JSON / form 请求
- 统一 JSON / HTML 响应
- 提供静态资源

### 服务器控制层

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- [src/server/session.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/session.js)
- [src/server/access.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/access.js)
- [src/server/maintenance.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/maintenance.js)
- [src/server/notifications.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/notifications.js)

职责：

- 鉴权
- 站点门禁
- API 分发
- 会话清理
- 备份恢复
- 定时检查

### 业务服务层

- [src/services.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
- [src/services](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services)

职责：

- 商品
- 订单
- 采购
- 库存
- 配置
- 同步
- 分析

当前现实：

- `src/services.js` 仍然是主实现中心
- `src/services/*` 是逐步拆分过程中的结构化出口

### 数据层

- [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)
- `data/ozon-profit-hub.sqlite`

职责：

- 表初始化
- 会话存储
- 业务数据持久化

## 3. 当前数据库模型概要

### 主数据

- `shops`
- `people`
- `products`
- `suppliers`
- `online_products`
- `sku_mappings`

### 采购与库存

- `procurement_requests`
- `purchase_orders`
- `purchase_order_items`
- `inbound_records`
- `outbound_records`
- `inventory_movements`
- `inventory_current`

### 订单与利润

- `orders`
- `order_items`
- `order_profit_items`
- `order_exceptions`
- `order_marks`
- `order_label_prints`
- `order_quality_rules`

### 同步与规则

- `ozon_orders_raw`
- `ozon_finance_items`
- `ozon_stock_snapshots`
- `sync_logs`
- `exchange_rates`
- `logistics_fee_rules`
- `stock_warehouse_rules`
- `online_product_actions`

### 安全与会话

- `sessions`
- `exception_task_states`

## 4. 当前部署方式

### 本地模式

- `npm start`
- 默认 SQLite
- 默认静态前端 + Node 服务

### 远程访问模式

- Node 只监听 `127.0.0.1`
- Cloudflare Tunnel 暴露外网入口
- 应用层站点访问口令

参考：

- [remote-access-deployment.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/remote-access-deployment.md)

## 5. 当前结构问题

- `public/app.js` 文件过大
- `src/services.js` 文件过大
- 业务实现尚未完全迁移到 `src/services/*`
- 运行目录曾混入备份和临时文件，导致入口判断困难

## 6. 当前建议

- 所有新结构说明都以本文件和 `PROJECT_GUIDE.md` 为准
- 不再从历史备份文件推断系统结构
- 如果后续继续拆分前后端大文件，先改代码，再更新本文件
