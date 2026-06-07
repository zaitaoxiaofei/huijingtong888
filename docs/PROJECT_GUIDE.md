# Ozon ERP Project Guide

本文档只描述当前仍在运行和维护的系统结构，不再把旧版 SQLite 运行形态当作当前事实。

## 1. 项目定位

当前项目是一个本地部署的 Ozon ERP 单体系统：

- 后端：Node.js
- 数据库：MySQL
- 前端：admin 管理端统一使用 `Vue 3 + Element Plus`

当前核心业务覆盖：

- 经营分析
- 选品中心
- 订单管理
- 库存管理
- 采购管理
- 系统设置

## 2. 当前真实入口

### 后端入口

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)

职责：

- 启动 HTTP 服务
- 处理登录与会话
- 注册 API
- 提供静态资源

### 前端入口

- [public/admin.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/admin.html)
- [frontend/admin/main.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/main.js)

说明：

- `/` 和 `/index.html` 都进入当前 admin 管理端
- 运行时前端产物位于 `public/vue-apps/`
- 旧静态工作台页面不再属于当前运行链路

## 3. 当前后端结构

### 3.1 基础入口

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- [src/config.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js)
- [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)

### 3.2 HTTP 层

- [src/http/request.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/request.js)
- [src/http/response.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/response.js)
- [src/http/static.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/static.js)

### 3.3 Server 子模块

- [src/server/session.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/session.js)
- [src/server/access.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/access.js)
- [src/server/maintenance.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/maintenance.js)
- [src/server/notifications.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/notifications.js)

### 3.4 业务服务层

- [src/services.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
- [src/services/index.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/index.js)
- [src/services/analytics.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/analytics.js)
- [src/services/catalog.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/catalog.js)
- [src/services/configuration.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/configuration.js)
- [src/services/orders.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/orders.js)
- [src/services/procurement.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/procurement.js)

## 4. 当前前端结构

- [frontend/admin/App.vue](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/App.vue)
- [frontend/admin/layouts/AdminLayout.vue](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/layouts/AdminLayout.vue)
- [frontend/admin/router/index.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/router/index.js)
- [frontend/admin/constants/navigation.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/constants/navigation.js)
- [frontend/admin/styles/index.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/styles/index.css)
- [frontend/admin/views](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/views)

约束：

- 只维护当前 Vue 管理端页面
- 不再在新系统里挂载旧利润页、异常页、采购旧页
- 页面搜索区、表格区、分页区统一遵循当前管理端样式规范

## 5. 当前主要页面

- 首页看板
- 利润看板
- 异常工作台
- 选品中心
- 订单列表
- 出库记录
- 产品库存
- FBP 库存
- 已隐藏产品
- SKU 绑定配置
- 供应商配置
- 库存预警
- 在线商品
- 采购请求
- 采购清单
- 采购历史
- 入库管理
- 配置中心

## 6. 运行与部署

启动：

```powershell
npm start
```

说明：

- `npm start` 会先构建前端，再启动后端
- 当前数据库运行时依赖 MySQL 连接配置，而不是本地 SQLite 文件

开发模式：

```powershell
npm run dev
```

前端构建：

```powershell
npm run build:frontend
```

部署产物：

```powershell
npm run package:deploy
```

说明：

- 该命令输出 `dist/deploy`
- 线上服务应只使用 `dist/deploy` 运行
- 不要只同步后端源码而漏掉 `public/vue-apps`
- `dist/deploy` 里的 `npm start` 只负责启动服务，不重复执行前端构建

## 7. 维护原则

- 先看代码，再写文档
- 以当前可运行入口和 MySQL 配置为准
- 历史 SQLite 数据文件和迁移草案不再作为当前系统描述依据
- 后端 API 变更必须同步更新文档
