# Ozon ERP Project Guide

本文档只描述当前仍在运行和维护的系统结构。

## 1. 项目定位

当前项目是一个本地部署的 Ozon ERP 单体系统，后端使用 Node.js + SQLite，前端统一使用 `Vue 3 + Element Plus` 管理端。

系统当前覆盖的核心业务包括:

- 经营分析
- 选品中心
- 订单管理
- 库存管理
- 采购请求、采购清单、入库、采购历史
- 系统设置

## 2. 当前真实入口

### 后端入口

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)

职责:

- 启动 HTTP 服务
- 处理登录与会话
- 注册 API
- 提供静态资源

### 前端入口

- [public/admin.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/admin.html)
- [frontend/admin/main.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/main.js)

说明:

- 根路径 `/` 与 `/index.html` 已统一进入 `admin.html`
- 运行时构建产物位于 `public/vue-apps/`
- 旧版静态入口已退出运行时

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

约束:

- 只维护新的 Vue 管理端页面
- 不再在新系统中挂载旧版利润页、异常页、采购旧页面
- 页面搜索区、表格区、分页区统一遵循当前管理端样式规范

## 5. 当前主要页面

- 首页看板
- 利润看板
- 异常工作台
- 选品中心
- 订单列表
- 出库记录
- 产品库存表
- FBP 库存表
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

启动:

```powershell
npm start
```

说明:

- `npm start` 会先构建前端，再启动后端。
- 这样本地运行链路与部署链路保持一致。

开发模式:

```powershell
npm run dev
```

前端构建:

```powershell
npm run build:frontend
```

部署产物:

```powershell
npm run package:deploy
```

说明:

- 该命令输出 `dist/deploy`
- 线上服务器应只使用 `dist/deploy` 目录运行
- 不要只同步后端源码而漏掉 `public/vue-apps`
- `dist/deploy` 目录中的 `npm start` 会直接启动服务，不重复执行前端构建

## 7. 维护原则

- 先看代码，再写文档
- 以当前可运行入口为准
- 历史备份文件和旧静态页面不再作为当前系统说明依据
- 后端 API 变更必须同步更新文档
